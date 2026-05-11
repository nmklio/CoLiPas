import { chromium } from 'playwright';
import fs from 'node:fs';

const baseUrl = process.env.PERF_BASE_URL ?? process.env.E2E_BASE_URL ?? process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:18080';
const username = process.env.PERF_ADMIN_USERNAME ?? process.env.E2E_ADMIN_USERNAME ?? process.env.SMOKE_ADMIN_USERNAME ?? 'admin';
const password = process.env.PERF_ADMIN_PASSWORD ?? process.env.E2E_ADMIN_PASSWORD ?? process.env.SMOKE_ADMIN_PASSWORD ?? 'admin123456';
const executablePath = process.env.E2E_BROWSER_PATH || findSystemBrowser();

const thresholds = {
  loginMs: Number(process.env.PERF_LOGIN_MS ?? 3500),
  sectionSwitchMs: Number(process.env.PERF_SECTION_MS ?? 1800),
  mapInteractionMs: Number(process.env.PERF_MAP_MS ?? 1200),
  longTaskMs: Number(process.env.PERF_LONG_TASK_MS ?? 250),
};

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
    loginMs,
    worstSection,
    mapInteractionMs,
    longTaskCount: longTasks.length,
    maxLongTaskMs: Math.round(maxLongTask),
    thresholds,
  }, null, 2));
} finally {
  await browser.close();
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
