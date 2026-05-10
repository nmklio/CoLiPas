import http from 'node:http';
import fs from 'node:fs';

const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080';
const authHeaders = {};
const smokeUsername = process.env.SMOKE_ADMIN_USERNAME ?? 'admin';
const initialSmokePassword = process.env.SMOKE_ADMIN_PASSWORD ?? 'admin123456';
let currentSmokePassword = initialSmokePassword;

assertAiProviderSecretNotPersisted();
assertAiStreamingCompatibility();
assertAiResponseCachingGuards();
assertAiConsoleI18nCoverage();
assertCloudAccountsI18nCoverage();
assertCustomApiSecretNotPersisted();
assertOverviewMapInteractionGuards();
assertMapRegionScopeLifecycleGuards();
assertOverviewServerFilterLinkage();
assertServerIdentityDetectionGuards();
assertServerStatusLifecycleGuards();
assertSshTerminalRealtimeGuards();
assertMobileTopbarKeepsCoreActions();
assertSecurityAuditRelationsAreSpecific();
assertOperationsTargetSelectionGuards();
assertCustomApiProxySecurityGuards();
assertSqlitePersistenceGuards();
assertBuildChunkingGuards();
assertRepositoryPreviewAssetGuards();

const unauthenticatedOverviewResponse = await fetch(`${baseUrl}/api/overview`);
if (unauthenticatedOverviewResponse.status !== 401) {
  throw new Error(`/api/overview expected 401 before login, got ${unauthenticatedOverviewResponse.status}`);
}
console.log('ok protected API requires login');

const unauthenticatedAccountResponse = await fetch(`${baseUrl}/api/account`);
if (unauthenticatedAccountResponse.status !== 401) {
  throw new Error(`/api/account expected 401 before login, got ${unauthenticatedAccountResponse.status}`);
}
const unauthenticatedPasswordResponse = await fetch(`${baseUrl}/api/account/password`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    currentPassword: 'admin123456',
    newPassword: 'Blocked12345',
  }),
});
if (unauthenticatedPasswordResponse.status !== 401) {
  throw new Error(`/api/account/password expected 401 before login, got ${unauthenticatedPasswordResponse.status}`);
}
console.log('ok account settings require login');

const failedLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'admin',
    password: `wrong-${Date.now()}`,
  }),
});
if (failedLoginResponse.status !== 401) {
  throw new Error(`/api/auth/login expected 401 with invalid password, got ${failedLoginResponse.status}`);
}
console.log('ok /api/auth/login rejects invalid credentials');

const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: smokeUsername,
    password: currentSmokePassword,
  }),
});
if (!loginResponse.ok) {
  throw new Error(`/api/auth/login returned HTTP ${loginResponse.status}`);
}
const loginBody = await loginResponse.json();
if (!loginBody.authenticated || loginBody.user?.username !== 'admin' || loginBody.profile?.displayName !== 'CoLiPas' || loginBody.profile?.avatarText !== 'CP') {
  throw new Error('/api/auth/login returned unexpected payload');
}
if (JSON.stringify(loginBody).match(/sessionId|scrypt|salt|passwordChangedAt/)) {
  throw new Error('/api/auth/login leaked internal account material');
}
const sessionCookie = loginResponse.headers.get('set-cookie')?.split(';')[0];
if (!sessionCookie) {
  throw new Error('/api/auth/login did not set a session cookie');
}
authHeaders.Cookie = sessionCookie;
console.log('ok /api/auth/login');

const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, { headers: authHeaders });
if (!sessionResponse.ok) {
  throw new Error(`/api/auth/session returned HTTP ${sessionResponse.status}`);
}
const sessionBody = await sessionResponse.json();
if (!sessionBody.authenticated || sessionBody.user?.username !== 'admin' || sessionBody.profile?.displayName !== 'CoLiPas') {
  throw new Error('/api/auth/session returned unexpected payload');
}
if (JSON.stringify(sessionBody).match(/sessionId|scrypt|salt|passwordChangedAt/)) {
  throw new Error('/api/auth/session leaked internal account material');
}
console.log('ok /api/auth/session');

const accountResponse = await fetch(`${baseUrl}/api/account`, { headers: authHeaders });
if (!accountResponse.ok) {
  throw new Error(`/api/account returned HTTP ${accountResponse.status}`);
}
const accountBody = await accountResponse.json();
if (accountBody.session?.user?.username !== 'admin' || accountBody.profile?.avatarText !== 'CP') {
  throw new Error('/api/account returned unexpected profile payload');
}
if (JSON.stringify(accountBody).match(/sessionId|scrypt|salt|passwordChangedAt/)) {
  throw new Error('/api/account leaked internal account material');
}
console.log('ok /api/account');

const profileUpdateResponse = await fetch(`${baseUrl}/api/account/profile`, {
  method: 'PATCH',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    displayName: 'OpsDesk',
    avatarText: 'OD',
  }),
});
if (!profileUpdateResponse.ok) {
  throw new Error(`/api/account/profile returned HTTP ${profileUpdateResponse.status}`);
}
const profileUpdateBody = await profileUpdateResponse.json();
if (profileUpdateBody.profile?.displayName !== 'OpsDesk' || profileUpdateBody.profile?.avatarText !== 'OD') {
  throw new Error('/api/account/profile returned unexpected profile');
}
const profileSessionResponse = await fetch(`${baseUrl}/api/auth/session`, { headers: authHeaders });
const profileSessionBody = await profileSessionResponse.json();
if (profileSessionBody.profile?.displayName !== 'OpsDesk' || profileSessionBody.profile?.avatarText !== 'OD') {
  throw new Error('/api/auth/session did not expose updated profile');
}
console.log('ok /api/account/profile persists custom avatar and display name');

const weakPasswordResponse = await fetch(`${baseUrl}/api/account/password`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    currentPassword: currentSmokePassword,
    newPassword: 'short',
  }),
});
if (weakPasswordResponse.status !== 400) {
  throw new Error(`/api/account/password expected 400 for weak password, got ${weakPasswordResponse.status}`);
}

const wrongCurrentPasswordResponse = await fetch(`${baseUrl}/api/account/password`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    currentPassword: 'wrong-current-password',
    newPassword: 'NextPassword123',
  }),
});
if (wrongCurrentPasswordResponse.status !== 403) {
  throw new Error(`/api/account/password expected 403 for wrong current password, got ${wrongCurrentPasswordResponse.status}`);
}

const secondLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: smokeUsername,
    password: currentSmokePassword,
  }),
});
const secondSessionCookie = secondLoginResponse.headers.get('set-cookie')?.split(';')[0];
if (!secondSessionCookie) {
  throw new Error('/api/auth/login second session did not set a session cookie');
}
const secondAuthHeaders = { Cookie: secondSessionCookie };
const nextPassword = 'NextPassword123';
const passwordChangeResponse = await fetch(`${baseUrl}/api/account/password`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    currentPassword: currentSmokePassword,
    newPassword: nextPassword,
  }),
});
if (!passwordChangeResponse.ok) {
  throw new Error(`/api/account/password returned HTTP ${passwordChangeResponse.status}`);
}
const passwordChangeBody = await passwordChangeResponse.json();
if (passwordChangeBody.ok !== true || !passwordChangeBody.changedAt) {
  throw new Error('/api/account/password returned unexpected payload');
}
if (JSON.stringify(passwordChangeBody).match(/remainingSession|sessionId|scrypt|salt|key/)) {
  throw new Error('/api/account/password leaked internal account material');
}
const oldPasswordLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: smokeUsername,
    password: initialSmokePassword,
  }),
});
if (oldPasswordLoginResponse.status !== 401) {
  throw new Error(`/api/auth/login expected 401 with old password after change, got ${oldPasswordLoginResponse.status}`);
}
const revokedSessionResponse = await fetch(`${baseUrl}/api/account`, { headers: secondAuthHeaders });
if (revokedSessionResponse.status !== 401) {
  throw new Error(`/api/account expected 401 for revoked session, got ${revokedSessionResponse.status}`);
}
currentSmokePassword = nextPassword;
console.log('ok /api/account/password hashes password, rejects weak input, and revokes other sessions');

const getChecks = [
  ['/api/health', (body) => body.status === 'ok' && body.database?.driver === 'sqlite' && body.database?.name === 'colipas.sqlite' && !('path' in body.database)],
  ['/api/config', (body) => Array.isArray(body.customApiAllowedHosts) && body.ai?.configured === false],
  [
    '/api/overview',
    (body) =>
      Array.isArray(body.cloudAccounts) &&
      Array.isArray(body.servers) &&
      Array.isArray(body.operationEvents) &&
      body.summary?.totalServers === body.servers.length &&
      body.summary?.onlineServers === body.servers.filter((server) => server.status === 'running').length &&
      body.summary?.openEvents === body.operationEvents.filter((event) => event.status === 'open').length,
  ],
  [
    '/api/servers?status=running',
    (body) =>
      Array.isArray(body.items) &&
      body.filters?.provider === 'all' &&
      body.filters?.status === 'running' &&
      body.items.every((server) => server.status === 'running'),
  ],
];
let runtimeConfig = null;

for (const [path, assert] of getChecks) {
  const response = await fetch(`${baseUrl}${path}`, { headers: path === '/api/health' ? {} : authHeaders });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }

  const body = await response.json();
  if (path === '/api/config') {
    runtimeConfig = body;
  }
  if (!assert(body)) {
    throw new Error(`${path} returned unexpected payload`);
  }

  console.log(`ok ${path}`);
}

async function readSseUntil(response, predicate, timeoutMs = 2500) {
  if (!response.body) {
    throw new Error('SSE response did not return a readable body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const timeout = setTimeout(() => reader.cancel().catch(() => undefined), timeoutMs);

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
      if (predicate(text)) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  text += decoder.decode();
  if (!predicate(text)) {
    throw new Error('Timed out waiting for expected SSE event');
  }

  return text;
}

const aiResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    question: 'analyze current multi-cloud risk',
    provider: {
      name: 'Smoke AI',
      baseUrl: 'https://api.example.com/v1',
      model: 'smoke-model',
      apiKey: '',
      temperature: 0.2,
    },
    serverId: 'all',
  }),
});
if (!aiResponse.ok) {
  throw new Error(`/api/ai/analyze returned HTTP ${aiResponse.status}`);
}
const aiBody = await aiResponse.json();
if (!aiBody.answer || aiBody.simulated !== true) {
  throw new Error('/api/ai/analyze returned unexpected payload');
}
console.log('ok /api/ai/analyze');

const aiStreamResponse = await fetch(`${baseUrl}/api/ai/stream`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    question: 'stream analyze current multi-cloud risk',
    provider: {
      name: 'Smoke AI',
      baseUrl: 'https://api.example.com/v1',
      model: 'smoke-model',
      apiKey: '',
      temperature: 0.2,
    },
    serverId: 'all',
  }),
});
if (!aiStreamResponse.ok) {
  throw new Error(`/api/ai/stream returned HTTP ${aiStreamResponse.status}`);
}
const aiStreamText = await aiStreamResponse.text();
if (!aiStreamText.includes('"type":"chunk"') || !aiStreamText.includes('"type":"done"')) {
  throw new Error('/api/ai/stream returned unexpected SSE payload');
}
console.log('ok /api/ai/stream');

const aiCachedStreamResponse = await fetch(`${baseUrl}/api/ai/stream`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    question: 'stream analyze current multi-cloud risk',
    provider: {
      name: 'Smoke AI',
      baseUrl: 'https://api.example.com/v1',
      model: 'smoke-model',
      apiKey: '',
      temperature: 0.2,
    },
    serverId: 'all',
  }),
});
if (!aiCachedStreamResponse.ok) {
  throw new Error(`/api/ai/stream cached request returned HTTP ${aiCachedStreamResponse.status}`);
}
const aiCachedStreamText = await aiCachedStreamResponse.text();
if (!aiCachedStreamText.includes('"cached":true')) {
  throw new Error('/api/ai/stream second identical request did not return cached:true');
}
console.log('ok /api/ai/stream caches repeated analysis');

const aiForceRefreshStreamResponse = await fetch(`${baseUrl}/api/ai/stream`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    question: 'stream analyze current multi-cloud risk',
    provider: {
      name: 'Smoke AI',
      baseUrl: 'https://api.example.com/v1',
      model: 'smoke-model',
      apiKey: '',
      temperature: 0.2,
    },
    serverId: 'all',
    forceRefresh: true,
  }),
});
if (!aiForceRefreshStreamResponse.ok) {
  throw new Error(`/api/ai/stream forceRefresh returned HTTP ${aiForceRefreshStreamResponse.status}`);
}
const aiForceRefreshStreamText = await aiForceRefreshStreamResponse.text();
if (aiForceRefreshStreamText.includes('"cached":true')) {
  throw new Error('/api/ai/stream forceRefresh must bypass response cache');
}
console.log('ok /api/ai/stream forceRefresh bypasses cache');

const shortAiStreamResponse = await fetch(`${baseUrl}/api/ai/stream`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    question: '你好',
    provider: {
      name: 'Smoke AI',
      baseUrl: 'https://api.example.com/v1',
      model: 'smoke-model',
      apiKey: '',
      temperature: 0.2,
    },
    serverId: 'all',
  }),
});
if (!shortAiStreamResponse.ok) {
  throw new Error(`/api/ai/stream short question returned HTTP ${shortAiStreamResponse.status}`);
}
const shortAiStreamText = await shortAiStreamResponse.text();
if (!shortAiStreamText.includes('"type":"chunk"') || !shortAiStreamText.includes('"type":"done"')) {
  throw new Error('/api/ai/stream short question returned unexpected SSE payload');
}
console.log('ok /api/ai/stream accepts short question');

const aiTestWithoutKeyResponse = await fetch(`${baseUrl}/api/ai/test`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    provider: {
      name: 'Smoke AI',
      baseUrl: 'https://api.example.com/v1',
      model: 'smoke-model',
      apiKey: '',
      temperature: 0.2,
    },
  }),
});
if (aiTestWithoutKeyResponse.status !== 400) {
  throw new Error(`/api/ai/test expected 400 without API key, got ${aiTestWithoutKeyResponse.status}`);
}
console.log('ok /api/ai/test requires API key');

const sensitiveAiBaseUrlSecret = `ai-url-secret-${Date.now()}`;
const aiTestSensitiveBaseUrlResponse = await fetch(`${baseUrl}/api/ai/test`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    provider: {
      name: 'Smoke AI',
      baseUrl: `https://api.example.com/v1?token=${sensitiveAiBaseUrlSecret}`,
      model: 'smoke-model',
      apiKey: 'smoke-key',
      temperature: 0.2,
    },
  }),
});
if (aiTestSensitiveBaseUrlResponse.status !== 400) {
  throw new Error(`/api/ai/test expected 400 for sensitive Base URL, got ${aiTestSensitiveBaseUrlResponse.status}`);
}
const aiTestSensitiveBaseUrlBody = await aiTestSensitiveBaseUrlResponse.json();
if (JSON.stringify(aiTestSensitiveBaseUrlBody).includes(sensitiveAiBaseUrlSecret)) {
  throw new Error('/api/ai/test leaked sensitive AI Base URL query parameters');
}
console.log('ok /api/ai/test rejects sensitive Base URL parameters without leaking them');

const mockAi = await startMockStreamingAi();
const upstreamErrorSecret = `upstream-secret-${Date.now()}`;
try {
  const streamingProvider = {
    name: 'Streaming Smoke AI',
    baseUrl: mockAi.baseUrl,
    model: 'stream-smoke-model',
    apiKey: 'stream-smoke-key',
    temperature: 0,
  };

  const upstreamFailureResponse = await fetch(`${baseUrl}/api/ai/test`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: {
        ...streamingProvider,
        model: 'fail-secret-model',
        apiKey: upstreamErrorSecret,
      },
    }),
  });
  if (upstreamFailureResponse.status !== 502) {
    throw new Error(`/api/ai/test expected 502 for upstream failure, got ${upstreamFailureResponse.status}`);
  }
  const upstreamFailureBody = await upstreamFailureResponse.json();
  const upstreamFailureText = JSON.stringify(upstreamFailureBody);
  if (upstreamFailureText.includes(upstreamErrorSecret) || upstreamFailureText.includes('upstream body token')) {
    throw new Error('/api/ai/test leaked sensitive upstream error details');
  }
  console.log('ok /api/ai/test redacts upstream error bodies');

  const upstreamAnalyzeResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: 'verify upstream streaming analyze',
      provider: streamingProvider,
      serverId: 'all',
    }),
  });
  if (!upstreamAnalyzeResponse.ok) {
    throw new Error(`/api/ai/analyze streaming upstream returned HTTP ${upstreamAnalyzeResponse.status}`);
  }
  const upstreamAnalyzeBody = await upstreamAnalyzeResponse.json();
  if (!upstreamAnalyzeBody.answer?.includes('stream-ok') || upstreamAnalyzeBody.simulated !== false) {
    throw new Error('/api/ai/analyze streaming upstream returned unexpected payload');
  }

  const upstreamChatStreamResponse = await fetch(`${baseUrl}/api/ai/stream`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: 'continue from the prior assistant answer',
      provider: streamingProvider,
      serverId: 'all',
      forceRefresh: true,
      messages: [
        { role: 'user', content: 'previous user chat context' },
        { role: 'assistant', content: 'previous assistant chat context' },
      ],
    }),
  });
  if (!upstreamChatStreamResponse.ok) {
    throw new Error(`/api/ai/stream multi-turn upstream returned HTTP ${upstreamChatStreamResponse.status}`);
  }
  const upstreamChatStreamText = await upstreamChatStreamResponse.text();
  if (!upstreamChatStreamText.includes('"type":"chunk"') || !upstreamChatStreamText.includes('stream-ok')) {
    throw new Error('/api/ai/stream multi-turn upstream returned unexpected SSE payload');
  }
  const multiTurnRequest = mockAi.requests.find((request) => (
    Array.isArray(request.body?.messages)
    && request.body.messages.some((message) => message.role === 'assistant' && message.content === 'previous assistant chat context')
    && request.body.messages.some((message) => message.role === 'user' && String(message.content).includes('continue from the prior assistant answer'))
  ));
  if (!multiTurnRequest || multiTurnRequest.body.stream !== true) {
    throw new Error('/api/ai/stream did not forward multi-turn chat history with stream:true');
  }
  console.log('ok /api/ai/stream forwards multi-turn chat history');

  const nakedProviderStreamResponse = await fetch(`${baseUrl}/api/ai/stream`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: 'plain chat should stream without operations context',
      name: streamingProvider.name,
      baseUrl: streamingProvider.baseUrl,
      model: streamingProvider.model,
      apiKey: streamingProvider.apiKey,
      temperature: streamingProvider.temperature,
      serverId: 'all',
      forceRefresh: true,
    }),
  });
  if (!nakedProviderStreamResponse.ok) {
    throw new Error(`/api/ai/stream naked provider returned HTTP ${nakedProviderStreamResponse.status}`);
  }
  const nakedProviderStreamText = await nakedProviderStreamResponse.text();
  if (!nakedProviderStreamText.includes('"type":"chunk"') || !nakedProviderStreamText.includes('stream-ok')) {
    throw new Error('/api/ai/stream naked provider request did not stream upstream output');
  }
  const nakedProviderRequest = mockAi.requests.find((request) => (
    Array.isArray(request.body?.messages)
    && request.body.messages.some((message) => message.role === 'user' && message.content === 'plain chat should stream without operations context')
  ));
  if (!nakedProviderRequest || nakedProviderRequest.body.stream !== true) {
    throw new Error('/api/ai/stream naked provider request did not forward stream:true chat payload');
  }
  console.log('ok /api/ai/stream accepts naked provider fields');

  const upstreamStreamFailureResponse = await fetch(`${baseUrl}/api/ai/stream`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: 'fail as event',
      provider: {
        ...streamingProvider,
        model: 'fail-secret-model',
        apiKey: upstreamErrorSecret,
      },
      serverId: 'all',
      forceRefresh: true,
    }),
  });
  if (!upstreamStreamFailureResponse.ok) {
    throw new Error(`/api/ai/stream upstream failure event returned HTTP ${upstreamStreamFailureResponse.status}`);
  }
  const upstreamStreamFailureText = await upstreamStreamFailureResponse.text();
  if (!upstreamStreamFailureText.includes('"type":"error"') || upstreamStreamFailureText.includes(upstreamErrorSecret) || upstreamStreamFailureText.includes('upstream body token')) {
    throw new Error('/api/ai/stream upstream failure event was missing or leaked sensitive details');
  }
  console.log('ok /api/ai/stream returns safe SSE error event');

  const upstreamTestResponse = await fetch(`${baseUrl}/api/ai/test`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: streamingProvider }),
  });
  if (!upstreamTestResponse.ok) {
    throw new Error(`/api/ai/test streaming upstream returned HTTP ${upstreamTestResponse.status}`);
  }

  const upstreamModelsResponse = await fetch(`${baseUrl}/api/ai/models`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: streamingProvider }),
  });
  if (!upstreamModelsResponse.ok) {
    throw new Error(`/api/ai/models upstream returned HTTP ${upstreamModelsResponse.status}`);
  }
  const upstreamModelsBody = await upstreamModelsResponse.json();
  if (!upstreamModelsBody.models?.includes('mock-stream-model') || upstreamModelsBody.source !== 'upstream') {
    throw new Error('/api/ai/models upstream returned unexpected payload');
  }
  console.log('ok /api/ai/models loads upstream models');

  if (runtimeConfig?.ai?.configured) {
    const inheritedModelsResponse = await fetch(`${baseUrl}/api/ai/models`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: {
          ...streamingProvider,
          apiKey: '',
        },
      }),
    });
    if (!inheritedModelsResponse.ok) {
      throw new Error(`/api/ai/models inherited server key returned HTTP ${inheritedModelsResponse.status}`);
    }
    const inheritedModelsBody = await inheritedModelsResponse.json();
    if (!inheritedModelsBody.models?.includes('mock-stream-model') || inheritedModelsBody.source !== 'upstream') {
      throw new Error('/api/ai/models did not inherit server-side API key when provider key was empty');
    }
    console.log('ok /api/ai/models inherits server API key');
  }

  const streamFlags = mockAi.requests.map((request) => request.body?.stream);
  if (streamFlags.length < 2 || streamFlags.some((value) => value !== true)) {
    throw new Error('/api/ai upstream calls did not set stream: true');
  }
  console.log('ok AI upstream calls use stream:true');
} finally {
  await mockAi.close();
}

const blockedApiResponse = await fetch(`${baseUrl}/api/custom-apis/test`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'blocked',
    method: 'GET',
    url: 'https://blocked.example.org/items',
    headersText: '',
    bodyText: '',
  }),
});
if (blockedApiResponse.status !== 403) {
  throw new Error(`/api/custom-apis/test expected 403, got ${blockedApiResponse.status}`);
}
console.log('ok /api/custom-apis/test blocks non-allowlisted hosts');

const blockedHeaderApiResponse = await fetch(`${baseUrl}/api/custom-apis/test`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'blocked header',
    method: 'GET',
    url: 'https://api.example.com/items',
    headersText: 'Host: metadata.google.internal\nX-Smoke: blocked-header',
    bodyText: '',
  }),
});
if (blockedHeaderApiResponse.status !== 400) {
  throw new Error(`/api/custom-apis/test expected 400 for blocked header, got ${blockedHeaderApiResponse.status}`);
}
const blockedHeaderBody = await blockedHeaderApiResponse.json();
if (!blockedHeaderBody.error?.message?.includes('not allowed')) {
  throw new Error('/api/custom-apis/test blocked header returned unexpected error payload');
}
console.log('ok /api/custom-apis/test blocks unsafe request headers');

const sensitiveAuditSecret = `smoke-secret-${Date.now()}`;
const sensitiveAuditResponse = await fetch(`${baseUrl}/api/custom-apis/test`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'sensitive audit target',
    method: 'GET',
    url: `https://blocked.example.org/items?token=${sensitiveAuditSecret}&api_key=${sensitiveAuditSecret}&page=1`,
    headersText: '',
    bodyText: '',
  }),
});
if (sensitiveAuditResponse.status !== 403) {
  throw new Error(`/api/custom-apis/test expected 403 for sensitive audit target, got ${sensitiveAuditResponse.status}`);
}
console.log('ok /api/custom-apis/test blocks sensitive query audit probe');

let customApiSuccessChecked = false;
if (runtimeConfig?.customApiAllowedHosts?.includes('127.0.0.1')) {
  const mockCustomApi = await startMockCustomApi();
  try {
    const customApiSuccessResponse = await fetch(`${baseUrl}/api/custom-apis/test`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'local mock success',
        method: 'POST',
        url: `${mockCustomApi.baseUrl}/assets`,
        headersText: 'Content-Type: application/json\nX-Smoke: custom-api',
        bodyText: JSON.stringify({ provider: 'mock-cloud' }),
      }),
    });
    if (!customApiSuccessResponse.ok) {
      throw new Error(`/api/custom-apis/test success path returned HTTP ${customApiSuccessResponse.status}`);
    }
    const customApiSuccessBody = await customApiSuccessResponse.json();
    if (
      customApiSuccessBody.status !== 200
      || customApiSuccessBody.ok !== true
      || !customApiSuccessBody.bodyText?.includes('mock-cloud')
    ) {
      throw new Error('/api/custom-apis/test success path returned unexpected payload');
    }
    customApiSuccessChecked = true;
    console.log('ok /api/custom-apis/test success path');

    const redirectResponse = await fetch(`${baseUrl}/api/custom-apis/test`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'local mock redirect',
        method: 'GET',
        url: `${mockCustomApi.baseUrl}/redirect-private`,
        headersText: '',
        bodyText: '',
      }),
    });
    if (!redirectResponse.ok) {
      throw new Error(`/api/custom-apis/test redirect path returned HTTP ${redirectResponse.status}`);
    }
    const redirectBody = await redirectResponse.json();
    if (
      redirectBody.status !== 302
      || redirectBody.ok !== false
      || !redirectBody.headers?.location?.includes('169.254.169.254')
    ) {
      throw new Error('/api/custom-apis/test did not expose the upstream redirect as a manual 302 response');
    }
    console.log('ok /api/custom-apis/test does not follow upstream redirects');
  } finally {
    await mockCustomApi.close();
  }
} else {
  console.log('skip /api/custom-apis/test success path; 127.0.0.1 is not allowlisted');
}

const failedSshConnectResponse = await fetch(`${baseUrl}/api/servers`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: `unreachable-server-${Date.now()}`,
    provider: 'Custom',
    region: 'smoke-region',
    publicIp: '203.0.113.11',
    privateIp: '',
    os: 'Ubuntu 24.04',
    tags: ['smoke'],
    ssh: {
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'invalid',
      verifyMode: 'real',
    },
  }),
});
if (failedSshConnectResponse.status !== 422 && failedSshConnectResponse.status !== 408) {
  throw new Error(`/api/servers real SSH verification expected 422 or 408, got ${failedSshConnectResponse.status}`);
}
console.log('ok /api/servers blocks unreachable real SSH access');

const identityInspectResponse = await fetch(`${baseUrl}/api/servers/inspect`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    publicIp: '',
    region: '',
    os: '',
    ssh: {
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'smoke-password',
      verifyMode: 'simulate',
    },
  }),
});
if (!identityInspectResponse.ok) {
  throw new Error(`/api/servers/inspect returned HTTP ${identityInspectResponse.status}`);
}
const identityInspectBody = await identityInspectResponse.json();
if (identityInspectBody.region !== 'Unknown region' || identityInspectBody.os !== 'Ubuntu 24.04 LTS') {
  throw new Error('/api/servers/inspect returned unexpected fallback identity');
}
console.log('ok /api/servers/inspect identity fallback');

const deterministicIdentityResponse = await fetch(`${baseUrl}/api/servers/inspect`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    publicIp: '203.0.113.88',
    region: '',
    os: '',
    ssh: {
      port: 22,
      username: 'root',
      authType: 'password',
      verifyMode: 'assetOnly',
    },
  }),
});
if (!deterministicIdentityResponse.ok) {
  throw new Error(`/api/servers/inspect deterministic region returned HTTP ${deterministicIdentityResponse.status}`);
}
const deterministicIdentityBody = await deterministicIdentityResponse.json();
if (deterministicIdentityBody.region !== 'SG - Singapore') {
  throw new Error('/api/servers/inspect deterministic region returned unexpected payload');
}
console.log('ok /api/servers/inspect deterministic IP region fallback');

const inferredInventoryResponse = await fetch(`${baseUrl}/api/servers`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: `auto-identity-${Date.now()}`,
    provider: 'OpenStack Lab',
    region: '',
    publicIp: '203.0.113.21',
    privateIp: '',
    os: '',
    tags: ['identity'],
    ssh: {
      port: 22,
      username: 'root',
      authType: 'password',
      verifyMode: 'assetOnly',
    },
  }),
});
if (inferredInventoryResponse.status !== 201) {
  throw new Error(`/api/servers auto identity returned HTTP ${inferredInventoryResponse.status}`);
}
const inferredInventoryServer = await inferredInventoryResponse.json();
if (inferredInventoryServer.region !== 'DE - Frankfurt' || inferredInventoryServer.os !== 'Unknown OS') {
  throw new Error('/api/servers auto identity did not fill blank region/os');
}
console.log('ok /api/servers fills blank region/os');

const deleteInferredInventoryResponse = await fetch(`${baseUrl}/api/servers/${inferredInventoryServer.id}`, { method: 'DELETE', headers: authHeaders });
if (!deleteInferredInventoryResponse.ok) {
  throw new Error(`/api/servers/:serverId DELETE inferred inventory returned HTTP ${deleteInferredInventoryResponse.status}`);
}
console.log('ok /api/servers/:serverId DELETE inferred inventory');

const inventoryOnlyResponse = await fetch(`${baseUrl}/api/servers`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: `inventory-only-${Date.now()}`,
    provider: 'OpenStack Lab',
    region: 'lab-region',
    publicIp: '203.0.113.12',
    privateIp: '',
    os: 'Debian 12',
    tags: ['inventory'],
    ssh: {
      port: 22,
      username: 'root',
      authType: 'password',
      verifyMode: 'assetOnly',
    },
  }),
});
if (inventoryOnlyResponse.status !== 201) {
  throw new Error(`/api/servers inventory-only returned HTTP ${inventoryOnlyResponse.status}`);
}
const inventoryOnlyServer = await inventoryOnlyResponse.json();
if (!inventoryOnlyServer.id || inventoryOnlyServer.provider !== 'OpenStack Lab' || inventoryOnlyServer.ssh || inventoryOnlyServer.status !== 'unconnected') {
  throw new Error('/api/servers inventory-only returned unexpected payload');
}
console.log('ok /api/servers inventory-only custom provider');

const mapAliasRegionResponse = await fetch(`${baseUrl}/api/servers`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: `map-alias-us-la-${Date.now()}`,
    provider: 'OpenStack Lab',
    region: 'United States - Los Angeles',
    publicIp: '203.0.113.13',
    privateIp: '',
    os: 'Debian 12',
    tags: ['map-alias'],
    ssh: {
      port: 22,
      username: 'root',
      authType: 'password',
      verifyMode: 'assetOnly',
    },
  }),
});
if (mapAliasRegionResponse.status !== 201) {
  throw new Error(`/api/servers map alias region returned HTTP ${mapAliasRegionResponse.status}`);
}
const mapAliasRegionServer = await mapAliasRegionResponse.json();
const mapAliasOverviewResponse = await fetch(`${baseUrl}/api/overview`, { headers: authHeaders });
if (!mapAliasOverviewResponse.ok) {
  throw new Error(`/api/overview map alias verification returned HTTP ${mapAliasOverviewResponse.status}`);
}
const mapAliasOverview = await mapAliasOverviewResponse.json();
if (!mapAliasOverview.servers?.some((server) => server.id === mapAliasRegionServer.id && server.region === 'United States - Los Angeles')) {
  throw new Error('/api/overview did not expose the US Los Angeles region alias server');
}
const deleteMapAliasRegionResponse = await fetch(`${baseUrl}/api/servers/${mapAliasRegionServer.id}`, { method: 'DELETE', headers: authHeaders });
if (!deleteMapAliasRegionResponse.ok) {
  throw new Error(`/api/servers/:serverId DELETE map alias returned HTTP ${deleteMapAliasRegionResponse.status}`);
}
console.log('ok /api/overview carries US Los Angeles region aliases for map rendering');

const blockedActionResponse = await fetch(`${baseUrl}/api/servers/actions`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    serverId: inventoryOnlyServer.id,
    action: 'reboot',
    reason: 'should be blocked without SSH',
  }),
});
if (blockedActionResponse.status !== 409) {
  throw new Error(`/api/servers/actions expected 409 without SSH, got ${blockedActionResponse.status}`);
}
console.log('ok /api/servers/actions blocks inventory-only server');

const connectResponse = await fetch(`${baseUrl}/api/servers`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: `smoke-server-${Date.now()}`,
    provider: 'Custom',
    region: 'smoke-region',
    publicIp: '203.0.113.10',
    privateIp: '10.0.0.10',
    os: 'Ubuntu 24.04',
    tags: ['smoke'],
    ssh: {
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'smoke-password',
      verifyMode: 'simulate',
    },
  }),
});
if (connectResponse.status !== 201) {
  throw new Error(`/api/servers returned HTTP ${connectResponse.status}`);
}
const connectedServer = await connectResponse.json();
if (!connectedServer.id || connectedServer.publicIp !== '203.0.113.10' || connectedServer.ssh?.connected !== true || connectedServer.status !== 'running') {
  throw new Error('/api/servers returned unexpected payload');
}
console.log('ok /api/servers SSH connect');

const updateServerResponse = await fetch(`${baseUrl}/api/servers/${connectedServer.id}`, {
  method: 'PATCH',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: `${connectedServer.name}-edited`,
    provider: 'Custom',
    region: 'edited-region',
    publicIp: connectedServer.publicIp,
    privateIp: '10.0.0.11',
    os: 'Ubuntu 24.04 LTS',
    tags: ['smoke', 'edited'],
    ssh: {
      port: 22,
      username: 'root',
      authType: 'password',
      verifyMode: 'assetOnly',
    },
  }),
});
if (!updateServerResponse.ok) {
  throw new Error(`/api/servers/:serverId PATCH returned HTTP ${updateServerResponse.status}`);
}
const updatedServer = await updateServerResponse.json();
if (updatedServer.name !== `${connectedServer.name}-edited` || updatedServer.region !== 'edited-region' || updatedServer.ssh || updatedServer.status !== 'unconnected') {
  throw new Error('/api/servers/:serverId PATCH returned unexpected payload');
}
console.log('ok /api/servers/:serverId PATCH');

const lowerRegionResponse = await fetch(`${baseUrl}/api/servers?region=edited-region`, { headers: authHeaders });
const upperRegionResponse = await fetch(`${baseUrl}/api/servers?region=EDITED-REGION`, { headers: authHeaders });
if (!lowerRegionResponse.ok || !upperRegionResponse.ok) {
  throw new Error('/api/servers region filter case check failed to load');
}
const lowerRegionBody = await lowerRegionResponse.json();
const upperRegionBody = await upperRegionResponse.json();
const lowerRegionIds = lowerRegionBody.items.map((server) => server.id).sort().join(',');
const upperRegionIds = upperRegionBody.items.map((server) => server.id).sort().join(',');
if (!lowerRegionIds || lowerRegionIds !== upperRegionIds) {
  throw new Error('/api/servers region filter must be case-insensitive');
}
console.log('ok /api/servers region filter is case-insensitive');

const reconnectedServerResponse = await fetch(`${baseUrl}/api/servers/${connectedServer.id}`, {
  method: 'PATCH',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: updatedServer.name,
    provider: 'Custom',
    region: updatedServer.region,
    publicIp: updatedServer.publicIp,
    privateIp: updatedServer.privateIp,
    os: updatedServer.os,
    tags: updatedServer.tags,
    ssh: {
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'smoke-password',
      verifyMode: 'simulate',
    },
  }),
});
if (!reconnectedServerResponse.ok) {
  throw new Error(`/api/servers/:serverId reconnect PATCH returned HTTP ${reconnectedServerResponse.status}`);
}
const reconnectedServer = await reconnectedServerResponse.json();
if (reconnectedServer.ssh?.connected !== true || reconnectedServer.status !== 'running') {
  throw new Error('/api/servers/:serverId reconnect PATCH returned unexpected payload');
}
console.log('ok /api/servers/:serverId reconnect PATCH');

const metricsOverviewResponse = await fetch(`${baseUrl}/api/overview`, { headers: authHeaders });
if (!metricsOverviewResponse.ok) {
  throw new Error(`/api/overview metrics returned HTTP ${metricsOverviewResponse.status}`);
}
const metricsOverview = await metricsOverviewResponse.json();
const metricsServer = metricsOverview.servers.find((server) => server.id === connectedServer.id);
if (!metricsServer || metricsServer.cpu === 0 || metricsServer.memory === 0 || metricsServer.disk === 0) {
  throw new Error('/api/overview did not refresh server metrics');
}
console.log('ok /api/overview refreshes server metrics');

const diagnosticResponse = await fetch(`${baseUrl}/api/servers/${connectedServer.id}/diagnostics`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
});
if (!diagnosticResponse.ok) {
  throw new Error(`/api/servers/:serverId/diagnostics returned HTTP ${diagnosticResponse.status}`);
}
const diagnosticBody = await diagnosticResponse.json();
if (diagnosticBody.serverId !== connectedServer.id || !diagnosticBody.output?.includes('host=')) {
  throw new Error('/api/servers/:serverId/diagnostics returned unexpected payload');
}
console.log('ok /api/servers/:serverId/diagnostics');

const commandResponse = await fetch(`${baseUrl}/api/servers/commands`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    serverId: connectedServer.id,
    command: 'uptime',
  }),
});
if (!commandResponse.ok) {
  throw new Error(`/api/servers/commands returned HTTP ${commandResponse.status}`);
}
const commandBody = await commandResponse.json();
if (commandBody.serverId !== connectedServer.id || !commandBody.output?.includes('simulated$ uptime')) {
  throw new Error('/api/servers/commands returned unexpected payload');
}
console.log('ok /api/servers/commands');

const trimmedCommandResponse = await fetch(`${baseUrl}/api/servers/commands`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    serverId: connectedServer.id,
    command: '  hostname  ',
  }),
});
if (!trimmedCommandResponse.ok) {
  throw new Error(`/api/servers/commands trimmed command returned HTTP ${trimmedCommandResponse.status}`);
}
const trimmedCommandBody = await trimmedCommandResponse.json();
if (trimmedCommandBody.command !== 'hostname' || !trimmedCommandBody.output?.includes('simulated$ hostname')) {
  throw new Error('/api/servers/commands must trim command input before execution');
}
console.log('ok /api/servers/commands trims command input');

const sensitiveSshSecret = `ssh-secret-${Date.now()}`;
const sensitiveCommandResponse = await fetch(`${baseUrl}/api/servers/commands`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    serverId: connectedServer.id,
    command: `curl "https://example.invalid/health?token=${sensitiveSshSecret}" -H "Authorization: Bearer ${sensitiveSshSecret}"`,
  }),
});
if (!sensitiveCommandResponse.ok) {
  throw new Error(`/api/servers/commands sensitive command returned HTTP ${sensitiveCommandResponse.status}`);
}
const sensitiveCommandBody = await sensitiveCommandResponse.json();
const sensitiveCommandPayload = JSON.stringify(sensitiveCommandBody);
if (
  sensitiveCommandPayload.includes(sensitiveSshSecret)
  || !sensitiveCommandPayload.includes('[redacted]')
) {
  throw new Error('/api/servers/commands leaked sensitive SSH command text');
}
console.log('ok /api/servers/commands redacts sensitive command text');

const blankCommandResponse = await fetch(`${baseUrl}/api/servers/commands`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    serverId: connectedServer.id,
    command: '   ',
  }),
});
if (blankCommandResponse.status !== 400) {
  throw new Error(`/api/servers/commands expected 400 for blank command, got ${blankCommandResponse.status}`);
}
console.log('ok /api/servers/commands blocks blank command');

const shellResponse = await fetch(`${baseUrl}/api/servers/shells`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    serverId: connectedServer.id,
    cols: 100,
    rows: 28,
  }),
});
if (shellResponse.status !== 201) {
  throw new Error(`/api/servers/shells returned HTTP ${shellResponse.status}`);
}
const shellBody = await shellResponse.json();
if (shellBody.serverId !== connectedServer.id || !shellBody.sessionId) {
  throw new Error('/api/servers/shells returned unexpected payload');
}
const shellWriteResponse = await fetch(`${baseUrl}/api/servers/shells/${shellBody.sessionId}/input`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: 'whoami\n' }),
});
if (!shellWriteResponse.ok) {
  throw new Error(`/api/servers/shells/:sessionId/input returned HTTP ${shellWriteResponse.status}`);
}
const shellStreamResponse = await fetch(`${baseUrl}/api/servers/shells/${shellBody.sessionId}/stream`, {
  headers: authHeaders,
});
if (!shellStreamResponse.ok) {
  throw new Error(`/api/servers/shells/:sessionId/stream returned HTTP ${shellStreamResponse.status}`);
}
const shellStreamText = await readSseUntil(shellStreamResponse, (text) => text.includes('"type":"stdout"') && text.includes('simulated$ whoami'));
if (!shellStreamText.includes('"type":"start"') || !shellStreamText.includes('"type":"stdout"')) {
  throw new Error('/api/servers/shells/:sessionId/stream returned unexpected SSE payload');
}
const shellCloseResponse = await fetch(`${baseUrl}/api/servers/shells/${shellBody.sessionId}`, {
  method: 'DELETE',
  headers: authHeaders,
});
if (!shellCloseResponse.ok) {
  throw new Error(`/api/servers/shells/:sessionId DELETE returned HTTP ${shellCloseResponse.status}`);
}
console.log('ok /api/servers/shells realtime stream');

const actionResponse = await fetch(`${baseUrl}/api/servers/actions`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    serverId: connectedServer.id,
    action: 'reboot',
    reason: 'pre-release smoke verification',
    confirmed: true,
  }),
});
if (actionResponse.status !== 202) {
  throw new Error(`/api/servers/actions returned HTTP ${actionResponse.status}`);
}
const actionBody = await actionResponse.json();
if (actionBody.status !== 'executed' || actionBody.serverId !== connectedServer.id || actionBody.action !== 'reboot') {
  throw new Error('/api/servers/actions returned unexpected payload');
}
console.log('ok /api/servers/actions');

const unconfirmedActionResponse = await fetch(`${baseUrl}/api/servers/actions`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    serverId: connectedServer.id,
    action: 'reboot',
    reason: 'missing confirmation should be blocked',
  }),
});
if (unconfirmedActionResponse.status !== 409) {
  throw new Error(`/api/servers/actions expected 409 without confirmation, got ${unconfirmedActionResponse.status}`);
}
console.log('ok /api/servers/actions requires confirmation for reboot');

const missingDryRunActionResponse = await fetch(`${baseUrl}/api/servers/actions`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    serverId: `missing-${Date.now()}`,
    action: 'powerOn',
    reason: 'missing dry-run target should be rejected',
    dryRun: true,
  }),
});
if (missingDryRunActionResponse.status !== 404) {
  throw new Error(`/api/servers/actions dry-run expected 404 for missing server, got ${missingDryRunActionResponse.status}`);
}
console.log('ok /api/servers/actions dry-run validates target');

const operationHealthResponse = await fetch(`${baseUrl}/api/operations/tasks`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'healthCheck',
    targetMode: 'selected',
    serverIds: [connectedServer.id],
  }),
});
if (operationHealthResponse.status !== 202) {
  throw new Error(`/api/operations/tasks healthCheck returned HTTP ${operationHealthResponse.status}`);
}
const operationHealthBody = await operationHealthResponse.json();
if (
  operationHealthBody.status !== 'completed'
  || operationHealthBody.summary?.success !== 1
  || !operationHealthBody.outputs?.[0]?.output?.includes('host=')
) {
  throw new Error('/api/operations/tasks healthCheck returned unexpected payload');
}
console.log('ok /api/operations/tasks healthCheck');

const operationCommandResponse = await fetch(`${baseUrl}/api/operations/tasks`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'sshCommand',
    targetMode: 'selected',
    serverIds: [connectedServer.id],
    command: 'hostname',
    reason: 'pre-release orchestration smoke verification',
  }),
});
if (operationCommandResponse.status !== 202) {
  throw new Error(`/api/operations/tasks sshCommand returned HTTP ${operationCommandResponse.status}`);
}
const operationCommandBody = await operationCommandResponse.json();
if (
  operationCommandBody.status !== 'completed'
  || operationCommandBody.outputs?.[0]?.command !== 'hostname'
  || !operationCommandBody.outputs?.[0]?.output?.includes('simulated$ hostname')
) {
  throw new Error('/api/operations/tasks sshCommand returned unexpected payload');
}
console.log('ok /api/operations/tasks sshCommand');

const operationAssetResponse = await fetch(`${baseUrl}/api/operations/tasks`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'assetSync',
    targetMode: 'allServers',
  }),
});
if (operationAssetResponse.status !== 202) {
  throw new Error(`/api/operations/tasks assetSync returned HTTP ${operationAssetResponse.status}`);
}
const operationAssetBody = await operationAssetResponse.json();
if (
  operationAssetBody.status !== 'completed'
  || operationAssetBody.summary?.total < 1
  || !operationAssetBody.outputs?.some((item) => item.serverId === connectedServer.id && item.output.includes('provider='))
) {
  throw new Error('/api/operations/tasks assetSync returned unexpected payload');
}
console.log('ok /api/operations/tasks assetSync');

const operationAllServersUnconnectedResponse = await fetch(`${baseUrl}/api/operations/tasks`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'healthCheck',
    targetMode: 'allServers',
  }),
});
if (operationAllServersUnconnectedResponse.status !== 409) {
  throw new Error(`/api/operations/tasks expected 409 for allServers with unconnected targets, got ${operationAllServersUnconnectedResponse.status}`);
}
const operationAllServersUnconnectedBody = await operationAllServersUnconnectedResponse.json();
if (operationAllServersUnconnectedBody.error?.code !== 'OPERATIONS_TARGETS_UNCONNECTED') {
  throw new Error('/api/operations/tasks allServers unconnected targets returned unexpected error code');
}
console.log('ok /api/operations/tasks blocks allServers for SSH-required tasks with unconnected targets');

const operationRebootResponse = await fetch(`${baseUrl}/api/operations/tasks`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'reboot',
    targetMode: 'selected',
    serverIds: [connectedServer.id],
    reason: 'pre-release orchestration smoke verification',
    confirmed: true,
  }),
});
if (operationRebootResponse.status !== 202) {
  throw new Error(`/api/operations/tasks reboot returned HTTP ${operationRebootResponse.status}`);
}
const operationRebootBody = await operationRebootResponse.json();
if (
  operationRebootBody.status !== 'completed'
  || operationRebootBody.outputs?.[0]?.status !== 'success'
  || !operationRebootBody.outputs?.[0]?.output?.includes('simulated$')
) {
  throw new Error('/api/operations/tasks reboot returned unexpected payload');
}
console.log('ok /api/operations/tasks reboot');

const operationUnconfirmedRebootResponse = await fetch(`${baseUrl}/api/operations/tasks`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'reboot',
    targetMode: 'selected',
    serverIds: [connectedServer.id],
    reason: 'missing operation confirmation should be blocked',
  }),
});
if (operationUnconfirmedRebootResponse.status !== 409) {
  throw new Error(`/api/operations/tasks expected 409 without confirmation, got ${operationUnconfirmedRebootResponse.status}`);
}
console.log('ok /api/operations/tasks requires confirmation for reboot');

const operationUnconnectedSelectedResponse = await fetch(`${baseUrl}/api/operations/tasks`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'healthCheck',
    targetMode: 'selected',
    serverIds: [inventoryOnlyServer.id],
  }),
});
if (operationUnconnectedSelectedResponse.status !== 409) {
  throw new Error(`/api/operations/tasks expected 409 for selected unconnected target, got ${operationUnconnectedSelectedResponse.status}`);
}
const operationUnconnectedSelectedBody = await operationUnconnectedSelectedResponse.json();
if (operationUnconnectedSelectedBody.error?.code !== 'OPERATIONS_TARGETS_UNCONNECTED') {
  throw new Error('/api/operations/tasks selected unconnected target returned unexpected error code');
}
console.log('ok /api/operations/tasks blocks selected unconnected targets');

const operationMissingSelectedResponse = await fetch(`${baseUrl}/api/operations/tasks`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'healthCheck',
    targetMode: 'selected',
    serverIds: [`missing-${Date.now()}`],
  }),
});
if (operationMissingSelectedResponse.status !== 404) {
  throw new Error(`/api/operations/tasks expected 404 for missing selected target, got ${operationMissingSelectedResponse.status}`);
}
const operationMissingSelectedBody = await operationMissingSelectedResponse.json();
if (operationMissingSelectedBody.error?.code !== 'OPERATIONS_TARGETS_NOT_FOUND') {
  throw new Error('/api/operations/tasks missing selected target returned unexpected error code');
}
console.log('ok /api/operations/tasks blocks missing selected targets');

const deleteInventoryOnlyResponse = await fetch(`${baseUrl}/api/servers/${inventoryOnlyServer.id}`, { method: 'DELETE', headers: authHeaders });
if (!deleteInventoryOnlyResponse.ok) {
  throw new Error(`/api/servers/:serverId DELETE returned HTTP ${deleteInventoryOnlyResponse.status}`);
}
const deleteInventoryOnlyBody = await deleteInventoryOnlyResponse.json();
if (deleteInventoryOnlyBody.deleted !== true || deleteInventoryOnlyBody.id !== inventoryOnlyServer.id) {
  throw new Error('/api/servers/:serverId DELETE returned unexpected payload');
}
console.log('ok /api/servers/:serverId DELETE');

const deleteConnectedServerResponse = await fetch(`${baseUrl}/api/servers/${connectedServer.id}`, { method: 'DELETE', headers: authHeaders });
if (!deleteConnectedServerResponse.ok) {
  throw new Error(`/api/servers/:serverId DELETE connected smoke server returned HTTP ${deleteConnectedServerResponse.status}`);
}
const deleteConnectedServerBody = await deleteConnectedServerResponse.json();
if (deleteConnectedServerBody.deleted !== true || deleteConnectedServerBody.id !== connectedServer.id) {
  throw new Error('/api/servers/:serverId DELETE connected smoke server returned unexpected payload');
}
console.log('ok /api/servers/:serverId DELETE connected smoke server');

const auditResponse = await fetch(`${baseUrl}/api/audit/events`, { headers: authHeaders });
if (!auditResponse.ok) {
  throw new Error(`/api/audit/events returned HTTP ${auditResponse.status}`);
}
const auditBody = await auditResponse.json();
if (!Array.isArray(auditBody.items) || !auditBody.items.some((item) => item.action === 'OPERATIONS_TASK')) {
  throw new Error('/api/audit/events returned unexpected payload');
}
if (!auditBody.items.some((item) => item.action === 'CUSTOM_API_TEST' && item.status === 'blocked')) {
  throw new Error('/api/audit/events did not include blocked custom API evidence');
}
const sensitiveAuditEntry = auditBody.items.find(
  (item) => item.action === 'CUSTOM_API_TEST'
    && item.target?.includes('blocked.example.org/items')
    && item.target?.includes('page=1'),
);
if (
  !sensitiveAuditEntry
  || sensitiveAuditEntry.target.includes(sensitiveAuditSecret)
  || !(sensitiveAuditEntry.target.includes('[redacted]') || sensitiveAuditEntry.target.includes('%5Bredacted%5D'))
) {
  throw new Error('/api/audit/events leaked sensitive custom API URL query parameters');
}
if (customApiSuccessChecked && !auditBody.items.some((item) => item.action === 'CUSTOM_API_TEST' && item.status === 'success')) {
  throw new Error('/api/audit/events did not include successful custom API evidence');
}
const sensitiveSshAuditEntry = auditBody.items.find(
  (item) => item.action === 'SERVER_SSH_COMMAND'
    && item.detail?.includes('https://example.invalid/health'),
);
if (
  !sensitiveSshAuditEntry
  || sensitiveSshAuditEntry.detail.includes(sensitiveSshSecret)
  || !sensitiveSshAuditEntry.detail.includes('[redacted]')
) {
  throw new Error('/api/audit/events leaked sensitive SSH command detail');
}
if (!auditBody.items.some((item) => item.action === 'SERVER_ACTION' && item.status === 'blocked')) {
  throw new Error('/api/audit/events did not include blocked server action evidence');
}
if (!auditBody.items.some((item) => item.action === 'AUTH_LOGIN' && item.status === 'failed')) {
  throw new Error('/api/audit/events did not include failed login evidence');
}
if (!auditBody.items.some((item) => item.action === 'AUTH_LOGIN' && item.status === 'success' && item.actor === 'admin')) {
  throw new Error('/api/audit/events did not include successful login evidence');
}
if (!auditBody.items.some((item) => item.action === 'PROFILE_UPDATE' && item.status === 'success' && item.actor === 'admin')) {
  throw new Error('/api/audit/events did not include profile update evidence');
}
if (!auditBody.items.some((item) => item.action === 'AUTH_PASSWORD_CHANGE' && item.status === 'success' && item.actor === 'admin')) {
  throw new Error('/api/audit/events did not include password change evidence');
}
if (!auditBody.items.some((item) => item.action === 'AUTH_PASSWORD_CHANGE' && item.status === 'failed')) {
  throw new Error('/api/audit/events did not include failed password change evidence');
}
console.log('ok /api/audit/events');

const remediationResponse = await fetch(`${baseUrl}/api/audit/remediate`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'acknowledgeAuditFailures',
    target: 'audit-errors',
    note: 'smoke remediation closure',
  }),
});
if (!remediationResponse.ok) {
  throw new Error(`/api/audit/remediate returned HTTP ${remediationResponse.status}`);
}
const remediationBody = await remediationResponse.json();
if (remediationBody.ok !== true || remediationBody.audit?.action !== 'SECURITY_REMEDIATION' || remediationBody.audit?.target !== 'audit-errors') {
  throw new Error('/api/audit/remediate returned unexpected remediation payload');
}
const remediatedAuditResponse = await fetch(`${baseUrl}/api/audit/events`, { headers: authHeaders });
const remediatedAuditBody = await remediatedAuditResponse.json();
if (!remediatedAuditBody.items?.some((item) => item.action === 'SECURITY_REMEDIATION' && item.target === 'audit-errors' && item.actor === 'admin')) {
  throw new Error('/api/audit/events did not include security remediation evidence');
}
console.log('ok /api/audit/remediate records remediation closure');

const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: authHeaders });
if (!logoutResponse.ok) {
  throw new Error(`/api/auth/logout returned HTTP ${logoutResponse.status}`);
}
const logoutBody = await logoutResponse.json();
if (logoutBody.authenticated !== false) {
  throw new Error('/api/auth/logout returned unexpected payload');
}
const postLogoutCookie = logoutResponse.headers.get('set-cookie')?.split(';')[0];
const postLogoutAuthHeaders = postLogoutCookie ? { Cookie: postLogoutCookie } : {};
const postLogoutAuditResponse = await fetch(`${baseUrl}/api/audit/events`, { headers: postLogoutAuthHeaders });
if (postLogoutAuditResponse.status !== 401) {
  throw new Error(`/api/audit/events expected 401 after logout, got ${postLogoutAuditResponse.status}`);
}
const loggedOutSessionResponse = await fetch(`${baseUrl}/api/auth/session`, { headers: postLogoutAuthHeaders });
if (!loggedOutSessionResponse.ok) {
  throw new Error(`/api/auth/session after logout returned HTTP ${loggedOutSessionResponse.status}`);
}
const loggedOutSessionBody = await loggedOutSessionResponse.json();
if (loggedOutSessionBody.authenticated !== false) {
  throw new Error('/api/auth/session after logout returned unexpected payload');
}
console.log('ok /api/auth/logout clears session');

const reloginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: smokeUsername,
    password: currentSmokePassword,
  }),
});
if (!reloginResponse.ok) {
  throw new Error(`/api/auth/login after logout returned HTTP ${reloginResponse.status}`);
}
const reloginCookie = reloginResponse.headers.get('set-cookie')?.split(';')[0];
if (!reloginCookie) {
  throw new Error('/api/auth/login after logout did not set a session cookie');
}
const reloginAuthHeaders = { Cookie: reloginCookie };
const logoutAuditResponse = await fetch(`${baseUrl}/api/audit/events`, { headers: reloginAuthHeaders });
if (!logoutAuditResponse.ok) {
  throw new Error(`/api/audit/events after relogin returned HTTP ${logoutAuditResponse.status}`);
}
const logoutAuditBody = await logoutAuditResponse.json();
if (!logoutAuditBody.items?.some((item) => item.action === 'AUTH_LOGOUT' && item.status === 'success' && item.actor === 'admin')) {
  throw new Error('/api/audit/events did not include logout evidence');
}
console.log('ok /api/audit/events includes logout evidence');

const frontendResponse = await fetch(`${baseUrl}/`);
const html = await frontendResponse.text();
if (!frontendResponse.ok || !html.includes('root') || !html.includes('CoLiPas')) {
  throw new Error('/ did not return the built frontend shell');
}
console.log('ok / frontend shell');

const appSource = fs.readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
if (!appSource.includes("import { LoginPage } from './LoginPage';")) {
  throw new Error('Deployed app must render LoginPage for unauthenticated visitors');
}
if (appSource.includes('MarketingPage') || appSource.includes('DocsPage') || appSource.includes('onDocsPage')) {
  throw new Error('Deployed app must not expose marketing or docs pages at runtime');
}
console.log('ok deployed frontend is limited to login and authenticated console');

function assertAiProviderSecretNotPersisted() {
  const aiConsoleSource = fs.readFileSync(new URL('../src/modules/ai/AIConsole.tsx', import.meta.url), 'utf8');
  if (aiConsoleSource.includes('localStorage.setItem(aiProviderStorageKey, JSON.stringify(provider))')) {
    throw new Error('AI provider storage must not persist provider.apiKey to localStorage');
  }

  const storedProviderBody = aiConsoleSource.match(/function\s+toStoredProvider[\s\S]*?return\s+\{([\s\S]*?)\};\s*\}/)?.[1] ?? '';
  if (!storedProviderBody || /\bapiKey\b/.test(storedProviderBody)) {
    throw new Error('toStoredProvider must strip apiKey before writing AI provider settings');
  }

  if (!aiConsoleSource.includes('apiKey: defaultAIProvider.apiKey')) {
    throw new Error('loadStoredProvider must ignore legacy apiKey values from localStorage');
  }

  if (!aiConsoleSource.includes('modelRequestSeqRef') || !aiConsoleSource.includes('modelRequestSeqRef.current !== requestSeq')) {
    throw new Error('AI model refresh must ignore stale model-list responses');
  }

  if (!aiConsoleSource.includes('aiStatePersistTimerRef') || !aiConsoleSource.includes('persistConsoleState(latestConsoleStateRef.current)')) {
    throw new Error('AI console state persistence must be debounced and flushed on unmount');
  }

  const persistenceEffectBody = aiConsoleSource.match(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?latestConsoleStateRef\.current\s*=\s*state;([\s\S]*?)\},\s*\[activeSessionId,\s*connectionTest,\s*sessions\]\);/)?.[1] ?? '';
  if (!persistenceEffectBody || persistenceEffectBody.includes('localStorage.setItem')) {
    throw new Error('AI console must not synchronously write the full chat state on every input change');
  }

  console.log('ok AI provider localStorage strips API key and guards stale model refreshes');
}

function assertAiStreamingCompatibility() {
  const aiServiceSource = fs.readFileSync(new URL('../src/server/services/aiService.ts', import.meta.url), 'utf8');
  const aiConfigSource = fs.readFileSync(new URL('../src/modules/ai/aiConfig.ts', import.meta.url), 'utf8');
  const requiredFragments = [
    'choice?.delta?.content',
    'choice?.message?.content',
    'choice?.text',
    'parsed.response',
    'parsed.content',
    'normalizeChatHistory(input.messages)',
    'const question = (input.question || input.prompt || \'\').trim()',
    'inputApiKey !== \'__use_server_env__\'',
    'shouldUseOperationsContext(question, selectedServer)',
    'Answer the user question directly and naturally',
    'For casual, meta, or general questions, do not force an operations-risk template',
    'Continue the conversation naturally',
    '...chatHistory',
    'publicProviderEndpoint(aiProvider.baseUrl)',
    'url.username || url.password || url.search || url.hash',
    '.split(/\\r?\\n/)',
    'AI Base URL 不能包含账号、密码、查询参数或片段',
    'await response.body?.cancel().catch(() => undefined)',
  ];
  const missing = requiredFragments.filter((fragment) => {
    if (fragment.startsWith('AI Base URL')) {
      return !aiServiceSource.includes('AI Base URL must not include username, password, query parameters, or fragments');
    }
    return !aiServiceSource.includes(fragment);
  });
  if (missing.length) {
    throw new Error(`AI stream parser compatibility is incomplete: ${missing.join(', ')}`);
  }

  const forbiddenFragments = [
    'const body = await response.text();',
    'body.slice(0, 160)',
    'provider: aiProvider.baseUrl',
  ];
  const regressions = forbiddenFragments.filter((fragment) => aiServiceSource.includes(fragment));
  if (regressions.length) {
    throw new Error(`AI provider handling may leak sensitive data: ${regressions.join(', ')}`);
  }

  const validationFragments = [
    'errors.push(copy.baseUrlClean)',
    'baseUrlClean',
    'username, password, query parameters, or fragments',
  ];
  const missingValidation = validationFragments.filter((fragment) => !aiConfigSource.includes(fragment));
  if (missingValidation.length) {
    throw new Error(`AI Base URL frontend validation is incomplete: ${missingValidation.join(', ')}`);
  }

  console.log('ok AI stream parser supports compatible content variants and guards provider secret leakage');
}

function assertAiResponseCachingGuards() {
  const aiServiceSource = fs.readFileSync(new URL('../src/server/services/aiService.ts', import.meta.url), 'utf8');
  const aiConsoleSource = fs.readFileSync(new URL('../src/modules/ai/AIConsole.tsx', import.meta.url), 'utf8');
  const apiClientSource = fs.readFileSync(new URL('../src/services/apiClient.ts', import.meta.url), 'utf8');
  const promptSource = fs.readFileSync(new URL('../src/shared/aiPrompt.ts', import.meta.url), 'utf8');

  const backendFragments = [
    'const aiResponseCache = new Map',
    'aiResponseCacheTtlMs',
    'buildAiCacheKey(aiProvider',
    'const cached = input.forceRefresh ? undefined : getCachedAiResponse(cacheKey)',
    'cached: true',
    'setCachedAiResponse(cacheKey, result)',
    'Local rule analysis. No API key is configured',
    'Question: ${question}',
    'riskReasons(server',
  ];
  const missingBackend = backendFragments.filter((fragment) => !aiServiceSource.includes(fragment));
  if (missingBackend.length) {
    throw new Error(`AI backend cache/dynamic-answer guards are incomplete: ${missingBackend.join(', ')}`);
  }

  if (aiServiceSource.includes('apiKey') && aiServiceSource.includes('createHash')) {
    const cacheKeyBody = aiServiceSource.match(/function buildAiCacheKey[\s\S]*?return `ai:\$\{hash\}`;/)?.[0] ?? '';
    if (cacheKeyBody.includes('apiKey')) {
      throw new Error('AI response cache key must not include provider.apiKey');
    }
  }

  const frontendFragments = [
    'const aiResponseCacheStorageKey',
    'buildAiResponseCacheKey(provider',
    'const requestForceRefresh = forceRefresh || !useLocalCache',
    'const cachedResult = requestForceRefresh ? null : getCachedAiResponse(cacheKey)',
    'setCachedAiResponse(cacheKey, result)',
    'handleAnalyze(true)',
    'toRequestHistory(baseMessages)',
    'ai-chat-thread',
    'ai-live-strip',
    'serverAiConfigured',
    "t('ai.apiKeyEphemeral')",
    "t('ai.cachedResult')",
    "t('ai.forceRegenerate')",
    "t('ai.cacheHit')",
  ];
  const missingFrontend = frontendFragments.filter((fragment) => !aiConsoleSource.includes(fragment));
  if (missingFrontend.length) {
    throw new Error(`AI frontend cache guards are incomplete: ${missingFrontend.join(', ')}`);
  }

  const apiFragments = [
    'forceRefresh?: boolean',
    'forceRefresh: options.forceRefresh === true',
    'messages: options.messages ?? []',
    'signal: options.signal',
  ];
  const missingApi = apiFragments.filter((fragment) => !apiClientSource.includes(fragment));
  if (missingApi.length) {
    throw new Error(`AI client force-refresh support is incomplete: ${missingApi.join(', ')}`);
  }

  const promptFragments = [
    'Current CoLiPas operations context',
    'Use this context only when it is relevant to the user question',
    'Do not invent servers',
    'Server inventory:',
    'High-load servers:',
    'Open operation/security events:',
  ];
  const missingPrompt = promptFragments.filter((fragment) => !promptSource.includes(fragment));
  if (missingPrompt.length) {
    throw new Error(`AI prompt grounding is incomplete: ${missingPrompt.join(', ')}`);
  }

  console.log('ok AI analysis caches repeated prompts and produces grounded dynamic local answers');
}

function assertAiConsoleI18nCoverage() {
  const aiConsoleSource = fs.readFileSync(new URL('../src/modules/ai/AIConsole.tsx', import.meta.url), 'utf8');
  const aiConfigSource = fs.readFileSync(new URL('../src/modules/ai/aiConfig.ts', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
  const i18nSource = fs.readFileSync(new URL('../src/i18n.tsx', import.meta.url), 'utf8');
  const forbiddenFragments = [
    '>OpenAI Compatible Base URL<',
    '>API Key<',
    'aria-label="AI chat input"',
    'aria-label="刷新 API 模型列表"',
    'title="刷新 API 模型列表"',
    '} tokens</strong>',
  ];
  const hardcoded = forbiddenFragments.filter((fragment) => aiConsoleSource.includes(fragment));
  if (hardcoded.length) {
    throw new Error(`AI console has hardcoded localized text: ${hardcoded.join(', ')}`);
  }

  const requiredKeys = [
    "'ai.baseUrl'",
    "'ai.apiKey'",
    "'ai.temperature'",
    "'ai.tokens'",
    "'ai.chatInput'",
  ];
  const missingKeys = requiredKeys.filter((key) => (i18nSource.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length < 3);
  if (missingKeys.length) {
    throw new Error(`AI console i18n keys are missing in one or more languages: ${missingKeys.join(', ')}`);
  }

  if (aiConsoleSource.includes('Temperature:')) {
    throw new Error('AI console has hardcoded temperature label');
  }

  const validationFragments = [
    "validateAIProviderConfig(provider, language)",
    'const validationCopy',
    'providerNameShort',
    'Temperature must be between 0 and 2',
    '温度は 0 から 2 の範囲で指定してください',
  ];
  const missingValidation = validationFragments.filter((fragment) => !(aiConsoleSource + aiConfigSource).includes(fragment));
  if (missingValidation.length) {
    throw new Error(`AI provider validation messages are not fully localized: ${missingValidation.join(', ')}`);
  }

  const forbiddenValidationFragments = [
    "errors.push('",
    'errors.push("',
  ];
  const hardcodedValidation = forbiddenValidationFragments.filter((fragment) => aiConfigSource.includes(fragment));
  if (hardcodedValidation.length) {
    throw new Error(`AI provider validation must use validationCopy instead of inline messages: ${hardcodedValidation.join(', ')}`);
  }

  const shortcutFragments = [
    'openAiWithQuestion(t(\'app.aiPromptRiskQuestion\'))',
    'openAiWithQuestion(t(\'app.aiPromptSshQuestion\'))',
    'openAiWithQuestion(t(\'app.aiPromptPriorityQuestion\'))',
    'seedQuestion={aiSeedQuestion}',
    'onSeedQuestionConsumed={() => setAiSeedQuestion(\'\')}',
    'seedQuestion.trim()',
  ];
  const shortcutSources = `${appSource}\n${aiConsoleSource}`;
  const missingShortcutFragments = shortcutFragments.filter((fragment) => !shortcutSources.includes(fragment));
  if (missingShortcutFragments.length) {
    throw new Error(`AI prompt shortcuts are not wired into chat state: ${missingShortcutFragments.join(', ')}`);
  }

  const promptQuestionKeys = [
    "'app.aiPromptRiskQuestion'",
    "'app.aiPromptSshQuestion'",
    "'app.aiPromptPriorityQuestion'",
  ];
  const missingPromptQuestionKeys = promptQuestionKeys.filter((key) => (i18nSource.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length < 3);
  if (missingPromptQuestionKeys.length) {
    throw new Error(`AI prompt shortcut question keys are missing in one or more languages: ${missingPromptQuestionKeys.join(', ')}`);
  }

  console.log('ok AI console visible labels use i18n keys');
}

function assertCloudAccountsI18nCoverage() {
  const cloudSource = fs.readFileSync(new URL('../src/modules/cloud/CloudAccounts.tsx', import.meta.url), 'utf8');
  const i18nSource = fs.readFileSync(new URL('../src/i18n.tsx', import.meta.url), 'utf8');
  const forbiddenFragments = [
    '>云账号接入<',
    '>同步资产<',
    '>尚未接入云账号<',
    '个地域',
    '台服务器',
    '>月成本<',
    '>最近同步<',
    'statusLabel(account.status)',
    'formatCurrency(account.monthlyCost)',
  ];
  const hardcoded = forbiddenFragments.filter((fragment) => cloudSource.includes(fragment));
  if (hardcoded.length) {
    throw new Error(`Cloud accounts page has hardcoded localized text: ${hardcoded.join(', ')}`);
  }

  const requiredKeys = [
    "'cloud.eyebrow'",
    "'cloud.title'",
    "'cloud.syncAssets'",
    "'cloud.emptyTitle'",
    "'cloud.emptyDesc'",
    "'cloud.accountMeta'",
    "'cloud.monthlyCost'",
    "'cloud.lastSync'",
  ];
  const missingKeys = requiredKeys.filter((key) => (i18nSource.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length < 3);
  if (missingKeys.length) {
    throw new Error(`Cloud accounts i18n keys are missing in one or more languages: ${missingKeys.join(', ')}`);
  }

  console.log('ok cloud accounts visible labels use i18n keys');
}

function assertCustomApiSecretNotPersisted() {
  const customApiSource = fs.readFileSync(new URL('../src/modules/custom-api/CustomApiLab.tsx', import.meta.url), 'utf8');
  const globalStyleSource = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  if (customApiSource.includes('localStorage.setItem(storageKey, JSON.stringify(config))')) {
    throw new Error('Custom API storage must not persist authToken to localStorage');
  }

  const requiredUiFragments = [
    'savedIntegrationsKey',
    'IntegrationTemplateId',
    'api-template-grid',
    'api-template-card',
    'api-linkage-panel',
    'api-integration-list',
    'assetSync',
    'alertWebhook',
    'billingUsage',
    'linkOverviewMap',
    'linkSecurityAudit',
    "authToken: ''",
  ];
  for (const fragment of requiredUiFragments) {
    if (!customApiSource.includes(fragment)) {
      throw new Error(`Custom API integration center is missing ${fragment}`);
    }
  }

  const requiredStyleFragments = [
    '.api-template-grid',
    '.api-template-card',
    '.api-linkage-panel',
    '.api-integration-list',
    '.api-integration-row',
    '.api-integration-row b',
    '.content:not(.ai-collapsed) .api-layout',
    '.content:not(.ai-collapsed) .api-workbench-layout',
    '.content:not(.ai-collapsed) .api-header .section-actions',
  ];
  for (const fragment of requiredStyleFragments) {
    if (!globalStyleSource.includes(fragment)) {
      throw new Error(`Custom API integration center style is missing ${fragment}`);
    }
  }

  const storedConfigBody = customApiSource.match(/function\s+toStoredConfig[\s\S]*?return\s+\{([\s\S]*?)\};\s*\}/)?.[1] ?? '';
  if (!storedConfigBody || !storedConfigBody.includes("authToken: ''")) {
    throw new Error('toStoredConfig must strip authToken before writing custom API settings');
  }

  const loadStoredConfigBody = customApiSource.match(/function\s+loadStoredConfig\(\)\s+\{([\s\S]*?)\n\}/)?.[1] ?? '';
  if (!loadStoredConfigBody.includes("authToken: ''")) {
    throw new Error('loadStoredConfig must ignore legacy authToken values from localStorage');
  }

  console.log('ok custom API integration center and localStorage token guard');
}

function assertSqlitePersistenceGuards() {
  const databaseSource = fs.readFileSync(new URL('../src/server/services/database.ts', import.meta.url), 'utf8');
  const inventoryServiceSource = fs.readFileSync(new URL('../src/server/services/inventoryService.ts', import.meta.url), 'utf8');
  const auditServiceSource = fs.readFileSync(new URL('../src/server/services/auditService.ts', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
  const combined = [databaseSource, inventoryServiceSource, auditServiceSource, appSource].join('\n');
  const requiredFragments = [
    "import { DatabaseSync } from 'node:sqlite'",
    "path.join(dataDir, 'colipas.sqlite')",
    'PRAGMA busy_timeout = 5000',
    'PRAGMA wal_autocheckpoint = 200',
    'PRAGMA journal_size_limit = 1048576',
    'export function checkpointDatabase()',
    'const maxWalBytes = 1024 * 1024',
    'function checkpointDatabaseIfNeeded()',
    'fs.statSync(walPath).size > maxWalBytes',
    'PRAGMA wal_checkpoint(TRUNCATE)',
    'checkpointDatabaseIfNeeded()',
    'CREATE TABLE IF NOT EXISTS servers',
    'CREATE TABLE IF NOT EXISTS credentials',
    'CREATE TABLE IF NOT EXISTS audit_entries',
    'replaceServerRows(servers)',
    'replaceCredentialRows(Object.fromEntries(persistedCredentials))',
    'replaceAuditRows(auditEntries)',
    "driver: 'sqlite'",
    'name: path.basename(getDatabasePath())',
  ];
  const missing = requiredFragments.filter((fragment) => !combined.includes(fragment));
  if (missing.length) {
    throw new Error(`SQLite persistence guard is incomplete: ${missing.join(', ')}`);
  }

  const refreshServerMetricsBody = inventoryServiceSource.match(/export async function refreshServerMetrics\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  if (!refreshServerMetricsBody || refreshServerMetricsBody.includes('persistInventory()') || refreshServerMetricsBody.includes('replaceServerRows')) {
    throw new Error('Overview metric refresh must not rewrite SQLite inventory rows');
  }

  const healthRouteBody = appSource.match(/app\.get\('\/api\/health'[\s\S]*?\n  \}\);/)?.[0] ?? '';
  if (healthRouteBody.includes('recordAudit') || healthRouteBody.includes('HEALTH_CHECK')) {
    throw new Error('Health endpoint must not write audit rows or churn the SQLite WAL');
  }

  const inspectRouteBody = appSource.match(/app\.post\('\/api\/servers\/inspect'[\s\S]*?\n  \}\);/)?.[0] ?? '';
  if (inspectRouteBody.includes('recordAudit') || inspectRouteBody.includes('SERVER_IDENTITY_INSPECT')) {
    throw new Error('Automatic server identity inspection must not write audit rows or churn the SQLite WAL');
  }

  const frontendSource = fs.readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
  const frontendRequired = [
    'overviewRefreshInFlightRef',
    'sessionAuthenticatedRef',
    'appMountedRef',
    'overviewRefreshInFlightRef.current = true',
    'overviewRefreshInFlightRef.current = false',
    'void refreshOverview()',
  ];
  const missingFrontend = frontendRequired.filter((fragment) => !frontendSource.includes(fragment));
  if (missingFrontend.length) {
    throw new Error(`Overview auto-refresh concurrency guard is incomplete: ${missingFrontend.join(', ')}`);
  }

  console.log('ok SQLite persistence layer stores structural data without churn from health, identity inspect, or overview polling');
}

function assertBuildChunkingGuards() {
  const viteConfig = fs.readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
  const requiredFragments = [
    'manualChunks(id)',
    "'vendor-react'",
    "'vendor-map'",
    "'vendor-icons'",
    "id.includes('node_modules/react')",
    "id.includes('node_modules/d3-geo')",
    "id.includes('node_modules/topojson-client')",
    "id.includes('node_modules/world-atlas')",
    "id.includes('node_modules/lucide-react')",
  ];
  const missing = requiredFragments.filter((fragment) => !viteConfig.includes(fragment));
  if (missing.length) {
    throw new Error(`Build chunking guard is incomplete: ${missing.join(', ')}`);
  }

  console.log('ok production build splits React, map, and icon vendors');
}

function assertRepositoryPreviewAssetGuards() {
  const readmeSource = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const githubPreviewUrl = new URL('../.github/assets/colipas-dashboard-preview.svg', import.meta.url);
  const publicPreviewUrl = new URL('../public/colipas-dashboard-preview.svg', import.meta.url);
  const previewSource = fs.readFileSync(githubPreviewUrl, 'utf8');

  if (!readmeSource.includes('.github/assets/colipas-dashboard-preview.svg')) {
    throw new Error('README preview image must point to .github/assets, not deployed public assets');
  }
  if (readmeSource.includes('public/colipas-dashboard-preview.svg') || fs.existsSync(publicPreviewUrl)) {
    throw new Error('Repository preview image must not be copied into the production public directory');
  }
  if (!previewSource.includes('PUBLIC PREVIEW') || !previewSource.includes('deployment opens login console only')) {
    throw new Error('Repository preview image must clearly describe sanitized public preview and deployment behavior');
  }

  console.log('ok repository preview asset stays outside deployed public assets');
}

function assertOverviewMapInteractionGuards() {
  const overviewSource = fs.readFileSync(new URL('../src/modules/overview/MonitoringOverview.tsx', import.meta.url), 'utf8');
  const requiredFragments = [
    'moved: boolean',
    'suppressMapClickRef.current = drag.moved',
    'Math.hypot(deltaX, deltaY) > 5',
    'if (suppressMapClickRef.current)',
    'title: regionNames.length > 2',
    'const weightedTotal = Math.max(1, regions.reduce((sum, region) => sum + region.total, 0))',
    'const regionAnchor = {',
    'region.x * region.total',
    'region.y * region.total',
    'const visibleTooltipAnchor = visibleCountryPopup ? getTooltipViewportAnchor(visibleCountryPopup) : null',
    'const tooltipIsPinned = Boolean(pinnedCountry && visibleCountryPopup && pinnedCountry.title === visibleCountryPopup.title)',
    'function getTooltipViewportAnchor(country: CountryHover)',
    '50 + (country.x - 50) * mapView.scale + (mapView.x / width) * 100',
    '50 + (country.y - 50) * mapView.scale + (mapView.y / height) * 100',
    'left: `${clamp(visibleTooltipAnchor?.x ?? visibleCountryPopup.x, 8, 92)}%`',
    'top: `${clamp(visibleTooltipAnchor?.y ?? visibleCountryPopup.y, 12, 82)}%`',
    'className="region-row"',
    'aria-label={`${t(\'overview.focusRegion\')}: ${region.region}`}',
    'onClick={() => focusRegion(region)}',
    'function buildRegionHover(region: RegionNode): CountryHover',
    'setPinnedCountry(buildRegionHover(region))',
    '{visibleCountryPopup.title}',
    'tooltipIsPinned && (',
    'map-tooltip-action',
    'aria-label={`${t(\'overview.viewRegionServers\')}: ${visibleCountryPopup.title}`}',
    "t('overview.viewRegionServers')",
    'openRegionServers(visibleCountryPopup)',
    'function openRegionServers(country: CountryHover)',
    'onPointerDown={(event) =>',
    "onKeyDown={(event) =>",
    "event.key === 'Enter' || event.key === ' '",
    'clampMapPan',
    'getMapPanBounds',
    'getFocusedMapView',
    'Math.round(((50 - region.x) / 100) * width)',
    'Math.round(((50 - region.y) / 100) * height)',
    'hasPointerCapture',
    "closest('button, .map-tooltip, .map-country.active')",
    'onPointerLeave={handleMapPointerLeave}',
    'function handleMapPointerLeave',
    "mapView.scale > 1.01 ? 'is-zoomed'",
    "event.pointerType === 'touch' && mapView.scale <= 1.01",
    "event.key === 'Escape'",
    'onFocus={() =>',
    'onBlur={() => setHoveredCountry(null)}',
    'setHoveredCountry(null);',
    'aria-label={countryHover ?',
    'aria-pressed={matchedRegions.some',
    'ResizeObserver',
    'orientationchange',
    'window.addEventListener(\'resize\', settleMapView)',
    "const fallbackLocation: RegionLocation = { lat: 18, lng: 0, countryId: '', matched: false }",
    'countryIds: getRenderableCountryIds(location)',
    '?? fallbackLocation',
    'const normalizedRegions = buildRegionSearchVariants(region)',
    'function buildRegionSearchVariants(region: string): string[]',
    'const shortRegionExpansions',
    'function addShortRegionVariants',
    "la: 'los angeles'",
    "variants.add(expandedTokens.join(' '))",
    "replace(/\\bunited states\\b/g, 'us')",
    "replace(/\\busa\\b/g, 'us')",
    "const splitRegionTokens = countryNormalized.split(/[-\\s/]+/).filter(Boolean)",
    "addShortRegionVariants(variants, splitRegionTokens)",
    'function containsTokenSequence(tokens: string[], aliasTokens: string[]): boolean',
    'exactMatch?.location ?? partialMatch?.location ?? countryCodeLocation ?? fallbackLocation',
    'const countryCodeLocations',
    'resolveCountryCodeLocation',
    'getRenderableCountryIds',
    "HK: { lat: 22.3193",
    "SG: { lat: 1.3521",
    'countryIds: [\'156\']',
    'mapCountryIds.has(countryId)',
    "'us-la'",
    'lat: 34.0522',
    "'us-ny'",
    'lat: 40.7128',
    "'us-sjc'",
    'lat: 37.3382',
    "'ap-hongkong'",
    "'us-siliconvalley'",
    "'us-california-los angeles'",
    "'california-los angeles'",
    "'ロサンゼルス'",
    "'ニューヨーク'",
    "'東京'",
    "'米国'",
    "replace(/美国|美國|米国|アメリカ/g, 'us')",
    ".normalize('NFKC')",
    "'us-east-1'",
    "'eastus'",
    "'ap-southeast-1'",
    "'northamerica-northeast1'",
    "'hong kong sar'",
    "'taipei'",
    "'new york'",
    "'dallas'",
  ];
  const missing = requiredFragments.filter((fragment) => !overviewSource.includes(fragment));
  if (missing.length) {
    throw new Error(`Overview map interaction guard is incomplete: ${missing.join(', ')}`);
  }

  if (overviewSource.includes('fallbackLocations')) {
    throw new Error('Overview map must not rotate unknown regions through real country locations');
  }
  if (overviewSource.includes('--map-tooltip-scale') || overviewSource.includes("Record<'--map-tooltip-scale'")) {
    throw new Error('Overview map tooltip must not be counter-scaled inside the transformed map layer');
  }

  const tooltipPointerDownBlock = overviewSource.slice(
    overviewSource.indexOf('onPointerDown={(event) =>', overviewSource.indexOf('className="map-tooltip-action"')),
    overviewSource.indexOf('onClick={(event) =>', overviewSource.indexOf('className="map-tooltip-action"')),
  );
  const tooltipClickBlock = overviewSource.slice(
    overviewSource.indexOf('onClick={(event) =>', overviewSource.indexOf('className="map-tooltip-action"')),
    overviewSource.indexOf('>', overviewSource.indexOf('onClick={(event) =>', overviewSource.indexOf('className="map-tooltip-action"'))),
  );
  if (!tooltipPointerDownBlock.includes('openRegionServers(visibleCountryPopup);')) {
    throw new Error('Overview map tooltip action must fire on pointerdown for reliable map overlay clicks');
  }
  if (tooltipClickBlock.includes('openRegionServers(visibleCountryPopup);')) {
    throw new Error('Overview map tooltip action must not fire on both pointerdown and click');
  }

  const globalCss = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  const cssFragments = [
    '.map-tooltip.flip-x',
    '.map-tooltip.flip-y',
    'max-width: min(204px, calc(100vw - 58px))',
    'max-height: 178px',
    'overscroll-behavior: contain',
    'inset: 34px 8px 58px',
    'bottom: 9px',
    '.content:not(.ai-collapsed) .cloud-map',
    'margin-bottom: calc(min(46vh, 360px) + 18px)',
    '.content:not(.ai-collapsed) .map-controls',
    'bottom: calc(min(46vh, 360px) + 24px)',
    'width: max-content',
    'max-width: calc(100% - 20px)',
    'backdrop-filter: blur(8px)',
    'touch-action: pan-y',
    '.nezha-map.is-zoomed',
    '.map-tooltip-action',
    'pointer-events: none',
    '.map-tooltip.pinned',
    'pointer-events: auto',
    '.region-row:hover',
    '.region-row:focus-visible',
    '.map-country.active:focus-visible',
    'drop-shadow(0 0 6px rgba(15, 118, 110, 0.42))',
  ];
  const missingCss = cssFragments.filter((fragment) => !globalCss.includes(fragment));
  if (missingCss.length) {
    throw new Error(`Overview map responsive tooltip CSS is incomplete: ${missingCss.join(', ')}`);
  }
  if (globalCss.includes('--map-tooltip-scale')) {
    throw new Error('Overview map CSS must not counter-scale tooltip content');
  }

  console.log('ok overview map guards drag clicks, pan bounds, and responsive tooltip');
}

function assertMapRegionScopeLifecycleGuards() {
  const appSource = fs.readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
  const requiredFragments = [
    'const availableRegions = new Set(overview.servers.map',
    'const validRegionScope = scopedRegions.filter',
    'const regionIsStale = filters.region !== \'all\' && !availableRegions.has(selectedRegion)',
    'currentRegionIsStale ? \'all\' : current.region',
    'validRegionScope.length !== scopedRegions.length',
    "region: nextScope.length === 1 ? nextScope[0] : currentRegionIsStale ? 'all' : current.region",
    'regionScope: nextScope.length > 0 ? nextScope : undefined',
    '}, [filters.region, filters.regionScope, overview.servers]);',
  ];
  const missing = requiredFragments.filter((fragment) => !appSource.includes(fragment));
  if (missing.length) {
    throw new Error(`Map region scope lifecycle guard is incomplete: ${missing.join(', ')}`);
  }

  console.log('ok map region scope clears stale regions after inventory changes');
}

function assertOverviewServerFilterLinkage() {
  const appSource = fs.readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
  const overviewSource = fs.readFileSync(new URL('../src/modules/overview/MonitoringOverview.tsx', import.meta.url), 'utf8');
  const i18nSource = fs.readFileSync(new URL('../src/i18n.tsx', import.meta.url), 'utf8');
  const requiredAppFragments = [
    'function openServersForRegion(region: string | string[])',
    'const regionScope = (Array.isArray(region) ? region : [region])',
    "setActiveSection('servers')",
    "region: regionScope.length === 1 ? regionScope[0] : 'all'",
    'regionScope,',
    'onRegionServersOpen={openServersForRegion}',
  ];
  const missingApp = requiredAppFragments.filter((fragment) => !appSource.includes(fragment));
  if (missingApp.length) {
    throw new Error(`Overview-to-server region linkage is incomplete: ${missingApp.join(', ')}`);
  }

  const requiredOverviewFragments = [
    'onRegionServersOpen?: (region: string | string[]) => void',
    'className="map-tooltip-action"',
    "t('overview.viewRegionServers')",
    'country.regions.map((region) => region.region)',
  ];
  const missingOverview = requiredOverviewFragments.filter((fragment) => !overviewSource.includes(fragment));
  if (missingOverview.length) {
    throw new Error(`Overview map tooltip server action is incomplete: ${missingOverview.join(', ')}`);
  }

  const keyCount = (i18nSource.match(/'overview\.viewRegionServers'/g) ?? []).length;
  if (keyCount < 3) {
    throw new Error('overview.viewRegionServers must be translated in zh/en/ja');
  }

  const sharedFilterSource = fs.readFileSync(new URL('../src/shared/serverFilters.ts', import.meta.url), 'utf8');
  const inventoryServiceSource = fs.readFileSync(new URL('../src/server/services/inventoryService.ts', import.meta.url), 'utf8');
  const inventorySource = fs.readFileSync(new URL('../src/modules/servers/ServerInventory.tsx', import.meta.url), 'utf8');
  const globalCss = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  const regionScopeFragments = [
    'regionScope?: string[]',
    'const scopedRegions = new Set((filters.regionScope ?? []).map(normalizeFilterValue).filter(Boolean))',
    'const selectedRegion = normalizeFilterValue(filters.region)',
    'const serverRegion = normalizeFilterValue(server.region)',
    'scopedRegions.size > 0',
    'scopedRegions.has(serverRegion)',
    'serverRegion === selectedRegion',
    'function normalizeFilterValue(value: string)',
  ];
  const missingRegionScope = regionScopeFragments.filter((fragment) => !sharedFilterSource.includes(fragment));
  if (missingRegionScope.length) {
    throw new Error(`Server filters must support map region scopes: ${missingRegionScope.join(', ')}`);
  }

  const serviceRegionFragments = [
    'item.trim().toLowerCase() === value.trim().toLowerCase()',
    'return match ?? fallback',
  ];
  const missingServiceRegion = serviceRegionFragments.filter((fragment) => !inventoryServiceSource.includes(fragment));
  if (missingServiceRegion.length) {
    throw new Error(`Server API filters must normalize query casing: ${missingServiceRegion.join(', ')}`);
  }

  const inventoryFragments = [
    'const scopedRegions = (filters.regionScope ?? [])',
    'items.findIndex((item) => item.trim().toLowerCase() === region.trim().toLowerCase())',
    'const visibleConnectedServers = useMemo(() => servers.filter((server) => server.ssh?.connected), [servers])',
    'const visibleMaxLoadServer = useMemo(',
    'const visibleProviderCount = new Set(servers.map((server) => server.provider)).size',
    'const visibleRegionCount = new Set(servers.map((server) => server.region)).size',
    'const visibleAvgLoad = servers.length > 0',
    'servers.mapRegionScope',
    'servers.clearRegionScope',
    'scopedRegions.length > 0',
    'regionScope: undefined',
  ];
  const missingInventory = inventoryFragments.filter((fragment) => !inventorySource.includes(fragment));
  if (missingInventory.length) {
    throw new Error(`Server inventory map scope chip is incomplete: ${missingInventory.join(', ')}`);
  }

  if (!globalCss.includes('.region-scope-chip')) {
    throw new Error('Server inventory map scope chip CSS is missing');
  }

  console.log('ok overview map tooltip links to filtered server inventory');
}

function assertServerIdentityDetectionGuards() {
  const inventorySource = fs.readFileSync(new URL('../src/modules/servers/ServerInventory.tsx', import.meta.url), 'utf8');
  const identityServiceSource = fs.readFileSync(new URL('../src/server/services/serverIdentityService.ts', import.meta.url), 'utf8');
  const inventoryServiceSource = fs.readFileSync(new URL('../src/server/services/inventoryService.ts', import.meta.url), 'utf8');
  const requiredFragments = [
    'formRef.current = form',
    'identityRequestSeqRef',
    'identityInFlightRef',
    'identityCacheRef',
    'lastAppliedIdentityRef',
    'clearAutoIdentityFields',
    'isAutoIdentityCandidate',
    'buildIdentityRequestKey',
    'identityRequestSeqRef.current === requestSeq',
    'isCurrentIdentityTarget(publicIp, sshHost)',
    'identityInFlightRef.current?.key === identityKey',
    'invalidateIdentityDetection',
    'identityRequestSeqRef.current += 1',
    'clearIdentityDetectionState',
    'clearIdentityDetectionState({ clearAutoFields: Boolean(lastAppliedIdentity) })',
    "clearIdentityDetectionState({ clearAutoFields: key === 'publicIp' })",
    "region: current.region === lastApplied.region ? '' : current.region",
    "os: current.os === lastApplied.os ? '' : current.os",
    'lastAppliedIdentityRef.current = { region: result.region, os: result.os }',
    'lastAppliedIdentityRef.current = null',
    "updateIdentityField('publicIp', event.target.value)",
    "updateIdentityField('region', event.target.value)",
    "updateIdentityField('os', event.target.value)",
    'isIdentityTargetFormField',
    'isIdentityTargetSshField',
    'key === \'host\' || key === \'port\' || key === \'username\' || key === \'authType\' || key === \'verifyMode\'',
    'setDetectingIdentity(false)',
    "setIdentityMessage('')",
    "setIdentityMessage(error instanceof Error ? `${t('servers.identityFailed')}: ${error.message}`",
    'function isLikelyIpv4Address',
  ];
  const missing = requiredFragments.filter((fragment) => !inventorySource.includes(fragment));
  if (missing.length) {
    throw new Error(`Server identity detection guards are incomplete: ${missing.join(', ')}`);
  }

  const serviceFragments = [
    'regionCacheTtlMs',
    'ipRegionCache',
    'getCachedIpRegion(publicIp)',
    'setCachedIpRegion(publicIp, detectedRegion)',
    'lookupDeterministicIpRegion',
    "ipToNumber('192.0.2.0')",
    "ipToNumber('198.51.100.0')",
    "ipToNumber('203.0.113.0')",
    'const deterministicRegion = lookupDeterministicIpRegion(publicIp)',
  ];
  const missingService = serviceFragments.filter((fragment) => !identityServiceSource.includes(fragment));
  if (missingService.length) {
    throw new Error(`Server identity service cache/fallback guards are incomplete: ${missingService.join(', ')}`);
  }

  const forbiddenFragments = [
    "`${t('servers.identityFailed')}\uff1a${error.message}`",
    "`${t('servers.identityFailed')}\u951b",
  ];
  const regressions = forbiddenFragments.filter((fragment) => inventorySource.includes(fragment));
  if (regressions.length) {
    throw new Error(`Server identity detection error text regressed: ${regressions.join(', ')}`);
  }

  const globalCss = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  if (!globalCss.includes('.connect-form.open') || !globalCss.includes('max-height: 2200px')) {
    throw new Error('Server connect form must leave enough expanded height for real SSH/private-key fields');
  }

  const sshCommandGuardFragments = [
    'command: z.string().trim().min(1).max(2000)',
    'function summarizeAuditCommand(command: string)',
    "redactSensitiveText(command).replace(/\\s+/g, ' ').slice(0, 160)",
    'summarizeAuditCommand(parsed.command)',
  ];
  const missingSshCommandGuard = sshCommandGuardFragments.filter((fragment) => !inventoryServiceSource.includes(fragment));
  if (missingSshCommandGuard.length) {
    throw new Error(`Server SSH command boundary guards are incomplete: ${missingSshCommandGuard.join(', ')}`);
  }

  console.log('ok server identity detection skips noisy auto probes, ignores stale responses, and clears stale UI state');
}

function assertServerStatusLifecycleGuards() {
  const inventorySource = fs.readFileSync(new URL('../src/modules/servers/ServerInventory.tsx', import.meta.url), 'utf8');
  const inventoryServiceSource = fs.readFileSync(new URL('../src/server/services/inventoryService.ts', import.meta.url), 'utf8');
  const serverActionsSource = fs.readFileSync(new URL('../src/server/services/serverActions.ts', import.meta.url), 'utf8');

  if (inventorySource.includes("['all', 'running', 'warning', 'stopped', 'provisioning', 'unconnected']")) {
    throw new Error('Server status filters must not expose provisioning/creating status');
  }
  if (inventorySource.includes("['all', 'running', 'warning', 'stopped', 'unconnected']")) {
    throw new Error('Server lifecycle filters must not mix health warning with access/power lifecycle');
  }
  if (inventorySource.includes("statusLabel('provisioning'")) {
    throw new Error('Connected servers must not display provisioning/creating as their lifecycle state');
  }

  const requiredInventoryFragments = [
    "const statuses: Array<Extract<ServerStatus, 'running' | 'stopped' | 'unconnected'> | 'all'> = ['all', 'running', 'stopped', 'unconnected']",
    'resolveServerLifecycleStatus(server)',
    "return 'running'",
    'function normalizeServerRuntimeStatus(server: ServerNode): ServerStatus',
  ];
  const missingInventory = requiredInventoryFragments.filter((fragment) => !inventoryServiceSource.includes(fragment) && !inventorySource.includes(fragment));
  if (missingInventory.length) {
    throw new Error(`Server lifecycle status guard is incomplete: ${missingInventory.join(', ')}`);
  }

  const requiredActionFragments = [
    "const nextStatus = parsed.action === 'shutdown' ? 'stopped' : 'running'",
    'setServerRuntimeStatus(server.id, nextStatus)',
  ];
  const missingAction = requiredActionFragments.filter((fragment) => !serverActionsSource.includes(fragment));
  if (missingAction.length) {
    throw new Error(`Server power action status update is incomplete: ${missingAction.join(', ')}`);
  }

  console.log('ok server lifecycle status maps SSH access to running/unconnected and power actions to stopped/running');
}

function assertSshTerminalRealtimeGuards() {
  const inventorySource = fs.readFileSync(new URL('../src/modules/servers/ServerInventory.tsx', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
  const sshServiceSource = fs.readFileSync(new URL('../src/server/services/sshAccessService.ts', import.meta.url), 'utf8');
  const apiClientSource = fs.readFileSync(new URL('../src/services/apiClient.ts', import.meta.url), 'utf8');

  const requiredFrontendFragments = [
    'openServerShell(server.id, getTerminalDimensions())',
    'streamServerShell(',
    'writeServerShell(sessionId, `${normalizeInteractiveCommand(trimmedCommand)}\\n`)',
    "writeServerShell(terminalShellIdRef.current, '\\u0003')",
    'terminalShellStreamRef.current?.close()',
    "t('servers.commandSent'",
  ];
  const missingFrontend = requiredFrontendFragments.filter((fragment) => !inventorySource.includes(fragment));
  if (missingFrontend.length) {
    throw new Error(`SSH terminal realtime frontend guard is incomplete: ${missingFrontend.join(', ')}`);
  }

  if (inventorySource.includes('disabled={sshRunning}')) {
    throw new Error('SSH terminal input must remain usable while the remote process is running');
  }

  const requiredBackendFragments = [
    'client.shell({',
    "term: 'xterm-256color'",
    'activeSshShellSessions',
    'emitSshShellEvent(session, { type: \'stdout\'',
    'stream.setWindow(rows, cols',
    'sshShellIdleTimeoutMs',
  ];
  const missingBackend = requiredBackendFragments.filter((fragment) => !sshServiceSource.includes(fragment));
  if (missingBackend.length) {
    throw new Error(`SSH shell PTY backend guard is incomplete: ${missingBackend.join(', ')}`);
  }

  const requiredApiFragments = [
    "app.post('/api/servers/shells'",
    "app.get('/api/servers/shells/:sessionId/stream'",
    "app.post('/api/servers/shells/:sessionId/input'",
    "app.delete('/api/servers/shells/:sessionId'",
    'flushSse(response)',
    'X-Accel-Buffering',
  ];
  const missingApi = requiredApiFragments.filter((fragment) => !appSource.includes(fragment));
  if (missingApi.length) {
    throw new Error(`SSH shell API guard is incomplete: ${missingApi.join(', ')}`);
  }

  const requiredClientFragments = [
    'new EventSource(`/api/servers/shells/',
    'export async function writeServerShell',
    'export async function closeServerShell',
  ];
  const missingClient = requiredClientFragments.filter((fragment) => !apiClientSource.includes(fragment));
  if (missingClient.length) {
    throw new Error(`SSH shell API client guard is incomplete: ${missingClient.join(', ')}`);
  }

  console.log('ok SSH terminal uses live PTY shell streaming and keeps input responsive');
}

function assertMobileTopbarKeepsCoreActions() {
  const globalCss = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  const mobileSection = globalCss.slice(globalCss.indexOf('@media (max-width: 820px)'));
  if (/\.topbar-actions\s*\{[^}]*display:\s*none/i.test(mobileSection)) {
    throw new Error('Mobile topbar must keep language, refresh, session, and logout actions visible');
  }

  const requiredFragments = [
    '.topbar-actions {',
    'overflow-x: auto',
    '.language-switcher',
    '.session-chip',
    '.topbar-refresh',
    '.topbar-logout',
    'visibility: hidden',
    'pointer-events: none',
    'visibility: visible',
    'pointer-events: auto',
    '.ai-dock',
    'position: fixed',
    'top: auto',
    'height: min(46vh, 360px)',
    '.content:not(.ai-collapsed) main',
    'padding-bottom: calc(min(46vh, 360px) + 28px)',
    '.content:not(.ai-collapsed) .map-controls',
    'position: fixed',
    'bottom: calc(min(46vh, 360px) + 24px)',
    'z-index: 43',
    '.ai-launcher',
  ];
  const missing = requiredFragments.filter((fragment) => !mobileSection.includes(fragment));
  if (missing.length) {
    throw new Error(`Mobile topbar core actions are incomplete: ${missing.join(', ')}`);
  }

  console.log('ok mobile topbar keeps language and session actions');
}

function assertSecurityAuditRelationsAreSpecific() {
  const securitySource = fs.readFileSync(new URL('../src/modules/security/SecurityPanel.tsx', import.meta.url), 'utf8');
  const forbiddenFragments = [
    "if (relation === 'runtime') {\n    return true;",
    "|| ['AI_ANALYZE', 'AI_TEST', 'CUSTOM_API_TEST'",
    "return action === 'CUSTOM_API_TEST' || haystack.includes('timeout')",
  ];
  const regressions = forbiddenFragments.filter((fragment) => securitySource.includes(fragment));
  if (regressions.length) {
    throw new Error(`Security audit relation filters are too broad: ${regressions.join(', ')}`);
  }

  const requiredFragments = [
    'if (!configResponse.ok || !auditResponse.ok)',
    'Array.isArray(auditBody.items)',
    'setLoadError(copy.loadFailed)',
    'buildSecurityRiskActions(checks, auditEntries, openEvents, copy)',
    'remediateSecurityRisk({',
    "document.getElementById('security-remediation')",
    "actionType: 'acknowledgeAuditFailures'",
    "actionType: 'closeOpenEvents'",
    "actionType: 'navigate'",
    'getActiveAuditEntries(auditEntries)',
    "action.startsWith('AUTH_')",
    "return haystack.includes('cors') || corsOrigins.some",
    "return haystack.includes('timeout') || haystack.includes('timed out')",
    'function buildAuditInsight(entry: AuditEntry, copy: SecurityCopy): AuditInsight',
    'security-audit-insight',
    "action === 'CUSTOM_API_TEST'",
    "action.startsWith('SERVER_') || action === 'OPERATIONS_TASK'",
    'auditDomainAuth',
    'auditNextSshRisk',
    'copy.blockedFailedCount(blockedCount, failedCount)',
    'copy.blockedFailedCount(auditIssues.blocked, auditIssues.failed)',
    'copy.configRelationDetail(corsOriginText, count(\'cors\'))',
    'copy.configRelationDetail(config?.ai.baseUrl ?? copy.unavailable, count(\'ai\'))',
    'copy.configRelationDetail(apiHostText, count(\'api\'))',
  ];
  const missing = requiredFragments.filter((fragment) => !securitySource.includes(fragment));
  if (missing.length) {
    throw new Error(`Security audit relation/load guards are incomplete: ${missing.join(', ')}`);
  }

  const forbiddenHardcodedFragments = [
    '{blockedCount} blocked / {failedCount} failed',
    '`${recentBlocked} blocked / ${recentFailed} failed`',
    "`${corsOriginText} · ${copy.linkedAudits(count('cors'))}`",
    "`${config?.ai.baseUrl ?? copy.unavailable} · ${copy.linkedAudits(count('ai'))}`",
    "`${apiHostText} · ${copy.linkedAudits(count('api'))}`",
  ];
  const hardcodedRegressions = forbiddenHardcodedFragments.filter((fragment) => securitySource.includes(fragment));
  if (hardcodedRegressions.length) {
    throw new Error(`Security audit visible copy must use language-specific helpers: ${hardcodedRegressions.join(', ')}`);
  }

  const globalCss = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  const cssFragments = [
    '.security-audit-insight',
    '.security-audit-insight.medium',
    '.security-audit-insight.high',
    '.security-remediation-card',
    '.security-remediation-list',
    '.security-remediation-item',
    '.config-state.action',
  ];
  const missingCss = cssFragments.filter((fragment) => !globalCss.includes(fragment));
  if (missingCss.length) {
    throw new Error(`Security audit insight CSS is incomplete: ${missingCss.join(', ')}`);
  }

  const appSource = fs.readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
  const auditServiceSource = fs.readFileSync(new URL('../src/server/services/auditService.ts', import.meta.url), 'utf8');
  const apiClientSource = fs.readFileSync(new URL('../src/services/apiClient.ts', import.meta.url), 'utf8');
  const remediationFragments = [
    "app.post('/api/audit/remediate'",
    'remediateSecurityRisk(request.body, session.user.username)',
    "z.enum(['acknowledgeCheck', 'acknowledgeAuditFailures', 'closeOpenEvents', 'reviewRuntime'])",
    "action: 'SECURITY_REMEDIATION'",
    "target: parsed.target",
    "fetcher('/api/audit/remediate'",
  ];
  const remediationCombined = [appSource, auditServiceSource, apiClientSource].join('\n');
  const missingRemediation = remediationFragments.filter((fragment) => !remediationCombined.includes(fragment));
  if (missingRemediation.length) {
    throw new Error(`Security audit remediation API is incomplete: ${missingRemediation.join(', ')}`);
  }

  console.log('ok security audit relation filters, remediation actions, load errors, and insight cards are guarded');
}

function assertOperationsTargetSelectionGuards() {
  const operationsSource = fs.readFileSync(new URL('../src/modules/operations/OperationsCenter.tsx', import.meta.url), 'utf8');
  const serviceSource = fs.readFileSync(new URL('../src/server/services/operationsService.ts', import.meta.url), 'utf8');
  const frontendRequired = [
    'const sshRequiredTask = taskType !== \'assetSync\'',
    'if (sshRequiredTask && targetMode === \'allServers\')',
    '<option value="allServers" disabled={sshRequiredTask}>',
    'activeSelectedServerIds',
    'eligibleServerIds',
    'serverIds: targetMode === \'selected\' ? activeSelectedServerIds : []',
    'setSelectedServerIds((current) => current.filter((id) => eligibleServerIds.has(id)))',
  ];
  const missingFrontend = frontendRequired.filter((fragment) => !operationsSource.includes(fragment));
  if (missingFrontend.length) {
    throw new Error(`Operations target selection guard is incomplete: ${missingFrontend.join(', ')}`);
  }

  const serviceRequired = [
    'OPERATIONS_TARGETS_UNCONNECTED',
    'OPERATIONS_TARGETS_NOT_FOUND',
    'allServers includes servers that are not SSH-connected',
    'All server targets must be SSH-connected for this operation',
    'selected servers are not SSH-connected',
    'Selected servers must be SSH-connected for this operation',
    'selected servers do not exist',
  ];
  const missingService = serviceRequired.filter((fragment) => !serviceSource.includes(fragment));
  if (missingService.length) {
    throw new Error(`Operations service selected target guard is incomplete: ${missingService.join(', ')}`);
  }

  console.log('ok operations target selection guards stale and unconnected targets');
}

function assertCustomApiProxySecurityGuards() {
  const proxySource = fs.readFileSync(new URL('../src/server/services/customApiProxy.ts', import.meta.url), 'utf8');
  const sharedRequestSource = fs.readFileSync(new URL('../src/shared/apiRequest.ts', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
  const requiredFragments = [
    "redirect: 'manual'",
    'INVALID_CUSTOM_API_REQUEST',
    'a === 0',
    '(a === 192 && b === 0)',
    '(a === 198 && (b === 18 || b === 19))',
    'a >= 224',
    "hostname === '::'",
  ];
  const missing = requiredFragments.filter((fragment) => !proxySource.includes(fragment));
  if (missing.length) {
    throw new Error(`Custom API proxy SSRF guards are incomplete: ${missing.join(', ')}`);
  }

  const requiredHeaderFragments = [
    'blockedHeaderNames',
    "'host'",
    "'content-length'",
    "'connection'",
    "'x-forwarded-for'",
    'is not allowed through the custom API proxy',
    'has an invalid header name',
  ];
  const missingHeaderFragments = requiredHeaderFragments.filter((fragment) => !sharedRequestSource.includes(fragment));
  if (missingHeaderFragments.length) {
    throw new Error(`Custom API proxy header guards are incomplete: ${missingHeaderFragments.join(', ')}`);
  }

  const requiredAuditFragments = [
    'const auditTarget = sanitizeAuditTarget(request.body?.url)',
    'function sanitizeAuditTarget(value: unknown)',
    "'api_key'",
    "'client_secret'",
    "'token'",
    "'[redacted]'",
  ];
  const missingAuditFragments = requiredAuditFragments.filter((fragment) => !appSource.includes(fragment));
  if (missingAuditFragments.length) {
    throw new Error(`Custom API audit target sanitization is incomplete: ${missingAuditFragments.join(', ')}`);
  }

  console.log('ok custom API proxy blocks redirect-following, private ranges, unsafe headers, and audit secret leakage');
}

function startMockStreamingAi() {
  const requests = [];
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'mock-stream-model', object: 'model' },
          { id: 'mock-reasoning-model', object: 'model' },
        ],
      }));
      return;
    }

    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }

    let rawBody = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', () => {
      const body = rawBody ? JSON.parse(rawBody) : {};
      requests.push({ headers: request.headers, body });
      if (body.model === 'fail-secret-model') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          error: {
            message: `upstream body token ${request.headers.authorization ?? ''}`,
          },
        }));
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      response.write('data: {"choices":[{"delta":{"content":"stream-"}}]}\n\n');
      response.write('data: {"choices":[{"text":"ok"}]}\n\n');
      response.write('data: {"response":"!"}\n\n');
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Mock AI server did not expose a TCP port'));
        return;
      }

      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requests,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => {
            if (error) {
              closeReject(error);
              return;
            }
            closeResolve();
          });
        }),
      });
    });
  });
}

function startMockCustomApi() {
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/redirect-private') {
      response.writeHead(302, {
        Location: 'http://169.254.169.254/latest/meta-data',
        'Content-Type': 'text/plain',
      });
      response.end('redirecting to metadata');
      return;
    }

    if (request.method !== 'POST' || request.url !== '/assets') {
      response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false }));
      return;
    }

    let rawBody = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      rawBody += chunk;
    });
    request.on('end', () => {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Mock-Api': 'colipas-smoke',
      });
      response.end(JSON.stringify({
        ok: true,
        received: rawBody ? JSON.parse(rawBody) : null,
      }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Mock custom API server did not expose a TCP port'));
        return;
      }

      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => {
            if (error) {
              closeReject(error);
              return;
            }
            closeResolve();
          });
        }),
      });
    });
  });
}
