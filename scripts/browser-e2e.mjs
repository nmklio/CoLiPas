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
  await page.locator('[data-release-fix-router="true"]').scrollIntoViewIfNeeded();
  await captureVisualEvidence(page, 'desktop-release-cockpit-handoff', ['[data-release-fix-router="true"]', '[data-release-cockpit="true"]', '[data-release-handoff-pack="true"]']);
  await captureVisualEvidence(page, 'desktop-security-trace', ['.security-workbench', '.security-readiness-card', '[data-release-fix-router="true"]', '[data-release-cockpit="true"]', '[data-release-handoff-pack="true"]', '.security-evidence-brief', '.security-release-playbook', '.security-ssh-performance-card']);
  await page.locator('[data-ssh-flight-recorder="true"]').scrollIntoViewIfNeeded();
  await captureVisualEvidence(page, 'desktop-ssh-flight-recorder', ['[data-ssh-flight-recorder="true"]', '.security-ssh-flight-rail', '[data-ssh-latency-curve="true"]', '[data-ssh-interaction-sampler="true"]', '[data-ssh-bottleneck-trend="true"]']);
  await page.locator('[data-ssh-bottleneck-trend="true"]').scrollIntoViewIfNeeded();
  await captureVisualEvidence(page, 'desktop-ssh-bottleneck-trend', ['[data-ssh-bottleneck-trend="true"]']);
  await assertOverviewHealthBaseline(page);
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
    window.localStorage.removeItem('colipas.sshLagReportHistory.v1');
    window.localStorage.removeItem('colipas.sshConnectionDoctorHistory.v1');
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

async function ensureSshQuickCommandsEnabled(targetPage, sshServerRow) {
  const quickRunButton = targetPage.locator('[data-ssh-quick-command-run="disk"]');
  await quickRunButton.waitFor({ timeout: 5000 });
  if (!(await quickRunButton.isDisabled())) {
    return;
  }

  await targetPage.locator('.ssh-console-header .icon-button').click();
  await targetPage.locator('.ssh-console').waitFor({ state: 'hidden', timeout: 5000 });
  await targetPage.waitForFunction(async () => {
    const response = await fetch('/api/servers/shells/status');
    const status = await response.json();
    return status.activeCount === 0;
  }, undefined, { timeout: 7000 });
  await sshServerRow.getByRole('button', { name: /^SSH$/i }).click();
  await targetPage.locator('.ssh-console').waitFor({ timeout: 10000 });
  await targetPage.locator('.ssh-terminal-screen .xterm').waitFor({ timeout: 10000 });
  await targetPage.locator('.ssh-terminal-session-count').filter({ hasText: /sessions 1/i }).waitFor({ timeout: 10000 });
  await targetPage.locator('.ssh-terminal-network').filter({ hasText: /RTT/i }).waitFor({ timeout: 10000 });
  await quickRunButton.waitFor({ timeout: 5000 });
  if (await quickRunButton.isDisabled()) {
    throw new Error('SSH quick commands remained disabled after terminal reconnect recovery');
  }
}

async function assertReleaseEvidenceBrief(targetPage) {
  await targetPage.locator('.security-evidence-brief').waitFor({ timeout: 10000 });
  await targetPage.locator('[data-release-fix-router="true"]').waitFor({ timeout: 10000 });
  await targetPage.locator('[data-release-fix-checklist="true"]').waitFor({ timeout: 10000 });
  await targetPage.locator('[data-release-cockpit="true"]').waitFor({ timeout: 10000 });
  await targetPage.locator('[data-release-handoff-pack="true"]').waitFor({ timeout: 10000 });
  await targetPage.locator('.security-release-playbook').waitFor({ timeout: 10000 });
  await targetPage.locator('.security-ssh-performance-card').waitFor({ timeout: 10000 });
  await targetPage.getByRole('button', { name: /copy evidence brief/i }).waitFor({ timeout: 5000 });
  await targetPage.getByRole('button', { name: /copy fix route/i }).waitFor({ timeout: 5000 });
  await targetPage.getByRole('button', { name: /copy checklist/i }).waitFor({ timeout: 5000 });
  await targetPage.getByRole('button', { name: /copy cockpit/i }).waitFor({ timeout: 5000 });
  await targetPage.getByRole('button', { name: /copy handoff pack/i }).waitFor({ timeout: 5000 });
  const releaseFixText = await targetPage.locator('[data-release-fix-router="true"]').innerText();
  if (!/Release fix router/i.test(releaseFixText) || !/Fix route/i.test(releaseFixText) || !/routed finding/i.test(releaseFixText) || !/Open|Review/i.test(releaseFixText)) {
    throw new Error(`Release fix router did not render actionable route text: ${releaseFixText}`);
  }
  const releaseFixStepCount = await targetPage.locator('[data-release-fix-step]').count();
  if (releaseFixStepCount < 1) {
    throw new Error(`Release fix router should expose at least one actionable finding in the grey test fixture, got ${releaseFixStepCount}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(releaseFixText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(releaseFixText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(releaseFixText)) {
    throw new Error('Release fix router rendered a raw IP address or secret');
  }
  const releaseFixChecklistText = await targetPage.locator('[data-release-fix-checklist="true"]').innerText();
  if (!/Release fix checklist/i.test(releaseFixChecklistText) || !/Open/i.test(releaseFixChecklistText) || !/Done/i.test(releaseFixChecklistText) || !/Deferred/i.test(releaseFixChecklistText)) {
    throw new Error(`Release fix checklist did not render status controls: ${releaseFixChecklistText}`);
  }
  const releaseFixChecklistItem = targetPage.locator('[data-release-fix-checklist-item]').first();
  if (await releaseFixChecklistItem.count() === 0) {
    throw new Error('Release fix checklist should expose at least one checklist item in the grey test fixture');
  }
  await releaseFixChecklistItem.locator('button', { hasText: /^Done$/i }).click();
  await expectReleaseFixChecklistStatus(targetPage, 'done');
  await releaseFixChecklistItem.locator('button', { hasText: /^Deferred$/i }).click();
  await expectReleaseFixChecklistStatus(targetPage, 'deferred');
  const storedReleaseFixChecklist = await targetPage.evaluate(() => window.localStorage.getItem('colipas.releaseFixChecklist.v1') ?? '');
  if (!/"version":1/.test(storedReleaseFixChecklist) || !/"deferred"/.test(storedReleaseFixChecklist)) {
    throw new Error(`Release fix checklist did not persist sanitized status state: ${storedReleaseFixChecklist}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(storedReleaseFixChecklist) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(storedReleaseFixChecklist) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(storedReleaseFixChecklist)) {
    throw new Error('Release fix checklist storage leaked a raw IP address or secret');
  }
  await releaseFixChecklistItem.locator('button', { hasText: /^Open$/i }).click();
  await expectReleaseFixChecklistStatus(targetPage, 'open');
  const focusStep = targetPage.locator('[data-release-fix-step="ai"], [data-release-fix-step="api"], [data-release-fix-step="servers"], [data-release-fix-step="ssh"], [data-release-fix-step="events"]').first();
  if (await focusStep.count() === 0) {
    throw new Error('Release fix router should expose at least one cross-module focus route in the grey test fixture');
  }
  const focusModule = await focusStep.getAttribute('data-release-fix-step');
  await focusStep.click();
  const focusBanner = targetPage.locator('[data-release-fix-focus="true"]');
  await focusBanner.waitFor({ timeout: 10000 });
  const focusText = await focusBanner.innerText();
  if (!/Fix ticket/i.test(focusText) || !/Release fix router/i.test(focusText) || !/Current value/i.test(focusText) || !/Recommended action/i.test(focusText)) {
    throw new Error(`Release fix focus banner did not render the routed check context: ${focusText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(focusText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(focusText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(focusText)) {
    throw new Error('Release fix focus banner rendered a raw IP address or secret');
  }
  const expectedAnchor = releaseFixAnchorForModule(focusModule);
  const targetAnchor = targetPage.locator(`[data-release-focus-anchor="${expectedAnchor}"]`).first();
  await targetPage.locator('[data-release-fix-anchor-action="true"]').click();
  await targetAnchor.waitFor({ timeout: 10000 });
  const targetAnchorClass = await targetAnchor.getAttribute('class');
  if (!targetAnchorClass?.includes('release-focus-anchor') || !targetAnchorClass.includes('active')) {
    throw new Error(`Release fix target anchor ${expectedAnchor} was not visibly highlighted: ${targetAnchorClass}`);
  }
  await captureVisualEvidence(targetPage, 'desktop-release-fix-focus', ['[data-release-fix-focus="true"]']);
  await targetPage.locator('[data-release-fix-focus-close="true"]').click();
  await focusBanner.waitFor({ state: 'detached', timeout: 5000 });
  const aiHideButton = targetPage.getByRole('button', { name: /hide ai assistant/i });
  if (focusModule === 'ai' && await aiHideButton.count() > 0) {
    await aiHideButton.click();
  }
  await targetPage.locator('.nav-list').getByRole('button', { name: /^Security$/i }).click();
  await targetPage.locator('[data-release-fix-router="true"]').waitFor({ timeout: 10000 });
  const releaseCockpitLaneCount = await targetPage.locator('[data-release-cockpit-lane]').count();
  if (releaseCockpitLaneCount !== 4) {
    throw new Error(`Release cockpit should expose four health rails, got ${releaseCockpitLaneCount}`);
  }
  const releaseCockpitText = await targetPage.locator('[data-release-cockpit="true"]').innerText();
  if (!/Release cockpit/i.test(releaseCockpitText) || !/Version rail/i.test(releaseCockpitText) || !/Readiness rail/i.test(releaseCockpitText) || !/Audit rail/i.test(releaseCockpitText) || !/SSH rail/i.test(releaseCockpitText) || !/Next publish move/i.test(releaseCockpitText)) {
    throw new Error(`Release cockpit did not render publish-control rails: ${releaseCockpitText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(releaseCockpitText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(releaseCockpitText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(releaseCockpitText)) {
    throw new Error('Release cockpit rendered a raw IP address or secret');
  }
  const releaseHandoffSectionCount = await targetPage.locator('[data-release-handoff-section]').count();
  if (releaseHandoffSectionCount !== 4) {
    throw new Error(`Release handoff pack should expose four handoff sections, got ${releaseHandoffSectionCount}`);
  }
  const releaseHandoffText = await targetPage.locator('[data-release-handoff-pack="true"]').innerText();
  if (!/Release handoff pack/i.test(releaseHandoffText) || !/Tower conclusion/i.test(releaseHandoffText) || !/Publish evidence/i.test(releaseHandoffText) || !/SSH field state/i.test(releaseHandoffText) || !/Handoff rule/i.test(releaseHandoffText) || !/sanitized/i.test(releaseHandoffText)) {
    throw new Error(`Release handoff pack did not render review sections: ${releaseHandoffText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(releaseHandoffText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(releaseHandoffText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(releaseHandoffText)) {
    throw new Error('Release handoff pack rendered a raw IP address or secret');
  }
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
  await targetPage.locator('[data-ssh-experience-summary="true"]').waitFor({ timeout: 5000 });
  const sshExperienceCardCount = await targetPage.locator('.security-ssh-experience-card').count();
  if (sshExperienceCardCount !== 4) {
    throw new Error(`SSH experience brief should expose four decision cards, got ${sshExperienceCardCount}`);
  }
  const sshExperienceText = await targetPage.locator('[data-ssh-experience-summary="true"]').innerText();
  if (!/SSH experience brief/i.test(sshExperienceText) || !/Experience state/i.test(sshExperienceText) || !/Evidence source/i.test(sshExperienceText) || !/Most likely bottleneck/i.test(sshExperienceText) || !/Next move/i.test(sshExperienceText)) {
    throw new Error(`SSH experience brief did not render decision fields: ${sshExperienceText}`);
  }
  await targetPage.locator('[data-ssh-performance-detail="true"]').waitFor({ timeout: 5000 });
  await targetPage.getByRole('button', { name: /likely bottleneck/i }).click();
  const sshPerfDetailText = await targetPage.locator('[data-ssh-performance-detail="true"]').innerText();
  if (!/full metric detail/i.test(sshPerfDetailText) || !/likely bottleneck/i.test(sshPerfDetailText)) {
    throw new Error(`SSH performance detail panel did not switch to the selected metric: ${sshPerfDetailText}`);
  }
  const sshPerfText = await targetPage.locator('.security-ssh-performance-card').innerText();
  if (!/SSH experience brief/i.test(sshPerfText) || !/full metric detail/i.test(sshPerfText) || !/track/i.test(sshPerfText) || !/latency/i.test(sshPerfText) || !/audit/i.test(sshPerfText) || !/input batching/i.test(sshPerfText) || !/socket errors/i.test(sshPerfText) || !/last safe test/i.test(sshPerfText) || !/response split/i.test(sshPerfText) || !/safe test trend/i.test(sshPerfText) || !/likely bottleneck/i.test(sshPerfText) || !/session replay/i.test(sshPerfText)) {
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
  await targetPage.locator('[data-ssh-lag-history="true"]').waitFor({ timeout: 5000 });
  let sshLagHistoryText = await targetPage.locator('[data-ssh-lag-history="true"]').innerText();
  if (!/Local diagnosis snapshots/i.test(sshLagHistoryText) || !/No snapshots yet/i.test(sshLagHistoryText)) {
    throw new Error(`SSH lag diagnosis history did not render its empty state: ${sshLagHistoryText}`);
  }
  await targetPage.evaluate(() => {
    window.__colipasCopiedReleaseFixText = '';
    window.__colipasCopiedReleaseFixChecklistText = '';
    window.__colipasCopiedReleaseCockpitText = '';
    window.__colipasCopiedReleaseHandoffText = '';
    window.__colipasCopiedSshPerformanceText = '';
    window.__colipasCopiedSshLagReportText = '';
    window.__colipasCopiedSshFlightText = '';
    window.__colipasCopiedSshSamplerText = '';
    window.__colipasCopiedSshBottleneckTrendText = '';
    window.__colipasCopiedSshSupportBundleText = '';
    window.__colipasCopiedSshSupportTicketText = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          if (/Release fix checklist/i.test(text)) {
            window.__colipasCopiedReleaseFixChecklistText = text;
          } else if (/Release fix router/i.test(text)) {
            window.__colipasCopiedReleaseFixText = text;
          } else if (/Release handoff pack/i.test(text)) {
            window.__colipasCopiedReleaseHandoffText = text;
          } else if (/Release cockpit/i.test(text)) {
            window.__colipasCopiedReleaseCockpitText = text;
          } else if (/SSH lag ticket template/i.test(text)) {
            window.__colipasCopiedSshSupportTicketText = text;
          } else if (/SSH sanitized support bundle/i.test(text)) {
            window.__colipasCopiedSshSupportBundleText = text;
          } else if (/SSH lag diagnosis report/i.test(text)) {
            window.__colipasCopiedSshLagReportText = text;
          } else if (/SSH flight recorder/i.test(text)) {
            window.__colipasCopiedSshFlightText = text;
          } else if (/SSH real interaction sampler/i.test(text)) {
            window.__colipasCopiedSshSamplerText = text;
          } else if (/SSH bottleneck trend report/i.test(text)) {
            window.__colipasCopiedSshBottleneckTrendText = text;
          } else {
            window.__colipasCopiedSshPerformanceText = text;
          }
        },
      },
    });
  });
  await targetPage.getByRole('button', { name: /copy fix route/i }).click();
  const copiedReleaseFixText = await targetPage.evaluate(() => window.__colipasCopiedReleaseFixText ?? '');
  if (!/Release fix router/i.test(copiedReleaseFixText) || !/Recommended action/i.test(copiedReleaseFixText) || !/Open entry/i.test(copiedReleaseFixText) || !/only includes check names/i.test(copiedReleaseFixText)) {
    throw new Error(`Release fix route copy output is incomplete: ${copiedReleaseFixText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedReleaseFixText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedReleaseFixText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(copiedReleaseFixText)) {
    throw new Error('Release fix route copy output leaked a raw IP address or secret');
  }
  await targetPage.getByRole('button', { name: /copy checklist/i }).click();
  const copiedReleaseFixChecklistText = await targetPage.evaluate(() => window.__colipasCopiedReleaseFixChecklistText ?? '');
  if (!/Release fix checklist/i.test(copiedReleaseFixChecklistText) || !/Open/i.test(copiedReleaseFixChecklistText) || !/Current value/i.test(copiedReleaseFixChecklistText) || !/copied text is sanitized/i.test(copiedReleaseFixChecklistText)) {
    throw new Error(`Release fix checklist copy output is incomplete: ${copiedReleaseFixChecklistText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedReleaseFixChecklistText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedReleaseFixChecklistText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(copiedReleaseFixChecklistText)) {
    throw new Error('Release fix checklist copy output leaked a raw IP address or secret');
  }
  await targetPage.getByRole('button', { name: /copy cockpit/i }).click();
  const copiedReleaseCockpitText = await targetPage.evaluate(() => window.__colipasCopiedReleaseCockpitText ?? '');
  if (!/Release cockpit/i.test(copiedReleaseCockpitText) || !/Release state/i.test(copiedReleaseCockpitText) || !/Version rail/i.test(copiedReleaseCockpitText) || !/Readiness rail/i.test(copiedReleaseCockpitText) || !/Audit rail/i.test(copiedReleaseCockpitText) || !/SSH rail/i.test(copiedReleaseCockpitText) || !/The cockpit only includes sanitized version/i.test(copiedReleaseCockpitText)) {
    throw new Error(`Release cockpit copy output is incomplete: ${copiedReleaseCockpitText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedReleaseCockpitText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedReleaseCockpitText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(copiedReleaseCockpitText)) {
    throw new Error('Release cockpit copy output leaked a raw IP address or secret');
  }
  await targetPage.getByRole('button', { name: /copy handoff pack/i }).click();
  const copiedReleaseHandoffText = await targetPage.evaluate(() => window.__colipasCopiedReleaseHandoffText ?? '');
  if (!/Release handoff pack/i.test(copiedReleaseHandoffText) || !/Release cockpit/i.test(copiedReleaseHandoffText) || !/Release evidence brief/i.test(copiedReleaseHandoffText) || !/SSH sanitized support bundle/i.test(copiedReleaseHandoffText) || !/Handoff contents/i.test(copiedReleaseHandoffText) || !/only combines sanitized cockpit/i.test(copiedReleaseHandoffText)) {
    throw new Error(`Release handoff pack copy output is incomplete: ${copiedReleaseHandoffText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedReleaseHandoffText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedReleaseHandoffText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(copiedReleaseHandoffText)) {
    throw new Error('Release handoff pack copy output leaked a raw IP address or secret');
  }
  await targetPage.locator('[data-ssh-support-bundle="true"]').waitFor({ timeout: 5000 });
  const sshSupportBundleText = await targetPage.locator('[data-ssh-support-bundle="true"]').innerText();
  if (!/SSH sanitized support bundle/i.test(sshSupportBundleText) || !/Bundle contents/i.test(sshSupportBundleText) || !/Performance summary/i.test(sshSupportBundleText) || !/Bottleneck trend/i.test(sshSupportBundleText)) {
    throw new Error(`SSH support bundle did not render all evidence sections: ${sshSupportBundleText}`);
  }
  await targetPage.getByRole('button', { name: /copy support bundle/i }).click();
  const copiedSshSupportBundleText = await targetPage.evaluate(() => window.__colipasCopiedSshSupportBundleText ?? '');
  if (!/SSH sanitized support bundle/i.test(copiedSshSupportBundleText) || !/Performance summary/i.test(copiedSshSupportBundleText) || !/Lag diagnosis/i.test(copiedSshSupportBundleText) || !/Flight recorder/i.test(copiedSshSupportBundleText) || !/Real sampler/i.test(copiedSshSupportBundleText) || !/Bottleneck trend/i.test(copiedSshSupportBundleText) || !/This support bundle only includes sanitized aggregate metrics/i.test(copiedSshSupportBundleText)) {
    throw new Error(`SSH support bundle copy output is incomplete: ${copiedSshSupportBundleText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedSshSupportBundleText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedSshSupportBundleText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(copiedSshSupportBundleText)) {
    throw new Error('SSH support bundle copy output leaked a raw IP address or secret');
  }
  await targetPage.getByRole('button', { name: /copy ticket template/i }).click();
  const copiedSshSupportTicketText = await targetPage.evaluate(() => window.__colipasCopiedSshSupportTicketText ?? '');
  if (!/SSH lag ticket template/i.test(copiedSshSupportTicketText) || !/Priority/i.test(copiedSshSupportTicketText) || !/User impact/i.test(copiedSshSupportTicketText) || !/Collected evidence/i.test(copiedSshSupportTicketText) || !/Need from user/i.test(copiedSshSupportTicketText) || !/This ticket template only includes sanitized evidence/i.test(copiedSshSupportTicketText)) {
    throw new Error(`SSH support ticket copy output is incomplete: ${copiedSshSupportTicketText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedSshSupportTicketText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedSshSupportTicketText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(copiedSshSupportTicketText)) {
    throw new Error('SSH support ticket copy output leaked a raw IP address or secret');
  }
  await targetPage.waitForFunction(async () => {
    const response = await fetch('/api/audit/events');
    if (!response.ok) {
      return false;
    }
    const body = await response.json();
    return Array.isArray(body.items) && body.items.some((item) => item.action === 'SSH_SUPPORT_TICKET_COPY' && item.target === 'ssh-support-ticket');
  }, undefined, { timeout: 5000 });
  const sshSupportTicketAudit = await targetPage.evaluate(async () => {
    const response = await fetch('/api/audit/events');
    const body = await response.json();
    return JSON.stringify(body.items.find((item) => item.action === 'SSH_SUPPORT_TICKET_COPY' && item.target === 'ssh-support-ticket') ?? {});
  });
  if (!/sanitized evidence section/i.test(sshSupportTicketAudit) || /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(sshSupportTicketAudit) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(sshSupportTicketAudit) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(sshSupportTicketAudit)) {
    throw new Error(`SSH support ticket audit event is missing or unsafe: ${sshSupportTicketAudit}`);
  }
  await targetPage.getByRole('button', { name: /copy diagnosis report/i }).click();
  const copiedSshLagReportText = await targetPage.evaluate(() => window.__colipasCopiedSshLagReportText ?? '');
  if (!/SSH lag diagnosis report/i.test(copiedSshLagReportText) || !/Report context/i.test(copiedSshLagReportText) || !/Generated/i.test(copiedSshLagReportText) || !/Sanitized/i.test(copiedSshLagReportText) || !/Key evidence/i.test(copiedSshLagReportText) || !/Input path/i.test(copiedSshLagReportText) || !/sanitized aggregate metrics/i.test(copiedSshLagReportText)) {
    throw new Error(`SSH lag diagnosis copy output is incomplete: ${copiedSshLagReportText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedSshLagReportText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedSshLagReportText)) {
    throw new Error('SSH lag diagnosis copy output leaked a raw IP address or API key');
  }
  await targetPage.getByRole('button', { name: /save snapshot/i }).click();
  sshLagHistoryText = await targetPage.locator('[data-ssh-lag-history="true"]').innerText();
  if (!/Current SSH experience/i.test(sshLagHistoryText) || !/Trend vs latest snapshot/i.test(sshLagHistoryText) || !/Watch closely|Healthy path|Errors found/i.test(sshLagHistoryText)) {
    throw new Error(`SSH lag diagnosis history did not save the current snapshot: ${sshLagHistoryText}`);
  }
  const sshLagCompareText = await targetPage.locator('[data-ssh-lag-history-compare="true"]').innerText();
  if (!/Experience unchanged|Experience improved|Experience degraded/i.test(sshLagCompareText) || !/Current .* baseline/i.test(sshLagCompareText)) {
    throw new Error(`SSH lag diagnosis history did not render a trend comparison: ${sshLagCompareText}`);
  }
  await targetPage.locator('[data-ssh-flight-recorder="true"]').waitFor({ timeout: 5000 });
  const sshFlightText = await targetPage.locator('[data-ssh-flight-recorder="true"]').innerText();
  if (!/SSH flight recorder/i.test(sshFlightText) || !/Sessions/i.test(sshFlightText) || !/Output lines/i.test(sshFlightText) || !/Session #/i.test(sshFlightText) || !/input/i.test(sshFlightText) || !/output/i.test(sshFlightText)) {
    throw new Error(`SSH flight recorder did not render sanitized session timeline evidence: ${sshFlightText}`);
  }
  if (!/Automatic bottleneck hint/i.test(sshFlightText) || !/Suggested action/i.test(sshFlightText) && !/Keep the screenshot|Focus on|Check WebSocket|Retest/i.test(sshFlightText)) {
    throw new Error(`SSH flight recorder did not render automatic bottleneck guidance: ${sshFlightText}`);
  }
  const sshFlightSegmentCount = await targetPage.locator('.security-ssh-flight-rail span').count();
  if (sshFlightSegmentCount < 2) {
    throw new Error(`SSH flight recorder should expose multiple timeline segments, got ${sshFlightSegmentCount}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(sshFlightText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(sshFlightText)) {
    throw new Error('SSH flight recorder rendered a raw IP address or API key');
  }
  await targetPage.getByRole('button', { name: /copy flight summary/i }).click();
  const copiedSshFlightText = await targetPage.evaluate(() => window.__colipasCopiedSshFlightText ?? '');
  if (!/SSH flight recorder/i.test(copiedSshFlightText) || !/Automatic bottleneck hint/i.test(copiedSshFlightText) || !/Evidence/i.test(copiedSshFlightText) || !/Suggested action/i.test(copiedSshFlightText) || !/This summary only includes sanitized aggregate metrics/i.test(copiedSshFlightText)) {
    throw new Error(`SSH flight recorder copy output is incomplete: ${copiedSshFlightText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedSshFlightText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedSshFlightText)) {
    throw new Error('SSH flight recorder copy output leaked a raw IP address or API key');
  }
  await targetPage.locator('[data-ssh-latency-curve="true"]').waitFor({ timeout: 5000 });
  const sshLatencyCurveText = await targetPage.locator('[data-ssh-latency-curve="true"]').innerText();
  if (!/SSH live latency curve/i.test(sshLatencyCurveText) || !/Duration/i.test(sshLatencyCurveText) || !/Events/i.test(sshLatencyCurveText) || !/Peak/i.test(sshLatencyCurveText) || !/Start/i.test(sshLatencyCurveText) || !/Last/i.test(sshLatencyCurveText)) {
    throw new Error(`SSH live latency curve did not render timing markers: ${sshLatencyCurveText}`);
  }
  const sshLatencyPointCount = await targetPage.locator('.security-ssh-latency-chart > span').count();
  if (sshLatencyPointCount < 2) {
    throw new Error(`SSH live latency curve should expose multiple event points, got ${sshLatencyPointCount}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(sshLatencyCurveText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(sshLatencyCurveText)) {
    throw new Error('SSH live latency curve rendered a raw IP address or API key');
  }
  await targetPage.locator('[data-ssh-interaction-sampler="true"]').waitFor({ timeout: 5000 });
  const sshSamplerText = await targetPage.locator('[data-ssh-interaction-sampler="true"]').innerText();
  if (!/SSH real interaction sampler/i.test(sshSamplerText) || !/Sampling score/i.test(sshSamplerText) || !/Sampled sessions/i.test(sshSamplerText) || !/Avg first output/i.test(sshSamplerText) || !/Output peak/i.test(sshSamplerText) || !/Close cleanup/i.test(sshSamplerText)) {
    throw new Error(`SSH interaction sampler did not render real-experience metrics: ${sshSamplerText}`);
  }
  const sshSamplerStatCount = await targetPage.locator('.security-ssh-sampler-stats article').count();
  const sshSamplerStepCount = await targetPage.locator('.security-ssh-sampler-steps article').count();
  if (sshSamplerStatCount !== 4 || sshSamplerStepCount !== 4) {
    throw new Error(`SSH interaction sampler should expose four stats and four path steps, got ${sshSamplerStatCount}/${sshSamplerStepCount}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(sshSamplerText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(sshSamplerText)) {
    throw new Error('SSH interaction sampler rendered a raw IP address or API key');
  }
  const storedSshLagHistory = await targetPage.evaluate(() => window.localStorage.getItem('colipas.sshLagReportHistory.v1') ?? '');
  if (!/SSH lag diagnosis report/i.test(storedSshLagHistory) || !/"tone":/i.test(storedSshLagHistory) || /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(storedSshLagHistory) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(storedSshLagHistory)) {
    throw new Error(`SSH lag diagnosis history storage is missing or unsafe: ${storedSshLagHistory}`);
  }
  await targetPage.evaluate(() => { window.__colipasCopiedSshSamplerText = ''; });
  await targetPage.getByRole('button', { name: /copy sampling report/i }).click();
  const copiedSshSamplerText = await targetPage.evaluate(() => window.__colipasCopiedSshSamplerText ?? window.__colipasCopiedSshPerformanceText ?? '');
  if (!/SSH real interaction sampler/i.test(copiedSshSamplerText) || !/Sampling score/i.test(copiedSshSamplerText) || !/Sampled sessions/i.test(copiedSshSamplerText) || !/Avg first output/i.test(copiedSshSamplerText) || !/The sampling report only includes sanitized aggregate metrics/i.test(copiedSshSamplerText)) {
    throw new Error(`SSH interaction sampler copy output is incomplete: ${copiedSshSamplerText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedSshSamplerText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedSshSamplerText)) {
    throw new Error('SSH interaction sampler copy output leaked a raw IP address or API key');
  }
  await targetPage.locator('[data-ssh-bottleneck-trend="true"]').waitFor({ timeout: 5000 });
  const sshBottleneckTrendText = await targetPage.locator('[data-ssh-bottleneck-trend="true"]').innerText();
  if (!/SSH bottleneck trend/i.test(sshBottleneckTrendText) || !/Network/i.test(sshBottleneckTrendText) || !/Input/i.test(sshBottleneckTrendText) || !/Output/i.test(sshBottleneckTrendText) || !/Render/i.test(sshBottleneckTrendText)) {
    throw new Error(`SSH bottleneck trend did not render the four diagnosis lanes: ${sshBottleneckTrendText}`);
  }
  if (!/sanitized snapshots|samples/i.test(sshBottleneckTrendText) || !/Trend snapshots only contain sanitized numbers/i.test(sshBottleneckTrendText)) {
    throw new Error(`SSH bottleneck trend did not explain sanitized local evidence: ${sshBottleneckTrendText}`);
  }
  const bottleneckTrendLaneCount = await targetPage.locator('[data-ssh-bottleneck-trend-lane]').count();
  if (bottleneckTrendLaneCount !== 4) {
    throw new Error(`SSH bottleneck trend should expose four pressure lanes, got ${bottleneckTrendLaneCount}`);
  }
  const bottleneckTrendSampleCount = await targetPage.locator('.security-ssh-bottleneck-trend-timeline article').count();
  if (bottleneckTrendSampleCount < 1) {
    throw new Error(`SSH bottleneck trend should show at least one persisted sample, got ${bottleneckTrendSampleCount}: ${sshBottleneckTrendText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(sshBottleneckTrendText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(sshBottleneckTrendText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(sshBottleneckTrendText)) {
    throw new Error('SSH bottleneck trend rendered a raw IP address or secret');
  }
  await targetPage.getByRole('button', { name: /copy trend report/i }).click();
  const copiedSshBottleneckTrendText = await targetPage.evaluate(() => window.__colipasCopiedSshBottleneckTrendText ?? '');
  if (!/SSH bottleneck trend report/i.test(copiedSshBottleneckTrendText) || !/Primary bottleneck/i.test(copiedSshBottleneckTrendText) || !/Pressure lanes/i.test(copiedSshBottleneckTrendText) || !/Recent samples/i.test(copiedSshBottleneckTrendText) || !/Trend snapshots only contain sanitized numbers/i.test(copiedSshBottleneckTrendText)) {
    throw new Error(`SSH bottleneck trend report copy output is incomplete: ${copiedSshBottleneckTrendText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedSshBottleneckTrendText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedSshBottleneckTrendText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(copiedSshBottleneckTrendText)) {
    throw new Error('SSH bottleneck trend report copy output leaked a raw IP address or secret');
  }
  await targetPage.getByRole('button', { name: /copy summary|复制摘要|サマリーをコピー/i }).click();
  const copiedSshPerfText = await targetPage.evaluate(() => window.__colipasCopiedSshPerformanceText ?? '');
  if (!/SSH terminal performance|Input batching/i.test(copiedSshPerfText) || !/\[SSH experience brief\]/i.test(copiedSshPerfText) || !/\[Track\]/i.test(copiedSshPerfText) || !/\[Latency\]/i.test(copiedSshPerfText) || !/\[Audit\]/i.test(copiedSshPerfText) || !/Experience state/i.test(copiedSshPerfText) || !/Evidence source/i.test(copiedSshPerfText) || !/Socket errors/i.test(copiedSshPerfText) || !/Last safe test/i.test(copiedSshPerfText) || !/Response split/i.test(copiedSshPerfText) || !/Safe test trend/i.test(copiedSshPerfText) || !/Likely bottleneck/i.test(copiedSshPerfText) || !/Session replay/i.test(copiedSshPerfText)) {
    throw new Error(`SSH performance copy output is incomplete: ${copiedSshPerfText}`);
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedSshPerfText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedSshPerfText)) {
    throw new Error('SSH performance copy output leaked a raw IP address or API key');
  }
  const text = `${releaseFixText}\n${releaseFixChecklistText}\n${releaseCockpitText}\n${releaseHandoffText}\n${await targetPage.locator('.security-evidence-brief').innerText()}\n${await targetPage.locator('.security-release-playbook').innerText()}\n${sshPerfText}`;
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(text)) {
    throw new Error('Release fix router, cockpit, handoff pack, evidence, failure playbook, or SSH performance card rendered a raw IP address or API key');
  }
  await assertElementHorizontallyWithinViewport(targetPage, '[data-release-fix-router="true"]', 'desktop release fix router');
  await assertElementHorizontallyWithinViewport(targetPage, '[data-release-fix-checklist="true"]', 'desktop release fix checklist');
  await assertElementHorizontallyWithinViewport(targetPage, '[data-release-cockpit="true"]', 'desktop release cockpit');
  await assertElementHorizontallyWithinViewport(targetPage, '[data-release-handoff-pack="true"]', 'desktop release handoff pack');
  await assertElementHorizontallyWithinViewport(targetPage, '.security-evidence-brief', 'desktop release evidence brief');
  await assertElementHorizontallyWithinViewport(targetPage, '.security-release-playbook', 'desktop release failure playbook');
  await assertElementHorizontallyWithinViewport(targetPage, '.security-ssh-performance-card', 'desktop SSH performance card');
}

async function expectReleaseFixChecklistStatus(targetPage, status) {
  await targetPage.waitForFunction(
    (expectedStatus) => document.querySelector('[data-release-fix-checklist-item]')?.getAttribute('data-release-fix-checklist-status') === expectedStatus,
    status,
    { timeout: 5000 },
  );
}

function releaseFixAnchorForModule(module) {
  if (module === 'ai') {
    return 'ai-provider';
  }
  if (module === 'api') {
    return 'api-request';
  }
  if (module === 'ssh' || module === 'servers') {
    return 'server-ssh';
  }
  if (module === 'events') {
    return 'operations-builder';
  }
  throw new Error(`Unexpected release fix module for anchor routing: ${module}`);
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

    const sshServerRow = targetPage.locator('.server-workspace-row').filter({ hasText: sshServer.name });
    await sshServerRow.getByRole('button', { name: /diagnose/i }).click();
    await targetPage.locator('[data-ssh-connection-doctor="true"]').waitFor({ timeout: 10000 });
    const sshDoctorText = await targetPage.locator('[data-ssh-connection-doctor="true"]').innerText();
    if (!/SSH connection doctor|SSH link/i.test(sshDoctorText) || !/Credential/i.test(sshDoctorText) || !/Backend/i.test(sshDoctorText) || !/Shell/i.test(sshDoctorText) || !/Terminal/i.test(sshDoctorText)) {
      throw new Error(`SSH connection doctor did not render the full diagnostic chain: ${sshDoctorText}`);
    }
    const sshDoctorStepCount = await targetPage.locator('[data-ssh-connection-doctor-step]').count();
    if (sshDoctorStepCount !== 5) {
      throw new Error(`SSH connection doctor should render five stages, got ${sshDoctorStepCount}`);
    }
    if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(sshDoctorText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(sshDoctorText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(sshDoctorText)) {
      throw new Error('SSH connection doctor rendered raw IP or secret material');
    }
    await targetPage.locator('[data-ssh-connection-doctor-trend="true"]').waitFor({ timeout: 5000 });
    const sshDoctorTrendText = await targetPage.locator('[data-ssh-connection-doctor-trend="true"]').innerText();
    if (!/History trend|Baseline saved|Current focus/i.test(sshDoctorTrendText)) {
      throw new Error(`SSH connection doctor trend did not render baseline evidence: ${sshDoctorTrendText}`);
    }
    const sshDoctorTrendLaneCount = await targetPage.locator('[data-ssh-connection-doctor-trend-lane]').count();
    if (sshDoctorTrendLaneCount !== 5) {
      throw new Error(`SSH connection doctor trend should render five lanes, got ${sshDoctorTrendLaneCount}`);
    }
    const sshDoctorHistory = await targetPage.evaluate(() => window.localStorage.getItem('colipas.sshConnectionDoctorHistory.v1') ?? '');
    if (!/"targetKey"/.test(sshDoctorHistory) || /"serverId"|"serverName"|"summary"|"detail"|"value"|"label"/.test(sshDoctorHistory)) {
      throw new Error(`SSH connection doctor history should only persist compact stage metrics: ${sshDoctorHistory}`);
    }
    if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(sshDoctorHistory) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(sshDoctorHistory) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(sshDoctorHistory)) {
      throw new Error('SSH connection doctor history leaked raw IP or secret material');
    }
    await targetPage.locator('[data-ssh-troubleshooting-report="true"]').waitFor({ timeout: 5000 });
    const sshTroubleshootingReportText = await targetPage.locator('[data-ssh-troubleshooting-report="true"]').innerText();
    if (!/SSH troubleshooting report|Terminal channel|Live telemetry|Recommended action/i.test(sshTroubleshootingReportText)) {
      throw new Error(`SSH troubleshooting report card did not render the handoff summary: ${sshTroubleshootingReportText}`);
    }
    if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(sshTroubleshootingReportText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(sshTroubleshootingReportText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(sshTroubleshootingReportText)) {
      throw new Error('SSH troubleshooting report card rendered raw IP or secret material');
    }
    await targetPage.evaluate(() => {
      window.__colipasCopiedSshTroubleshootingReport = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__colipasCopiedSshTroubleshootingReport = text;
          },
        },
      });
    });
    await targetPage.locator('[data-ssh-troubleshooting-report-copy="true"]').click();
    const copiedSshTroubleshootingReport = await targetPage.evaluate(() => window.__colipasCopiedSshTroubleshootingReport ?? '');
    if (!/SSH troubleshooting report|Generated|Recommended action|SSH connection doctor|History trend/i.test(copiedSshTroubleshootingReport)) {
      throw new Error(`SSH troubleshooting report copy output is incomplete: ${copiedSshTroubleshootingReport}`);
    }
    if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedSshTroubleshootingReport) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedSshTroubleshootingReport) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY|test-browser-e2e-value|password=|passphrase=|simulated\$ whoami/i.test(copiedSshTroubleshootingReport)) {
      throw new Error('SSH troubleshooting report copy output leaked raw host, secret, or command text');
    }
    await targetPage.locator('[data-ssh-channel-check-run="true"]').click();
    await targetPage.locator('[data-ssh-channel-check="true"]').waitFor({ timeout: 20000 });
    const sshChannelCheckText = await targetPage.locator('[data-ssh-channel-check="true"]').innerText();
    if (!/SSH channel check|WebSocket|Compatible channel|Session cleanup|Round trip OK/i.test(sshChannelCheckText)) {
      throw new Error(`SSH channel self-check did not render all channel stages: ${sshChannelCheckText}`);
    }
    const sshChannelStageCount = await targetPage.locator('[data-ssh-channel-check-stage]').count();
    if (sshChannelStageCount !== 4) {
      throw new Error(`SSH channel self-check should render four stages, got ${sshChannelStageCount}`);
    }
    if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(sshChannelCheckText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(sshChannelCheckText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY|test-browser-e2e-value|password=|passphrase=/i.test(sshChannelCheckText)) {
      throw new Error('SSH channel self-check rendered raw host or secret material');
    }
    await targetPage.locator('[data-ssh-channel-fix-plan="true"]').waitFor({ timeout: 5000 });
    const sshChannelFixPlanText = await targetPage.locator('[data-ssh-channel-fix-plan="true"]').innerText();
    if (!/Fix plan|Keep WebSocket|compatible fallback|Copy fix plan/i.test(sshChannelFixPlanText)) {
      throw new Error(`SSH channel fix plan did not render actionable guidance: ${sshChannelFixPlanText}`);
    }
    if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(sshChannelFixPlanText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(sshChannelFixPlanText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY|test-browser-e2e-value|password=|passphrase=/i.test(sshChannelFixPlanText)) {
      throw new Error('SSH channel fix plan rendered raw host or secret material');
    }
    await targetPage.evaluate(() => {
      window.__colipasCopiedSshChannelFixPlan = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__colipasCopiedSshChannelFixPlan = text;
          },
        },
      });
    });
    await targetPage.locator('[data-ssh-channel-fix-plan-copy="true"]').click();
    const copiedSshChannelFixPlan = await targetPage.evaluate(() => window.__colipasCopiedSshChannelFixPlan ?? '');
    if (!/SSH channel fix plan|SSH channel check|Steps|Next action|Safe/i.test(copiedSshChannelFixPlan)) {
      throw new Error(`SSH channel fix plan copy output is incomplete: ${copiedSshChannelFixPlan}`);
    }
    if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(copiedSshChannelFixPlan) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(copiedSshChannelFixPlan) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY|test-browser-e2e-value|password=|passphrase=|__colipas_/i.test(copiedSshChannelFixPlan)) {
      throw new Error('SSH channel fix plan copy output leaked raw host, secret, or probe marker');
    }
    await targetPage.waitForFunction(async () => {
      const response = await fetch('/api/servers/shells/status');
      const status = await response.json();
      return status.activeCount === 0;
    }, undefined, { timeout: 7000 });
    await captureVisualEvidence(targetPage, 'desktop-ssh-connection-doctor', ['[data-ssh-connection-doctor="true"]']);
    await targetPage.getByRole('button', { name: /open ssh terminal/i }).click();
    await targetPage.locator('.ssh-console').waitFor({ timeout: 10000 });
    await targetPage.locator('.ssh-console-header .icon-button').click();
    await targetPage.locator('.ssh-console').waitFor({ state: 'hidden', timeout: 5000 });
    await targetPage.waitForFunction(() => {
      const messageText = Array.from(document.querySelectorAll('.action-message'))
        .map((element) => element.textContent ?? '')
        .join('\n');
      return !/live ssh terminal connected/i.test(messageText);
    }, undefined, { timeout: 2500 });

    await sshServerRow.getByRole('button', { name: /^SSH$/i }).click();
    await targetPage.locator('.ssh-console').waitFor({ timeout: 10000 });
    await targetPage.locator('.ssh-terminal-screen .xterm').waitFor({ timeout: 10000 });
    await targetPage.locator('.ssh-terminal-session-count').filter({ hasText: /sessions 1/i }).waitFor({ timeout: 10000 });
    await targetPage.locator('.ssh-terminal-network').filter({ hasText: /RTT/i }).waitFor({ timeout: 10000 });
    await targetPage.locator('[data-ssh-quick-command-deck="true"]').waitFor({ timeout: 5000 });
    await ensureSshQuickCommandsEnabled(targetPage, sshServerRow);
    const quickCommandText = await targetPage.locator('[data-ssh-quick-command-deck="true"]').innerText();
    const requiredQuickCommandLabels = ['Terminal runbook', 'System and uptime', 'Disk space', 'Memory pressure', 'Interfaces and addresses', 'Top CPU processes', 'Recent warning logs'];
    const missingQuickCommandLabels = requiredQuickCommandLabels.filter((label) => !quickCommandText.toLowerCase().includes(label.toLowerCase()));
    if (missingQuickCommandLabels.length) {
      throw new Error(`SSH quick command deck did not render ${missingQuickCommandLabels.join(', ')}: ${quickCommandText}`);
    }
    if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(quickCommandText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(quickCommandText) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY|password=|passphrase=/i.test(quickCommandText)) {
      throw new Error('SSH quick command deck rendered raw host or secret material');
    }
    const quickCommandCount = await targetPage.locator('[data-ssh-quick-command]').count();
    if (quickCommandCount !== 6) {
      throw new Error(`SSH quick command deck should expose six commands, got ${quickCommandCount}`);
    }
    const customRunbookTitle = `E2E custom uptime ${Date.now()}`;
    const customRunbookUpdatedTitle = `${customRunbookTitle} edited`;
    const customRunbookSecondTitle = `${customRunbookTitle} second`;
    const customRunbookCommand = 'printf colipas-runbook-custom';
    const customRunbookUpdatedCommand = 'printf colipas-runbook-custom-edited';
    const customRunbookSecondCommand = 'journalctl -n 5 --no-pager';
    let customRunbookId = '';
    let customRunbookSecondId = '';
    await targetPage.locator('[data-ssh-runbook-form="true"] input').first().fill(customRunbookTitle);
    await targetPage.locator('[data-ssh-runbook-form="true"] input').nth(1).fill(customRunbookCommand);
    await targetPage.locator('[data-ssh-runbook-form="true"]').getByRole('button', { name: /save command/i }).click();
    await targetPage.locator('.action-message').filter({ hasText: /runbook command saved/i }).waitFor({ timeout: 5000 });
    let customRunbookCard = targetPage.locator('[data-ssh-runbook-command]').filter({ hasText: customRunbookTitle });
    await customRunbookCard.waitFor({ timeout: 5000 });
    const runbookApiState = await targetPage.evaluate(async () => {
      const response = await fetch('/api/servers/ssh-runbook');
      return response.json();
    });
    const persistedRunbookCommand = Array.isArray(runbookApiState.commands)
      ? runbookApiState.commands.find((item) => item.title === customRunbookTitle && item.command === customRunbookCommand)
      : null;
    if (!persistedRunbookCommand?.id) {
      throw new Error(`SSH runbook API did not persist the custom command: ${JSON.stringify(runbookApiState)}`);
    }
    customRunbookId = persistedRunbookCommand.id;
    try {
      await customRunbookCard.locator(`[data-ssh-runbook-command-edit="${customRunbookId}"]`).click();
      await targetPage.locator('.action-message').filter({ hasText: customRunbookTitle }).waitFor({ timeout: 5000 });
      await targetPage.locator('[data-ssh-runbook-form="true"] input').first().fill(customRunbookUpdatedTitle);
      await targetPage.locator('[data-ssh-runbook-form="true"] input').nth(1).fill(customRunbookUpdatedCommand);
      await targetPage.locator('[data-ssh-runbook-form="true"]').getByRole('button', { name: /update command/i }).click();
      await targetPage.locator('.action-message').filter({ hasText: /runbook command updated/i }).waitFor({ timeout: 5000 });
      customRunbookCard = targetPage.locator('[data-ssh-runbook-command]').filter({ hasText: customRunbookUpdatedTitle });
      await customRunbookCard.waitFor({ timeout: 5000 });

      await targetPage.locator('[data-ssh-runbook-form="true"] input').first().fill(customRunbookSecondTitle);
      await targetPage.locator('[data-ssh-runbook-form="true"] input').nth(1).fill(customRunbookSecondCommand);
      await targetPage.locator('[data-ssh-runbook-form="true"]').getByRole('button', { name: /save command/i }).click();
      await targetPage.locator('.action-message').filter({ hasText: /runbook command saved/i }).waitFor({ timeout: 5000 });
      const customRunbookSecondCard = targetPage.locator('[data-ssh-runbook-command]').filter({ hasText: customRunbookSecondTitle });
      await customRunbookSecondCard.waitFor({ timeout: 5000 });
      const runbookApiAfterSecondCreate = await targetPage.evaluate(async (titles) => {
        const response = await fetch('/api/servers/ssh-runbook');
        const body = await response.json();
        return { status: response.status, body, titles };
      }, { first: customRunbookUpdatedTitle, second: customRunbookSecondTitle });
      const persistedUpdatedCommand = Array.isArray(runbookApiAfterSecondCreate.body.commands)
        ? runbookApiAfterSecondCreate.body.commands.find((item) => item.title === customRunbookUpdatedTitle && item.command === customRunbookUpdatedCommand)
        : null;
      const persistedSecondCommand = Array.isArray(runbookApiAfterSecondCreate.body.commands)
        ? runbookApiAfterSecondCreate.body.commands.find((item) => item.title === customRunbookSecondTitle && item.command === customRunbookSecondCommand)
        : null;
      if (!persistedUpdatedCommand?.id || persistedUpdatedCommand.id !== customRunbookId || !persistedSecondCommand?.id) {
        throw new Error(`SSH runbook API did not persist edit/create correctly: ${JSON.stringify(runbookApiAfterSecondCreate)}`);
      }
      customRunbookSecondId = persistedSecondCommand.id;

      await targetPage.locator('[data-ssh-runbook-search="true"]').fill('second');
      await targetPage.waitForFunction((expectedTitle) => {
        const cards = Array.from(document.querySelectorAll('[data-ssh-runbook-command]'));
        return cards.length === 1 && (cards[0]?.textContent ?? '').includes(expectedTitle);
      }, customRunbookSecondTitle, { timeout: 5000 });
      await targetPage.locator('[data-ssh-runbook-clear-filter="true"]').click();
      await targetPage.locator(`[data-ssh-runbook-command="${customRunbookId}"]`).waitFor({ timeout: 5000 });
      await targetPage.locator(`[data-ssh-runbook-command="${customRunbookSecondId}"]`).waitFor({ timeout: 5000 });
      await targetPage.locator('[data-ssh-runbook-category="logs"]').click();
      await targetPage.waitForFunction((expectedTitle) => {
        const cards = Array.from(document.querySelectorAll('[data-ssh-runbook-command]'));
        return cards.length === 1 && (cards[0]?.textContent ?? '').includes(expectedTitle);
      }, customRunbookSecondTitle, { timeout: 5000 });
      await targetPage.locator('[data-ssh-runbook-category="all"]').click();
      await targetPage.locator(`[data-ssh-runbook-command="${customRunbookId}"]`).waitFor({ timeout: 5000 });
      await targetPage.locator(`[data-ssh-runbook-command="${customRunbookSecondId}"]`).waitFor({ timeout: 5000 });

      await customRunbookSecondCard.locator(`[data-ssh-runbook-command-pin="${customRunbookSecondId}"]`).click();
      await targetPage.locator('.action-message').filter({ hasText: /Pinned/i }).waitFor({ timeout: 5000 });
      const runbookApiAfterPin = await targetPage.evaluate(async (expectedId) => {
        const response = await fetch('/api/servers/ssh-runbook');
        const body = await response.json();
        return { status: response.status, body, expectedId };
      }, customRunbookSecondId);
      if (runbookApiAfterPin.status !== 200 || runbookApiAfterPin.body.commands?.[0]?.id !== customRunbookSecondId || runbookApiAfterPin.body.commands?.[0]?.pinned !== true) {
        throw new Error(`SSH runbook pin did not move command to front: ${JSON.stringify(runbookApiAfterPin)}`);
      }
      await customRunbookSecondCard.locator(`[data-ssh-runbook-command-pin="${customRunbookSecondId}"]`).click();
      await targetPage.locator('.action-message').filter({ hasText: /Unpinned/i }).waitFor({ timeout: 5000 });

      await customRunbookSecondCard.locator(`[data-ssh-runbook-command-move-down="${customRunbookSecondId}"]`).click();
      await targetPage.locator('.action-message').filter({ hasText: /runbook order updated/i }).waitFor({ timeout: 5000 });
      const runbookApiAfterMove = await targetPage.evaluate(async (ids) => {
        const response = await fetch('/api/servers/ssh-runbook');
        const body = await response.json();
        return { status: response.status, body, ids };
      }, { first: customRunbookId, second: customRunbookSecondId });
      const orderedIds = runbookApiAfterMove.body.commands?.map((item) => item.id) ?? [];
      if (orderedIds.indexOf(customRunbookId) === -1 || orderedIds.indexOf(customRunbookSecondId) === -1 || orderedIds.indexOf(customRunbookId) > orderedIds.indexOf(customRunbookSecondId)) {
        throw new Error(`SSH runbook reorder did not put edited command before second command: ${JSON.stringify(runbookApiAfterMove)}`);
      }

      await ensureSshQuickCommandsEnabled(targetPage, sshServerRow);
      await customRunbookCard.locator('[data-ssh-runbook-command-run]').click();
      await targetPage.locator('.action-message').filter({ hasText: customRunbookUpdatedTitle }).waitFor({ timeout: 5000 });
      try {
        await targetPage.waitForFunction((expectedCommand) => {
          const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
          return terminalText.includes(expectedCommand) && terminalText.includes('command simulated.');
        }, customRunbookUpdatedCommand, { timeout: 10000 });
      } catch (error) {
        const runbookRunState = await targetPage.evaluate(async (expectedCommand) => {
          const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
          const messageText = Array.from(document.querySelectorAll('.action-message'))
            .map((element) => element.textContent ?? '')
            .join('\n');
          const terminalState = document.querySelector('.ssh-terminal-state')?.textContent ?? '';
          const sessionCount = document.querySelector('.ssh-terminal-session-count')?.textContent ?? '';
          const networkState = document.querySelector('.ssh-terminal-network')?.textContent ?? '';
          let replayHasCommand = false;
          let shellStatus = null;
          let socketDiagnostics = null;
          try {
            const response = await fetch('/api/audit/diagnostics/export');
            const body = await response.json();
            replayHasCommand = JSON.stringify(body.sshTerminal?.sessionReplays ?? []).includes(expectedCommand);
            socketDiagnostics = body.sshTerminal?.websocket ?? null;
            shellStatus = {
              activeSessions: body.sshTerminal?.activeSessions,
              byMode: body.sshTerminal?.byMode,
            };
          } catch {
            replayHasCommand = false;
          }
          return {
            terminalHasCommand: terminalText.includes(expectedCommand),
            terminalHasSimulatedOutput: terminalText.includes('command simulated.'),
            replayHasCommand,
            terminalState,
            sessionCount,
            networkState,
            shellStatus,
            socketDiagnostics,
            terminalTail: terminalText.slice(-600),
            messageText,
          };
        }, customRunbookUpdatedCommand);
        throw new Error(`SSH runbook custom command did not render in terminal after click: ${JSON.stringify(runbookRunState)}; ${error instanceof Error ? error.message : String(error)}`);
      }

      const deletedRunbookIds = [customRunbookId, customRunbookSecondId];
      await customRunbookSecondCard.locator('[data-ssh-runbook-command-delete]').click();
      await targetPage.locator('.action-message').filter({ hasText: /runbook command deleted/i }).waitFor({ timeout: 5000 });
      await customRunbookSecondCard.waitFor({ state: 'detached', timeout: 5000 });
      customRunbookSecondId = '';
      await customRunbookCard.locator('[data-ssh-runbook-command-delete]').click();
      await targetPage.locator('.action-message').filter({ hasText: /runbook command deleted/i }).waitFor({ timeout: 5000 });
      await customRunbookCard.waitFor({ state: 'detached', timeout: 5000 });
      const runbookApiAfterDelete = await targetPage.evaluate(async (ids) => {
        const response = await fetch('/api/servers/ssh-runbook');
        return response.json().then((body) => ({ status: response.status, body, ids }));
      }, deletedRunbookIds);
      if (runbookApiAfterDelete.status !== 200 || runbookApiAfterDelete.body.commands?.some((item) => deletedRunbookIds.includes(item.id))) {
        throw new Error(`SSH runbook API still returned deleted command: ${JSON.stringify(runbookApiAfterDelete)}`);
      }
      customRunbookId = '';
    } finally {
      if (customRunbookSecondId) {
        await targetPage.evaluate((staleId) => fetch(`/api/servers/ssh-runbook/${encodeURIComponent(staleId)}`, { method: 'DELETE' }).catch(() => undefined), customRunbookSecondId);
      }
      if (customRunbookId) {
        await targetPage.evaluate((staleId) => fetch(`/api/servers/ssh-runbook/${encodeURIComponent(staleId)}`, { method: 'DELETE' }).catch(() => undefined), customRunbookId);
      }
    }
    const importedPackIds = [];
    try {
      await targetPage.locator('[data-ssh-runbook-pack-import="system"]').click();
      await targetPage.locator('.action-message').filter({ hasText: /Imported 3/i }).waitFor({ timeout: 5000 });
      await targetPage.locator('[data-ssh-runbook-command]').filter({ hasText: 'System load snapshot' }).waitFor({ timeout: 5000 });
      const packImportState = await targetPage.evaluate(async () => {
        const response = await fetch('/api/servers/ssh-runbook');
        const body = await response.json();
        const imported = Array.isArray(body.commands)
          ? body.commands.filter((item) => ['System load snapshot', 'Top CPU processes', 'Failed services check'].includes(item.title))
          : [];
        return { status: response.status, imported };
      });
      if (packImportState.status !== 200 || packImportState.imported.length !== 3) {
        throw new Error(`SSH runbook pack import did not persist expected commands: ${JSON.stringify(packImportState)}`);
      }
      importedPackIds.push(...packImportState.imported.map((item) => item.id));
    } finally {
      if (importedPackIds.length) {
        await targetPage.evaluate((ids) => Promise.all(ids.map((id) => fetch(`/api/servers/ssh-runbook/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined))), importedPackIds);
      }
    }
    await targetPage.locator('[data-ssh-quick-command-insert="identity"]').click();
    await targetPage.locator('.action-message').filter({ hasText: /Inserted System and uptime/i }).waitFor({ timeout: 5000 });
    await targetPage.keyboard.press('Enter');
    await targetPage.waitForFunction(() => {
      const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
      return terminalText.includes('simulated$ uname -a && uptime') && terminalText.includes('command simulated.');
    }, undefined, { timeout: 10000 });
    await targetPage.locator('[data-ssh-quick-command-run="disk"]').click();
    await targetPage.waitForFunction(() => {
      const terminalText = document.querySelector('.ssh-terminal-screen .xterm-rows')?.textContent ?? '';
      return terminalText.includes('simulated$ df -h') && terminalText.includes('command simulated.');
    }, undefined, { timeout: 10000 });
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
    if (!/(Smooth|High latency|Low throughput|Measuring)/i.test(terminalNetworkText)) {
      throw new Error(`SSH terminal network diagnostics did not classify interactive quality: ${terminalNetworkText}`);
    }
    const terminalNetworkClass = await targetPage.locator('.ssh-terminal-network').getAttribute('class');
    if (!/\b(good|warn|slow|pending)\b/.test(terminalNetworkClass ?? '')) {
      throw new Error(`SSH terminal network diagnostics did not expose a quality tone: ${terminalNetworkClass}`);
    }
    const terminalQualityText = await targetPage.locator('.ssh-terminal-quality').innerText();
    if (!/(Interaction is smooth|Network latency is high|Output throughput is low|Collecting quality data|Compatible channel active)/i.test(terminalQualityText)) {
      throw new Error(`SSH terminal quality insight did not render an actionable summary: ${terminalQualityText}`);
    }
    if (!/(WebSocket live channel|Compatible stream|RTT\s+\d+ms)/i.test(terminalQualityText)) {
      throw new Error(`SSH terminal quality insight did not expose transport or metric evidence: ${terminalQualityText}`);
    }
    await targetPage.locator('[data-ssh-terminal-telemetry="true"]').waitFor({ timeout: 5000 });
    await targetPage.waitForFunction(() => {
      const inputValue = document.querySelector('[data-ssh-terminal-telemetry-card="input"] strong')?.textContent ?? '';
      const firstOutputValue = document.querySelector('[data-ssh-terminal-telemetry-card="first-output"] strong')?.textContent ?? '';
      const outputValue = document.querySelector('[data-ssh-terminal-telemetry-card="output"] strong')?.textContent ?? '';
      return !/^--$/.test(inputValue.trim()) && /\d+ms/i.test(firstOutputValue) && /(?:lines|B|KB|MB)/i.test(outputValue);
    }, undefined, { timeout: 5000 });
    const terminalTelemetryText = await targetPage.locator('[data-ssh-terminal-telemetry="true"]').innerText();
    if (!/Live telemetry/i.test(terminalTelemetryText) || !/Input/i.test(terminalTelemetryText) || !/First output/i.test(terminalTelemetryText) || !/Output/i.test(terminalTelemetryText) || !/Render/i.test(terminalTelemetryText)) {
      throw new Error(`SSH terminal live telemetry did not render the full instrument strip: ${terminalTelemetryText}`);
    }
    if (!/(Live interaction is smooth|Live interaction needs watching|Live interaction is lagging|Collecting live samples)/i.test(terminalTelemetryText)) {
      throw new Error(`SSH terminal live telemetry did not render an actionable status: ${terminalTelemetryText}`);
    }
    const telemetryCardCount = await targetPage.locator('[data-ssh-terminal-telemetry-card]').count();
    if (telemetryCardCount !== 4) {
      throw new Error(`SSH terminal live telemetry should expose four cards, got ${telemetryCardCount}`);
    }
    const terminalTelemetryClass = await targetPage.locator('[data-ssh-terminal-telemetry="true"]').getAttribute('class');
    if (!/\b(good|warn|slow|pending)\b/.test(terminalTelemetryClass ?? '')) {
      throw new Error(`SSH terminal live telemetry did not expose a quality tone: ${terminalTelemetryClass}`);
    }
    if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(terminalTelemetryText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(terminalTelemetryText)) {
      throw new Error('SSH terminal live telemetry rendered a raw IP address or API key');
    }
    await targetPage.locator('[data-ssh-terminal-bottleneck="true"]').waitFor({ timeout: 5000 });
    const terminalBottleneckText = await targetPage.locator('[data-ssh-terminal-bottleneck="true"]').innerText();
    if (!/Bottleneck radar/i.test(terminalBottleneckText) || !/Network/i.test(terminalBottleneckText) || !/Input/i.test(terminalBottleneckText) || !/Output/i.test(terminalBottleneckText) || !/Render/i.test(terminalBottleneckText)) {
      throw new Error(`SSH terminal bottleneck radar did not render all diagnosis lanes: ${terminalBottleneckText}`);
    }
    if (!/(No major bottleneck found|needs watching|is the main bottleneck|Waiting for live data)/i.test(terminalBottleneckText)) {
      throw new Error(`SSH terminal bottleneck radar did not render a diagnosis summary: ${terminalBottleneckText}`);
    }
    const bottleneckItemCount = await targetPage.locator('[data-ssh-terminal-bottleneck-item]').count();
    if (bottleneckItemCount !== 4) {
      throw new Error(`SSH terminal bottleneck radar should expose four lanes, got ${bottleneckItemCount}`);
    }
    const terminalBottleneckClass = await targetPage.locator('[data-ssh-terminal-bottleneck="true"]').getAttribute('class');
    if (!/\b(good|warn|slow|pending)\b/.test(terminalBottleneckClass ?? '')) {
      throw new Error(`SSH terminal bottleneck radar did not expose a quality tone: ${terminalBottleneckClass}`);
    }
    const radarWidths = await targetPage.locator('[data-ssh-terminal-bottleneck-item] i b').evaluateAll((bars) => bars.map((bar) => Number.parseFloat(getComputedStyle(bar).width)));
    if (radarWidths.length !== 4 || radarWidths.some((width) => !Number.isFinite(width) || width <= 0)) {
      throw new Error(`SSH terminal bottleneck radar bars did not render measurable widths: ${radarWidths.join(', ')}`);
    }
    if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(terminalBottleneckText) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(terminalBottleneckText)) {
      throw new Error('SSH terminal bottleneck radar rendered a raw IP address or API key');
    }
    console.log(`ok browser e2e SSH burst output rendered in ${burstOutputDurationMs}ms with max long task ${maxBurstLongTaskMs}ms`);
    await assertElementWithinViewport(targetPage, '.ssh-console', 'desktop SSH console');
    await captureVisualEvidence(targetPage, 'desktop-ssh-terminal-network', ['.ssh-console', '.ssh-terminal-network', '.ssh-terminal-quality', '[data-ssh-terminal-telemetry="true"]', '[data-ssh-terminal-bottleneck="true"]']);
    await targetPage.getByRole('button', { name: /disconnect/i }).click();
    await targetPage.locator('.ssh-console').waitFor({ state: 'hidden', timeout: 5000 });
    const disconnectMessage = targetPage.locator('.action-message').filter({ hasText: /disconnected/i });
    await disconnectMessage.waitFor({ timeout: 5000 });
    await disconnectMessage.waitFor({ state: 'hidden', timeout: 7000 });
    const storedSshBottleneckHistory = await targetPage.evaluate(() => window.localStorage.getItem('colipas.sshBottleneckRadarHistory.v1') ?? '');
    const parsedSshBottleneckHistory = JSON.parse(storedSshBottleneckHistory || '[]');
    if (
      !Array.isArray(parsedSshBottleneckHistory)
      || parsedSshBottleneckHistory.length < 1
      || parsedSshBottleneckHistory.some((snapshot) => snapshot.version !== 1 || !['network', 'input', 'output', 'render'].includes(snapshot.primary) || !snapshot.levels || !snapshot.metrics)
    ) {
      throw new Error(`SSH bottleneck trend storage is missing sanitized snapshots: ${storedSshBottleneckHistory}`);
    }
    if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(storedSshBottleneckHistory) || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(storedSshBottleneckHistory) || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(storedSshBottleneckHistory)) {
      throw new Error('SSH bottleneck trend storage leaked a raw IP address or secret');
    }
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
    console.log('ok browser e2e covers interactive xterm SSH terminal, quick commands, copy/clear tools, status count, and panel disconnect cleanup');
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

async function assertOverviewHealthBaseline(targetPage) {
  await targetPage.goto(`${baseUrl}/admin/#overview`, { waitUntil: 'networkidle', timeout: 30000 });
  const baseline = targetPage.locator('[data-health-baseline="true"]');
  await baseline.waitFor({ timeout: 10000 });
  const baselineText = await baseline.innerText();
  const requiredPhrases = [
    /Health baseline alerts/i,
    /Health score/i,
    /Resource level/i,
    /SSH coverage/i,
    /Event pressure/i,
    /Trend snapshot/i,
    /Next best actions/i,
  ];
  for (const phrase of requiredPhrases) {
    if (!phrase.test(baselineText)) {
      throw new Error(`Overview health baseline is missing ${phrase}: ${baselineText}`);
    }
  }
  const signalCount = await baseline.locator('.health-baseline-signal').count();
  if (signalCount !== 3) {
    throw new Error(`Overview health baseline should render three signals, got ${signalCount}`);
  }
  const scoreText = await baseline.locator('.health-baseline-score strong').innerText();
  const score = Number(scoreText);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`Overview health baseline score is invalid: ${scoreText}`);
  }
  const trend = baseline.locator('[data-health-trend="true"]');
  await trend.waitFor({ timeout: 10000 });
  const trendText = await trend.innerText();
  if (!/Trend snapshot/i.test(trendText)) {
    throw new Error(`Overview health trend snapshot is missing from baseline card: ${trendText}`);
  }
  const storedTrend = await targetPage.evaluate(() => window.localStorage.getItem('colipas.overview.healthTrend.v1'));
  if (!storedTrend) {
    throw new Error('Overview health trend did not persist an anonymous browser snapshot');
  }
  const parsedTrend = JSON.parse(storedTrend);
  if (!Array.isArray(parsedTrend) || parsedTrend.length < 1 || parsedTrend.length > 12) {
    throw new Error(`Overview health trend stored invalid history: ${storedTrend}`);
  }
  for (const point of parsedTrend) {
    const keys = Object.keys(point).sort().join(',');
    if (keys !== 'score,timestamp,tone') {
      throw new Error(`Overview health trend should store only anonymous score/tone/timestamp fields, got ${keys}`);
    }
    if (!Number.isFinite(point.score) || point.score < 0 || point.score > 100 || !Number.isFinite(point.timestamp)) {
      throw new Error(`Overview health trend stored invalid point: ${JSON.stringify(point)}`);
    }
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b|sk-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(baselineText)) {
    throw new Error('Overview health baseline leaked a raw IP address or secret');
  }
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b|sk-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(storedTrend)) {
    throw new Error('Overview health trend storage leaked a raw IP address or secret');
  }
  await assertElementWithinViewport(targetPage, '[data-health-baseline="true"]', 'desktop overview health baseline');
  await captureVisualEvidence(targetPage, 'desktop-overview-health-baseline', ['[data-health-baseline="true"]', '.monitor-kpis']);

  const draftButton = baseline.locator('.health-baseline-draft-button');
  await draftButton.waitFor({ timeout: 10000 });
  const draftButtonText = await draftButton.innerText();
  if (!/Create ops draft/i.test(draftButtonText)) {
    throw new Error(`Overview health baseline should expose an operations draft CTA, got ${draftButtonText}`);
  }
  await draftButton.click();
  await targetPage.locator('#ops-title').waitFor({ timeout: 10000 });
  const draftBanner = targetPage.locator('[data-ops-draft-banner="true"]');
  await draftBanner.waitFor({ timeout: 10000 });
  const draftBannerText = await draftBanner.innerText();
  if (!/Health draft generated|Overview health response draft/i.test(draftBannerText)) {
    throw new Error(`Operations draft banner is missing health draft context: ${draftBannerText}`);
  }
  await targetPage.locator('.ops-builder').waitFor({ timeout: 10000 });
  await targetPage.waitForFunction(
    () => {
      const targetScope = document.querySelector('.ops-builder select');
      return targetScope instanceof HTMLSelectElement && targetScope.value === 'allServers';
    },
    null,
    { timeout: 10000 },
  );
  if (!/#operations/.test(targetPage.url())) {
    throw new Error(`Overview operations draft should route to operations, got ${targetPage.url()}`);
  }
  const preflightOnlyButton = targetPage.locator('[data-ops-draft-preflight-button="true"]');
  await preflightOnlyButton.waitFor({ timeout: 10000 });
  const tasksBeforePreflight = await targetPage.locator('.ops-task-item').count();
  await preflightOnlyButton.click();
  await targetPage.waitForFunction(
    () => {
      const preflightCard = document.querySelector('.ops-preflight-card');
      return preflightCard && !/Preflight not run/i.test(preflightCard.textContent || '');
    },
    null,
    { timeout: 10000 },
  );
  const tasksAfterPreflight = await targetPage.locator('.ops-task-item').count();
  if (tasksAfterPreflight !== tasksBeforePreflight) {
    throw new Error(`Preflight-only should not create a task, before=${tasksBeforePreflight}, after=${tasksAfterPreflight}`);
  }
  const preflightHistoryPanel = targetPage.locator('[data-ops-preflight-history="true"]');
  await preflightHistoryPanel.waitFor({ timeout: 10000 });
  const preflightHistoryItem = preflightHistoryPanel.locator('[data-ops-preflight-history-item="true"]').first();
  await preflightHistoryItem.waitFor({ timeout: 10000 });
  const preflightHistoryText = await preflightHistoryPanel.innerText();
  if (!/Preflight history|Latest|Ready to run|Blocked|Targets|Evidence/i.test(preflightHistoryText)) {
    throw new Error(`Operations preflight history should keep the latest preflight evidence, got ${preflightHistoryText}`);
  }
  if (/0\/0/.test(preflightHistoryText)) {
    throw new Error(`Operations preflight history should not show an all-server asset draft as 0/0 targets: ${preflightHistoryText}`);
  }
  await preflightHistoryItem.click();
  const tasksAfterHistoryRestore = await targetPage.locator('.ops-task-item').count();
  if (tasksAfterHistoryRestore !== tasksBeforePreflight) {
    throw new Error(`Restoring preflight history should not create a task, before=${tasksBeforePreflight}, after=${tasksAfterHistoryRestore}`);
  }
  await captureVisualEvidence(targetPage, 'desktop-ops-health-draft', ['[data-ops-draft-banner="true"]', '.ops-builder']);
  const preflightEvidenceButton = preflightHistoryPanel.locator('[data-ops-preflight-evidence-button="true"]').first();
  await preflightEvidenceButton.click();
  await targetPage.waitForURL(/#security\?trace=ops-trace-[a-f0-9-]+$/, { timeout: 10000 });
  const preflightTraceId = new URL(targetPage.url()).hash.replace(/^#security\?trace=/, '');
  const preflightAuditRows = await waitForAuditEvents(targetPage, preflightTraceId, 1);
  if (preflightAuditRows.length < 1) {
    throw new Error(`Preflight evidence button should focus its audit trace, got ${preflightAuditRows.length} rows`);
  }

  await targetPage.locator('button.nav-item', { hasText: /Overview/i }).click();
  const rerenderedBaseline = targetPage.locator('[data-health-baseline="true"]');
  await rerenderedBaseline.waitFor({ timeout: 10000 });
  const overviewPreflightSnapshot = targetPage.locator('[data-overview-preflight-snapshot="true"]');
  await overviewPreflightSnapshot.waitFor({ timeout: 10000 });
  const overviewPreflightText = await overviewPreflightSnapshot.innerText();
  if (!/Latest preflight|Ready to run|Blocked|targets runnable/i.test(overviewPreflightText)) {
    throw new Error(`Overview should show the latest operations preflight summary, got ${overviewPreflightText}`);
  }
  await rerenderedBaseline.locator('[data-health-signal="ssh"]').click();
  await targetPage.locator('#servers-title').waitFor({ timeout: 10000 });
  const healthScopeChip = targetPage.locator('[data-health-scope-chip="true"]');
  await healthScopeChip.waitFor({ timeout: 10000 });
  const healthScopeText = await healthScopeChip.innerText();
  if (!/Assets missing SSH|SSH/i.test(healthScopeText)) {
    throw new Error(`Servers page should show the SSH health filter chip, got ${healthScopeText}`);
  }
  if (!/#servers/.test(targetPage.url())) {
    throw new Error(`SSH health signal should route to servers, got ${targetPage.url()}`);
  }

  await targetPage.goto(`${baseUrl}/admin/#overview`, { waitUntil: 'networkidle', timeout: 30000 });
  const eventSignal = targetPage.locator('[data-health-baseline="true"] [data-health-signal="events"]');
  await eventSignal.waitFor({ timeout: 10000 });
  await eventSignal.click();
  await targetPage.locator('#security-title').waitFor({ timeout: 10000 });
  if (!/#security/.test(targetPage.url())) {
    throw new Error(`Event health signal should route to security, got ${targetPage.url()}`);
  }

  console.log('ok browser e2e covers overview health baseline alerts, trend snapshots, and action routing');
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
      '.security-ssh-bottleneck-trend',
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
    await assertElementHorizontallyWithinViewport(mobilePage, '.security-ssh-bottleneck-trend', 'mobile SSH bottleneck trend');
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

async function waitForAuditEvents(targetPage, expectedTraceId, minimumCount = 2) {
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
    if (matches.length >= minimumCount) {
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
    const actionTexts = Array.from(actionStrip?.querySelectorAll('button') ?? []).map((button) => button.textContent?.trim() ?? '');
    return {
      opsDisplay: ops ? getComputedStyle(ops).display : '',
      statusColumns: statusStrip ? getComputedStyle(statusStrip).gridTemplateColumns : '',
      actionColumns: actionStrip ? getComputedStyle(actionStrip).gridTemplateColumns : '',
      actionCount: actionTexts.length,
      actionTexts,
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
  if (metrics.statusColumns.split(' ').filter(Boolean).length !== 3 || metrics.actionCount !== 4 || metrics.actionColumns.split(' ').filter(Boolean).length > 2) {
    throw new Error(`Mobile server operation strip should expose three status chips and four compact actions: ${JSON.stringify(metrics)}`);
  }
  if (!/ssh/i.test(metrics.primaryText) || !metrics.actionTexts.some((text) => /diagnose/i.test(text)) || metrics.iconActionsDisplay !== 'none') {
    throw new Error(`Mobile server primary SSH and Diagnose actions should replace crowded icon actions: ${JSON.stringify(metrics)}`);
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
