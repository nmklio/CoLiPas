import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const baseUrl = process.env.E2E_BASE_URL ?? process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:18080';
const username = process.env.E2E_ADMIN_USERNAME ?? process.env.SMOKE_ADMIN_USERNAME ?? 'admin';
const password = process.env.E2E_ADMIN_PASSWORD ?? process.env.SMOKE_ADMIN_PASSWORD ?? 'admin123456';
const traceId = process.env.E2E_TRACE_ID ?? 'srv-trace-00000000-0000-4000-8000-000000000000';
const executablePath = process.env.E2E_BROWSER_PATH || findSystemBrowser();
const evidenceDir = path.resolve('output', 'browser-e2e');

fs.rmSync(evidenceDir, { recursive: true, force: true });
fs.mkdirSync(evidenceDir, { recursive: true });

const browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { headless: true });
const consoleProblems = [];
const page = await createE2ePage({ viewport: { width: 1440, height: 980 } });
let temporaryServerId = '';

try {
  await openAndLogin(page, `${baseUrl}/admin/#security?trace=${encodeURIComponent(traceId)}`);
  await assertSyntheticTraceDeepLink(page, traceId);

  console.log('ok browser e2e preserves security trace deep link after login');

  await assertCommandPalette(page);
  await assertAccountSettingsAndAiChat(page);

  const temporaryServer = await createTemporaryAssetServer(page);
  temporaryServerId = temporaryServer.id;
  await assertSshTerminalPanel(page);
  await assertOperationsResultTraceRoundTrip(page);
  await deleteTemporaryAssetServer(page, temporaryServer.id);
  temporaryServerId = '';

  await assertReleaseEvidenceBrief(page);
  await captureVisualEvidence(page, 'desktop-security-trace', ['.security-workbench', '.security-readiness-card', '.security-evidence-brief', '.security-release-playbook', '.security-ssh-performance-card']);
  await assertMobileConsoleAndMap();
  await assertMobileModuleLayoutSweep();

  if (consoleProblems.length > 0) {
    throw new Error(`Browser console had problems:\n${consoleProblems.join('\n')}`);
  }
} finally {
  if (temporaryServerId) {
    await deleteTemporaryAssetServer(page, temporaryServerId).catch(() => undefined);
  }
  await browser.close();
}

async function createE2ePage(options) {
  const targetPage = await browser.newPage(options);
  await targetPage.addInitScript(() => {
    window.localStorage.setItem('colipas.language', 'en');
    window.localStorage.removeItem('colipas.aiConsoleState');
    window.localStorage.removeItem('colipas.aiResponseCache');
  });
  targetPage.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      if (isExpectedBrowserConsoleNoise(message.text())) {
        return;
      }
      consoleProblems.push(`${message.type()}: ${message.text()}`);
    }
  });
  targetPage.on('pageerror', (error) => {
    consoleProblems.push(`pageerror: ${error.message}`);
  });
  return targetPage;
}

function isExpectedBrowserConsoleNoise(text) {
  return /WebSocket connection to .+\/api\/servers\/shells\/ws.+WebSocket is closed before the connection is established/i.test(text);
}

async function openAndLogin(targetPage, url) {
  await targetPage.goto(url, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  await assertLoginGitHubLink(targetPage);
  await targetPage.locator('input[autocomplete="username"]').fill(username);
  await targetPage.locator('input[autocomplete="current-password"]').fill(password);
  await targetPage.getByRole('button', { name: /sign in/i }).click();
  await targetPage.locator('.topbar').waitFor({ timeout: 15000 });
}

async function assertLoginGitHubLink(targetPage) {
  const link = targetPage.getByRole('link', { name: /^GitHub$/i });
  await link.waitFor({ timeout: 5000 });
  const href = await link.getAttribute('href');
  if (href !== 'https://github.com/nmklio/CoLiPas') {
    throw new Error(`Login GitHub link points to ${href}`);
  }

  const [linkBox, headerBox, copyBox] = await Promise.all([
    link.boundingBox(),
    targetPage.locator('.login-panel-header').boundingBox(),
    targetPage.locator('.login-copy').boundingBox(),
  ]);
  if (!linkBox || !headerBox || !copyBox) {
    throw new Error('Login GitHub link layout boxes were unavailable');
  }
  if (linkBox.y >= copyBox.y || linkBox.y + linkBox.height > headerBox.y + headerBox.height + 3) {
    throw new Error('Login GitHub link should stay in the brand header, above the login hero copy');
  }
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

async function assertReleaseEvidenceBrief(targetPage) {
  await targetPage.locator('.security-evidence-brief').waitFor({ timeout: 10000 });
  await targetPage.locator('.security-release-playbook').waitFor({ timeout: 10000 });
  await targetPage.locator('.security-ssh-performance-card').waitFor({ timeout: 10000 });
  await targetPage.getByRole('button', { name: /copy evidence brief/i }).waitFor({ timeout: 5000 });
  const metricCount = await targetPage.locator('.security-evidence-metric').count();
  if (metricCount !== 4) {
    throw new Error(`Release evidence brief should expose four aggregate metrics, got ${metricCount}`);
  }
  const playbookCount = await targetPage.locator('.security-release-playbook-item').count();
  if (playbookCount !== 3) {
    throw new Error(`Release failure playbook should expose three diagnostic cards, got ${playbookCount}`);
  }
  const sshPerfMetricCount = await targetPage.locator('.security-ssh-performance-metric').count();
  if (sshPerfMetricCount !== 9) {
    throw new Error(`SSH performance card should expose nine aggregate metrics, got ${sshPerfMetricCount}`);
  }
  const sshPerfGroupCount = await targetPage.locator('.security-ssh-performance-group').count();
  if (sshPerfGroupCount !== 3) {
    throw new Error(`SSH performance card should expose three grouped sections, got ${sshPerfGroupCount}`);
  }
  const sshPerfSelectedCount = await targetPage.locator('.security-ssh-performance-metric[aria-pressed="true"]').count();
  if (sshPerfSelectedCount !== 1) {
    throw new Error(`SSH performance card should keep exactly one selected metric for detail review, got ${sshPerfSelectedCount}`);
  }
  await targetPage.locator('[data-ssh-performance-detail="true"]').waitFor({ timeout: 5000 });
  await targetPage.getByRole('button', { name: /likely bottleneck/i }).click();
  const sshPerfDetailText = await targetPage.locator('[data-ssh-performance-detail="true"]').innerText();
  if (!/full metric detail/i.test(sshPerfDetailText) || !/likely bottleneck/i.test(sshPerfDetailText)) {
    throw new Error(`SSH performance detail panel did not switch to the selected metric: ${sshPerfDetailText}`);
  }
  const sshPerfText = await targetPage.locator('.security-ssh-performance-card').innerText();
  if (!/full metric detail/i.test(sshPerfText) || !/track/i.test(sshPerfText) || !/latency/i.test(sshPerfText) || !/audit/i.test(sshPerfText) || !/input batching/i.test(sshPerfText) || !/socket errors/i.test(sshPerfText) || !/last safe test/i.test(sshPerfText) || !/response split/i.test(sshPerfText) || !/safe test trend/i.test(sshPerfText) || !/likely bottleneck/i.test(sshPerfText) || !/session replay/i.test(sshPerfText)) {
    throw new Error(`SSH performance card did not render batching/error evidence: ${sshPerfText}`);
  }
  await targetPage.locator('[data-ssh-lag-report="true"]').waitFor({ timeout: 5000 });
  const sshLagReportText = await targetPage.locator('[data-ssh-lag-report="true"]').innerText();
  if (!/SSH lag diagnosis report/i.test(sshLagReportText) || !/generated/i.test(sshLagReportText) || !/sanitized/i.test(sshLagReportText) || !/input path/i.test(sshLagReportText) || !/output path/i.test(sshLagReportText) || !/latency call/i.test(sshLagReportText)) {
    throw new Error(`SSH lag diagnosis report did not render key findings: ${sshLagReportText}`);
  }
  const sshLagContextCount = await targetPage.locator('.security-ssh-lag-report-context small').count();
  if (sshLagContextCount !== 3) {
    throw new Error(`SSH lag diagnosis report should expose three context badges, got ${sshLagContextCount}`);
  }
  await targetPage.evaluate(() => {
    window.__colipasCopiedSshPerformanceText = '';
    window.__colipasCopiedSshLagReportText = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          if (/SSH lag diagnosis report/i.test(text)) {
            window.__colipasCopiedSshLagReportText = text;
          } else {
            window.__colipasCopiedSshPerformanceText = text;
          }
        },
      },
    });
  });
  await targetPage.getByRole('button', { name: /copy diagnosis report/i }).click();
  const copiedSshLagReportText = await targetPage.evaluate(() => window.__colipasCopiedSshLagReportText ?? '');
  if (!/SSH lag diagnosis report/i.test(copiedSshLagReportText) || !/Report context/i.test(copiedSshLagReportText) || !/Generated/i.test(copiedSshLagReportText) || !/Sanitized/i.test(copiedSshLagReportText) || !/Key evidence/i.test(copiedSshLagReportText) || !/Input path/i.test(copiedSshLagReportText) || !/sanitized aggregate metrics/i.test(copiedSshLagReportText)) {
    throw new Error(`SSH lag diagnosis copy output is incomplete: ${copiedSshLagReportText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedSshLagReportText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedSshLagReportText)) {
    throw new Error('SSH lag diagnosis copy output leaked a raw IP address or API key');
  }
  await targetPage.getByRole('button', { name: /copy summary|复制摘要|サマリーをコピー/i }).click();
  const copiedSshPerfText = await targetPage.evaluate(() => window.__colipasCopiedSshPerformanceText ?? '');
  if (!/SSH terminal performance|Input batching/i.test(copiedSshPerfText) || !/\[Track\]/i.test(copiedSshPerfText) || !/\[Latency\]/i.test(copiedSshPerfText) || !/\[Audit\]/i.test(copiedSshPerfText) || !/Socket errors/i.test(copiedSshPerfText) || !/Last safe test/i.test(copiedSshPerfText) || !/Response split/i.test(copiedSshPerfText) || !/Safe test trend/i.test(copiedSshPerfText) || !/Likely bottleneck/i.test(copiedSshPerfText) || !/Session replay/i.test(copiedSshPerfText)) {
    throw new Error(`SSH performance copy output is incomplete: ${copiedSshPerfText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedSshPerfText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedSshPerfText)) {
    throw new Error('SSH performance copy output leaked a raw IP address or API key');
  }
  const text = `${await targetPage.locator('.security-evidence-brief').innerText()}\n${await targetPage.locator('.security-release-playbook').innerText()}\n${sshPerfText}`;
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(text)) {
    throw new Error('Release evidence, failure playbook, or SSH performance card rendered a raw IP address or API key');
  }
  await assertElementHorizontallyWithinViewport(targetPage, '.security-evidence-brief', 'desktop release evidence brief');
  await assertElementHorizontallyWithinViewport(targetPage, '.security-release-playbook', 'desktop release failure playbook');
  await assertElementHorizontallyWithinViewport(targetPage, '.security-ssh-performance-card', 'desktop SSH performance card');
}

async function assertCommandPalette(targetPage) {
  await targetPage.keyboard.press('Control+K');
  await targetPage.getByRole('dialog', { name: /open command palette/i }).waitFor({ timeout: 5000 });
  await targetPage.getByLabel(/search modules, tools, or actions/i).fill('servers');
  await targetPage.keyboard.press('Enter');
  await targetPage.waitForURL(/#servers$/, { timeout: 10000 });
  await targetPage.locator('.command-palette').waitFor({ state: 'hidden', timeout: 5000 });
  await targetPage.locator('.module-section').filter({ hasText: /server/i }).first().waitFor({ timeout: 10000 });

  await targetPage.getByRole('button', { name: /open command palette/i }).click();
  await targetPage.getByRole('dialog', { name: /open command palette/i }).waitFor({ timeout: 5000 });
  await targetPage.getByLabel(/search modules, tools, or actions/i).fill('account');
  await targetPage.getByRole('option', { name: /account and appearance/i }).click();
  await targetPage.locator('.account-modal').waitFor({ timeout: 5000 });
  await targetPage.locator('.account-modal .icon-button').first().click();
  await targetPage.locator('.account-modal').waitFor({ state: 'hidden', timeout: 5000 });

  console.log('ok browser e2e covers command palette keyboard and mouse actions');
}

async function assertAccountSettingsAndAiChat(targetPage) {
  const profileName = `Ops E2E ${Date.now().toString().slice(-5)}`;
  let aiSshServerId = '';
  await targetPage.locator('.account-settings-trigger').click();
  await targetPage.locator('.account-modal').waitFor({ timeout: 5000 });
  if (await targetPage.getByLabel(/avatar text|fallback text|备用文字|代替文字/i).count()) {
    throw new Error('Account appearance modal must not expose fallback avatar text');
  }
  await targetPage.getByLabel(/display name/i).fill(profileName);
  await targetPage.getByRole('button', { name: /save avatar and name|save appearance/i }).click();
  await targetPage.getByText(/avatar and display name updated|appearance settings updated/i).waitFor({ timeout: 10000 });
  await targetPage.locator('.account-modal .icon-button').first().click();
  await targetPage.locator('.account-modal').waitFor({ state: 'hidden', timeout: 5000 });
  await targetPage.locator('.account-settings-trigger').filter({ hasText: username }).waitFor({ timeout: 5000 });
  await targetPage.locator('.brand').filter({ hasText: profileName }).waitFor({ timeout: 5000 });
  const accountTriggerMediaCount = await targetPage.locator('.account-settings-trigger svg, .account-settings-trigger img, .account-settings-trigger .brand-mark').count();
  if (accountTriggerMediaCount !== 0) {
    throw new Error(`Topbar account settings trigger must be text-only, found ${accountTriggerMediaCount} media nodes`);
  }

  try {
    const aiSshServer = await createTemporarySimulatedSshServer(targetPage, 'browser-e2e-ai-exec');
    aiSshServerId = aiSshServer.id;

    await targetPage.getByRole('button', { name: /^AI System$/i }).click();
    await targetPage.waitForURL(/#ai$/, { timeout: 10000 });
    await targetPage.getByRole('button', { name: /open ai chat/i }).click();
    await targetPage.locator('.ai-dock').waitFor({ timeout: 10000 });
    await targetPage.locator('#ai-server-select').selectOption(aiSshServer.id);
    await targetPage.getByRole('textbox', { name: /question/i }).fill('Run a safe SSH uptime check');
    await targetPage.getByRole('button', { name: /^send$/i }).click();
    await targetPage.locator('.ai-message.assistant.done .ai-message-content').first().waitFor({ timeout: 20000 });
    const firstAnswer = (await targetPage.locator('.ai-message.assistant .ai-message-content').last().textContent())?.trim() ?? '';
    if (firstAnswer.length < 20) {
      throw new Error(`AI chat should return a substantive local answer, got ${firstAnswer.length} chars`);
    }
    await targetPage.locator('.ai-execution-card').waitFor({ timeout: 10000 });
    await targetPage.locator('.ai-execution-command code').filter({ hasText: /hostname|uptime|df -h/i }).waitFor({ timeout: 10000 });

    await targetPage.getByRole('button', { name: /new ai chat/i }).click();
    await targetPage.locator('#ai-server-select').selectOption(aiSshServer.id);
    await targetPage.getByRole('textbox', { name: /question/i }).fill('Run a safe SSH uptime check');
    await targetPage.getByRole('button', { name: /^send$/i }).click();
    await targetPage.waitForFunction((expectedAnswer) => {
      const assistantCards = Array.from(document.querySelectorAll('.ai-message.assistant'));
      const lastAssistant = assistantCards[assistantCards.length - 1];
      if (!lastAssistant) {
        return false;
      }
      const content = lastAssistant.querySelector('.ai-message-content')?.textContent?.trim() ?? '';
      return content === expectedAnswer && lastAssistant.classList.contains('cached');
    }, firstAnswer, { timeout: 15000 });
    const cachedAnswer = (await targetPage.locator('.ai-message.assistant').last().locator('.ai-message-content').textContent())?.trim() ?? '';
    if (cachedAnswer !== firstAnswer) {
      throw new Error('AI cached answer should match the first local rule answer for the same prompt');
    }

    await targetPage.locator('.ai-execution-card').waitFor({ timeout: 10000 });
    await targetPage.getByRole('button', { name: /allow execution/i }).click();
    await targetPage.getByRole('button', { name: /^submit$/i }).click();
    await targetPage.locator('.ai-execution-result pre').first().waitFor({ timeout: 15000 });
    const executionText = await targetPage.locator('.ai-execution-result').innerText();
    if (!executionText.includes(aiSshServer.name) || !executionText.includes('simulated')) {
      throw new Error(`AI execution card did not run through simulated SSH: ${executionText}`);
    }
    await targetPage.locator('.ai-message.assistant .ai-message-content').filter({ hasText: 'Execution evidence:' }).waitFor({ timeout: 10000 });
    await targetPage.getByRole('textbox', { name: /question/i }).fill('What did the last SSH execution return?');
    await targetPage.getByRole('button', { name: /^send$/i }).click();
    await targetPage.locator('.ai-message.assistant.done .ai-message-content').filter({ hasText: /Available execution evidence|simulated/i }).last().waitFor({ timeout: 20000 });

    await targetPage.getByRole('button', { name: /new ai chat/i }).click();
    await targetPage.locator('#ai-server-select').selectOption(aiSshServer.id);
    await targetPage.getByRole('textbox', { name: /question/i }).fill('执行 ip addr');
    await targetPage.getByRole('button', { name: /^send$/i }).click();
    await targetPage.locator('.ai-message.assistant.done .ai-message-content').filter({ hasText: /guarded execution plan|受控|执行卡/i }).last().waitFor({ timeout: 20000 });
    await targetPage.locator('.ai-execution-card').waitFor({ timeout: 10000 });
    await targetPage.locator('.ai-execution-command code').filter({ hasText: /^ip addr$/ }).waitFor({ timeout: 10000 });

    await targetPage.getByRole('button', { name: /new ai chat/i }).click();
    await targetPage.locator('#ai-server-select').selectOption(aiSshServer.id);
    await targetPage.getByRole('textbox', { name: /question/i }).fill('帮我执行一下 apt install -y unzip');
    await targetPage.getByRole('button', { name: /^send$/i }).click();
    await targetPage.locator('.ai-message.assistant.done .ai-message-content').filter({ hasText: /guarded execution plan|受控|执行卡/i }).last().waitFor({ timeout: 20000 });
    await targetPage.locator('.ai-execution-card').waitFor({ timeout: 10000 });
    await targetPage.locator('.ai-execution-command code').filter({ hasText: /^apt install -y unzip$/ }).waitFor({ timeout: 10000 });
    await targetPage.locator('.ai-execution-tags .risk').filter({ hasText: /confirmation required/i }).waitFor({ timeout: 10000 });
    await targetPage.locator('.ai-execution-tags .risk').filter({ hasText: /high-impact SSH command/i }).waitFor({ timeout: 10000 });
    const highRiskCancelClass = await targetPage.locator('.ai-execution-card .ai-execution-choice.danger').getAttribute('class');
    if (!highRiskCancelClass?.includes('active')) {
      throw new Error(`AI high-impact execution card should default to cancel, got classes: ${highRiskCancelClass ?? 'none'}`);
    }

    await assertDesktopAiDockLayout(targetPage);

    console.log('ok browser e2e covers account profile save, AI executable SSH plan, cached chat, and AI dock layout');
  } finally {
    if (aiSshServerId) {
      await deleteTemporaryAssetServer(targetPage, aiSshServerId).catch(() => undefined);
    }
  }
}

async function createTemporaryAssetServer(targetPage, namePrefix = 'browser-e2e-asset') {
  const payload = {
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
  };
  const response = await postJsonWithTransientRetry(targetPage, `${baseUrl}/api/servers`, () => ({
    ...payload,
    name: `${namePrefix}-${Date.now()}`,
  }), 'browser e2e asset server setup');

  const server = await response.json();
  if (!server.id || server.status !== 'unconnected') {
    throw new Error('/api/servers browser e2e setup returned unexpected asset server payload');
  }

  return server;
}

async function postJsonWithTransientRetry(targetPage, url, buildData, label, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 1) {
        await waitForApiHealth(targetPage);
      }
      const response = await targetPage.request.post(url, {
        data: buildData(),
        timeout: 15000,
      });
      if (response.status() === 201) {
        return response;
      }
      throw new Error(`${label} returned HTTP ${response.status()}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isTransientApiRequestFailure(message) || attempt === maxAttempts) {
        throw error;
      }
      console.log(`retry ${label} after transient request failure (${attempt}/${maxAttempts}): ${message}`);
      await targetPage.waitForTimeout(300 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}

async function waitForApiHealth(targetPage) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await targetPage.request.get(`${baseUrl}/api/health`, { timeout: 5000 });
      if (response.ok()) {
        return;
      }
    } catch {
      // Retry; CI can briefly reset local sockets while Chromium is starting.
    }
    await targetPage.waitForTimeout(250 * attempt);
  }
}

function isTransientApiRequestFailure(message) {
  return /socket hang up|ECONNRESET|ECONNREFUSED|UND_ERR_SOCKET|Target page, context or browser has been closed/i.test(message);
}

async function createTemporarySimulatedSshServer(targetPage, namePrefix = 'browser-e2e-ssh') {
  const response = await postJsonWithTransientRetry(targetPage, `${baseUrl}/api/servers`, () => ({
    name: `${namePrefix}-${Date.now()}`,
    provider: 'OpenStack Lab',
    region: 'US - Los Angeles',
    publicIp: `203.0.113.${Math.floor(Math.random() * 100) + 10}`,
    privateIp: '10.77.0.10',
    os: 'Debian 12',
    tags: ['browser-e2e', 'ssh-panel'],
    ssh: {
      host: 'simulated-ssh.local',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'test-browser-e2e-value',
      verifyMode: 'simulate',
    },
  }), 'browser e2e simulated SSH setup');

  const server = await response.json();
  if (!server.id || server.ssh?.connected !== true || server.status !== 'running') {
    throw new Error('/api/servers simulated SSH setup returned unexpected connected server payload');
  }

  return server;
}

async function deleteTemporaryAssetServer(targetPage, serverId) {
  const response = await targetPage.request.delete(`${baseUrl}/api/servers/${encodeURIComponent(serverId)}`);
  if (!response.ok()) {
    throw new Error(`/api/servers/${serverId} browser e2e cleanup returned HTTP ${response.status()}`);
  }
}

async function assertSshTerminalPanel(targetPage) {
  const sshServer = await createTemporarySimulatedSshServer(targetPage);
  try {
    await targetPage.goto(`${baseUrl}/admin/#servers`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await targetPage.reload({ waitUntil: 'networkidle' });
    await targetPage.locator('.server-workspace-row').filter({ hasText: sshServer.name }).waitFor({ timeout: 10000 });

    await targetPage.locator('.server-workspace-row').filter({ hasText: sshServer.name }).getByRole('button', { name: /^SSH$/i }).click();
    await targetPage.locator('.ssh-console').waitFor({ timeout: 10000 });
    await targetPage.locator('.ssh-console-header .icon-button').click();
    await targetPage.locator('.ssh-console').waitFor({ state: 'hidden', timeout: 5000 });
    await targetPage.waitForFunction(() => {
      const messageText = Array.from(document.querySelectorAll('.action-message'))
        .map((element) => element.textContent ?? '')
        .join('\n');
      return !/live ssh terminal connected/i.test(messageText);
    }, undefined, { timeout: 2500 });

    await targetPage.locator('.server-workspace-row').filter({ hasText: sshServer.name }).getByRole('button', { name: /^SSH$/i }).click();
    await targetPage.locator('.ssh-console').waitFor({ timeout: 10000 });
    await targetPage.locator('.ssh-terminal-screen .xterm').waitFor({ timeout: 10000 });
    await targetPage.locator('.ssh-terminal-session-count').filter({ hasText: /sessions 1/i }).waitFor({ timeout: 10000 });
    await targetPage.locator('.ssh-terminal-network').filter({ hasText: /RTT/i }).waitFor({ timeout: 10000 });
    await targetPage.locator('.ssh-terminal-screen').click();
    await targetPage.keyboard.type('whoami', { delay: 10 });
    await targetPage.keyboard.press('Enter');
    await targetPage.waitForFunction(() => {
      const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
      return terminalText.includes('simulated$ whoami') && terminalText.includes('command simulated.');
    }, undefined, { timeout: 10000 });
    await targetPage.waitForFunction(() => document.querySelectorAll('.ssh-terminal-input-line').length === 0, undefined, { timeout: 5000 });

    const terminalState = await targetPage.evaluate(() => {
      const lineTexts = Array.from(document.querySelectorAll('.ssh-terminal-screen .xterm-rows > div')).map((element) => element.textContent ?? '');
      const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
      const trailingPromptCount = lineTexts.filter((text) => /^root@[\w.-]+:.+[#$]\s*$/.test(text.trim())).length;
      const helperTextarea = document.querySelector('.ssh-terminal-screen .xterm-helper-textarea');
      const helperStyle = helperTextarea ? window.getComputedStyle(helperTextarea) : null;
      const helperRect = helperTextarea?.getBoundingClientRect();
      const firstLine = lineTexts[0] ?? '';
      return {
        firstLine,
        lineTexts,
        terminalText,
        trailingPromptCount,
        hasCommandInput: Boolean(document.querySelector('.ssh-terminal-input-line input')),
        hasXtermTextarea: Boolean(document.querySelector('.ssh-terminal-screen .xterm-helper-textarea')),
        helperTextareaVisible: Boolean(
          helperStyle &&
          helperStyle.opacity !== '0' &&
          helperStyle.color !== 'rgba(0, 0, 0, 0)' &&
          helperRect &&
          helperRect.width > 1 &&
          helperRect.height > 1,
        ),
      };
    });

    if (!terminalState.terminalText.includes('simulated$ whoami') || !terminalState.terminalText.includes('command simulated.')) {
      throw new Error(`SSH terminal did not stream simulated interactive command output: ${terminalState.terminalText}`);
    }
    if (terminalState.hasCommandInput || !terminalState.hasXtermTextarea) {
      throw new Error('SSH terminal still uses a command input instead of xterm keyboard capture');
    }
    if (terminalState.helperTextareaVisible || /whoami{2,}|bbbb{4,}|[a-z]{18,}/i.test(terminalState.firstLine)) {
      throw new Error(`SSH terminal leaked keyboard buffer into the visible top row: ${terminalState.firstLine}`);
    }
    if (terminalState.trailingPromptCount > 0) {
      throw new Error(`SSH terminal rendered duplicate remote prompt history rows: ${terminalState.lineTexts.join(' | ')}`);
    }

    await targetPage.getByRole('button', { name: /disconnect/i }).waitFor({ timeout: 5000 });
    await targetPage.evaluate(() => {
      window.__colipasCopiedTerminalText = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__colipasCopiedTerminalText = text;
          },
        },
      });
    });
    await targetPage.getByRole('button', { name: /copy terminal output/i }).click();
    const copiedTerminalText = await targetPage.evaluate(() => window.__colipasCopiedTerminalText ?? '');
    if (!copiedTerminalText.includes('simulated$ whoami') || !copiedTerminalText.includes('command simulated.')) {
      throw new Error(`SSH terminal copy tool did not copy visible output: ${copiedTerminalText}`);
    }
    await targetPage.getByRole('button', { name: /clear terminal output/i }).click();
    await targetPage.waitForFunction(() => {
      const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
      return !terminalText.includes('simulated$ whoami') && !terminalText.includes('command simulated.');
    }, undefined, { timeout: 5000 });
    await targetPage.locator('.ssh-terminal-screen').click();
    await targetPage.keyboard.type('pwd', { delay: 10 });
    await targetPage.keyboard.press('Enter');
    await targetPage.waitForFunction(() => {
      const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
      return terminalText.includes('simulated$ pwd') && terminalText.includes('command simulated.');
    }, undefined, { timeout: 10000 });
    await targetPage.keyboard.type('colipas-hang', { delay: 10 });
    await targetPage.keyboard.press('Enter');
    await targetPage.waitForFunction(() => {
      const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
      return terminalText.includes('hanging until interrupt');
    }, undefined, { timeout: 10000 });
    const interruptMessage = targetPage.locator('.action-message').filter({ hasText: /sent ctrl\+c/i }).waitFor({ timeout: 7000 });
    await targetPage.getByRole('button', { name: /send ctrl\+c/i }).click();
    await targetPage.getByText(/sending interrupt/i).waitFor({ timeout: 5000 }).catch(() => undefined);
    await interruptMessage;
    await targetPage.waitForFunction(() => {
      const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
      return terminalText.includes('^C') && terminalText.includes('simulated$');
    }, undefined, { timeout: 5000 });
    await targetPage.keyboard.type('id', { delay: 10 });
    await targetPage.keyboard.press('Enter');
    await targetPage.waitForFunction(() => {
      const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
      return terminalText.includes('simulated$ id') && terminalText.includes('command simulated.');
    }, undefined, { timeout: 10000 });
    const selfTestStartedAt = Date.now();
    await targetPage.getByRole('button', { name: /run ssh safe speed test/i }).click();
    await targetPage.waitForFunction(() => {
      const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
      return terminalText.includes('colipas-ssh-self-test-40')
        && terminalText.includes('colipas-ssh-self-test-end')
        && terminalText.includes('CoLiPas SSH self-test:')
        && terminalText.includes('simulated$');
    }, undefined, { timeout: 10000 });
    await targetPage.locator('.ssh-terminal-self-test.complete').filter({ hasText: /40 lines/i }).waitFor({ timeout: 5000 });
    const selfTestDurationMs = Date.now() - selfTestStartedAt;
    if (selfTestDurationMs > 6000) {
      throw new Error(`SSH safe speed test output rendered too slowly: ${selfTestDurationMs}ms`);
    }
    await targetPage.waitForFunction(async () => {
      const response = await fetch('/api/audit/diagnostics/export');
      const diagnostic = await response.json();
      return diagnostic?.sshTerminal?.lastSelfTest?.status === 'complete'
        && diagnostic.sshTerminal.lastSelfTest.lines === 40
        && Number.isFinite(diagnostic.sshTerminal.lastSelfTest.firstResponseMs)
        && Number.isFinite(diagnostic.sshTerminal.lastSelfTest.outputSpanMs)
        && diagnostic.sshTerminal.lastSelfTest.bottleneck === 'healthy'
        && !('sessionId' in diagnostic.sshTerminal.lastSelfTest);
    }, undefined, { timeout: 5000 });
    console.log(`ok browser e2e SSH safe speed test rendered in ${selfTestDurationMs}ms`);
    const longOutputStartedAt = Date.now();
    await targetPage.evaluate(() => {
      window.__colipasSshLongTasks = [];
      if (!window.__colipasSshLongTaskObserver && 'PerformanceObserver' in window) {
        try {
          window.__colipasSshLongTaskObserver = new PerformanceObserver((list) => {
            window.__colipasSshLongTasks.push(...list.getEntries().map((entry) => Math.round(entry.duration)));
          });
          window.__colipasSshLongTaskObserver.observe({ entryTypes: ['longtask'] });
        } catch {
          window.__colipasSshLongTaskObserver = null;
        }
      }
    });
    await targetPage.keyboard.type('colipas-long-output', { delay: 1 });
    await targetPage.keyboard.press('Enter');
    await targetPage.waitForFunction(() => {
      const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
      return terminalText.includes('long-output-80') && terminalText.includes('simulated$');
    }, undefined, { timeout: 10000 });
    const longOutputDurationMs = Date.now() - longOutputStartedAt;
    const sshLongTaskDurations = await targetPage.evaluate(() => window.__colipasSshLongTasks ?? []);
    const maxLongTaskMs = sshLongTaskDurations.length > 0 ? Math.max(...sshLongTaskDurations) : 0;
    if (longOutputDurationMs > 6000 || maxLongTaskMs > 750) {
      throw new Error(`SSH long output rendered too slowly: ${longOutputDurationMs}ms, max long task ${maxLongTaskMs}ms`);
    }
    console.log(`ok browser e2e SSH long output rendered in ${longOutputDurationMs}ms with max long task ${maxLongTaskMs}ms`);
    await targetPage.evaluate(() => {
      window.__colipasSshLongTasks = [];
    });
    const burstOutputStartedAt = Date.now();
    await targetPage.keyboard.type('colipas-burst-output', { delay: 1 });
    await targetPage.keyboard.press('Enter');
    await targetPage.waitForFunction(() => {
      const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
      return terminalText.includes('burst-output-1200') && terminalText.includes('simulated$');
    }, undefined, { timeout: 15000 });
    const burstOutputDurationMs = Date.now() - burstOutputStartedAt;
    const burstLongTaskDurations = await targetPage.evaluate(() => window.__colipasSshLongTasks ?? []);
    const maxBurstLongTaskMs = burstLongTaskDurations.length > 0 ? Math.max(...burstLongTaskDurations) : 0;
    if (burstOutputDurationMs > 12000 || maxBurstLongTaskMs > 300) {
      throw new Error(`SSH burst output rendered too slowly: ${burstOutputDurationMs}ms, max long task ${maxBurstLongTaskMs}ms`);
    }
    const terminalNetworkText = await targetPage.locator('.ssh-terminal-network').innerText();
    if (!/RTT\s+\d+ms\s+\/\s+(?:\d+\s+KB\/s|\d+(?:\.\d)?\s+MB\/s)/i.test(terminalNetworkText)) {
      throw new Error(`SSH terminal network diagnostics did not render latency and throughput: ${terminalNetworkText}`);
    }
    console.log(`ok browser e2e SSH burst output rendered in ${burstOutputDurationMs}ms with max long task ${maxBurstLongTaskMs}ms`);
    await assertElementWithinViewport(targetPage, '.ssh-console', 'desktop SSH console');
    await targetPage.getByRole('button', { name: /disconnect/i }).click();
    await targetPage.locator('.ssh-console').waitFor({ state: 'hidden', timeout: 5000 });
    const disconnectMessage = targetPage.locator('.action-message').filter({ hasText: /disconnected/i });
    await disconnectMessage.waitFor({ timeout: 5000 });
    await disconnectMessage.waitFor({ state: 'hidden', timeout: 7000 });
    await targetPage.waitForFunction(async () => {
      const response = await fetch('/api/servers/shells/status');
      const status = await response.json();
      return status.activeCount === 0;
    }, undefined, { timeout: 5000 });
    await targetPage.locator('.server-workspace-row').filter({ hasText: sshServer.name }).getByRole('button', { name: /^SSH$/i }).click();
    await targetPage.locator('.ssh-console').waitFor({ timeout: 10000 });
    await targetPage.waitForFunction(() => {
      const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
      return terminalText.includes('CoLiPas云服务器管理面板 simulated SSH shell') && terminalText.includes('simulated$');
    }, undefined, { timeout: 10000 });
    const reopenedText = await targetPage.locator('.ssh-terminal-screen .xterm-rows').textContent();
    if (reopenedText?.includes('simulated$ pwd')) {
      throw new Error('SSH terminal preserved the old shell buffer after disconnecting the panel');
    }
    await targetPage.locator('.ssh-console-header .icon-button').click();
    await targetPage.locator('.ssh-console').waitFor({ state: 'hidden', timeout: 5000 });
    const closeMessage = targetPage.locator('.action-message').filter({ hasText: /disconnected/i });
    await closeMessage.waitFor({ timeout: 5000 });
    await closeMessage.waitFor({ state: 'hidden', timeout: 7000 });
    await targetPage.waitForFunction(async () => {
      const response = await fetch('/api/servers/shells/status');
      const status = await response.json();
      return status.activeCount === 0;
    }, undefined, { timeout: 5000 });
    console.log('ok browser e2e covers interactive xterm SSH terminal, copy/clear tools, status count, and panel disconnect cleanup');
  } finally {
    await deleteTemporaryAssetServer(targetPage, sshServer.id).catch(() => undefined);
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

async function assertMobileConsoleAndMap() {
  const mobilePage = await createE2ePage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });
  let mobileServerId = '';

  try {
    await openAndLogin(mobilePage, `${baseUrl}/admin/#overview`);
    await mobilePage.getByRole('button', { name: /open navigation/i }).waitFor({ timeout: 5000 });
    await assertNoHorizontalOverflow(mobilePage, 'mobile console after login');

    await mobilePage.locator('.account-settings-trigger').click();
    await mobilePage.locator('.account-modal').waitFor({ timeout: 5000 });
    await assertElementWithinViewport(mobilePage, '.account-modal', 'mobile account settings modal');
    await mobilePage.getByRole('button', { name: /close settings/i }).click();
    await mobilePage.locator('.account-modal').waitFor({ state: 'hidden', timeout: 5000 });

    await mobilePage.getByRole('button', { name: /open navigation/i }).click();
    await mobilePage.getByRole('button', { name: /^AI System$/i }).click();
    await mobilePage.waitForURL(/#ai$/, { timeout: 10000 });
    await mobilePage.getByRole('button', { name: /open ai chat/i }).click();
    await mobilePage.locator('.ai-dock').waitFor({ timeout: 10000 });
    await assertElementWithinViewport(mobilePage, '.ai-dock', 'mobile AI dock');
    await mobilePage.getByRole('textbox', { name: /question/i }).fill('Check server memory usage');
    await mobilePage.getByRole('button', { name: /^send$/i }).click();
    await mobilePage.locator('.ai-message.user').first().waitFor({ timeout: 10000 });
    await mobilePage.locator('.ai-message.assistant.done .ai-message-content').first().waitFor({ timeout: 20000 });
    await assertMobileAiChatLayout(mobilePage);
    await captureVisualEvidence(mobilePage, 'mobile-ai-dock-chat', ['.ai-dock', '.ai-chat-thread', '.ai-composer']);
    await mobilePage.getByRole('button', { name: /hide ai assistant/i }).click();
    await mobilePage.locator('.ai-dock').waitFor({ state: 'hidden', timeout: 5000 });

    mobileServerId = (await createTemporaryAssetServer(mobilePage, 'browser-e2e-mobile-map')).id;
    await mobilePage.goto(`${baseUrl}/admin/#overview`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await mobilePage.reload({ waitUntil: 'networkidle' });
    await mobilePage.locator('.cloud-map').scrollIntoViewIfNeeded();
    await mobilePage.locator('.cloud-map').waitFor({ timeout: 10000 });
    await mobilePage.locator('.world-map-svg').waitFor({ timeout: 10000 });
    await mobilePage.waitForFunction(() => document.querySelectorAll('.map-country.active').length > 0, undefined, { timeout: 10000 });
    await assertElementWithinViewport(mobilePage, '.cloud-map', 'mobile overview map');

    await mobilePage.getByRole('button', { name: /zoom in/i }).click();
    await mobilePage.waitForFunction(() => document.querySelector('.cloud-map')?.classList.contains('is-zoomed'), undefined, { timeout: 5000 });
    await mobilePage.locator('.map-country.active').first().click({ force: true });
    await mobilePage.locator('.map-tooltip.pinned').waitFor({ timeout: 5000 });
    await assertElementWithinViewport(mobilePage, '.map-tooltip.pinned', 'mobile map pinned tooltip');
    await mobilePage.waitForTimeout(1100);
    if (!(await mobilePage.locator('.map-tooltip.pinned').isVisible())) {
      throw new Error('Mobile map pinned tooltip disappeared before users could interact with it');
    }

    await mobilePage.getByRole('button', { name: /view region servers|view regional assets/i }).click();
    await mobilePage.waitForURL(/#servers$/, { timeout: 10000 });
    await assertNoHorizontalOverflow(mobilePage, 'mobile map to servers linkage');
    await captureVisualEvidence(mobilePage, 'mobile-map-to-servers', ['.server-workspace-row']);

    console.log('ok browser e2e covers mobile account, AI dock, map tooltip, zoom, and region linkage');
  } finally {
    if (mobileServerId) {
      await deleteTemporaryAssetServer(mobilePage, mobileServerId).catch(() => undefined);
    }
    await mobilePage.close();
  }
}

async function assertMobileModuleLayoutSweep() {
  const mobilePage = await createE2ePage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });
  let mobileServerId = '';

  try {
    await openAndLogin(mobilePage, `${baseUrl}/admin/#overview`);
    mobileServerId = (await createTemporaryAssetServer(mobilePage, 'browser-e2e-mobile-sweep')).id;
    await mobilePage.reload({ waitUntil: 'networkidle' });

    await assertMobileSection(mobilePage, /^Servers$/i, /#servers$/, [
      '.server-summary-grid',
      '.server-filter-row',
      '.server-workspace-row',
    ]);
    await assertSingleColumnStack(mobilePage, '.server-workspace-row', 'mobile server inventory row');
    await assertMobileServerOpsLayout(mobilePage);
    await mobilePage.locator('.module-section .section-header .tool-button.primary').first().click();
    await mobilePage.locator('.connect-form.open').waitFor({ timeout: 5000 });
    await assertElementHorizontallyWithinViewport(mobilePage, '.connect-form.open', 'mobile server connect form');
    await mobilePage.locator('.connect-form.open .icon-button').first().click();
    await mobilePage.locator('.connect-form.open').waitFor({ state: 'hidden', timeout: 5000 });

    await assertMobileSection(mobilePage, /^Operations$/i, /#operations$/, [
      '.ops-summary-grid',
      '.ops-layout',
      '.ops-queue-panel',
      '.ops-result-panel',
    ]);
    await mobilePage.getByRole('button', { name: /new task/i }).click();
    await mobilePage.locator('.ops-builder').waitFor({ timeout: 5000 });
    await assertElementHorizontallyWithinViewport(mobilePage, '.ops-builder', 'mobile operations builder');
    await assertSingleColumnStack(mobilePage, '.ops-type-grid', 'mobile operations task cards');

    await assertMobileSection(mobilePage, /^Custom API$/i, /#api$/, [
      '.api-status-strip',
      '.api-template-grid',
      '.api-workbench-layout',
      '.api-config-panel',
      '.api-debug-panel',
      '.api-integration-list',
    ]);
    await assertSingleColumnStack(mobilePage, '.api-template-grid', 'mobile custom API templates');
    await assertSingleColumnStack(mobilePage, '.api-config-panel', 'mobile custom API form');

    await assertMobileSection(mobilePage, /^Security$/i, /#security$/, [
      '.security-readiness-card',
      '.security-evidence-brief',
      '.security-release-playbook',
      '.security-kpi-grid',
      '.security-control-grid',
      '.security-remediation-card',
      '.security-audit-workspace',
    ]);
    await assertSingleColumnStack(mobilePage, '.security-readiness-card', 'mobile security readiness card');
    await assertSingleColumnStack(mobilePage, '.security-evidence-metrics', 'mobile release evidence metrics');
    await assertSingleColumnStack(mobilePage, '.security-release-playbook-grid', 'mobile release failure playbook');
    await assertElementHorizontallyWithinViewport(mobilePage, '.security-evidence-brief', 'mobile release evidence brief');
    await assertElementHorizontallyWithinViewport(mobilePage, '.security-release-playbook', 'mobile release failure playbook');
    await assertSingleColumnStack(mobilePage, '.security-control-grid', 'mobile security control grid');
    await assertMobileAuditRowLayout(mobilePage);
    await mobilePage.locator('.security-audit-row').first().click();
    await mobilePage.locator('.security-audit-detail-card').waitFor({ timeout: 5000 });
    await assertElementHorizontallyWithinViewport(mobilePage, '.security-audit-detail-card', 'mobile security audit detail');
    await assertNoHorizontalOverflow(mobilePage, 'mobile module layout sweep');
    await captureVisualEvidence(mobilePage, 'mobile-security-audit', ['.security-workbench', '.security-audit-detail-card']);

    console.log('ok browser e2e covers mobile servers, operations, custom API, and security layout linkage');
  } finally {
    if (mobileServerId) {
      await deleteTemporaryAssetServer(mobilePage, mobileServerId).catch(() => undefined);
    }
    await mobilePage.close();
  }
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

async function captureVisualEvidence(targetPage, name, selectors) {
  for (const selector of selectors) {
    await targetPage.locator(selector).first().waitFor({ timeout: 10000 });
  }
  const filePath = path.join(evidenceDir, `${name}.png`);
  const buffer = await targetPage.screenshot({
    path: filePath,
    fullPage: false,
  });
  if (buffer.length < 12000) {
    throw new Error(`Browser visual evidence ${name} looks too small or blank: ${buffer.length} bytes`);
  }
  const uniqueByteCount = new Set(buffer).size;
  if (uniqueByteCount < 24) {
    throw new Error(`Browser visual evidence ${name} has too little pixel entropy: ${uniqueByteCount} unique bytes`);
  }
  console.log(`ok browser visual evidence ${name} ${buffer.length} bytes`);
}

async function assertMobileSection(targetPage, navName, expectedHashPattern, selectors) {
  await targetPage.getByRole('button', { name: /open navigation/i }).click();
  await targetPage.getByRole('button', { name: navName }).click();
  await targetPage.waitForURL(expectedHashPattern, { timeout: 10000 });
  await targetPage.locator('.module-section').first().waitFor({ timeout: 10000 });

  for (const selector of selectors) {
    await targetPage.locator(selector).first().waitFor({ timeout: 10000 });
    await targetPage.locator(selector).first().scrollIntoViewIfNeeded();
    await assertNoHorizontalOverflow(targetPage, `mobile ${String(navName)} section ${selector}`);
  }
}

async function assertElementWithinViewport(targetPage, selector, label) {
  const viewport = targetPage.viewportSize();
  const box = await targetPage.locator(selector).first().boundingBox();
  if (!viewport || !box) {
    throw new Error(`${label} was not rendered with a measurable viewport box`);
  }

  const tolerance = 3;
  if (
    box.x < -tolerance
    || box.y < -tolerance
    || box.x + box.width > viewport.width + tolerance
    || box.y + box.height > viewport.height + tolerance
  ) {
    throw new Error(`${label} overflows viewport ${viewport.width}x${viewport.height}: ${JSON.stringify(box)}`);
  }
}

async function assertDesktopAiDockLayout(targetPage) {
  await assertElementWithinViewport(targetPage, '.ai-dock', 'desktop AI dock');
  await assertNoHorizontalOverflow(targetPage, 'desktop AI chat dock');

  let metrics = await readAiDockMetrics(targetPage);
  if (metrics.body.overflow !== 'hidden') {
    throw new Error(`Desktop AI chat body should hide outer overflow, got ${metrics.body.overflow}`);
  }
  if (metrics.thread.overflow !== 'auto') {
    throw new Error(`Desktop AI chat thread should own message scrolling, got ${metrics.thread.overflow}`);
  }
  if (metrics.thread.bottom > metrics.composer.y + 3) {
    throw new Error(`Desktop AI chat thread overlaps composer: ${JSON.stringify(metrics)}`);
  }
  if (metrics.execution && metrics.execution.bottom > metrics.composer.y + 3) {
    throw new Error(`Desktop AI execution card should sit above composer: ${JSON.stringify(metrics)}`);
  }
  if (metrics.status && metrics.composer.bottom > metrics.status.y + 3) {
    throw new Error(`Desktop AI status stack should sit below composer: ${JSON.stringify(metrics)}`);
  }
  if (metrics.composer.right > metrics.dock.right + 3 || metrics.toolbar.right > metrics.dock.right + 3) {
    throw new Error(`Desktop AI composer escapes dock width: ${JSON.stringify(metrics)}`);
  }

  await captureVisualEvidence(targetPage, 'desktop-ai-dock-chat', ['.ai-dock', '.ai-chat-thread', '.ai-composer']);
  await targetPage.getByRole('button', { name: /ai settings/i }).click();
  await targetPage.locator('.ai-dock-settings').waitFor({ timeout: 5000 });
  await assertElementWithinViewport(targetPage, '.ai-dock', 'desktop AI settings dock');
  metrics = await readAiDockMetrics(targetPage);
  if (metrics.body.overflow !== 'hidden') {
    throw new Error(`Desktop AI settings body should hide outer overflow, got ${metrics.body.overflow}`);
  }
  if (metrics.settings.overflow !== 'auto') {
    throw new Error(`Desktop AI settings form should own scrolling, got ${metrics.settings.overflow}`);
  }
  if (metrics.settings.right > metrics.dock.right + 3 || metrics.range.right > metrics.settings.right + 3 || metrics.button.right > metrics.settings.right + 3) {
    throw new Error(`Desktop AI settings controls escape the dock: ${JSON.stringify(metrics)}`);
  }
  if (metrics.range.width < 120) {
    throw new Error(`Desktop AI temperature slider is too cramped: ${JSON.stringify(metrics.range)}`);
  }
  await captureVisualEvidence(targetPage, 'desktop-ai-dock-settings', ['.ai-dock', '.ai-dock-settings', '.ai-dock-settings input[type="range"]']);
  await targetPage.getByRole('button', { name: /ai settings/i }).click();
}

async function readAiDockMetrics(targetPage) {
  return targetPage.evaluate(() => {
    const readBox = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        selector,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
        right: rect.right,
        overflow: style.overflow,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    };

    return {
      dock: readBox('.ai-dock'),
      body: readBox('.ai-dock-body'),
      thread: readBox('.ai-chat-thread'),
    composer: readBox('.ai-composer'),
    execution: readBox('.ai-execution-card'),
    toolbar: readBox('.ai-composer-toolbar'),
    status: readBox('.ai-status-stack'),
    settings: readBox('.ai-dock-settings'),
    range: readBox('.ai-dock-settings input[type="range"]'),
    button: readBox('.ai-dock-settings .tool-button.wide'),
    };
  });
}

async function assertMobileAiChatLayout(targetPage) {
  const metrics = await targetPage.evaluate(() => {
    const readBox = (selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        selector,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
        right: rect.right,
        overflow: style.overflow,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      };
    };

    const thread = document.querySelector('.ai-chat-thread')?.getBoundingClientRect();
    const messageIntersections = Array.from(document.querySelectorAll('.ai-chat-thread .ai-message')).map((element) => {
      const rect = element.getBoundingClientRect();
      if (!thread) {
        return null;
      }
      const top = Math.max(rect.top, thread.top);
      const bottom = Math.min(rect.bottom, thread.bottom);
      const left = Math.max(rect.left, thread.left);
      const right = Math.min(rect.right, thread.right);
      return {
        selector: element.className,
        x: left,
        y: top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
        bottom,
        right,
      };
    }).filter(Boolean);

    const selectors = [
      '.ai-dock',
      '.ai-dock-body',
      '.ai-live-strip',
      '.ai-chat-thread',
      '.ai-composer',
      '.ai-status-stack',
    ];
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      messageIntersections,
      boxes: Object.fromEntries(selectors.map((selector) => [selector, readBox(selector)])),
    };
  });

  const tolerance = 3;
  const requireBox = (selector) => {
    const box = metrics.boxes[selector];
    if (!box) {
      throw new Error(`Mobile AI chat layout missing ${selector}`);
    }
    return box;
  };
  const dock = requireBox('.ai-dock');
  const body = requireBox('.ai-dock-body');
  const liveStrip = requireBox('.ai-live-strip');
  const thread = requireBox('.ai-chat-thread');
  const composer = requireBox('.ai-composer');
  const execution = metrics.boxes['.ai-execution-card'];
  const statusStack = metrics.boxes['.ai-status-stack'];

  if (metrics.scrollWidth > metrics.viewport.width + 1) {
    throw new Error(`Mobile AI chat introduced horizontal overflow: ${metrics.scrollWidth}px > ${metrics.viewport.width}px`);
  }
  if (body.overflow !== 'hidden') {
    throw new Error(`Mobile AI chat body should keep outer overflow hidden, got ${body.overflow}`);
  }
  if (thread.overflow !== 'auto') {
    throw new Error(`Mobile AI chat thread should own message scrolling, got ${thread.overflow}`);
  }
  if (dock.y < -tolerance || dock.bottom > metrics.viewport.height + tolerance) {
    throw new Error(`Mobile AI dock should fit viewport, got ${JSON.stringify(dock)}`);
  }
  if (liveStrip.bottom > thread.y + tolerance) {
    throw new Error(`Mobile AI live strip overlaps chat thread: ${JSON.stringify({ liveStrip, thread })}`);
  }
  if (thread.bottom > composer.y + tolerance) {
    throw new Error(`Mobile AI chat thread overlaps composer: ${JSON.stringify({ thread, composer })}`);
  }
  if (execution && execution.bottom > composer.y + tolerance) {
    throw new Error(`Mobile AI execution card should sit above composer: ${JSON.stringify({ execution, composer })}`);
  }
  if (statusStack && composer.bottom > statusStack.y + tolerance) {
    throw new Error(`Mobile AI composer overlaps status stack: ${JSON.stringify({ composer, statusStack })}`);
  }
  if ((statusStack?.bottom ?? composer.bottom) > body.bottom + tolerance) {
    throw new Error(`Mobile AI chat content exceeds dock body: ${JSON.stringify({ body, composer, statusStack })}`);
  }
  const visibleMessages = metrics.messageIntersections.filter((box) => box.height > 8 && box.width > 8);
  if (visibleMessages.length === 0) {
    throw new Error('Mobile AI chat thread should show at least one clipped message inside its own scroll area');
  }
  for (const messageBox of visibleMessages) {
    if (
      messageBox.y < thread.y - tolerance
      || messageBox.bottom > thread.bottom + tolerance
      || messageBox.x < thread.x - tolerance
      || messageBox.right > thread.right + tolerance
    ) {
      throw new Error(`Mobile AI visible message escapes chat thread: ${JSON.stringify({ messageBox, thread })}`);
    }
  }
}

async function assertNoHorizontalOverflow(targetPage, label) {
  const metrics = await targetPage.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  if (metrics.scrollWidth > metrics.viewportWidth + 1) {
    throw new Error(`${label} has horizontal document overflow: ${metrics.scrollWidth}px > ${metrics.viewportWidth}px`);
  }
}

async function assertElementHorizontallyWithinViewport(targetPage, selector, label) {
  const viewport = targetPage.viewportSize();
  const box = await targetPage.locator(selector).first().boundingBox();
  if (!viewport || !box) {
    throw new Error(`${label} was not rendered with a measurable viewport box`);
  }

  const tolerance = 1;
  if (box.x < -tolerance || box.x + box.width > viewport.width + tolerance) {
    throw new Error(`${label} overflows viewport width ${viewport.width}px: ${JSON.stringify(box)}`);
  }
}

async function assertSingleColumnStack(targetPage, selector, label) {
  const columns = await targetPage.locator(selector).first().evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  const columnCount = columns.split(' ').filter(Boolean).length;
  if (columnCount !== 1) {
    throw new Error(`${label} should collapse to one grid column on mobile, got ${columns}`);
  }
}

async function assertMobileAuditRowLayout(targetPage) {
  await targetPage.locator('.security-audit-row').first().waitFor({ timeout: 10000 });
  const metrics = await targetPage.locator('.security-audit-row').first().evaluate((row) => {
    const style = getComputedStyle(row);
    const meta = row.querySelector('.security-audit-meta');
    const time = row.querySelector('time');
    const target = row.querySelector('.security-audit-main small');
    const chip = row.querySelector('.security-audit-main em');
    return {
      columns: style.gridTemplateColumns,
      metaDisplay: meta ? getComputedStyle(meta).display : '',
      timeDisplay: time ? getComputedStyle(time).display : '',
      targetWhiteSpace: target ? getComputedStyle(target).whiteSpace : '',
      hasChip: Boolean(chip),
      rowWidth: row.getBoundingClientRect().width,
      metaRight: meta ? meta.getBoundingClientRect().right : 0,
      viewportWidth: window.innerWidth,
    };
  });
  const columnCount = metrics.columns.split(' ').filter(Boolean).length;
  if (columnCount > 2) {
    throw new Error(`Mobile audit row should use at most two columns, got ${metrics.columns}`);
  }
  if (metrics.metaDisplay !== 'flex' || metrics.timeDisplay === 'none') {
    throw new Error(`Mobile audit row meta should keep status and time visible: ${JSON.stringify(metrics)}`);
  }
  if (metrics.targetWhiteSpace !== 'normal') {
    throw new Error(`Mobile audit row target should wrap instead of truncating: ${JSON.stringify(metrics)}`);
  }
  if (metrics.metaRight > metrics.viewportWidth + 1 || metrics.rowWidth > metrics.viewportWidth + 1) {
    throw new Error(`Mobile audit row overflowed viewport: ${JSON.stringify(metrics)}`);
  }
}

async function assertMobileServerOpsLayout(targetPage) {
  await targetPage.locator('.server-workspace-row').first().waitFor({ timeout: 10000 });
  const metrics = await targetPage.locator('.server-workspace-row').first().evaluate((row) => {
    const ops = row.querySelector('.server-mobile-ops');
    const statusStrip = row.querySelector('.server-mobile-status-strip');
    const actionStrip = row.querySelector('.server-mobile-action-strip');
    const primary = row.querySelector('.server-mobile-primary-action');
    const iconActions = row.querySelector('.server-row-actions');
    return {
      opsDisplay: ops ? getComputedStyle(ops).display : '',
      statusColumns: statusStrip ? getComputedStyle(statusStrip).gridTemplateColumns : '',
      actionColumns: actionStrip ? getComputedStyle(actionStrip).gridTemplateColumns : '',
      primaryText: primary?.textContent?.trim() ?? '',
      iconActionsDisplay: iconActions ? getComputedStyle(iconActions).display : '',
      opsRight: ops ? ops.getBoundingClientRect().right : 0,
      rowRight: row.getBoundingClientRect().right,
      viewportWidth: window.innerWidth,
    };
  });
  if (metrics.opsDisplay !== 'grid') {
    throw new Error(`Mobile server operation strip should be visible as grid: ${JSON.stringify(metrics)}`);
  }
  if (metrics.statusColumns.split(' ').filter(Boolean).length !== 3 || metrics.actionColumns.split(' ').filter(Boolean).length !== 3) {
    throw new Error(`Mobile server operation strip should expose three status chips and three actions: ${JSON.stringify(metrics)}`);
  }
  if (!/ssh/i.test(metrics.primaryText) || metrics.iconActionsDisplay !== 'none') {
    throw new Error(`Mobile server primary SSH action should replace crowded icon actions: ${JSON.stringify(metrics)}`);
  }
  if (metrics.opsRight > metrics.viewportWidth + 1 || metrics.rowRight > metrics.viewportWidth + 1) {
    throw new Error(`Mobile server operation strip overflowed viewport: ${JSON.stringify(metrics)}`);
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
