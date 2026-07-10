import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(process.cwd());
const dataDir = path.resolve(root, '.tmp-session-persistence-check');
const expectedDataDir = `${root}${path.sep}.tmp-session-persistence-check`;
if (dataDir !== expectedDataDir) {
  throw new Error(`Unsafe session persistence test directory: ${dataDir}`);
}

fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const port = await getAvailablePort(18126);
const baseUrl = `http://127.0.0.1:${port}`;
const username = 'persistence-admin';
const loginValue = 'PersistenceCheck123';
const serverEnv = {
  ...process.env,
  NODE_ENV: 'production',
  PORT: String(port),
  CORS_ORIGIN: baseUrl,
  ADMIN_USERNAME: username,
  ADMIN_PASSWORD: loginValue,
  SESSION_SECRET: 'session-persistence-check-secret',
  SESSION_MAX_ACTIVE: '12',
  RELEASE_PUBLIC_URL: baseUrl,
  COLIPAS_DATA_DIR: dataDir,
};

let server;
try {
  server = startServer();
  await waitForHealth();
  const firstCookie = await login('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121 Safari/537.36');
  const firstSessionId = extractRawSessionId(firstCookie);
  const initialSessions = await getJson('/api/account/sessions', firstCookie, 200);
  assert(initialSessions.summary?.persistent === true, 'session API reports SQLite persistence');
  assert(initialSessions.summary?.active === 1, 'initial persisted session is active');

  await stopServer();
  server = startServer();
  await waitForHealth();
  await getJson('/api/account', firstCookie, 200);

  const secondCookie = await login('Mozilla/5.0 (X11; Linux x86_64) Edg/121');
  const secondSessionId = extractRawSessionId(secondCookie);
  const restartedSessions = await getJson('/api/account/sessions', firstCookie, 200);
  const otherSession = restartedSessions.items?.find((item) => !item.current);
  assert(restartedSessions.summary?.active === 2 && otherSession?.id, 'restart restores the first session and accepts a second');
  await fetchJson(`/api/account/sessions/${otherSession.id}`, {
    method: 'DELETE',
    headers: { Cookie: firstCookie },
  }, 200);

  await stopServer();
  server = startServer();
  await waitForHealth();
  await getJson('/api/account', firstCookie, 200);
  await getJson('/api/account', secondCookie, 401);

  const databasePath = path.join(dataDir, 'colipas.sqlite');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM auth_sessions ORDER BY created_at ASC').all();
    const columns = db.prepare('PRAGMA table_info(auth_sessions)').all().map((column) => column.name);
    const serializedRows = JSON.stringify(rows);
    assert(rows.length === 1, 'revoked session remains deleted after restart');
    assert(rows.every((row) => /^[a-f0-9]{64}$/.test(String(row.token_hash))), 'database stores only fixed-length token hashes');
    assert(!serializedRows.includes(firstSessionId) && !serializedRows.includes(secondSessionId), 'database never stores raw session IDs');
    assert(
      columns.join(',') === 'token_hash,username,device_label,created_at,last_seen_at,expires_at',
      'session table contains only bounded hashed-token and sanitized metadata columns',
    );
  } finally {
    db.close();
  }

  await fetchJson('/api/auth/logout', {
    method: 'POST',
    headers: { Cookie: firstCookie },
  }, 200);
  await getJson('/api/account', firstCookie, 401);

  await stopServer();
  server = startServer();
  await waitForHealth();
  await getJson('/api/account', firstCookie, 401);

  const finalDb = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const count = finalDb.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get();
    assert(Number(count.count) === 0, 'logout deletion remains effective after another restart');
  } finally {
    finalDb.close();
  }

  console.log(JSON.stringify({
    ok: true,
    restartRecoveries: 2,
    persistedRowsAfterRevoke: 1,
    persistedRowsAfterLogout: 0,
    rawSessionIdsStored: false,
  }));
} finally {
  await stopServer().catch(() => undefined);
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function startServer() {
  const child = spawn(process.execPath, ['build/server/index.js'], {
    cwd: root,
    env: serverEnv,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => undefined);
  child.stderr.on('data', () => undefined);
  return child;
}

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) {
    server = undefined;
    return;
  }

  const child = server;
  server = undefined;
  const exitPromise = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server && (server.exitCode !== null || server.signalCode !== null)) {
      throw new Error(`Session persistence test server exited early with ${server.exitCode ?? server.signalCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Wait for the isolated production server.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Session persistence test server did not become healthy at ${baseUrl}`);
}

async function login(userAgent) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
    },
    body: JSON.stringify({ username, password: loginValue }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!response.ok || !cookie) {
    throw new Error(`Session persistence login failed with HTTP ${response.status}`);
  }
  return cookie;
}

async function getJson(route, cookie, expectedStatus) {
  return fetchJson(route, { headers: { Cookie: cookie } }, expectedStatus);
}

async function fetchJson(route, options, expectedStatus) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const body = await response.json().catch(() => ({}));
  if (response.status !== expectedStatus) {
    throw new Error(`${route} expected HTTP ${expectedStatus}, got ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function extractRawSessionId(cookie) {
  const encodedToken = cookie.slice(cookie.indexOf('=') + 1);
  const token = decodeURIComponent(encodedToken);
  const [sessionId] = token.split('.');
  if (!/^[a-f0-9]{64}$/.test(sessionId)) {
    throw new Error('Session persistence check could not parse the raw session ID');
  }
  return sessionId;
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
