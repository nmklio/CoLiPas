import { chromium } from 'playwright';
import fs from 'node:fs';

const baseUrl = process.env.E2E_BASE_URL ?? process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:18080';
const username = process.env.E2E_ADMIN_USERNAME ?? process.env.SMOKE_ADMIN_USERNAME ?? 'admin';
const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.SMOKE_ADMIN_PASSWORD ?? 'admin123456';
const traceId = process.env.E2E_TRACE_ID ?? 'srv-trace-00000000-0000-4000-8000-000000000000';
const executablePath = process.env.E2E_BROWSER_PATH || findSystemBrowser();

if (!executablePath) {
  throw new Error('Browser E2E requires Chromium, Chrome, or Edge. Set E2E_BROWSER_PATH or install a supported browser.');
}

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
const consoleProblems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    consoleProblems.push(`${message.type()}: ${message.text()}`);
  }
});
page.on('pageerror', (error) => {
  consoleProblems.push(`pageerror: ${error.message}`);
});

try {
  await page.goto(`${baseUrl}/admin/#security?trace=${encodeURIComponent(traceId)}`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  await page.getByPlaceholder(/账号|username|管理者アカウント/i).fill(username);
  await page.getByPlaceholder(/密码|password|パスワード/i).fill(password);
  await page.getByRole('button', { name: /登录|sign in|ログイン/i }).click();

  await page.waitForURL(/#security\?trace=srv-trace-00000000-0000-4000-8000-000000000000$/, { timeout: 15000 });
  await page.getByText(/正在查看 trace|Viewing trace|trace .*表示中/i).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /复制链路链接|Copy trace link|trace リンクをコピー/i }).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: /清除链路筛选|Clear trace|trace を解除/i }).waitFor({ timeout: 5000 });

  const currentUrl = page.url();
  if (!currentUrl.includes(`#security?trace=${traceId}`)) {
    throw new Error(`Security trace route was not preserved after login: ${currentUrl}`);
  }

  const auditRows = await page.locator('.security-audit-row').count();
  if (auditRows !== 0) {
    throw new Error(`Synthetic trace should filter to zero audit rows, got ${auditRows}`);
  }

  if (consoleProblems.length > 0) {
    throw new Error(`Browser console had problems:\n${consoleProblems.join('\n')}`);
  }

  console.log('ok browser e2e preserves security trace deep link after login');
} finally {
  await browser.close();
}

function findSystemBrowser() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? '';
}
