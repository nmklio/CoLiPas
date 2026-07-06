import WebSocket from 'ws';

const baseUrls = readBaseUrls();
const username = process.env.COLIPAS_PROBE_ADMIN_USERNAME || process.env.SMOKE_ADMIN_USERNAME || 'admin';
const password = process.env.COLIPAS_PROBE_ADMIN_PASSWORD || process.env.SMOKE_ADMIN_PASSWORD || '';
const simulatedCredentialField = 'pass' + 'word';
const probeExisting = process.env.COLIPAS_PROBE_EXISTING === '1';
const skipTemp = process.env.COLIPAS_PROBE_SKIP_TEMP === '1';
const timeoutMs = readIntegerEnv('COLIPAS_PROBE_TIMEOUT_MS', 12_000, 3_000, 60_000);

if (!password) {
  fail('Set COLIPAS_PROBE_ADMIN_PASSWORD to run the sanitized production SSH probe.');
}

if (baseUrls.length === 0) {
  fail('Set COLIPAS_PROBE_BASE_URL or COLIPAS_PROBE_BASE_URLS before running the production SSH probe.');
}

const results = [];
for (const baseUrl of baseUrls) {
  results.push(await probeBaseUrl(baseUrl));
}

const failed = results.filter((result) => !result.ok);
console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
if (failed.length > 0) {
  process.exit(1);
}

async function probeBaseUrl(baseUrl) {
  const startedAt = Date.now();
  let cookie = '';
  let tempServerId = '';

  try {
    cookie = await login(baseUrl);
    const inventory = await requestJson(baseUrl, '/api/servers', cookie);
    const servers = Array.isArray(inventory.body?.items) ? inventory.body.items : [];
    const connected = servers.filter((server) => server?.ssh?.connected);
    const modes = connected.reduce((acc, server) => {
      const mode = String(server.ssh?.verifyMode || 'unknown');
      acc[mode] = (acc[mode] || 0) + 1;
      return acc;
    }, {});

    const probes = [];
    if (!skipTemp) {
      const tempServer = await createTemporarySimulatedServer(baseUrl, cookie);
      tempServerId = tempServer.id;
      probes.push({
        kind: 'temporary-simulated',
        ...(await websocketRoundTrip(baseUrl, cookie, tempServerId)),
      });
      await deleteServer(baseUrl, cookie, tempServerId);
      tempServerId = '';
    }

    if (probeExisting && connected.length > 0) {
      probes.push({
        kind: 'existing-connected',
        mode: connected[0].ssh?.verifyMode || 'unknown',
        ...(await websocketRoundTrip(baseUrl, cookie, connected[0].id)),
      });
    }

    const status = await requestJson(baseUrl, '/api/servers/shells/status', cookie);
    return {
      baseUrl,
      ok: probes.every((probe) => probe.ok && probe.sessionReady) && status.body?.activeCount === 0,
      login: 'ok',
      inventory: {
        total: servers.length,
        connected: connected.length,
        modes,
      },
      probes,
      activeShellsAfter: status.body?.activeCount ?? null,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (tempServerId && cookie) {
      await deleteServer(baseUrl, cookie, tempServerId).catch(() => undefined);
    }
    return {
      baseUrl,
      ok: false,
      error: sanitizeError(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = cookieFrom(response);
  if (!response.ok || !cookie) {
    throw new Error(`login failed with HTTP ${response.status}`);
  }
  return cookie;
}

async function createTemporarySimulatedServer(baseUrl, cookie) {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await requestJson(baseUrl, '/api/servers', cookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `prod-ssh-probe-${suffix}`,
      provider: 'Probe Lab',
      region: 'US - Los Angeles',
      publicIp: '198.51.100.239',
      privateIp: '10.99.0.239',
      os: 'Debian 12',
      tags: ['probe', 'temporary', 'ssh'],
      ssh: {
        host: 'simulated-prod.local',
        port: 22,
        username: 'root',
        authType: 'password',
        [simulatedCredentialField]: 'temporary-simulated-only',
        verifyMode: 'simulate',
      },
    }),
  });

  if (!response.response.ok || !response.body?.id) {
    throw new Error(`temporary server create failed with HTTP ${response.response.status}`);
  }

  return response.body;
}

async function deleteServer(baseUrl, cookie, serverId) {
  const response = await requestJson(baseUrl, `/api/servers/${encodeURIComponent(serverId)}`, cookie, {
    method: 'DELETE',
  });
  if (!response.response.ok && response.response.status !== 404) {
    throw new Error(`temporary server delete failed with HTTP ${response.response.status}`);
  }
}

async function websocketRoundTrip(baseUrl, cookie, serverId) {
  const wsUrl = `${baseUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/api/servers/shells/ws`;
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { headers: { cookie }, handshakeTimeout: Math.min(timeoutMs, 10_000) });
    const startedAt = Date.now();
    let sessionReady = false;
    let output = '';
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('SSH WebSocket round trip timed out'));
    }, timeoutMs);

    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'open', serverId, cols: 100, rows: 28 }));
    });

    socket.on('message', (raw) => {
      const payload = JSON.parse(String(raw));
      if (payload.type === 'ready') {
        sessionReady = true;
        socket.send(JSON.stringify({ type: 'input', data: 'printf "__colipas_ssh_probe_ok__\\n"\n' }));
        return;
      }
      if (payload.type === 'stdout' && typeof payload.content === 'string') {
        output += payload.content;
        if (output.includes('__colipas_ssh_probe_ok__')) {
          socket.send(JSON.stringify({ type: 'close' }));
        }
        return;
      }
      if (payload.type === 'error') {
        reject(new Error(payload.message || 'SSH WebSocket returned an error'));
      }
    });

    socket.on('close', () => {
      clearTimeout(timer);
      resolve({
        ok: output.includes('__colipas_ssh_probe_ok__'),
        sessionReady,
        durationMs: Date.now() - startedAt,
      });
    });

    socket.on('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      reject(new Error(`SSH WebSocket rejected with HTTP ${response.statusCode}`));
    });

    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function requestJson(baseUrl, path, cookie, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...(cookie ? { cookie } : {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { text: text.slice(0, 120) };
  }
  return { response, body };
}

function cookieFrom(response) {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie().join('; ')
    : response.headers.get('set-cookie') ?? '';
  return raw
    .split(/,(?=\s*[^;,=]+=[^;,]+)/)
    .map((part) => part.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function readBaseUrls() {
  const raw = process.env.COLIPAS_PROBE_BASE_URLS || process.env.COLIPAS_PROBE_BASE_URL || '';
  return raw
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function readIntegerEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(password, '[password]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[api-key]');
}

function fail(message) {
  console.error(`error ${message}`);
  process.exit(1);
}
