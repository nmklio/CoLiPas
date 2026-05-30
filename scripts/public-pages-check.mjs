import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const baseUrl = normalizeBaseUrl(process.env.PUBLIC_PAGES_BASE_URL ?? process.env.E2E_BASE_URL ?? process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:18080');
const mode = process.env.PUBLIC_PAGES_MODE ?? (isLocalhost(baseUrl) ? 'admin' : 'public');
const executablePath = process.env.PUBLIC_PAGES_BROWSER_PATH ?? process.env.E2E_BROWSER_PATH ?? findSystemBrowser();
const evidenceDir = path.resolve('output', 'public-pages-check');
const viewports = [
  { name: 'desktop', width: 1440, height: 1000, isMobile: false },
  { name: 'mobile', width: 390, height: 844, isMobile: true },
];
const pages = mode === 'admin'
  ? [buildAdminCheck()]
  : [buildLandingCheck(), buildDocsCheck(), buildAdminCheck()];

fs.rmSync(evidenceDir, { recursive: true, force: true });
fs.mkdirSync(evidenceDir, { recursive: true });

const browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { headless: true });
const failures = [];

try {
  for (const viewport of viewports) {
    for (const pageSpec of pages) {
      await validatePage(pageSpec, viewport);
    }
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  throw new Error(`Public page browser validation failed:\n${failures.join('\n')}`);
}

console.log(`ok public page browser validation ${mode} ${baseUrl}`);

async function validatePage(pageSpec, viewport) {
  const pageErrors = [];
  const failedRequests = [];
  const badResponses = [];
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.isMobile,
  });

  page.on('console', (message) => {
    if (message.type() === 'error') {
      if (message.text().startsWith('Failed to load resource:')) {
        return;
      }
      pageErrors.push(`console error: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(`pageerror: ${error.message}`);
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (!isIgnorableResource(url)) {
      failedRequests.push(`${request.method()} ${url} ${request.failure()?.errorText ?? 'failed'}`);
    }
  });
  page.on('response', (response) => {
    const status = response.status();
    const url = response.url();
    if (status >= 400 && !isIgnorableResource(url)) {
      badResponses.push(`${status} ${url}`);
    }
  });

  try {
    const targetUrl = new URL(pageSpec.path, baseUrl).toString();
    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 35000,
    });
    if (!response?.ok()) {
      throw new Error(`${pageSpec.name} ${viewport.name} returned HTTP ${response?.status() ?? 'none'}`);
    }

    await pageSpec.assert(page, viewport);
    await assertNoHorizontalOverflow(page, `${pageSpec.name} ${viewport.name}`);
    await assertNoBadBoxes(page, pageSpec.name, viewport.name);
    await captureVisualEvidence(page, `${pageSpec.name}-${viewport.name}`);

    if (pageErrors.length || failedRequests.length || badResponses.length) {
      throw new Error([
        ...pageErrors,
        ...failedRequests.map((item) => `request failed: ${item}`),
        ...badResponses.map((item) => `bad response: ${item}`),
      ].join('\n'));
    }

    console.log(`ok public page ${pageSpec.name} ${viewport.name}`);
  } catch (error) {
    failures.push(`${pageSpec.name} ${viewport.name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await page.close();
  }
}

function buildLandingCheck() {
  return {
    name: 'landing',
    path: '/',
    assert: async (page) => {
      await expectTitle(page, /CoLiPas云服务器管理面板/);
      await expectTitleAbsent(page, /CoLiPas - 多云服务器管理面板|多云服务器管理面板/);
      await expectText(page.locator('h1').first(), /CoLiPas云服务器管理面板|CoLiPas Cloud Server Management Panel|multi-cloud/i, 'landing h1');
      await expectText(page.locator('body'), /云服务器管理与 AI 运维后台|cloud server management/i, 'landing footer product description');
      await expectTextAbsent(page, /多云服务器管理与 AI 运维后台/, 'landing legacy footer product description');
      await expectLink(page, /GitHub/i, 'https://github.com/nmklio/CoLiPas');
      await expectLink(page, /文档|Docs/i, '/docs.html');
      await expectLink(page, /后台|登录|Admin|进入/i, '/admin/');
      await expectLocatorCountAtLeast(page.locator('section, article, .feature-card, .position-card, .deploy-card'), 6, 'landing content sections');
      await expectLocatorCountAtLeast(page.locator('.feature-card .feature-icon svg'), 6, 'landing feature SVG icons');
      await expectLocatorCountAtLeast(page.locator('.position-card .position-icon svg'), 4, 'landing position SVG icons');
      await expectLocatorCountAtLeast(page.locator('.position-card.position-card-modern'), 4, 'landing modern position cards');
      await expectLocatorCountAtLeast(page.locator('.position-card .position-icon.position-icon-modern svg'), 4, 'landing modern position SVG icons');
      await expectLocatorCount(page.locator('.position-card small'), 0, 'landing legacy numbered position badges');
      await expectLocatorCountAtLeast(page.locator('.deploy-card .deploy-icon svg'), 3, 'landing deploy SVG icons');
      await expectLocatorCountAtLeast(page.locator('.brand img.brand-mark[src="/colipas-icon.svg"]'), 1, 'landing brand icon image');
      await expectLocatorCount(page.locator('.brand .brand-mark').filter({ hasText: /^CP$/ }), 0, 'landing legacy CP brand mark');
      await assertSensitiveTextAbsent(page, 'landing');
    },
  };
}

function buildDocsCheck() {
  return {
    name: 'docs',
    path: '/docs.html',
    assert: async (page) => {
      await expectTitle(page, /CoLiPas/);
      await expectText(page.locator('h1').first(), /下载、配置、运行|Linux|Docker|CoLiPas云服务器管理面板/i, 'docs h1');
      await expectLocatorCountAtLeast(page.locator('h2'), 6, 'docs h2 sections');
      await expectLink(page, /GitHub/i, 'https://github.com/nmklio/CoLiPas');
      await expectLink(page, /进入后台|立即体验|Admin|后台/i, '/admin/');
      await expectText(page.locator('body'), /Docker|systemd|SSH|AI|安全|SQLite/i, 'docs body');
      await assertSensitiveTextAbsent(page, 'docs');
    },
  };
}

function buildAdminCheck() {
  return {
    name: 'admin',
    path: '/admin/',
    assert: async (page) => {
      await expectTitle(page, /CoLiPas/);
      await page.locator('input[autocomplete="username"]').waitFor({ timeout: 15000 });
      await page.locator('input[autocomplete="current-password"]').waitFor({ timeout: 15000 });
      await expectText(page.locator('h1').first(), /CoLiPas|控制台|console|多云|安全/i, 'admin login h1');
      await expectLink(page, /^GitHub$/i, 'https://github.com/nmklio/CoLiPas');
      const usernameValue = await page.locator('input[autocomplete="username"]').inputValue();
      if (usernameValue.trim()) {
        throw new Error('admin login must not prefill the username');
      }
      await assertSensitiveTextAbsent(page, 'admin login');
    },
  };
}

async function expectTitle(page, pattern) {
  const title = await page.title();
  if (!pattern.test(title)) {
    throw new Error(`page title "${title}" did not match ${pattern}`);
  }
}

async function expectTitleAbsent(page, pattern) {
  const title = await page.title();
  if (pattern.test(title)) {
    throw new Error(`page title "${title}" still matched legacy pattern ${pattern}`);
  }
}

async function expectText(locator, pattern, label) {
  await locator.waitFor({ timeout: 10000 });
  const text = (await locator.innerText({ timeout: 5000 })).trim();
  if (!pattern.test(text)) {
    throw new Error(`${label} text "${text.slice(0, 160)}" did not match ${pattern}`);
  }
}

async function expectTextAbsent(page, pattern, label) {
  const text = await page.locator('body').innerText({ timeout: 10000 });
  if (pattern.test(text)) {
    throw new Error(`${label} still rendered`);
  }
}

async function expectLink(page, namePattern, hrefFragment) {
  const link = page.getByRole('link', { name: namePattern }).first();
  await link.waitFor({ timeout: 10000 });
  const href = await link.getAttribute('href');
  if (!href || !href.includes(hrefFragment)) {
    throw new Error(`link ${namePattern} href "${href}" did not include ${hrefFragment}`);
  }
}

async function expectLocatorCountAtLeast(locator, minimum, label) {
  const count = await locator.count();
  if (count < minimum) {
    throw new Error(`${label} expected at least ${minimum}, got ${count}`);
  }
}

async function expectLocatorCount(locator, expected, label) {
  const count = await locator.count();
  if (count !== expected) {
    throw new Error(`${label} expected ${expected}, got ${count}`);
  }
}

async function assertSensitiveTextAbsent(page, label) {
  const text = await page.locator('body').innerText({ timeout: 10000 });
  const redFlags = [
    /\bsk-[A-Za-z0-9_-]{12,}\b/,
    /BEGIN (?:OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY/,
    /Ymz\d{6,}/i,
  ];
  const matches = redFlags.filter((pattern) => pattern.test(text));
  if (matches.length > 0) {
    throw new Error(`${label} rendered sensitive-looking text`);
  }
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  if (metrics.scrollWidth > metrics.viewportWidth + 1) {
    throw new Error(`${label} has horizontal document overflow: ${metrics.scrollWidth}px > ${metrics.viewportWidth}px`);
  }
}

async function assertNoBadBoxes(page, pageName, viewportName) {
  const badBoxes = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const selector = [
      'a',
      'button',
      'input',
      'select',
      'h1',
      'h2',
      '.nav',
      '.marketing-nav',
      '.docs-hero',
      '.docs-section',
      '.docs-quick-card',
      '.login-card',
      '.login-panel',
      '.quick-card',
      '.doc-card',
      '.terminal-card',
    ].join(',');
    return Array.from(document.querySelectorAll(selector))
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === 'string' ? element.className : '',
          text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      })
      .filter((box) => {
        const isVisible = box.width > 0 && box.height > 0 && box.y < viewportHeight + 200;
        const horizontallyOutside = box.x < -2 || box.x + box.width > viewportWidth + 2;
        const clippedText = box.clientWidth > 0 && box.scrollWidth > box.clientWidth + 2 && !['pre', 'code'].includes(box.tag);
        return isVisible && (horizontallyOutside || clippedText);
      });
  });

  if (badBoxes.length > 0) {
    throw new Error(`${pageName} ${viewportName} has overflowing elements: ${JSON.stringify(badBoxes.slice(0, 6))}`);
  }
}

async function captureVisualEvidence(page, name) {
  const filePath = path.join(evidenceDir, `${name}.png`);
  const buffer = await page.screenshot({ path: filePath, fullPage: true });
  if (buffer.length < 12000) {
    throw new Error(`public page screenshot ${name} looks too small or blank: ${buffer.length} bytes`);
  }
  const uniqueByteCount = new Set(buffer).size;
  if (uniqueByteCount < 24) {
    throw new Error(`public page screenshot ${name} has too little pixel entropy: ${uniqueByteCount} unique bytes`);
  }
}

function normalizeBaseUrl(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function isLocalhost(value) {
  const url = new URL(value);
  return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
}

function isIgnorableResource(value) {
  try {
    const url = new URL(value);
    return url.pathname === '/favicon.ico'
      || (url.hostname === 'static.cloudflareinsights.com' && url.pathname.includes('/beacon.min.js'));
  } catch {
    return false;
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
