import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const root = process.cwd();
const serverCount = clampNumber(process.env.LARGE_SIM_SERVER_COUNT, 100, 3000, 1000);
const userCount = clampNumber(process.env.LARGE_SIM_USERS, 4, 80, 24);
const createConcurrency = clampNumber(process.env.LARGE_SIM_CREATE_CONCURRENCY, 2, 64, 16);
const expectedServerRenderBatch = 120;
const dataDir = path.resolve(root, '.tmp-large-simulation-data');
const evidenceDir = path.resolve(root, 'output', 'large-user-simulation');
const adminUsername = 'admin';
const adminPassword = 'admin123456';
const releaseVerifyToken = 'large-simulation-release-token-12345';
const runId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
const createdIds = [];

assertSafeTemporaryPath(dataDir);
fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
fs.rmSync(evidenceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
fs.mkdirSync(evidenceDir, { recursive: true });

const upstreamPort = await getAvailablePort(19080);
const upstream = await startMockUpstream(upstreamPort);
const port = await getAvailablePort(Number(process.env.LARGE_SIM_PORT || 18180));
const baseUrl = `http://127.0.0.1:${port}`;
const timings = {};
const assertions = [];
let browser;
let appServer;

try {
  appServer = startApplicationServer(port, upstreamPort);
  await waitForHealth(baseUrl);

  const adminHeaders = await login(baseUrl);
  await timed('insertServersMs', async () => {
    const payloads = buildServerPayloads(serverCount);
    const responses = await mapWithConcurrency(payloads, createConcurrency, async (payload, index) => {
      const response = await postJson(baseUrl, '/api/servers', payload, adminHeaders, 201);
      if (!response.body.id) {
        throw new Error(`Created server ${index} did not return an id`);
      }
      createdIds.push(response.body.id);
      return response.body;
    });

    assertions.push(`inserted ${responses.length} simulated servers through POST /api/servers`);
  });

  const sessions = await timed('loginUsersMs', () => loginUsers(baseUrl, userCount));
  await timed('apiReadWriteSimulationMs', () => runConcurrentUserSimulation(baseUrl, sessions));
  await timed('operationsSimulationMs', () => runOperationsSimulation(baseUrl, adminHeaders));
  await timed('aiSimulationMs', () => runAiSimulation(baseUrl, adminHeaders));
  await timed('securityAndReleaseSimulationMs', () => runSecurityAndReleaseSimulation(baseUrl, adminHeaders));
  await timed('browserSimulationMs', () => runBrowserSimulation(baseUrl));

  const overview = await getJson(baseUrl, '/api/overview', adminHeaders);
  const serverList = await getJson(baseUrl, '/api/servers', adminHeaders);
  assert(serverList.body.meta?.total >= serverCount, 'unpaginated server inventory reported total metadata');
  assert(serverList.body.meta?.returned >= serverCount, 'unpaginated server inventory kept backward-compatible full results');
  const firstPage = await getJson(baseUrl, '/api/servers?page=1&pageSize=75', adminHeaders);
  const secondPage = await getJson(baseUrl, '/api/servers?page=2&pageSize=75', adminHeaders);
  assert(firstPage.body.items?.length === 75, 'server inventory pagination returned the requested first page size');
  assert(firstPage.body.meta?.total >= serverCount && firstPage.body.meta?.hasMore === true, 'server inventory pagination exposed total and hasMore metadata');
  assert(secondPage.body.items?.length === 75 && secondPage.body.items[0]?.id !== firstPage.body.items[0]?.id, 'server inventory pagination returned a distinct second page');
  const summary = buildSummary(overview.body, serverList.body);
  writeEvidence(summary);

  console.log(`ok large user simulation inserted ${summary.inventory.totalServers} servers`);
  console.log(`ok simulated ${userCount} concurrent users; timings ${JSON.stringify(timings)}`);
  console.log(`ok evidence written to ${path.relative(root, path.join(evidenceDir, 'summary.json'))}`);
} finally {
  await browser?.close().catch(() => undefined);
  await stopServer(appServer).catch(() => undefined);
  await closeHttpServer(upstream).catch(() => undefined);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function timed(label, callback) {
  const startedAt = performance.now();
  const result = await callback();
  timings[label] = Math.round(performance.now() - startedAt);
  return result;
}

async function runConcurrentUserSimulation(targetBaseUrl, sessions) {
  const overviewReads = await Promise.all(sessions.map((headers) => getJson(targetBaseUrl, '/api/overview', headers)));
  assert(overviewReads.every((response) => response.status === 200), 'all concurrent overview reads returned HTTP 200');
  assert(
    overviewReads.every((response) => response.body.summary.totalServers >= serverCount),
    'all concurrent overview reads saw the large inventory',
  );

  const filteredReads = await Promise.all(sessions.flatMap((headers) => [
    getJson(targetBaseUrl, '/api/servers?status=unconnected', headers),
    getJson(targetBaseUrl, '/api/servers?status=running', headers),
    getJson(targetBaseUrl, '/api/servers?provider=Custom', headers),
    getJson(targetBaseUrl, `/api/servers?region=${encodeURIComponent('SG - Singapore')}`, headers),
  ]));
  assert(filteredReads.every((response) => response.status === 200), 'all concurrent server filter reads returned HTTP 200');
  assert(filteredReads.some((response) => response.body.items?.length > 0), 'server filters returned non-empty large-data slices');

  const patchTargets = createdIds.slice(0, sessions.length);
  const patchResponses = await Promise.all(patchTargets.map((id, index) => patchJson(targetBaseUrl, `/api/servers/${id}`, {
    tags: ['loadtest', `user-${index}`, 'patched'],
  }, sessions[index % sessions.length])));
  assert(patchResponses.every((response) => response.status === 200), 'concurrent user profile-like server edits returned HTTP 200');

  const apiResponses = await Promise.all(sessions.slice(0, Math.min(8, sessions.length)).map((headers, index) => postJson(targetBaseUrl, '/api/custom-apis/test', {
    name: `load-user-api-${index}`,
    method: 'GET',
    url: `http://127.0.0.1:${upstreamPort}/status?user=${index}`,
    headersText: 'Accept: application/json',
    bodyText: '',
    authToken: '',
  }, headers, 200)));
  assert(apiResponses.every((response) => response.body.ok === true), 'loopback custom API checks succeeded under the test allowlist');

  const blocked = await postJson(targetBaseUrl, '/api/custom-apis/test', {
    name: 'blocked-metadata',
    method: 'GET',
    url: 'http://169.254.169.254/latest/meta-data',
    headersText: '',
    bodyText: '',
    authToken: '',
  }, sessions[0], [400, 403]);
  assert(blocked.status === 400 || blocked.status === 403, 'custom API SSRF guard blocked metadata address');
}

async function runOperationsSimulation(targetBaseUrl, headers) {
  const allPreflight = await postJson(targetBaseUrl, '/api/operations/tasks/preflight', {
    type: 'assetSync',
    targetMode: 'allServers',
  }, headers, 200);
  assert(allPreflight.body.summary.totalTargets >= serverCount, 'asset sync preflight included the large inventory');
  assert(allPreflight.body.ok === true, 'asset sync preflight stayed runnable for inventory-only assets');

  const assetSync = await postJson(targetBaseUrl, '/api/operations/tasks', {
    type: 'assetSync',
    targetMode: 'allServers',
  }, headers, 202);
  assert(assetSync.body.summary.total >= serverCount, 'asset sync operation returned one result per simulated server');
  assert(assetSync.body.summary.failed === 0, 'asset sync operation completed without target failures');

  const connectedIds = await findConnectedServerIds(targetBaseUrl, headers, 8);
  assert(connectedIds.length >= 4, 'simulation created SSH-connected targets for operations');

  const health = await postJson(targetBaseUrl, '/api/operations/tasks', {
    type: 'healthCheck',
    targetMode: 'selected',
    serverIds: connectedIds.slice(0, 4),
  }, headers, 202);
  assert(health.body.summary.success === 4, 'selected simulated SSH health checks succeeded');

  const shutdownBlocked = await postJson(targetBaseUrl, '/api/servers/actions', {
    serverId: connectedIds[0],
    action: 'shutdown',
    reason: 'large simulation confirmation guard',
    confirmed: false,
  }, headers, 409);
  assert(shutdownBlocked.body.error?.code === 'SERVER_ACTION_CONFIRMATION_REQUIRED', 'shutdown action required operator confirmation');

  const commandStream = await postSse(targetBaseUrl, '/api/servers/commands/stream', {
    serverId: connectedIds[1],
    command: 'printf "large-simulation-ok\\n"',
  }, headers);
  assert(commandStream.includes('"type":"stdout"') && commandStream.includes('"type":"done"'), 'simulated SSH command stream returned stdout and done events');

  const shell = await postJson(targetBaseUrl, '/api/servers/shells', {
    serverId: connectedIds[2],
    cols: 120,
    rows: 30,
  }, headers, 201);
  await postJson(targetBaseUrl, `/api/servers/shells/${encodeURIComponent(shell.body.sessionId)}/input`, {
    input: 'printf "interactive-ok"\\n',
  }, headers, 200);
  await postJson(targetBaseUrl, `/api/servers/shells/${encodeURIComponent(shell.body.sessionId)}/resize`, {
    cols: 100,
    rows: 24,
  }, headers, 200);
  await deleteJson(targetBaseUrl, `/api/servers/shells/${encodeURIComponent(shell.body.sessionId)}`, headers, 200);
  assert(shell.body.sessionId, 'simulated SSH shell opened, accepted input and resize, then closed');
}

async function runAiSimulation(targetBaseUrl, headers) {
  const question = 'Summarize the highest capacity risk in this simulated fleet in one sentence.';
  const first = await postSse(targetBaseUrl, '/api/ai/stream', {
    question,
    serverId: 'all',
    forceRefresh: false,
    provider: {
      name: 'Local Load Simulation',
      baseUrl: 'https://api.example.com/v1',
      model: 'load-sim-model',
      apiKey: '',
      temperature: 0.2,
    },
  }, headers);
  const second = await postSse(targetBaseUrl, '/api/ai/stream', {
    question,
    serverId: 'all',
    forceRefresh: false,
    provider: {
      name: 'Local Load Simulation',
      baseUrl: 'https://api.example.com/v1',
      model: 'load-sim-model',
      apiKey: '',
      temperature: 0.2,
    },
  }, headers);

  assert(first.includes('"type":"chunk"') && first.includes('"type":"done"'), 'AI stream returned chunks and done for the large inventory');
  assert(second.includes('"cached":true'), 'AI repeated prompt returned a cached response');

  const models = await postJson(targetBaseUrl, '/api/ai/models', {
    provider: {
      name: 'Local Load Simulation',
      baseUrl: 'https://api.example.com/v1',
      model: 'load-sim-model',
      apiKey: '',
      temperature: 0.2,
    },
  }, headers, 200);
  assert(models.body.source === 'fallback' && models.body.models.includes('load-sim-model'), 'AI model list fell back safely without an API key');
}

async function runSecurityAndReleaseSimulation(targetBaseUrl, headers) {
  const audit = await getJson(targetBaseUrl, '/api/audit/events', headers);
  assert(audit.body.items.length <= 200, 'audit retention stayed capped at 200 entries after bulk activity');

  const readiness = await getJson(targetBaseUrl, '/api/audit/readiness', headers);
  assert(Number.isFinite(readiness.body.score), 'security readiness returned a numeric score');

  const diagnostics = await getJson(targetBaseUrl, '/api/audit/diagnostics/export', headers);
  const diagnosticText = JSON.stringify(diagnostics.body);
  assert(!/sk-[A-Za-z0-9_-]{12,}/.test(diagnosticText), 'diagnostic export did not expose API keys');
  assert(!/BEGIN [A-Z ]*PRIVATE KEY/.test(diagnosticText), 'diagnostic export did not expose private keys');
  assert(diagnostics.body.inventory.servers.total >= serverCount, 'diagnostic export saw the large inventory');

  const release = await getJson(targetBaseUrl, '/api/release/verify', {
    Authorization: `Bearer ${releaseVerifyToken}`,
  });
  assert(release.status === 200 && release.body.ok === true, 'release verification endpoint accepted the test token');
  assert(release.body.inventory.servers.total >= serverCount, 'release verification included the large inventory');
}

async function runBrowserSimulation(targetBaseUrl) {
  const executablePath = findSystemBrowser();
  browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { headless: true });

  await withPage({ width: 1440, height: 960 }, async (page) => {
    await loginInBrowser(page, `${targetBaseUrl}/admin/#overview`);
    await page.locator('.cloud-map').waitFor({ timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('.map-country.active').length >= 8, undefined, { timeout: 20000 });
    await assertNoHorizontalOverflow(page, 'desktop overview');
    await page.getByRole('button', { name: /zoom in/i }).click();
    await page.waitForFunction(() => document.querySelector('.cloud-map')?.classList.contains('is-zoomed'), undefined, { timeout: 5000 });
    await page.locator('.map-country.active').first().click({ force: true });
    await page.locator('.map-tooltip.pinned').waitFor({ timeout: 5000 });
    await page.waitForTimeout(1200);
    assert(await page.locator('.map-tooltip.pinned').isVisible(), 'desktop map pinned tooltip remained visible');
    await page.screenshot({ path: path.join(evidenceDir, 'desktop-overview-large.png'), fullPage: false });

    await page.getByRole('button', { name: /^Servers$/i }).click();
    await page.locator('.server-workspace-row').first().waitFor({ timeout: 20000 });
    const visibleRows = await page.locator('.server-workspace-row').count();
    assert(visibleRows >= Math.min(serverCount, expectedServerRenderBatch), 'desktop server inventory rendered the first batch');
    assert(visibleRows <= expectedServerRenderBatch, 'desktop server inventory limited the initial DOM rows');
    if (serverCount > expectedServerRenderBatch) {
      await page.locator('.server-render-window').waitFor({ timeout: 5000 });
      await page.getByRole('button', { name: /load \d+ more/i }).click();
      await page.waitForFunction(
        ({ minRows, maxRows }) => {
          const rows = document.querySelectorAll('.server-workspace-row').length;
          return rows > minRows && rows <= maxRows;
        },
        { minRows: visibleRows, maxRows: expectedServerRenderBatch * 2 },
        { timeout: 5000 },
      );
      assertions.push(`desktop server inventory rendered ${visibleRows} initial rows before loading more`);
    }
    await assertNoHorizontalOverflow(page, 'desktop server inventory');
    await page.screenshot({ path: path.join(evidenceDir, 'desktop-servers-large.png'), fullPage: false });
  });

  await withPage({ width: 390, height: 844, isMobile: true }, async (page) => {
    await loginInBrowser(page, `${targetBaseUrl}/admin/#overview`);
    await page.getByRole('button', { name: /open navigation/i }).waitFor({ timeout: 10000 });
    await page.locator('.cloud-map').scrollIntoViewIfNeeded();
    await page.locator('.cloud-map').waitFor({ timeout: 20000 });
    await assertNoHorizontalOverflow(page, 'mobile overview');
    await page.locator('.map-country.active').first().click({ force: true });
    await page.locator('.map-tooltip.pinned').waitFor({ timeout: 5000 });
    await page.waitForTimeout(1200);
    assert(await page.locator('.map-tooltip.pinned').isVisible(), 'mobile map pinned tooltip remained visible');
    await page.screenshot({ path: path.join(evidenceDir, 'mobile-overview-large.png'), fullPage: false });

    await page.getByRole('button', { name: /open navigation/i }).click();
    await page.getByRole('button', { name: /^Servers$/i }).click();
    await page.locator('.server-workspace-row').first().waitFor({ timeout: 20000 });
    const mobileVisibleRows = await page.locator('.server-workspace-row').count();
    assert(mobileVisibleRows >= Math.min(serverCount, expectedServerRenderBatch), 'mobile server inventory rendered the first batch');
    assert(mobileVisibleRows <= expectedServerRenderBatch, 'mobile server inventory limited the initial DOM rows');
    if (serverCount > expectedServerRenderBatch) {
      await page.locator('.server-render-window').waitFor({ timeout: 5000 });
      await page.getByRole('button', { name: /load \d+ more/i }).click();
      await page.waitForFunction(
        ({ minRows, maxRows }) => {
          const rows = document.querySelectorAll('.server-workspace-row').length;
          return rows > minRows && rows <= maxRows;
        },
        { minRows: mobileVisibleRows, maxRows: expectedServerRenderBatch * 2 },
        { timeout: 5000 },
      );
      assertions.push(`mobile server inventory rendered ${mobileVisibleRows} initial rows before loading more`);
    }
    await assertNoHorizontalOverflow(page, 'mobile server inventory');
    await page.screenshot({ path: path.join(evidenceDir, 'mobile-servers-large.png'), fullPage: false });
  });
}

async function withPage(viewport, callback) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: Boolean(viewport.isMobile),
  });
  const consoleMessages = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleMessages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    consoleMessages.push(`pageerror: ${error.message}`);
  });
  try {
    await page.addInitScript(() => {
      window.localStorage.setItem('colipas.language', 'en');
      window.localStorage.removeItem('colipas.aiConsoleState');
      window.localStorage.removeItem('colipas.aiResponseCache');
    });
    await callback(page);
    if (consoleMessages.length > 0) {
      throw new Error(`Browser console problems:\n${consoleMessages.join('\n')}`);
    }
  } finally {
    await page.close();
  }
}

async function loginInBrowser(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.locator('input[autocomplete="username"]').fill(adminUsername);
  await page.locator('input[autocomplete="current-password"]').fill(adminPassword);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.locator('.topbar').waitFor({ timeout: 20000 });
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  assert(metrics.scrollWidth <= metrics.viewportWidth + 1, `${label} had no horizontal overflow`);
}

async function findConnectedServerIds(targetBaseUrl, headers, limit) {
  const response = await getJson(targetBaseUrl, '/api/servers?status=running', headers);
  return response.body.items
    .filter((server) => server.ssh?.connected)
    .slice(0, limit)
    .map((server) => server.id);
}

function buildSummary(overview, serverList) {
  const items = serverList.items ?? [];
  const byStatus = countBy(items.map((server) => server.status));
  const byProvider = countBy(items.map((server) => server.provider));
  const byRegion = countBy(items.map((server) => server.region));
  const connectedSsh = items.filter((server) => server.ssh?.connected).length;
  const topRegions = Object.entries(byRegion)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([region, count]) => ({ region, count }));

  return {
    runId,
    generatedAt: new Date().toISOString(),
    settings: {
      requestedServers: serverCount,
      simulatedUsers: userCount,
      createConcurrency,
      tempDataDir: path.basename(dataDir),
    },
    inventory: {
      totalServers: overview.summary.totalServers,
      onlineServers: overview.summary.onlineServers,
      listedServers: items.length,
      connectedSsh,
      byStatus,
      providerCount: Object.keys(byProvider).length,
      regionCount: Object.keys(byRegion).length,
      topRegions,
    },
    timingsMs: timings,
    assertions,
  };
}

function writeEvidence(summary) {
  fs.writeFileSync(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
}

function buildServerPayloads(count) {
  const providers = ['AWS', 'Azure', 'GCP', 'Aliyun', 'Tencent Cloud', 'OpenStack Lab', 'Private Cloud', 'Edge POP'];
  const regions = [
    'US - Virginia',
    'US - California',
    'US - New York',
    'SG - Singapore',
    'JP - Tokyo',
    'DE - Frankfurt',
    'GB - London',
    'AU - Sydney',
    'BR - Sao Paulo',
    'KR - Seoul',
    'HK - Hong Kong',
    'IN - Mumbai',
    'CA - Toronto',
  ];
  const osOptions = ['Ubuntu 24.04 LTS', 'Debian 12', 'Rocky Linux 9', 'AlmaLinux 9', 'Windows Server 2022'];

  return Array.from({ length: count }, (_, index) => {
    const provider = providers[index % providers.length];
    const region = regions[index % regions.length];
    const simulateSsh = index % 5 === 0;
    const regionCode = region
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()
      .slice(0, 20);
    const providerCode = provider.replace(/[^a-z0-9]+/gi, '').toLowerCase().slice(0, 12);

    return {
      name: `sim-${runId}-${providerCode}-${regionCode}-${String(index).padStart(4, '0')}`.slice(0, 80),
      provider,
      region,
      publicIp: simulatedIp(index),
      privateIp: `10.${Math.floor(index / 64516) % 200}.${Math.floor(index / 254) % 254}.${(index % 254) + 1}`,
      os: osOptions[index % osOptions.length],
      tags: ['loadtest', `batch-${index % 10}`, simulateSsh ? 'ssh-sim' : 'asset-only'],
      ssh: {
        host: simulatedIp(index),
        port: 22,
        username: 'root',
        authType: 'password',
        password: simulateSsh ? 'test-simulated-password' : '',
        privateKey: '',
        passphrase: '',
        verifyMode: simulateSsh ? 'simulate' : 'assetOnly',
      },
    };
  });
}

function simulatedIp(index) {
  if (index < 254) {
    return `198.51.100.${index + 1}`;
  }
  if (index < 508) {
    return `203.0.113.${index - 253}`;
  }
  if (index < 762) {
    return `192.0.2.${index - 507}`;
  }
  if (index < 762 + (64 * 254)) {
    const offset = index - 762;
    return `100.${64 + Math.floor(offset / 254)}.0.${(offset % 254) + 1}`;
  }
  const offset = index - 762 - (64 * 254);
  return `198.${18 + Math.floor(offset / 64516)}.${Math.floor(offset / 254) % 254}.${(offset % 254) + 1}`;
}

async function loginUsers(targetBaseUrl, count) {
  return Promise.all(Array.from({ length: count }, () => login(targetBaseUrl)));
}

async function login(targetBaseUrl) {
  const response = await fetch(`${targetBaseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  });
  const body = await safeJson(response);
  if (!response.ok) {
    throw new Error(`/api/auth/login returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) {
    throw new Error('/api/auth/login did not set a session cookie');
  }
  return { Cookie: cookie };
}

async function getJson(targetBaseUrl, route, headers = {}) {
  const response = await fetch(`${targetBaseUrl}${route}`, { headers });
  return {
    ok: response.ok,
    status: response.status,
    route,
    body: await safeJson(response),
  };
}

async function postJson(targetBaseUrl, route, body, headers, expectedStatus = null) {
  const response = await fetch(`${targetBaseUrl}${route}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return assertExpectedStatus(response, route, await safeJson(response), expectedStatus);
}

async function patchJson(targetBaseUrl, route, body, headers, expectedStatus = 200) {
  const response = await fetch(`${targetBaseUrl}${route}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return assertExpectedStatus(response, route, await safeJson(response), expectedStatus);
}

async function deleteJson(targetBaseUrl, route, headers, expectedStatus = 200) {
  const response = await fetch(`${targetBaseUrl}${route}`, {
    method: 'DELETE',
    headers,
  });
  return assertExpectedStatus(response, route, await safeJson(response), expectedStatus);
}

async function postSse(targetBaseUrl, route, body, headers) {
  const response = await fetch(`${targetBaseUrl}${route}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${route} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return response.text();
}

function assertExpectedStatus(response, route, body, expectedStatus) {
  const allowed = expectedStatus === null
    ? [200, 201, 202, 204]
    : Array.isArray(expectedStatus)
      ? expectedStatus
      : [expectedStatus];
  if (!allowed.includes(response.status)) {
    throw new Error(`${route} expected HTTP ${allowed.join('/')} but got ${response.status}: ${JSON.stringify(body)}`);
  }
  return {
    ok: response.ok,
    status: response.status,
    route,
    body,
  };
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function startApplicationServer(appPort, mockPort) {
  return spawn(process.execPath, ['build/server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(appPort),
      CORS_ORIGIN: `http://127.0.0.1:${appPort}`,
      CUSTOM_API_ALLOWED_HOSTS: `api.example.com,127.0.0.1,localhost`,
      CUSTOM_API_TIMEOUT_MS: '5000',
      COLIPAS_TEST_ALLOW_LOOPBACK_API: '1',
      ADMIN_USERNAME: adminUsername,
      ADMIN_PASSWORD: adminPassword,
      SESSION_SECRET: 'large-simulation-session-secret',
      RELEASE_VERIFY_TOKEN: releaseVerifyToken,
      AI_API_KEY: '',
      COLIPAS_DATA_DIR: dataDir,
      LARGE_SIM_MOCK_PORT: String(mockPort),
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForHealth(targetBaseUrl, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (appServer?.exitCode !== null) {
      throw new Error(`Application server exited early with code ${appServer.exitCode}`);
    }
    try {
      const response = await fetch(`${targetBaseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      await delay(350);
    }
  }
  throw new Error(`Timed out waiting for ${targetBaseUrl}/api/health`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 3000);
  });
}

function startMockUpstream(mockPort) {
  const server = http.createServer((request, response) => {
    const body = JSON.stringify({
      ok: true,
      method: request.method,
      path: request.url,
      checkedAt: new Date().toISOString(),
    });
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(mockPort, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function closeHttpServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function getAvailablePort(preferred) {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once('error', () => {
      const fallback = net.createServer();
      fallback.once('error', reject);
      fallback.listen(0, '127.0.0.1', () => {
        const address = fallback.address();
        fallback.close(() => resolve(address.port));
      });
    });
    tester.listen(preferred, '127.0.0.1', () => {
      tester.close(() => resolve(preferred));
    });
  });
}

function countBy(values) {
  return values.reduce((result, value) => {
    const key = value || 'unknown';
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
  assertions.push(message);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function assertSafeTemporaryPath(targetPath) {
  const relative = path.relative(root, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || path.basename(targetPath) !== '.tmp-large-simulation-data') {
    throw new Error(`Unsafe temporary data path: ${targetPath}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findSystemBrowser() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? '';
}
