const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080';
const username = process.env.SMOKE_ADMIN_USERNAME ?? 'admin';
const password = process.env.SMOKE_ADMIN_PASSWORD ?? 'admin123456';
const createdServerIds = [];

let authHeaders = {};

try {
  authHeaders = await login();

  await assertLoginRateLimit();
  await assertConcurrentProtectedReads();
  await assertConcurrentServerLifecycle();
  await assertConcurrentAiStreams();
  await assertConcurrentCustomApiBlocks();
  await assertConcurrentProfileWrites();
  await assertConcurrentSessionCapacity();

  console.log('ok concurrency check completed');
} finally {
  await cleanupCreatedServers();
}

async function login() {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    throw new Error(`/api/auth/login returned HTTP ${response.status}`);
  }
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) {
    throw new Error('/api/auth/login did not set a session cookie');
  }
  return { Cookie: cookie };
}

async function assertLoginRateLimit() {
  const rateLimitUser = `rate-limit-${Date.now()}`;

  for (let index = 0; index < 9; index += 1) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': `198.51.100.${10 + index}`,
      },
      body: JSON.stringify({
        username: rateLimitUser,
        password: `wrong-${index}`,
      }),
    });

    if (response.status !== 401) {
      throw new Error(`/api/auth/login expected 401 across isolated client attempts, got ${response.status}`);
    }
  }

  const sharedIp = '198.51.100.200';
  for (let index = 0; index < 8; index += 1) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': sharedIp,
      },
      body: JSON.stringify({
        username: rateLimitUser,
        password: `wrong-shared-${index}`,
      }),
    });
    if (index < 7 && response.status !== 401) {
      throw new Error(`/api/auth/login expected 401 for failed attempt ${index + 1}, got ${response.status}`);
    }
    if (index === 7 && response.status !== 429) {
      throw new Error(`/api/auth/login expected 429 after repeated failures, got ${response.status}`);
    }
    if (index === 7 && !response.headers.get('retry-after')) {
      throw new Error('/api/auth/login rate limit response must include Retry-After');
    }
  }

  const goodLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '198.51.100.201',
    },
    body: JSON.stringify({ username, password }),
  });
  if (!goodLoginResponse.ok) {
    throw new Error(`/api/auth/login rate limit leaked to valid admin login: HTTP ${goodLoginResponse.status}`);
  }

  console.log('ok concurrent auth rate limit is scoped and returns Retry-After');
}

async function assertConcurrentProtectedReads() {
  const paths = [
    '/api/overview',
    '/api/servers',
    '/api/config',
    '/api/cloud/accounts',
    '/api/operations/events',
    '/api/audit/events',
    '/api/account',
  ];

  const responses = await Promise.all(
    Array.from({ length: 5 }).flatMap(() => paths.map((path) => getJson(path))),
  );

  if (!responses.every((response) => response.ok)) {
    throw new Error('Concurrent protected reads returned a failed response');
  }

  const overview = responses.find((response) => response.path === '/api/overview')?.body;
  if (!overview || overview.summary?.totalServers !== overview.servers?.length) {
    throw new Error('/api/overview concurrent response has inconsistent summary');
  }

  console.log('ok concurrent protected reads');
}

async function assertConcurrentServerLifecycle() {
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const createBodies = Array.from({ length: 16 }, (_, index) => ({
    name: `concurrency-${runId}-${index}`,
    provider: index % 2 === 0 ? 'Other Cloud' : 'Edge Cloud',
    region: '',
    publicIp: deterministicIp(index),
    privateIp: '',
    os: '',
    tags: ['concurrency', `n${index}`],
    ssh: {
      port: 22,
      username: 'root',
      authType: 'password',
      password: '',
      verifyMode: 'assetOnly',
    },
  }));

  const created = await Promise.all(
    createBodies.map((body) => postJson('/api/servers', body, 201)),
  );

  const ids = created.map((response) => response.body.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('/api/servers returned duplicate IDs under concurrent create');
  }
  createdServerIds.push(...ids);

  const uniqueRegions = new Set(created.map((response) => response.body.region));
  if (uniqueRegions.size < 4 || uniqueRegions.has('Unknown region')) {
    throw new Error('/api/servers did not resolve deterministic multi-region identity during concurrent create');
  }

  const listed = await getJson('/api/servers?provider=otherCloud');
  if (!listed.ok || !Array.isArray(listed.body.items)) {
    throw new Error('/api/servers provider filter returned unexpected payload');
  }

  const patchResponses = await Promise.all(
    ids.slice(0, 6).map((id, index) => patchJson(`/api/servers/${id}`, {
      name: `concurrency-renamed-${runId}-${index}`,
      tags: ['patched', `p${index}`],
    })),
  );
  if (!patchResponses.every((response) => response.ok)) {
    throw new Error('/api/servers concurrent PATCH returned a failed response');
  }

  const deletes = await Promise.all(
    ids.map((id) => deleteJson(`/api/servers/${id}`)),
  );
  if (!deletes.every((response) => response.ok && response.body.deleted === true)) {
    throw new Error('/api/servers concurrent DELETE returned a failed response');
  }
  createdServerIds.splice(0, createdServerIds.length);

  console.log('ok concurrent server create/update/delete keeps IDs unique and region detection stable');
}

async function assertConcurrentAiStreams() {
  const responses = await Promise.all(
    Array.from({ length: 6 }, (_, index) => postSse('/api/ai/stream', {
      question: index % 2 === 0 ? 'hello, respond as realtime chat' : 'analyze current server state',
      provider: {
        name: 'Concurrency AI',
        baseUrl: 'https://api.example.com/v1',
        model: 'concurrency-model',
        apiKey: '',
        temperature: 0.2,
      },
      serverId: 'all',
      forceRefresh: true,
    })),
  );

  if (!responses.every((text) => text.includes('"type":"chunk"') && text.includes('"type":"done"'))) {
    throw new Error('/api/ai/stream concurrent fallback streams returned incomplete SSE payloads');
  }

  console.log('ok concurrent AI streams finish without fixed canned failure');
}

async function assertConcurrentCustomApiBlocks() {
  const responses = await Promise.all(
    [
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1/private',
      'http://192.168.1.1/private',
      'ftp://api.example.com/not-http',
    ].map((url) => postJson('/api/custom-apis/test', {
      name: 'blocked-concurrency',
      method: 'GET',
      url,
      headers: {},
      body: '',
    }, [400, 403])),
  );

  if (!responses.every((response) => response.status === 400 || response.status === 403)) {
    throw new Error('/api/custom-apis/test concurrent blocked probes returned unexpected status');
  }

  console.log('ok concurrent custom API SSRF probes are blocked');
}

async function assertConcurrentProfileWrites() {
  const writes = await Promise.all(
    Array.from({ length: 4 }, (_, index) => patchJson('/api/account/profile', {
      displayName: `OpsDesk${index}`,
      avatarText: `O${index}`,
      avatarImage: '',
    })),
  );
  if (!writes.every((response) => response.ok)) {
    throw new Error('/api/account/profile concurrent writes returned a failed response');
  }

  const account = await getJson('/api/account');
  if (!account.ok || !/^OpsDesk[0-3]$/.test(account.body.profile?.displayName ?? '')) {
    throw new Error('/api/account/profile concurrent writes left an invalid profile');
  }

  console.log('ok concurrent profile writes remain valid');
}

async function assertConcurrentSessionCapacity() {
  const loginResponses = await Promise.all(
    Array.from({ length: 24 }, (_, index) => fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/120.0.6099.${100 + index} Mobile Safari/537.36`,
      },
      body: JSON.stringify({ username, password }),
    })),
  );
  if (!loginResponses.every((response) => response.ok)) {
    throw new Error('Concurrent valid logins returned a failed response');
  }
  const cookies = loginResponses.map((response) => response.headers.get('set-cookie')?.split(';')[0] ?? '');
  if (cookies.some((cookie) => !cookie)) {
    throw new Error('Concurrent valid logins did not return every session cookie');
  }

  const guaranteedLatestResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/120.0.6099.999 Mobile Safari/537.36',
    },
    body: JSON.stringify({ username, password }),
  });
  const guaranteedLatestCookie = guaranteedLatestResponse.headers.get('set-cookie')?.split(';')[0] ?? '';
  if (!guaranteedLatestResponse.ok || !guaranteedLatestCookie) {
    throw new Error(`Deterministic newest login failed with HTTP ${guaranteedLatestResponse.status}`);
  }

  const latestHeaders = { Cookie: guaranteedLatestCookie };
  const sessionsResponse = await fetch(`${baseUrl}/api/account/sessions`, { headers: latestHeaders });
  const sessions = await safeJson(sessionsResponse);
  if (
    !sessionsResponse.ok
    || !Number.isInteger(sessions?.summary?.maxActive)
    || sessions.summary.active !== sessions.summary.maxActive
    || sessions.summary.available !== 0
    || sessions.summary.atCapacity !== true
    || sessions.summary.otherSessions !== sessions.summary.maxActive - 1
  ) {
    throw new Error(`Concurrent session capacity returned an unexpected summary: ${JSON.stringify(sessions?.summary)}`);
  }

  const cookieStatuses = await Promise.all(
    [...cookies, guaranteedLatestCookie].map(async (cookie) => {
      const response = await fetch(`${baseUrl}/api/account`, { headers: { Cookie: cookie } });
      return response.status;
    }),
  );
  const validCookieCount = cookieStatuses.filter((status) => status === 200).length;
  const retiredCookieCount = cookieStatuses.filter((status) => status === 401).length;
  if (
    validCookieCount !== sessions.summary.maxActive
    || retiredCookieCount !== cookieStatuses.length - sessions.summary.maxActive
    || cookieStatuses.some((status) => status !== 200 && status !== 401)
  ) {
    throw new Error(`Concurrent session capacity returned unexpected cookie statuses: ${JSON.stringify(cookieStatuses)}`);
  }
  const latestSessionResponse = await fetch(`${baseUrl}/api/account`, { headers: latestHeaders });
  if (!latestSessionResponse.ok) {
    throw new Error(`Deterministic newest login must remain active, got HTTP ${latestSessionResponse.status}`);
  }

  const cleanupResponse = await fetch(`${baseUrl}/api/account/sessions/revoke-others`, {
    method: 'POST',
    headers: latestHeaders,
  });
  const cleanup = await safeJson(cleanupResponse);
  if (!cleanupResponse.ok || cleanup?.sessions?.summary?.active !== 1) {
    throw new Error('Concurrent session capacity cleanup did not retain exactly the newest session');
  }

  const sequentialCookies = [];
  for (let index = 0; index < sessions.summary.maxActive; index += 1) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.6167.${100 + index} Safari/537.36`,
      },
      body: JSON.stringify({ username, password }),
    });
    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    if (!response.ok || !cookie) {
      throw new Error(`Sequential capacity login ${index + 1} failed with HTTP ${response.status}`);
    }
    sequentialCookies.push(cookie);
  }
  const deterministicOldestResponse = await fetch(`${baseUrl}/api/account`, {
    headers: { Cookie: guaranteedLatestCookie },
  });
  const deterministicNewestHeaders = { Cookie: sequentialCookies.at(-1) };
  const deterministicNewestResponse = await fetch(`${baseUrl}/api/account`, {
    headers: deterministicNewestHeaders,
  });
  if (deterministicOldestResponse.status !== 401 || !deterministicNewestResponse.ok) {
    throw new Error(
      `Sequential capacity retirement expected oldest=401/newest=200, got oldest=${deterministicOldestResponse.status}/newest=${deterministicNewestResponse.status}`,
    );
  }
  const finalCleanupResponse = await fetch(`${baseUrl}/api/account/sessions/revoke-others`, {
    method: 'POST',
    headers: deterministicNewestHeaders,
  });
  const finalCleanup = await safeJson(finalCleanupResponse);
  if (!finalCleanupResponse.ok || finalCleanup?.sessions?.summary?.active !== 1) {
    throw new Error('Sequential session capacity cleanup did not retain exactly the newest session');
  }
  authHeaders = deterministicNewestHeaders;

  console.log(`ok concurrent login sessions stay bounded at ${sessions.summary.maxActive}; deterministic order retires the oldest session`);
}

function deterministicIp(index) {
  const samples = [
    '198.51.100.10',
    '198.51.100.11',
    '198.51.100.80',
    '198.51.100.81',
    '203.0.113.10',
    '203.0.113.11',
    '203.0.113.80',
    '203.0.113.81',
    '203.0.113.150',
    '203.0.113.151',
    '203.0.113.220',
    '203.0.113.221',
    '192.0.2.10',
    '192.0.2.11',
    '192.0.2.80',
    '192.0.2.81',
  ];
  return samples[index % samples.length];
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`, { headers: authHeaders });
  const body = await safeJson(response);
  return { ok: response.ok, status: response.status, path, body };
}

async function postJson(path, body, expectedStatus = null) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return assertExpectedStatus(response, path, await safeJson(response), expectedStatus);
}

async function patchJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status, path, body: await safeJson(response) };
}

async function deleteJson(path) {
  if (!authHeaders.Cookie) {
    return { ok: false, status: 0, path, body: null };
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  return { ok: response.ok, status: response.status, path, body: await safeJson(response) };
}

async function postSse(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return response.text();
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

function assertExpectedStatus(response, path, body, expectedStatus) {
  if (expectedStatus) {
    const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    if (!allowed.includes(response.status)) {
      throw new Error(`${path} expected HTTP ${allowed.join('/')} but got ${response.status}`);
    }
  } else if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  return {
    ok: response.ok,
    status: response.status,
    path,
    body,
  };
}

async function cleanupCreatedServers() {
  if (createdServerIds.length === 0) {
    return;
  }
  await Promise.allSettled(createdServerIds.splice(0).map((id) => deleteJson(`/api/servers/${id}`)));
}
