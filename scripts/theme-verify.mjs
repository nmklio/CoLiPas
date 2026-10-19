import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const baseUrl = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:18099';
const username = process.env.E2E_ADMIN_USERNAME ?? 'admin';
const password = process.env.E2E_ADMIN_PASSWORD ?? 'admin123456';
const browserPath =
  process.env.E2E_BROWSER_PATH
  ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ?? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((candidate) => fs.existsSync(candidate))
  ?? undefined;
const outDir = path.resolve('.tmp-theme');
fs.mkdirSync(outDir, { recursive: true });

const report = {};
const browser = await chromium.launch(browserPath ? { executablePath: browserPath, headless: true } : { headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

await page.goto(`${baseUrl}/admin/#overview`, { waitUntil: 'networkidle', timeout: 40000 });
await page.locator('input[autocomplete="username"]').fill(username);
await page.locator('input[autocomplete="current-password"]').fill(password);
await page.locator('button[type="submit"]').click();
await page.locator('.topbar').waitFor({ timeout: 20000 });

async function sample(label) {
  return page.evaluate(() => {
    const read = (selector, property) => {
      const element = selector === ':root' ? document.documentElement : document.querySelector(selector);
      return element ? getComputedStyle(element)[property] : null;
    };
    return {
      dataTheme: document.documentElement.getAttribute('data-theme'),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      bodyBg: read('body', 'backgroundColor'),
      bodyColor: read('body', 'color'),
      shellBg: read('.shell', 'backgroundColor'),
      sidebarBg: read('.sidebar', 'backgroundImage') || read('.sidebar', 'backgroundColor'),
      topbarBg: read('.topbar', 'backgroundColor'),
      stored: window.localStorage.getItem('colipas.theme'),
      toggleIcon: document.querySelector('[data-theme-toggle] b')?.textContent ?? null,
      prePaintTheme: window.__themeAtScriptStart ?? null,
      // The workspace keeps the audited light surface in both themes, so these
      // values must be identical: a difference means the island drifted.
      mainBg: read('main', 'backgroundColor'),
      mainColorScheme: read('main', 'colorScheme'),
      mainTokens: ['--bg', '--panel', '--text', '--muted', '--border', '--brand'].map((token) => [
        token,
        document.querySelector('main') ? getComputedStyle(document.querySelector('main')).getPropertyValue(token).trim() : null,
      ]),
    };
  });
}

// --- light (default follows the OS, and the harness reports light) ----------
report.light = await sample('light');
await page.screenshot({ path: path.join(outDir, 'shell-light.png'), fullPage: false });

// --- switch to dark via the topbar toggle ----------------------------------
await page.locator('[data-theme-toggle]').click();
await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', null, {
  timeout: 5000,
});
await page.waitForTimeout(350);
report.dark = await sample('dark');
await page.screenshot({ path: path.join(outDir, 'shell-dark.png'), fullPage: false });

// --- persistence across reload --------------------------------------------
await page.reload({ waitUntil: 'networkidle' });
await page.locator('.topbar').waitFor({ timeout: 20000 });
report.afterReload = await sample('afterReload');

// --- no flash: the theme must already be applied when the document is ready -
await page.reload({ waitUntil: 'domcontentloaded' });
report.atDomContentLoaded = await page.evaluate(() => ({
  dataTheme: document.documentElement.getAttribute('data-theme'),
  bodyBg: getComputedStyle(document.body).backgroundColor,
}));
await page.locator('.topbar').waitFor({ timeout: 20000 });

// --- cross-tab sync --------------------------------------------------------
const secondPage = await context.newPage();
await secondPage.goto(`${baseUrl}/admin/#overview`, { waitUntil: 'networkidle', timeout: 40000 });
await secondPage.locator('.topbar').waitFor({ timeout: 20000 });
report.secondTabBefore = await secondPage.evaluate(() => document.documentElement.getAttribute('data-theme'));

await page.locator('[data-theme-toggle]').click();
await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', null, {
  timeout: 5000,
});
await secondPage.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', null, {
  timeout: 5000,
}).catch(() => {});
report.secondTabAfter = await secondPage.evaluate(() => document.documentElement.getAttribute('data-theme'));

// --- system preference: dark OS, never chosen explicitly -------------------
const osDarkContext = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1280, height: 800 } });
const osDarkPage = await osDarkContext.newPage();
await osDarkPage.goto(`${baseUrl}/admin/#overview`, { waitUntil: 'networkidle', timeout: 40000 });
await osDarkPage.locator('input[autocomplete="username"]').fill(username);
await osDarkPage.locator('input[autocomplete="current-password"]').fill(password);
await osDarkPage.locator('button[type="submit"]').click();
await osDarkPage.locator('.topbar').waitFor({ timeout: 20000 });
report.osDarkFirstVisit = await osDarkPage.evaluate(() => ({
  dataTheme: document.documentElement.getAttribute('data-theme'),
  stored: window.localStorage.getItem('colipas.theme'),
  bodyBg: getComputedStyle(document.body).backgroundColor,
}));
await osDarkPage.screenshot({ path: path.join(outDir, 'shell-osdark.png'), fullPage: false });

await browser.close();

console.log(JSON.stringify(report, null, 2));

const failures = [];
const expect = (condition, message) => {
  if (!condition) {
    failures.push(message);
  }
};
expect(report.light.dataTheme === 'light', `expected light default, got ${report.light.dataTheme}`);
expect(report.dark.dataTheme === 'dark', `toggle did not reach dark (${report.dark.dataTheme})`);
expect(report.dark.bodyBg !== report.light.bodyBg, 'body background did not change with the theme');
expect(report.dark.topbarBg !== report.light.topbarBg, 'topbar surface did not change with the theme');
expect(
  report.dark.mainBg !== report.dark.bodyBg,
  `workspace island must paint its own surface instead of inheriting the dark canvas (${report.dark.mainBg})`,
);
expect(
  report.dark.mainColorScheme === 'light',
  `workspace island must declare color-scheme: light, got ${report.dark.mainColorScheme}`,
);
expect(
  JSON.stringify(report.dark.mainTokens) === JSON.stringify(report.light.mainTokens),
  `workspace island tokens drifted between themes: ${JSON.stringify(report.light.mainTokens)} vs ${JSON.stringify(report.dark.mainTokens)}`,
);
expect(report.dark.stored === 'dark', `localStorage did not persist dark (${report.dark.stored})`);
expect(report.afterReload.dataTheme === 'dark', 'theme did not survive a reload');
expect(
  report.atDomContentLoaded.dataTheme === 'dark',
  `theme was applied late (data-theme=${report.atDomContentLoaded.dataTheme} at domcontentloaded), which causes a flash`,
);
expect(report.secondTabAfter === 'light', `cross-tab sync failed (${report.secondTabAfter})`);
expect(report.osDarkFirstVisit.dataTheme === 'dark', 'a dark OS preference on first visit should resolve to dark');
expect(report.osDarkFirstVisit.stored === null, 'first visit must not fabricate an explicit preference');

if (failures.length > 0) {
  console.error('theme verification failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}
console.log('theme verification ok; screenshots in .tmp-theme/');
