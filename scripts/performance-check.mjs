import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const explicitBaseUrl = process.env.PERF_BASE_URL ?? process.env.E2E_BASE_URL ?? process.env.SMOKE_BASE_URL ?? '';
const username = process.env.PERF_ADMIN_USERNAME ?? process.env.E2E_ADMIN_USERNAME ?? process.env.SMOKE_ADMIN_USERNAME ?? 'admin';
const password = process.env.PERF_ADMIN_PASSWORD ?? process.env.E2E_ADMIN_PASSWORD ?? process.env.SMOKE_ADMIN_PASSWORD ?? 'admin123456';
const executablePath = process.env.E2E_BROWSER_PATH || findSystemBrowser();
const tempDataDir = path.resolve(process.cwd(), '.tmp-perf-data');

const thresholds = {
  loginMs: Number(process.env.PERF_LOGIN_MS ?? 3500),
  sectionSwitchMs: Number(process.env.PERF_SECTION_MS ?? 1800),
  mapInteractionMs: Number(process.env.PERF_MAP_MS ?? 1200),
  longTaskMs: Number(process.env.PERF_LONG_TASK_MS ?? 250),
};

let localServer;
let baseUrl = explicitBaseUrl;
if (!baseUrl) {
  const port = await getAvailablePort(Number(process.env.PERF_PORT ?? 18080));
  baseUrl = `http://127.0.0.1:${port}`;
  localServer = await startLocalServer(port, baseUrl);
}

const browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
const consoleProblems = [];

try {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleProblems.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    consoleProblems.push(error.message);
  });
  await page.addInitScript(() => {
    window.localStorage.setItem('colipas.language', 'en');
    window.__colipasPerfLongTasks = [];
    if ('PerformanceObserver' in window) {
      try {
        const observer = new PerformanceObserver((list) => {
          window.__colipasPerfLongTasks.push(...list.getEntries().map((entry) => ({
            name: entry.name,
            duration: entry.duration,
            startTime: entry.startTime,
          })));
        });
        observer.observe({ type: 'longtask', buffered: true });
      } catch {
        // Long task entries are unavailable in some Chromium modes.
      }
    }
  });

  const loginMs = await measure('login', async () => {
    await page.goto(`${baseUrl}/admin/#overview`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.locator('input[autocomplete="username"]').fill(username);
    await page.locator('input[autocomplete="current-password"]').fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.locator('.topbar').waitFor({ timeout: 15000 });
  });
  const initialModuleChunks = await page.evaluate(() => (
    performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /\/module-[^/]+\.js(?:$|\?)/i.test(name))
      .map((name) => name.split('/').pop() ?? name)
  ));
  const unexpectedInitialChunks = initialModuleChunks.filter((name) => (
    !name.startsWith('module-overview-')
  ));
  if (unexpectedInitialChunks.length > 0) {
    throw new Error(`Initial overview loaded unrelated admin modules before navigation: ${unexpectedInitialChunks.join(', ')}`);
  }

  const sections = [
    { name: 'servers', button: /^Servers$/i, url: /#servers$/, ready: '.server-workspace-list, .empty-state' },
    { name: 'operations', button: /^Operations$/i, url: /#operations$/, ready: '.ops-layout' },
    { name: 'ai', button: /^AI System$/i, url: /#ai$/, ready: '.ai-workbench' },
    { name: 'custom api', button: /^Custom API$/i, url: /#api$/, ready: '.api-workbench-layout' },
    { name: 'security', button: /^Security$/i, url: /#security$/, ready: '.security-workbench' },
    { name: 'overview', button: /^Overview$/i, url: /#overview$/, ready: '.cloud-map' },
  ];
  const sectionDurations = [];
  for (const section of sections) {
    const duration = await measure(section.name, async () => {
      await clickNav(section.button);
      await page.waitForURL(section.url, { timeout: 10000 });
      await waitForReady(section.ready, section.name);
    });
    sectionDurations.push({ section: section.name, duration });
  }

  const mapInteractionMs = await measure('map interaction', async () => {
    await page.locator('.cloud-map').scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: /zoom in/i }).click();
    await page.waitForFunction(() => document.querySelector('.cloud-map')?.classList.contains('is-zoomed'), undefined, { timeout: 5000 });
    const activeCountry = page.locator('.map-country.active').first();
    if (await activeCountry.count()) {
      await activeCountry.click({ force: true });
      await page.locator('.map-tooltip.pinned').waitFor({ timeout: 5000 });
    }
  });

  const longTasks = await page.evaluate(() => window.__colipasPerfLongTasks ?? []);
  const maxLongTask = longTasks.reduce((max, entry) => Math.max(max, entry.duration), 0);
  const worstSection = sectionDurations.reduce((worst, item) => item.duration > worst.duration ? item : worst, { section: 'none', duration: 0 });

  assertUnder('login', loginMs, thresholds.loginMs);
  assertUnder(`section switch (${worstSection.section})`, worstSection.duration, thresholds.sectionSwitchMs);
  assertUnder('map interaction', mapInteractionMs, thresholds.mapInteractionMs);
  assertUnder('long task', maxLongTask, thresholds.longTaskMs);
  if (consoleProblems.length > 0) {
    throw new Error(`Browser console errors:\n${consoleProblems.join('\n')}`);
  }

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    localServer: Boolean(localServer),
    loginMs,
    worstSection,
    mapInteractionMs,
    longTaskCount: longTasks.length,
    maxLongTaskMs: Math.round(maxLongTask),
    initialModuleChunks,
    thresholds,
  }, null, 2));
} finally {
  await browser.close();
  await stopLocalServer(localServer);
  if (localServer) {
    fs.rmSync(tempDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function measure(label, action) {
  const start = performance.now();
  await action();
  const duration = Math.round(performance.now() - start);
  console.log(`perf ${label}: ${duration}ms`);
  return duration;
}

function assertUnder(label, actual, threshold) {
  if (actual > threshold) {
    throw new Error(`${label} took ${actual}ms, over threshold ${threshold}ms`);
  }
}

async function clickNav(label) {
  const navButton = page.locator('.nav-item').filter({ hasText: label }).first();
  await navButton.waitFor({ timeout: 10000 });
  await navButton.click();
}

async function waitForReady(selector, sectionName) {
  try {
    await page.locator(selector).first().waitFor({ timeout: 10000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      url: window.location.href,
      activeNav: document.querySelector('.nav-item.active')?.textContent?.trim() ?? '',
      mainText: document.querySelector('main')?.textContent?.replace(/\s+/g, ' ').slice(0, 400) ?? '',
      selectors: {
        serverRows: document.querySelectorAll('.server-workspace-row').length,
        emptyStates: document.querySelectorAll('.empty-state').length,
        moduleSections: document.querySelectorAll('.module-section').length,
      },
    }));
    throw new Error(`Timed out waiting for ${sectionName} selector ${selector}: ${JSON.stringify(state)}`, { cause: error });
  }
}

function findSystemBrowser() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? '';
}

function startLocalServer(port, targetBaseUrl) {
  const serverEntry = path.resolve(process.cwd(), 'build', 'server', 'index.js');
  if (!fs.existsSync(serverEntry)) {
    throw new Error('Production server build is missing. Run npm run build before node scripts/performance-check.mjs, or use npm run perf.');
  }

  fs.rmSync(tempDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  fs.mkdirSync(tempDataDir, { recursive: true });

  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      CORS_ORIGIN: targetBaseUrl,
      CUSTOM_API_ALLOWED_HOSTS: 'api.example.com,127.0.0.1',
      COLIPAS_TEST_ALLOW_LOOPBACK_API: '1',
      AI_API_KEY: '',
      ADMIN_USERNAME: username,
      ADMIN_PASSWORD: password,
      SESSION_SECRET: 'performance-check-session-secret',
      RELEASE_VERIFY_TOKEN: 'performance-check-release-token-12345',
      RELEASE_TARGET_NAME: 'performance-local',
      RELEASE_CHANNEL: 'grey',
      RELEASE_DEPLOYMENT_MODE: 'node',
      RELEASE_PUBLIC_URL: targetBaseUrl,
      RELEASE_GIT_COMMIT: 'performance-check',
      RELEASE_ARTIFACT_ID: 'performance-check',
      RELEASE_DEPLOYED_AT: '2026-01-01T00:00:00.000Z',
      COLIPAS_DATA_DIR: tempDataDir,
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrTail = '';
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderrTail = `${stderrTail}${text}`.slice(-4000);
    process.stderr.write(chunk);
  });

  return waitForLocalHealth(targetBaseUrl, child, () => stderrTail).then(() => child);
}

async function waitForLocalHealth(targetBaseUrl, child, getStderrTail) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Performance check local server exited early: ${formatExit(child.exitCode, child.signalCode)}\n${getStderrTail()}`);
    }
    try {
      const response = await fetch(`${targetBaseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`Timed out waiting for ${targetBaseUrl}/api/health`);
}

async function stopLocalServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 3000);
  });
}

async function getAvailablePort(preferredPort) {
  if (await canListen(preferredPort)) {
    return preferredPort;
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function formatExit(code, signal) {
  const parts = [];
  if (code !== null && code !== undefined) {
    parts.push(`exit code ${code}`);
  }
  if (signal) {
    parts.push(`signal ${signal}`);
  }
  return parts.join(', ') || 'no exit code or signal';
}
