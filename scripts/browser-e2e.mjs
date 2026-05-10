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
let temporaryServerId = '';

await page.addInitScript(() => {
  window.localStorage.setItem('colipas.language', 'en');
});

page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    consoleProblems.push(`${message.type()}: ${message.text()}`);
  }
});
page.on('pageerror', (error) => {
  consoleProblems.push(`pageerror: ${error.message}`);
});

try {
  await openAndLogin(page, `${baseUrl}/admin/#security?trace=${encodeURIComponent(traceId)}`);
  await assertSyntheticTraceDeepLink(page, traceId);

  console.log('ok browser e2e preserves security trace deep link after login');

  const temporaryServer = await createTemporaryAssetServer(page);
  temporaryServerId = temporaryServer.id;
  await assertOperationsResultTraceRoundTrip(page);
  await deleteTemporaryAssetServer(page, temporaryServer.id);
  temporaryServerId = '';

  if (consoleProblems.length > 0) {
    throw new Error(`Browser console had problems:\n${consoleProblems.join('\n')}`);
  }
} finally {
  if (temporaryServerId) {
    await deleteTemporaryAssetServer(page, temporaryServerId).catch(() => undefined);
  }
  await browser.close();
}

async function openAndLogin(targetPage, url) {
  await targetPage.goto(url, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  await targetPage.locator('input[autocomplete="username"]').fill(username);
  await targetPage.locator('input[autocomplete="current-password"]').fill(password);
  await targetPage.getByRole('button', { name: /sign in/i }).click();
}

async function assertSyntheticTraceDeepLink(targetPage, expectedTraceId) {
  await targetPage.waitForURL(/#security\?trace=srv-trace-00000000-0000-4000-8000-000000000000$/, { timeout: 15000 });
  await targetPage.locator('.security-trace-filter-banner').waitFor({ timeout: 15000 });
  await targetPage.getByRole('button', { name: /copy trace link/i }).waitFor({ timeout: 5000 });
  await targetPage.getByRole('button', { name: /clear trace/i }).waitFor({ timeout: 5000 });

  const currentUrl = targetPage.url();
  if (!currentUrl.includes(`#security?trace=${expectedTraceId}`)) {
    throw new Error(`Security trace route was not preserved after login: ${currentUrl}`);
  }

  const auditRows = await targetPage.locator('.security-audit-row').count();
  if (auditRows !== 0) {
    throw new Error(`Synthetic trace should filter to zero audit rows, got ${auditRows}`);
  }
}

async function createTemporaryAssetServer(targetPage) {
  const response = await targetPage.request.post(`${baseUrl}/api/servers`, {
    data: {
      name: `browser-e2e-asset-${Date.now()}`,
      provider: 'OpenStack Lab',
      region: 'US - Los Angeles',
      publicIp: `198.51.100.${Math.floor(Math.random() * 100) + 10}`,
      privateIp: '10.66.0.10',
      os: 'Ubuntu 24.04 LTS',
      tags: ['browser-e2e', 'audit-trace'],
      ssh: {
        port: 22,
        username: 'root',
        authType: 'password',
        verifyMode: 'assetOnly',
      },
    },
  });

  if (response.status() !== 201) {
    throw new Error(`/api/servers browser e2e setup returned HTTP ${response.status()}: ${await response.text()}`);
  }

  const server = await response.json();
  if (!server.id || server.status !== 'unconnected') {
    throw new Error('/api/servers browser e2e setup returned unexpected asset server payload');
  }

  return server;
}

async function deleteTemporaryAssetServer(targetPage, serverId) {
  const response = await targetPage.request.delete(`${baseUrl}/api/servers/${encodeURIComponent(serverId)}`);
  if (!response.ok()) {
    throw new Error(`/api/servers/${serverId} browser e2e cleanup returned HTTP ${response.status()}`);
  }
}

async function assertOperationsResultTraceRoundTrip(targetPage) {
  await targetPage.getByRole('button', { name: /^Operations$/i }).click();
  await targetPage.waitForURL(/#operations$/, { timeout: 10000 });
  await targetPage.getByRole('button', { name: /new task/i }).click();
  await targetPage.locator('.ops-builder').waitFor({ timeout: 10000 });
  await targetPage.getByRole('button', { name: /asset sweep/i }).click();
  await targetPage.locator('.ops-type-card.active').filter({ hasText: /asset sweep/i }).waitFor({ timeout: 5000 });
  await targetPage.locator('.ops-form-grid select').selectOption('allServers');

  targetPage.once('dialog', (dialog) => dialog.accept());
  await targetPage.getByRole('button', { name: /run orchestration/i }).click();

  const traceButton = targetPage.locator('.ops-result-panel .inline-trace-button').last();
  await traceButton.waitFor({ timeout: 20000 });
  await traceButton.click();

  await targetPage.waitForURL(/#security\?trace=ops-trace-[a-f0-9-]{36}$/, { timeout: 10000 });
  const traceIdFromUrl = new URL(targetPage.url()).hash.match(/^#security\?trace=(ops-trace-[a-f0-9-]{36})$/)?.[1] ?? '';
  if (!traceIdFromUrl) {
    throw new Error(`Operations trace route was not written to URL: ${targetPage.url()}`);
  }

  await targetPage.locator('.security-trace-filter-banner').waitFor({ timeout: 15000 });
  await targetPage.getByRole('button', { name: /copy trace link/i }).waitFor({ timeout: 5000 });
  const matchingAuditRows = await waitForAuditEvents(targetPage, traceIdFromUrl);
  if (matchingAuditRows.length < 2) {
    throw new Error(`Operations trace should have preflight and execution audit records, got ${matchingAuditRows.length}`);
  }
  await targetPage.waitForFunction(
    (expectedTraceId) => document.querySelectorAll('.security-audit-row').length >= 2
      && window.location.hash === `#security?trace=${expectedTraceId}`,
    traceIdFromUrl,
    { timeout: 10000 },
  );
  const linkedAuditRows = await targetPage.locator('.security-audit-row').count();
  if (linkedAuditRows < 2) {
    throw new Error(`Operations trace should show preflight and execution audits, got ${linkedAuditRows}`);
  }

  await targetPage.reload({ waitUntil: 'networkidle' });
  await targetPage.waitForURL(new RegExp(`#security\\?trace=${traceIdFromUrl}$`), { timeout: 10000 });
  await targetPage.locator('.security-trace-filter-banner').waitFor({ timeout: 15000 });
  await waitForAuditEvents(targetPage, traceIdFromUrl);
  await targetPage.waitForFunction(
    (expectedTraceId) => document.querySelectorAll('.security-audit-row').length >= 2
      && window.location.hash === `#security?trace=${expectedTraceId}`,
    traceIdFromUrl,
    { timeout: 10000 },
  );
  const linkedAuditRowsAfterReload = await targetPage.locator('.security-audit-row').count();
  if (linkedAuditRowsAfterReload < 2) {
    throw new Error(`Operations trace should survive reload with linked audits, got ${linkedAuditRowsAfterReload}`);
  }

  console.log('ok browser e2e links operations result to security trace and preserves reload state');
}

async function waitForAuditEvents(targetPage, expectedTraceId) {
  const startedAt = Date.now();
  let lastCount = 0;
  while (Date.now() - startedAt < 10000) {
    const response = await targetPage.request.get(`${baseUrl}/api/audit/events`);
    if (!response.ok()) {
      throw new Error(`/api/audit/events browser e2e returned HTTP ${response.status()}`);
    }
    const body = await response.json();
    const matches = Array.isArray(body.items)
      ? body.items.filter((item) => item.correlationId === expectedTraceId)
      : [];
    lastCount = matches.length;
    if (matches.length >= 2) {
      return matches;
    }
    await targetPage.waitForTimeout(350);
  }

  throw new Error(`Timed out waiting for audit records with ${expectedTraceId}, last count ${lastCount}`);
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
