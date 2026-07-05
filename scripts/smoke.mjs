import http from 'node:http';
import fs from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { WebSocket } from 'ws';

const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8080';
const socketBaseUrl = baseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
const authHeaders = {};
const smokeUsername = process.env.SMOKE_ADMIN_USERNAME ?? 'admin';
const initialSmokePassword = process.env.SMOKE_ADMIN_PASSWORD ?? 'admin123456';
const releaseVerifyToken = process.env.SMOKE_RELEASE_VERIFY_TOKEN ?? process.env.RELEASE_VERIFY_TOKEN ?? '';
let currentSmokePassword = initialSmokePassword;
let temporarySimulatedSshServerSequence = 1;

assertAiProviderSecretNotPersisted();
assertAccountUiGuards();
assertCommandPaletteGuards();
assertAiStreamingCompatibility();
assertAiResponseCachingGuards();
assertAiConsoleI18nCoverage();
assertCloudAccountsI18nCoverage();
assertCustomApiSecretNotPersisted();
assertOverviewMapInteractionGuards();
assertMapRegionScopeLifecycleGuards();
assertOverviewServerFilterLinkage();
assertSessionCookieSecurityGuards();
assertServerIdentityDetectionGuards();
assertServerStatusLifecycleGuards();
assertSshTerminalRealtimeGuards();
assertSshKeyAuthenticationGuards();
assertMobileTopbarKeepsCoreActions();
assertSecurityAuditRelationsAreSpecific();
assertOperationsTargetSelectionGuards();
assertInventorySnapshotCacheGuards();
assertLocalizedFormatCacheGuards();
assertCustomApiProxySecurityGuards();
assertSqlitePersistenceGuards();
assertRepositoryIgnoreGuards();
assertBuildChunkingGuards();
assertStandalonePerformanceCheckGuards();
assertRepositoryPreviewAssetGuards();
assertInteractiveDeployDocsAndScriptGuards();
assertContainerRegistryPublishGuards();
await assertReleaseDeployTargetPlanGuards();

const unauthenticatedOverviewResponse = await fetch(`${baseUrl}/api/overview`);
if (unauthenticatedOverviewResponse.status !== 401) {
  throw new Error(`/api/overview expected 401 before login, got ${unauthenticatedOverviewResponse.status}`);
}
console.log('ok protected API requires login');

const unauthenticatedAccountResponse = await fetch(`${baseUrl}/api/account`);
if (unauthenticatedAccountResponse.status !== 401) {
  throw new Error(`/api/account expected 401 before login, got ${unauthenticatedAccountResponse.status}`);
}
const unauthenticatedShellStatusResponse = await fetch(`${baseUrl}/api/servers/shells/status`);
if (unauthenticatedShellStatusResponse.status !== 401) {
  throw new Error(`/api/servers/shells/status expected 401 before login, got ${unauthenticatedShellStatusResponse.status}`);
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

const releaseVerifyResponse = await fetch(`${baseUrl}/api/release/verify`, {
  headers: releaseVerifyToken ? { Authorization: `Bearer ${releaseVerifyToken}` } : {},
});
if (releaseVerifyToken) {
  if (!releaseVerifyResponse.ok) {
    throw new Error(`/api/release/verify returned HTTP ${releaseVerifyResponse.status}`);
  }
  const releaseVerifyBody = await releaseVerifyResponse.json();
  const releaseVerifyPayload = JSON.stringify(releaseVerifyBody);
  if (
    releaseVerifyBody.ok !== true
    || releaseVerifyBody.frontend?.featureMarkers?.['security-evidence-brief'] !== true
    || releaseVerifyBody.frontend?.featureMarkers?.['cloud-map'] !== true
    || !Number.isInteger(releaseVerifyBody.readiness?.score)
    || !Number.isInteger(releaseVerifyBody.audit?.total)
    || !Number.isInteger(releaseVerifyBody.inventory?.servers?.total)
    || releaseVerifyBody.deployment?.targetName !== 'verify-local'
    || releaseVerifyBody.deployment?.channel !== 'grey'
    || releaseVerifyBody.deployment?.deploymentMode !== 'node'
    || releaseVerifyBody.deployment?.gitCommit !== 'abcdef123456'
    || releaseVerifyBody.deployment?.publicHost !== '[redacted-host]'
    || releaseVerifyBody.deployment?.configured !== true
    || releaseVerifyBody.frontend?.scripts?.some((script) => typeof script.path !== 'string' || !/^[a-f0-9]{16}$/.test(script.hash))
  ) {
    throw new Error('/api/release/verify returned incomplete read-only verification payload');
  }
  if (
    releaseVerifyPayload.includes(initialSmokePassword)
    || releaseVerifyPayload.includes(releaseVerifyToken)
    || releaseVerifyPayload.includes('verify-production-session-secret')
    || releaseVerifyPayload.includes('"publicIp"')
    || releaseVerifyPayload.includes('"privateIp"')
    || releaseVerifyPayload.includes('"detail"')
    || /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(releaseVerifyPayload)
    || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(releaseVerifyPayload)
  ) {
    throw new Error('/api/release/verify leaked sensitive or asset-identifying material');
  }
  const wrongReleaseVerifyResponse = await fetch(`${baseUrl}/api/release/verify`, {
    headers: { Authorization: 'Bearer wrong-release-verification-token' },
  });
  if (wrongReleaseVerifyResponse.status !== 401) {
    throw new Error(`/api/release/verify expected 401 with wrong token, got ${wrongReleaseVerifyResponse.status}`);
  }
  console.log('ok /api/release/verify exposes only token-gated read-only release evidence');
} else if (releaseVerifyResponse.status !== 404) {
  throw new Error(`/api/release/verify expected 404 when disabled, got ${releaseVerifyResponse.status}`);
} else {
  console.log('ok /api/release/verify is disabled without release token');
}

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

const malformedLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '}',
});
if (malformedLoginResponse.status !== 400) {
  throw new Error(`/api/auth/login expected 400 with malformed JSON, got ${malformedLoginResponse.status}`);
}
const malformedLoginBody = await malformedLoginResponse.json();
if (malformedLoginBody.error?.code !== 'INVALID_JSON') {
  throw new Error('/api/auth/login malformed JSON returned unexpected error payload');
}
console.log('ok /api/auth/login rejects malformed JSON without 500');

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
const sessionSetCookie = loginResponse.headers.get('set-cookie') ?? '';
if (new URL(baseUrl).protocol === 'http:' && /;\s*Secure\b/i.test(sessionSetCookie)) {
  throw new Error('/api/auth/login set Secure on a local HTTP session cookie');
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
if (accountBody.session?.user?.username !== 'admin' || accountBody.profile?.displayName !== 'CoLiPas' || accountBody.profile?.avatarText !== 'CP') {
  throw new Error('/api/account returned unexpected profile payload');
}
if (JSON.stringify(accountBody).match(/sessionId|scrypt|salt|passwordChangedAt/)) {
  throw new Error('/api/account leaked internal account material');
}
console.log('ok /api/account');

const defaultProfileUpdateResponse = await fetch(`${baseUrl}/api/account/profile`, {
  method: 'PATCH',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    displayName: 'CoLiPas',
    avatarImage: '',
  }),
});
if (!defaultProfileUpdateResponse.ok) {
  throw new Error(`/api/account/profile default display name returned HTTP ${defaultProfileUpdateResponse.status}`);
}
const defaultProfileLogoutResponse = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: authHeaders });
if (!defaultProfileLogoutResponse.ok) {
  throw new Error(`/api/auth/logout after default profile save returned HTTP ${defaultProfileLogoutResponse.status}`);
}
const defaultProfileReloginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: smokeUsername,
    password: currentSmokePassword,
  }),
});
if (!defaultProfileReloginResponse.ok) {
  throw new Error(`/api/auth/login after default profile save returned HTTP ${defaultProfileReloginResponse.status}`);
}
const defaultProfileReloginBody = await defaultProfileReloginResponse.json();
if (defaultProfileReloginBody.profile?.displayName !== 'CoLiPas' || defaultProfileReloginBody.profile?.avatarText !== 'CP') {
  throw new Error('/api/account/profile default display name did not persist across logout/login');
}
const defaultProfileReloginCookie = defaultProfileReloginResponse.headers.get('set-cookie')?.split(';')[0];
if (!defaultProfileReloginCookie) {
  throw new Error('/api/auth/login after default profile save did not set a session cookie');
}
authHeaders.Cookie = defaultProfileReloginCookie;
console.log('ok /api/account/profile preserves CoLiPas default across logout/login without fallback text');

const profileUpdateResponse = await fetch(`${baseUrl}/api/account/profile`, {
  method: 'PATCH',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    displayName: 'OpsDesk',
    avatarText: 'OD',
    avatarImage: 'data:image/png;base64,iVBORw0KGgo=',
  }),
});
if (!profileUpdateResponse.ok) {
  throw new Error(`/api/account/profile returned HTTP ${profileUpdateResponse.status}`);
}
const profileUpdateBody = await profileUpdateResponse.json();
if (
  profileUpdateBody.profile?.displayName !== 'OpsDesk'
  || profileUpdateBody.profile?.avatarText !== 'OD'
  || profileUpdateBody.profile?.avatarImage !== 'data:image/png;base64,iVBORw0KGgo='
) {
  throw new Error('/api/account/profile returned unexpected profile');
}
const profileSessionResponse = await fetch(`${baseUrl}/api/auth/session`, { headers: authHeaders });
const profileSessionBody = await profileSessionResponse.json();
if (
  profileSessionBody.profile?.displayName !== 'OpsDesk'
  || profileSessionBody.profile?.avatarText !== 'OD'
  || profileSessionBody.profile?.avatarImage !== 'data:image/png;base64,iVBORw0KGgo='
) {
  throw new Error('/api/auth/session did not expose updated profile');
}
console.log('ok /api/account/profile persists custom avatar and display name');

const twoMbAvatarBytes = 2 * 1024 * 1024;
const nearLimitAvatarImage = `data:image/png;base64,${Buffer.alloc(twoMbAvatarBytes - 256).toString('base64')}`;
const nearLimitAvatarResponse = await fetch(`${baseUrl}/api/account/profile`, {
  method: 'PATCH',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    displayName: 'OpsDesk',
    avatarText: 'OD',
    avatarImage: nearLimitAvatarImage,
  }),
});
if (!nearLimitAvatarResponse.ok) {
  throw new Error(`/api/account/profile should accept near-2MB avatars, got HTTP ${nearLimitAvatarResponse.status}`);
}
console.log('ok /api/account/profile accepts near-2MB avatar images');

const invalidAvatarResponse = await fetch(`${baseUrl}/api/account/profile`, {
  method: 'PATCH',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    displayName: 'OpsDesk',
    avatarText: 'OD',
    avatarImage: 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+',
  }),
});
if (invalidAvatarResponse.status !== 400) {
  throw new Error(`/api/account/profile expected 400 for unsafe avatar image, got ${invalidAvatarResponse.status}`);
}
console.log('ok /api/account/profile rejects unsafe avatar images');

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
  [
    '/api/health',
    (body) =>
      body.status === 'ok'
      && body.database?.driver === 'sqlite'
      && body.database?.name === 'colipas.sqlite'
      && !('path' in body.database)
      && body.release?.gitCommit === 'abcdef123456'
      && body.release?.targetName === 'verify-local'
      && body.release?.deploymentMode === 'node'
      && !JSON.stringify(body).includes('verify-production-release-token-12345'),
  ],
  [
    '/api/config',
    (body) =>
      Array.isArray(body.customApiAllowedHosts) &&
      body.ai?.configured === false &&
      body.security?.adminPasswordDefault === true &&
      body.security?.sessionSecretDefault === false &&
      body.security?.credentialEncryptionKeyConfigured === false &&
      body.security?.credentialEncryptionKeyDefault === true &&
      !JSON.stringify(body).includes(initialSmokePassword) &&
      !JSON.stringify(body).includes('verify-production-session-secret'),
  ],
  [
    '/api/audit/readiness',
    (body) =>
      Number.isInteger(body.score) &&
      body.score >= 0 &&
      body.score <= 100 &&
      ['ready', 'review', 'blocked'].includes(body.status) &&
      Array.isArray(body.checks) &&
      body.checks.some((check) => check.id === 'api-allowlist') &&
      body.checks.some((check) => check.id === 'deployment-evidence' && check.relatedModule === 'deployment' && check.value === 'abcdef123456') &&
      body.checks.some((check) => check.id === 'runtime-secret-posture' && check.severity === 'fail') &&
      body.summary?.totalChecks === body.checks.length &&
      body.history?.trend?.snapshotCount >= 0 &&
      !JSON.stringify(body).includes('admin123456'),
  ],
  [
    '/api/audit/readiness/report',
    (body) =>
      body.contentType === 'text/markdown' &&
      body.filename?.startsWith('colipas-readiness-') &&
      body.markdown?.includes('# CoLiPas云服务器管理面板 Release Readiness Report') &&
      body.markdown?.includes('## Checks') &&
      body.markdown?.includes('Runtime secret posture') &&
      !body.markdown.includes('admin123456'),
  ],
  [
    '/api/audit/diagnostics/export',
    (body) =>
      body.contentType === 'application/json' &&
      body.filename?.startsWith('colipas-diagnostics-') &&
      body.runtime?.database?.driver === 'sqlite' &&
      body.runtime?.database?.name === 'colipas.sqlite' &&
      !('path' in body.runtime.database) &&
      Number.isInteger(body.config?.customApiAllowedHosts) &&
      typeof body.config?.ai?.baseUrlHost === 'string' &&
      body.config?.security?.adminPasswordDefault === true &&
      Number.isInteger(body.readiness?.score) &&
      body.readiness?.checks?.some((check) => check.id === 'runtime-secret-posture') &&
      Number.isInteger(body.audit?.total) &&
      Number.isInteger(body.inventory?.servers?.total) &&
      !JSON.stringify(body).includes('admin123456') &&
      !JSON.stringify(body).includes('verify-production-session-secret') &&
      !JSON.stringify(body).includes('publicIp') &&
      !JSON.stringify(body).includes('privateIp') &&
      !JSON.stringify(body).includes('detail'),
  ],
  [
    '/api/overview',
    (body) =>
      Array.isArray(body.cloudAccounts) &&
      Array.isArray(body.servers) &&
      Array.isArray(body.operationEvents) &&
      body.summary?.totalServers === body.servers.length &&
      body.summary?.onlineServers === body.servers.filter((server) => server.status === 'running').length &&
      body.summary?.openEvents === body.operationEvents.filter((event) => event.status === 'open').length &&
      body.summary?.connectedSsh === body.servers.filter((server) => server.ssh?.connected).length &&
      Number.isInteger(body.summary?.avgCpu),
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
  if (path === '/api/health' && !response.headers.get('cache-control')?.includes('no-store')) {
    throw new Error('/api/health must return Cache-Control: no-store so release evidence cannot be served stale');
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
if (aiBody.executionPlan && (!Array.isArray(aiBody.executionPlan.serverIds) || typeof aiBody.executionPlan.safetyNote !== 'string')) {
  throw new Error('/api/ai/analyze returned a malformed execution plan');
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
if (aiStreamText.includes('"executionPlan"') && !aiStreamText.includes('"safetyNote"')) {
  throw new Error('/api/ai/stream returned a malformed execution plan');
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

const aiExecutableServerResponse = await fetch(`${baseUrl}/api/servers`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: `smoke-ai-exec-${Date.now()}`,
    provider: 'Smoke Lab',
    region: 'US - Los Angeles',
    publicIp: '203.0.113.77',
    privateIp: '10.88.0.77',
    os: 'Debian 12',
    tags: ['smoke', 'ai-execution'],
    ssh: {
      host: 'simulated-smoke.local',
      port: 22,
      username: 'root',
      authType: 'password',
      password: 'smoke-simulated-only',
      verifyMode: 'simulate',
    },
  }),
});
if (aiExecutableServerResponse.status !== 201) {
  throw new Error(`/api/servers AI executable setup returned HTTP ${aiExecutableServerResponse.status}`);
}
const aiExecutableServer = await aiExecutableServerResponse.json();
try {
  const aiExecutableResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: 'Run a safe SSH uptime check',
      provider: {
        name: 'Smoke AI',
        baseUrl: 'https://api.example.com/v1',
        model: 'smoke-model',
        apiKey: '',
        temperature: 0.2,
      },
      serverId: aiExecutableServer.id,
    }),
  });
  if (!aiExecutableResponse.ok) {
    throw new Error(`/api/ai/analyze executable request returned HTTP ${aiExecutableResponse.status}`);
  }
  const aiExecutableBody = await aiExecutableResponse.json();
  if (
    !aiExecutableBody.executionPlan
    || aiExecutableBody.executionPlan.targetMode !== 'selected'
    || aiExecutableBody.executionPlan.serverIds[0] !== aiExecutableServer.id
    || !['healthCheck', 'sshCommand'].includes(aiExecutableBody.executionPlan.operation)
    || typeof aiExecutableBody.executionPlan.safetyNote !== 'string'
  ) {
    throw new Error('/api/ai/analyze did not return a guarded selected-server execution plan');
  }
  const aiNoEvidenceResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: 'What is the current user and ip addr output?',
      provider: {
        name: 'Smoke AI',
        baseUrl: 'https://api.example.com/v1',
        model: 'smoke-model',
        apiKey: '',
        temperature: 0.2,
      },
      serverId: aiExecutableServer.id,
      forceRefresh: true,
    }),
  });
  if (!aiNoEvidenceResponse.ok) {
    throw new Error(`/api/ai/analyze no-evidence request returned HTTP ${aiNoEvidenceResponse.status}`);
  }
  const aiNoEvidenceBody = await aiNoEvidenceResponse.json();
  if (
    !aiNoEvidenceBody.answer?.includes('Local evidence boundary')
    || !aiNoEvidenceBody.answer.includes('has not captured relevant SSH command output')
    || !aiNoEvidenceBody.answer.includes('root@host is only terminal context')
    || !['ip addr', 'hostname && whoami && ip -brief addr && ip route'].includes(aiNoEvidenceBody.executionPlan?.command)
  ) {
    throw new Error('/api/ai/analyze no-evidence SSH question did not guard against hallucinated command output');
  }
  if (/current user:\s*root|ip addr output:\s*(?!not captured)/i.test(aiNoEvidenceBody.answer)) {
    throw new Error('/api/ai/analyze no-evidence SSH answer claimed live command results');
  }
  const aiDirectExecutionResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: '执行 ip addr',
      provider: {
        name: 'Smoke AI',
        baseUrl: 'https://api.example.com/v1',
        model: 'smoke-model',
        apiKey: '',
        temperature: 0.2,
      },
      serverId: aiExecutableServer.id,
      forceRefresh: true,
    }),
  });
  if (!aiDirectExecutionResponse.ok) {
    throw new Error(`/api/ai/analyze direct SSH execution request returned HTTP ${aiDirectExecutionResponse.status}`);
  }
  const aiDirectExecutionBody = await aiDirectExecutionResponse.json();
  if (
    aiDirectExecutionBody.simulated !== true
    || !aiDirectExecutionBody.answer?.includes('Local guarded execution plan')
    || aiDirectExecutionBody.answer.includes('I cannot directly execute')
    || aiDirectExecutionBody.executionPlan?.operation !== 'sshCommand'
    || aiDirectExecutionBody.executionPlan?.command !== 'ip addr'
  ) {
    throw new Error('/api/ai/analyze direct SSH execution request did not produce a runnable ip addr execution card');
  }
  const aiPackageInstallResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: '帮我执行一下 apt install -y unzip',
      provider: {
        name: 'Smoke AI',
        baseUrl: 'https://api.example.com/v1',
        model: 'smoke-model',
        apiKey: '',
        temperature: 0.2,
      },
      serverId: aiExecutableServer.id,
      forceRefresh: true,
    }),
  });
  if (!aiPackageInstallResponse.ok) {
    throw new Error(`/api/ai/analyze package install SSH execution request returned HTTP ${aiPackageInstallResponse.status}`);
  }
  const aiPackageInstallBody = await aiPackageInstallResponse.json();
  if (
    aiPackageInstallBody.simulated !== true
    || !aiPackageInstallBody.answer?.includes('Local guarded execution plan')
    || aiPackageInstallBody.executionPlan?.operation !== 'sshCommand'
    || aiPackageInstallBody.executionPlan?.command !== 'apt install -y unzip'
    || aiPackageInstallBody.executionPlan?.requiresConfirmation !== true
    || aiPackageInstallBody.executionPlan?.confirmationReason !== 'high-impact SSH command'
    || !aiPackageInstallBody.executionPlan?.safetyNote?.includes('operator-provided command')
  ) {
    throw new Error('/api/ai/analyze direct SSH execution request did not preserve an arbitrary operator command with confirmation risk');
  }
  const aiRunColonResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: 'please run:apt install -y unzip',
      provider: {
        name: 'Smoke AI',
        baseUrl: 'https://api.example.com/v1',
        model: 'smoke-model',
        apiKey: '',
        temperature: 0.2,
      },
      serverId: aiExecutableServer.id,
      forceRefresh: true,
    }),
  });
  if (!aiRunColonResponse.ok) {
    throw new Error(`/api/ai/analyze run-colon SSH execution request returned HTTP ${aiRunColonResponse.status}`);
  }
  const aiRunColonBody = await aiRunColonResponse.json();
  if (
    aiRunColonBody.executionPlan?.operation !== 'sshCommand'
    || aiRunColonBody.executionPlan?.command !== 'apt install -y unzip'
    || aiRunColonBody.executionPlan?.requiresConfirmation !== true
  ) {
    throw new Error('/api/ai/analyze did not parse run:command SSH input with confirmation risk');
  }
  const aiRunOnServerResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: 'please run on the server systemctl restart nginx',
      provider: {
        name: 'Smoke AI',
        baseUrl: 'https://api.example.com/v1',
        model: 'smoke-model',
        apiKey: '',
        temperature: 0.2,
      },
      serverId: aiExecutableServer.id,
      forceRefresh: true,
    }),
  });
  if (!aiRunOnServerResponse.ok) {
    throw new Error(`/api/ai/analyze run-on-server SSH execution request returned HTTP ${aiRunOnServerResponse.status}`);
  }
  const aiRunOnServerBody = await aiRunOnServerResponse.json();
  if (
    aiRunOnServerBody.executionPlan?.operation !== 'sshCommand'
    || aiRunOnServerBody.executionPlan?.command !== 'systemctl restart nginx'
    || aiRunOnServerBody.executionPlan?.requiresConfirmation !== true
  ) {
    throw new Error('/api/ai/analyze did not parse run-on-server SSH input without treating target words as the command');
  }
  const aiChineseRunOnServerResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: '帮我在服务器上执行 systemctl restart nginx',
      provider: {
        name: 'Smoke AI',
        baseUrl: 'https://api.example.com/v1',
        model: 'smoke-model',
        apiKey: '',
        temperature: 0.2,
      },
      serverId: aiExecutableServer.id,
      forceRefresh: true,
    }),
  });
  if (!aiChineseRunOnServerResponse.ok) {
    throw new Error(`/api/ai/analyze Chinese run-on-server SSH execution request returned HTTP ${aiChineseRunOnServerResponse.status}`);
  }
  const aiChineseRunOnServerBody = await aiChineseRunOnServerResponse.json();
  if (
    aiChineseRunOnServerBody.executionPlan?.operation !== 'sshCommand'
    || aiChineseRunOnServerBody.executionPlan?.command !== 'systemctl restart nginx'
    || aiChineseRunOnServerBody.executionPlan?.requiresConfirmation !== true
  ) {
    throw new Error('/api/ai/analyze did not parse Chinese run-on-server SSH input without target-word leakage');
  }
  const noEvidenceUpstream = await startMockStreamingAi();
  try {
    const aiNoEvidenceUpstreamResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'What is the current user and ip addr output?',
        provider: {
          name: 'Smoke AI upstream',
          baseUrl: noEvidenceUpstream.baseUrl,
          model: 'stream-smoke-model',
          apiKey: 'stream-smoke-key',
          temperature: 0.2,
        },
        serverId: aiExecutableServer.id,
        forceRefresh: true,
      }),
    });
    if (!aiNoEvidenceUpstreamResponse.ok) {
      throw new Error(`/api/ai/analyze no-evidence upstream request returned HTTP ${aiNoEvidenceUpstreamResponse.status}`);
    }
    const aiNoEvidenceUpstreamBody = await aiNoEvidenceUpstreamResponse.json();
    if (
      aiNoEvidenceUpstreamBody.simulated !== true
      || !aiNoEvidenceUpstreamBody.answer?.includes('Local evidence boundary')
      || noEvidenceUpstream.requests.length !== 0
    ) {
      throw new Error('/api/ai/analyze sent a no-evidence SSH question to upstream AI instead of enforcing the local evidence boundary');
    }
    const directExecutionUpstreamResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: '执行 ip addr',
        provider: {
          name: 'Smoke AI upstream',
          baseUrl: noEvidenceUpstream.baseUrl,
          model: 'stream-smoke-model',
          apiKey: 'stream-smoke-key',
          temperature: 0.2,
        },
        serverId: aiExecutableServer.id,
        forceRefresh: true,
      }),
    });
    if (!directExecutionUpstreamResponse.ok) {
      throw new Error(`/api/ai/analyze direct SSH execution upstream request returned HTTP ${directExecutionUpstreamResponse.status}`);
    }
    const directExecutionUpstreamBody = await directExecutionUpstreamResponse.json();
    if (
      directExecutionUpstreamBody.simulated !== true
      || !directExecutionUpstreamBody.answer?.includes('Local guarded execution plan')
      || directExecutionUpstreamBody.executionPlan?.command !== 'ip addr'
      || noEvidenceUpstream.requests.length !== 0
    ) {
      throw new Error('/api/ai/analyze direct SSH execution request should stay local and produce a runnable card');
    }
  } finally {
    await noEvidenceUpstream.close();
  }
  const aiPlanPreflightResponse = await fetch(`${baseUrl}/api/operations/tasks/preflight`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: aiExecutableBody.executionPlan.operation,
      targetMode: aiExecutableBody.executionPlan.targetMode,
      serverIds: aiExecutableBody.executionPlan.serverIds,
      command: aiExecutableBody.executionPlan.command,
      reason: aiExecutableBody.executionPlan.reason,
      confirmed: Boolean(aiExecutableBody.executionPlan.confirmed),
    }),
  });
  if (!aiPlanPreflightResponse.ok) {
    throw new Error(`/api/operations/tasks/preflight AI plan returned HTTP ${aiPlanPreflightResponse.status}`);
  }
  const aiPlanPreflight = await aiPlanPreflightResponse.json();
  if (!aiPlanPreflight.ok || !aiPlanPreflight.correlationId?.startsWith('ops-trace-')) {
    throw new Error('/api/operations/tasks/preflight blocked the guarded AI execution plan');
  }
  const aiPlanTaskResponse = await fetch(`${baseUrl}/api/operations/tasks`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: aiExecutableBody.executionPlan.operation,
      targetMode: aiExecutableBody.executionPlan.targetMode,
      serverIds: aiExecutableBody.executionPlan.serverIds,
      command: aiExecutableBody.executionPlan.command,
      reason: aiExecutableBody.executionPlan.reason,
      confirmed: Boolean(aiExecutableBody.executionPlan.confirmed),
      correlationId: aiPlanPreflight.correlationId,
    }),
  });
  if (!aiPlanTaskResponse.ok) {
    throw new Error(`/api/operations/tasks AI plan returned HTTP ${aiPlanTaskResponse.status}: ${await aiPlanTaskResponse.text()}`);
  }
  const aiPlanTask = await aiPlanTaskResponse.json();
  if (aiPlanTask.status !== 'completed' || aiPlanTask.summary.success !== 1 || !JSON.stringify(aiPlanTask.outputs).includes('simulated')) {
    throw new Error('/api/operations/tasks did not execute the guarded AI plan on simulated SSH');
  }
  const aiEvidenceFollowupResponse = await fetch(`${baseUrl}/api/ai/stream`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: '刚才执行结果是什么',
      provider: {
        name: 'Smoke AI',
        baseUrl: 'https://api.example.com/v1',
        model: 'smoke-model',
        apiKey: '',
        temperature: 0.2,
      },
      serverId: aiExecutableServer.id,
      forceRefresh: true,
      messages: [
        { role: 'user', content: 'Run a safe SSH uptime check' },
        {
          role: 'assistant',
          content: [
            'Execution evidence:',
            `task=${aiPlanTask.id}`,
            `trace=${aiPlanTask.correlationId}`,
            `type=${aiPlanTask.type}`,
            `status=${aiPlanTask.status}`,
            `summary=${aiPlanTask.summary.success}/${aiPlanTask.summary.total} succeeded`,
            `output:\n${aiPlanTask.outputs[0]?.output ?? ''}`,
          ].join('\n'),
        },
      ],
    }),
  });
  if (!aiEvidenceFollowupResponse.ok) {
    throw new Error(`/api/ai/stream execution evidence follow-up returned HTTP ${aiEvidenceFollowupResponse.status}`);
  }
  const aiEvidenceFollowupText = await aiEvidenceFollowupResponse.text();
  if (!aiEvidenceFollowupText.includes('Available execution evidence') || !aiEvidenceFollowupText.includes('simulated')) {
    throw new Error('/api/ai/stream did not use prior execution evidence in follow-up answer');
  }
  console.log('ok AI execution plan preflights and runs through operations service');
} finally {
  const deleteAiExecutableServerResponse = await fetch(`${baseUrl}/api/servers/${aiExecutableServer.id}`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  if (!deleteAiExecutableServerResponse.ok) {
    throw new Error(`/api/servers/:serverId DELETE AI executable smoke server returned HTTP ${deleteAiExecutableServerResponse.status}`);
  }
}

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

  const storedAiSecret = `stored-ai-key-${Date.now()}`;
  const saveProviderResponse = await fetch(`${baseUrl}/api/ai/provider`, {
    method: 'PUT',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...streamingProvider,
      apiKey: storedAiSecret,
      model: 'stored-provider-model',
    }),
  });
  if (!saveProviderResponse.ok) {
    throw new Error(`/api/ai/provider save returned HTTP ${saveProviderResponse.status}`);
  }
  const saveProviderBody = await saveProviderResponse.json();
  const saveProviderText = JSON.stringify(saveProviderBody);
  if (
    saveProviderBody.configured !== true
    || saveProviderBody.hasStoredApiKey !== true
    || saveProviderBody.managedBy !== 'database'
    || saveProviderBody.provider?.apiKey !== ''
    || saveProviderBody.provider?.model !== 'stored-provider-model'
    || saveProviderText.includes(storedAiSecret)
  ) {
    throw new Error('/api/ai/provider save did not return safe database-backed provider status');
  }

  const providerSettingsResponse = await fetch(`${baseUrl}/api/ai/provider`, { headers: authHeaders });
  if (!providerSettingsResponse.ok) {
    throw new Error(`/api/ai/provider read returned HTTP ${providerSettingsResponse.status}`);
  }
  const providerSettingsBody = await providerSettingsResponse.json();
  if (
    providerSettingsBody.provider?.apiKey !== ''
    || providerSettingsBody.managedBy !== 'database'
    || JSON.stringify(providerSettingsBody).includes(storedAiSecret)
  ) {
    throw new Error('/api/ai/provider read leaked or lost stored AI key status');
  }

  const storedConfigResponse = await fetch(`${baseUrl}/api/config`, { headers: authHeaders });
  const storedConfigBody = await storedConfigResponse.json();
  if (storedConfigBody.ai?.configured !== true || storedConfigBody.ai?.managedBy !== 'database') {
    throw new Error('/api/config did not report database-managed AI key custody');
  }

  const storedProviderTestResponse = await fetch(`${baseUrl}/api/ai/test`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: {
        name: streamingProvider.name,
        baseUrl: streamingProvider.baseUrl,
        model: 'stored-provider-model',
        apiKey: '',
        temperature: 0,
      },
    }),
  });
  if (!storedProviderTestResponse.ok) {
    throw new Error(`/api/ai/test stored provider returned HTTP ${storedProviderTestResponse.status}`);
  }
  const storedProviderRequest = mockAi.requests.find((request) => (
    request.body?.model === 'stored-provider-model'
    && request.headers.authorization === `Bearer ${storedAiSecret}`
  ));
  if (!storedProviderRequest) {
    throw new Error('/api/ai/test did not use encrypted database AI key when request key was blank');
  }
  const clearStoredProviderResponse = await fetch(`${baseUrl}/api/ai/provider`, {
    method: 'PUT',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clearStoredKey: true }),
  });
  if (!clearStoredProviderResponse.ok) {
    throw new Error(`/api/ai/provider clear returned HTTP ${clearStoredProviderResponse.status}`);
  }
  console.log('ok /api/ai/provider encrypts key in database and downstream AI calls reuse it without exposing it');

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

const smokePrivateKeyMarker = `smoke-private-key-${Date.now()}`;
const smokePrivateKeyPassphrase = `smoke-key-passphrase-${Date.now()}`;
const smokePrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' }).toString();

const invalidPrivateKeyResponse = await fetch(`${baseUrl}/api/servers`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: `invalid-key-server-${Date.now()}`,
    provider: 'Custom',
    region: 'smoke-region',
    publicIp: '203.0.113.14',
    privateIp: '',
    os: 'Ubuntu 24.04',
    tags: ['smoke'],
    ssh: {
      port: 22,
      username: 'root',
      authType: 'privateKey',
      privateKey: 'not-a-private-key',
      verifyMode: 'simulate',
    },
  }),
});
if (invalidPrivateKeyResponse.status !== 400) {
  throw new Error(`/api/servers expected 400 for invalid SSH private key, got ${invalidPrivateKeyResponse.status}`);
}
const invalidPrivateKeyBody = await invalidPrivateKeyResponse.json();
if (
  invalidPrivateKeyBody.error?.code !== 'VALIDATION_ERROR'
  || !invalidPrivateKeyBody.error.details?.some((item) => item.path === 'ssh.privateKey')
) {
  throw new Error('/api/servers invalid SSH private key returned unexpected validation payload');
}
console.log('ok /api/servers rejects invalid SSH private key');

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

const keyConnectResponse = await fetch(`${baseUrl}/api/servers`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: `key-auth-server-${Date.now()}`,
    provider: 'Custom',
    region: 'smoke-region',
    publicIp: '203.0.113.15',
    privateIp: '10.0.0.15',
    os: 'Ubuntu 24.04',
    tags: ['smoke', 'key-auth'],
    ssh: {
      port: 22,
      username: 'root',
      authType: 'privateKey',
      privateKey: smokePrivateKey,
      passphrase: smokePrivateKeyPassphrase,
      verifyMode: 'simulate',
    },
  }),
});
if (keyConnectResponse.status !== 201) {
  throw new Error(`/api/servers private-key SSH connect returned HTTP ${keyConnectResponse.status}`);
}
const keyConnectedServer = await keyConnectResponse.json();
const keyConnectedPayload = JSON.stringify(keyConnectedServer);
if (
  !keyConnectedServer.id
  || keyConnectedServer.ssh?.connected !== true
  || keyConnectedServer.ssh?.authType !== 'privateKey'
  || keyConnectedServer.status !== 'running'
  || keyConnectedPayload.includes(smokePrivateKeyMarker)
  || keyConnectedPayload.includes(smokePrivateKeyPassphrase)
) {
  throw new Error('/api/servers private-key SSH connect returned unexpected or sensitive payload');
}
console.log('ok /api/servers SSH private-key connect');

const deleteKeyConnectedServerResponse = await fetch(`${baseUrl}/api/servers/${keyConnectedServer.id}`, { method: 'DELETE', headers: authHeaders });
if (!deleteKeyConnectedServerResponse.ok) {
  throw new Error(`/api/servers/:serverId DELETE private-key smoke server returned HTTP ${deleteKeyConnectedServerResponse.status}`);
}
console.log('ok /api/servers/:serverId DELETE private-key smoke server');

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
if (
  commandBody.serverId !== connectedServer.id
  || !commandBody.output?.includes('simulated$ uptime')
  || !/^srv-trace-[a-f0-9-]{36}$/.test(commandBody.correlationId)
) {
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

const shellInitialStatusResponse = await fetch(`${baseUrl}/api/servers/shells/status`, { headers: authHeaders });
if (!shellInitialStatusResponse.ok) {
  throw new Error(`/api/servers/shells/status initial returned HTTP ${shellInitialStatusResponse.status}`);
}
const shellInitialStatus = await shellInitialStatusResponse.json();
if (
  shellInitialStatus.activeCount !== 0
  || shellInitialStatus.byMode?.simulate !== 0
  || JSON.stringify(shellInitialStatus).match(/sessionId|203\.0\.113\.10|smoke-password|root@|whoami|uptime/)
) {
  throw new Error('/api/servers/shells/status initial payload was unexpected or leaked sensitive shell details');
}
console.log('ok /api/servers/shells/status starts empty and sanitized');

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
if (shellBody.serverId !== connectedServer.id || !shellBody.sessionId || !/^srv-trace-[a-f0-9-]{36}$/.test(shellBody.correlationId)) {
  throw new Error('/api/servers/shells returned unexpected payload');
}
const shellOpenStatusResponse = await fetch(`${baseUrl}/api/servers/shells/status`, { headers: authHeaders });
if (!shellOpenStatusResponse.ok) {
  throw new Error(`/api/servers/shells/status open returned HTTP ${shellOpenStatusResponse.status}`);
}
const shellOpenStatus = await shellOpenStatusResponse.json();
if (
  shellOpenStatus.activeCount !== 1
  || shellOpenStatus.byMode?.simulate !== 1
  || !shellOpenStatus.oldestConnectedAt
  || !shellOpenStatus.newestConnectedAt
  || JSON.stringify(shellOpenStatus).includes(shellBody.sessionId)
) {
  throw new Error('/api/servers/shells/status did not expose sanitized active shell stats');
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
const shellAiEvidenceResponse = await fetch(`${baseUrl}/api/ai/stream`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    question: '读取刚才服务器终端执行结果',
    provider: {
      name: 'Smoke AI',
      baseUrl: 'https://api.example.com/v1',
      model: 'smoke-model',
      apiKey: '',
      temperature: 0.2,
    },
    serverId: connectedServer.id,
    forceRefresh: true,
  }),
});
if (!shellAiEvidenceResponse.ok) {
  throw new Error(`/api/ai/stream shell evidence returned HTTP ${shellAiEvidenceResponse.status}`);
}
const shellAiEvidenceText = await shellAiEvidenceResponse.text();
if (!shellAiEvidenceText.includes('Recent SSH terminal') || !shellAiEvidenceText.includes('simulated$ whoami')) {
  throw new Error('/api/ai/stream did not include recent SSH terminal evidence');
}
const shellCloseResponse = await fetch(`${baseUrl}/api/servers/shells/${shellBody.sessionId}`, {
  method: 'DELETE',
  headers: authHeaders,
});
if (!shellCloseResponse.ok) {
  throw new Error(`/api/servers/shells/:sessionId DELETE returned HTTP ${shellCloseResponse.status}`);
}
const shellClosedWriteResponse = await fetch(`${baseUrl}/api/servers/shells/${shellBody.sessionId}/input`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: 'whoami\n' }),
});
if (shellClosedWriteResponse.status !== 404) {
  throw new Error(`/api/servers/shells/:sessionId/input after DELETE expected 404, got HTTP ${shellClosedWriteResponse.status}`);
}
const shellClosedStatusResponse = await fetch(`${baseUrl}/api/servers/shells/status`, { headers: authHeaders });
if (!shellClosedStatusResponse.ok) {
  throw new Error(`/api/servers/shells/status closed returned HTTP ${shellClosedStatusResponse.status}`);
}
const shellClosedStatus = await shellClosedStatusResponse.json();
if (shellClosedStatus.activeCount !== 0 || shellClosedStatus.byMode?.simulate !== 0 || shellClosedStatus.oldestConnectedAt !== null) {
  throw new Error('/api/servers/shells/status did not return to zero after close');
}
console.log('ok /api/servers/shells realtime stream, sanitized status, and close cleanup');

const wsUnauthorizedClosed = await assertUnauthorizedShellWebSocket();
if (!wsUnauthorizedClosed) {
  throw new Error('SSH WebSocket upgrade did not reject unauthenticated access');
}
console.log('ok /api/servers/shells websocket upgrade requires login');

const shellSocketServer = await createTemporarySimulatedSshServer({ name: `ws-shell-${Date.now()}` });
try {
  const shellSocketResult = await exerciseShellWebSocket(shellSocketServer.id);
  if (!shellSocketResult.text.includes('simulated$ whoami') || !shellSocketResult.text.includes('command simulated.')) {
    throw new Error('SSH WebSocket shell did not stream interactive output');
  }
  if (!shellSocketResult.text.includes('simulated$') || shellSocketResult.closed !== true) {
    throw new Error('SSH WebSocket shell did not close cleanly');
  }
  console.log('ok /api/servers/shells websocket shell open/input/close round trip');
} finally {
  await fetch(`${baseUrl}/api/servers/${shellSocketServer.id}`, {
    method: 'DELETE',
    headers: authHeaders,
  }).catch(() => undefined);
}

const shellLongResponse = await fetch(`${baseUrl}/api/servers/shells`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    serverId: connectedServer.id,
    cols: 120,
    rows: 32,
  }),
});
if (shellLongResponse.status !== 201) {
  throw new Error(`/api/servers/shells long-output setup returned HTTP ${shellLongResponse.status}`);
}
const shellLongBody = await shellLongResponse.json();
const shellLongWriteResponse = await fetch(`${baseUrl}/api/servers/shells/${shellLongBody.sessionId}/input`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: 'colipas-long-output\n' }),
});
if (!shellLongWriteResponse.ok) {
  throw new Error(`/api/servers/shells/:sessionId/input long output returned HTTP ${shellLongWriteResponse.status}`);
}
const shellLongReplayResponse = await fetch(`${baseUrl}/api/servers/shells/${shellLongBody.sessionId}/stream`, {
  headers: authHeaders,
});
if (!shellLongReplayResponse.ok) {
  throw new Error(`/api/servers/shells/:sessionId/stream long-output replay returned HTTP ${shellLongReplayResponse.status}`);
}
const shellLongOutputText = await readSseUntil(
  shellLongReplayResponse,
  (text) => text.includes('long-output-01') && text.includes('long-output-80'),
  5000,
);
if ((shellLongOutputText.match(/long-output-/g) ?? []).length < 80) {
  throw new Error('/api/servers/shells long-output command did not stream all expected chunks');
}
const shellLongCloseResponse = await fetch(`${baseUrl}/api/servers/shells/${shellLongBody.sessionId}`, {
  method: 'DELETE',
  headers: authHeaders,
});
if (!shellLongCloseResponse.ok) {
  throw new Error(`/api/servers/shells/:sessionId DELETE long-output returned HTTP ${shellLongCloseResponse.status}`);
}
console.log('ok /api/servers/shells streams long output without stalling');

const shellInterruptResponse = await fetch(`${baseUrl}/api/servers/shells`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    serverId: connectedServer.id,
    cols: 100,
    rows: 28,
  }),
});
if (shellInterruptResponse.status !== 201) {
  throw new Error(`/api/servers/shells interrupt setup returned HTTP ${shellInterruptResponse.status}`);
}
const shellInterruptBody = await shellInterruptResponse.json();
const shellInterruptStreamResponse = await fetch(`${baseUrl}/api/servers/shells/${shellInterruptBody.sessionId}/stream`, {
  headers: authHeaders,
});
if (!shellInterruptStreamResponse.ok) {
  throw new Error(`/api/servers/shells/:sessionId/stream interrupt returned HTTP ${shellInterruptStreamResponse.status}`);
}
const shellHangWriteResponse = await fetch(`${baseUrl}/api/servers/shells/${shellInterruptBody.sessionId}/input`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: 'colipas-hang\n' }),
});
if (!shellHangWriteResponse.ok) {
  throw new Error(`/api/servers/shells/:sessionId/input hang command returned HTTP ${shellHangWriteResponse.status}`);
}
await new Promise((resolve) => setTimeout(resolve, 100));
const shellInterruptWriteResponse = await fetch(`${baseUrl}/api/servers/shells/${shellInterruptBody.sessionId}/input`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: '\u0003' }),
});
if (!shellInterruptWriteResponse.ok) {
  throw new Error(`/api/servers/shells/:sessionId/input interrupt returned HTTP ${shellInterruptWriteResponse.status}`);
}
const shellInterruptedText = await readSseUntil(
  shellInterruptStreamResponse,
  (text) => text.includes('^C') && text.includes('simulated$'),
  5000,
);
if (!shellInterruptedText.includes('hanging until interrupt')) {
  throw new Error('/api/servers/shells interrupt test missed the running command evidence');
}
if (shellInterruptedText.includes('"type":"close"')) {
  throw new Error('/api/servers/shells interrupt closed the shell instead of returning to prompt');
}
const shellPostInterruptWriteResponse = await fetch(`${baseUrl}/api/servers/shells/${shellInterruptBody.sessionId}/input`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: 'whoami\n' }),
});
if (!shellPostInterruptWriteResponse.ok) {
  throw new Error(`/api/servers/shells/:sessionId/input post-interrupt command returned HTTP ${shellPostInterruptWriteResponse.status}`);
}
const shellPostInterruptStreamResponse = await fetch(`${baseUrl}/api/servers/shells/${shellInterruptBody.sessionId}/stream`, {
  headers: authHeaders,
});
if (!shellPostInterruptStreamResponse.ok) {
  throw new Error(`/api/servers/shells/:sessionId/stream post-interrupt returned HTTP ${shellPostInterruptStreamResponse.status}`);
}
const shellPostInterruptText = await readSseUntil(
  shellPostInterruptStreamResponse,
  (text) => text.includes('simulated$ whoami') && text.includes('command simulated.'),
  5000,
);
if (shellPostInterruptText.includes('"type":"close"')) {
  throw new Error('/api/servers/shells interrupt closed the shell instead of returning to prompt');
}
await fetch(`${baseUrl}/api/servers/shells/${shellInterruptBody.sessionId}`, { method: 'DELETE', headers: authHeaders });
console.log('ok /api/servers/shells interrupts a running terminal command without closing the shell');

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
if (
  actionBody.status !== 'executed'
  || actionBody.serverId !== connectedServer.id
  || actionBody.action !== 'reboot'
  || !/^srv-trace-[a-f0-9-]{36}$/.test(actionBody.correlationId)
) {
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

const operationPreflightReadyResponse = await fetch(`${baseUrl}/api/operations/tasks/preflight`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'healthCheck',
    targetMode: 'selected',
    serverIds: [connectedServer.id],
  }),
});
if (!operationPreflightReadyResponse.ok) {
  throw new Error(`/api/operations/tasks/preflight healthCheck returned HTTP ${operationPreflightReadyResponse.status}`);
}
const operationPreflightReadyBody = await operationPreflightReadyResponse.json();
const operationPreflightReadyPayload = JSON.stringify(operationPreflightReadyBody);
if (
  operationPreflightReadyBody.ok !== true
  || !/^ops-trace-[a-f0-9-]{36}$/.test(operationPreflightReadyBody.correlationId)
  || operationPreflightReadyBody.summary?.totalTargets !== 1
  || operationPreflightReadyBody.summary?.runnableTargets !== 1
  || operationPreflightReadyBody.summary?.blocked !== 0
  || !operationPreflightReadyBody.plan?.title?.includes('Health check')
  || operationPreflightReadyBody.plan?.targetSummary !== '1/1 targets runnable'
  || operationPreflightReadyBody.plan?.riskSummary !== 'No blocking issues or warnings'
  || operationPreflightReadyBody.targets?.[0]?.id !== connectedServer.id
  || operationPreflightReadyBody.targets?.[0]?.sshConnected !== true
  || operationPreflightReadyBody.targets?.[0]?.runnable !== true
  || operationPreflightReadyBody.targets?.[0]?.issues?.length !== 0
  || operationPreflightReadyPayload.includes('"publicIp"')
  || operationPreflightReadyPayload.includes('"privateIp"')
  || operationPreflightReadyPayload.includes(connectedServer.publicIp)
  || operationPreflightReadyPayload.includes(connectedServer.privateIp)
  || operationPreflightReadyPayload.includes('smoke-password')
  || operationPreflightReadyPayload.includes('BEGIN RSA PRIVATE KEY')
) {
  throw new Error('/api/operations/tasks/preflight ready path returned unexpected or sensitive payload');
}
console.log('ok /api/operations/tasks/preflight allows connected selected targets without leaking secrets');

const operationPreflightUnconnectedResponse = await fetch(`${baseUrl}/api/operations/tasks/preflight`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'healthCheck',
    targetMode: 'selected',
    serverIds: [inventoryOnlyServer.id],
  }),
});
if (!operationPreflightUnconnectedResponse.ok) {
  throw new Error(`/api/operations/tasks/preflight unconnected target returned HTTP ${operationPreflightUnconnectedResponse.status}`);
}
const operationPreflightUnconnectedBody = await operationPreflightUnconnectedResponse.json();
if (
  operationPreflightUnconnectedBody.ok !== false
  || operationPreflightUnconnectedBody.summary?.disconnectedTargets !== 1
  || operationPreflightUnconnectedBody.targets?.[0]?.id !== inventoryOnlyServer.id
  || operationPreflightUnconnectedBody.targets?.[0]?.runnable !== false
  || !operationPreflightUnconnectedBody.targets?.[0]?.issues?.some((issue) => issue.code === 'OPERATIONS_TARGETS_UNCONNECTED' && issue.severity === 'block')
  || !operationPreflightUnconnectedBody.issues?.some((issue) => issue.code === 'OPERATIONS_TARGETS_UNCONNECTED' && issue.severity === 'block')
) {
  throw new Error('/api/operations/tasks/preflight did not block selected unconnected targets');
}
console.log('ok /api/operations/tasks/preflight blocks unconnected selected targets');

const operationPreflightMissingResponse = await fetch(`${baseUrl}/api/operations/tasks/preflight`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'healthCheck',
    targetMode: 'selected',
    serverIds: [`missing-${Date.now()}`],
  }),
});
if (!operationPreflightMissingResponse.ok) {
  throw new Error(`/api/operations/tasks/preflight missing target returned HTTP ${operationPreflightMissingResponse.status}`);
}
const operationPreflightMissingBody = await operationPreflightMissingResponse.json();
if (
  operationPreflightMissingBody.ok !== false
  || operationPreflightMissingBody.summary?.missingTargets !== 1
  || operationPreflightMissingBody.summary?.totalTargets !== 1
  || operationPreflightMissingBody.targets?.[0]?.status !== 'missing'
  || operationPreflightMissingBody.targets?.[0]?.runnable !== false
  || !operationPreflightMissingBody.targets?.[0]?.issues?.some((issue) => issue.code === 'OPERATIONS_TARGETS_NOT_FOUND' && issue.severity === 'block')
  || !operationPreflightMissingBody.issues?.some((issue) => issue.code === 'OPERATIONS_TARGETS_NOT_FOUND' && issue.severity === 'block')
) {
  throw new Error('/api/operations/tasks/preflight did not report missing selected targets');
}
console.log('ok /api/operations/tasks/preflight reports missing selected targets');

const operationPreflightRebootWarnResponse = await fetch(`${baseUrl}/api/operations/tasks/preflight`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'reboot',
    targetMode: 'selected',
    serverIds: [connectedServer.id],
    reason: 'preflight confirmation warning should be visible',
  }),
});
if (!operationPreflightRebootWarnResponse.ok) {
  throw new Error(`/api/operations/tasks/preflight reboot warning returned HTTP ${operationPreflightRebootWarnResponse.status}`);
}
const operationPreflightRebootWarnBody = await operationPreflightRebootWarnResponse.json();
if (
  operationPreflightRebootWarnBody.ok !== true
  || operationPreflightRebootWarnBody.requiresConfirmation !== true
  || operationPreflightRebootWarnBody.targets?.[0]?.runnable !== true
  || !operationPreflightRebootWarnBody.targets?.[0]?.issues?.some((issue) => issue.code === 'OPERATIONS_CONFIRMATION_REQUIRED' && issue.severity === 'warn')
  || !operationPreflightRebootWarnBody.issues?.some((issue) => issue.code === 'OPERATIONS_CONFIRMATION_REQUIRED' && issue.severity === 'warn')
) {
  throw new Error('/api/operations/tasks/preflight did not warn for unconfirmed reboot');
}
console.log('ok /api/operations/tasks/preflight warns before destructive actions');

const operationPreflightCommandSecret = `sk-smoke-preflight-${Date.now()}`;
const operationPreflightCommandResponse = await fetch(`${baseUrl}/api/operations/tasks/preflight`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'sshCommand',
    targetMode: 'selected',
    serverIds: [connectedServer.id],
    command: `curl "https://example.invalid/check?token=${operationPreflightCommandSecret}" -H "Authorization: Bearer ${operationPreflightCommandSecret}"`,
    reason: 'preflight command preview should be redacted',
  }),
});
if (!operationPreflightCommandResponse.ok) {
  throw new Error(`/api/operations/tasks/preflight sshCommand preview returned HTTP ${operationPreflightCommandResponse.status}`);
}
const operationPreflightCommandBody = await operationPreflightCommandResponse.json();
const operationPreflightCommandPreview = operationPreflightCommandBody.plan?.commandPreview ?? '';
if (
  operationPreflightCommandBody.ok !== true
  || !operationPreflightCommandBody.plan?.title?.includes('SSH command')
  || operationPreflightCommandPreview.includes(operationPreflightCommandSecret)
  || !operationPreflightCommandPreview.includes('[redacted]')
) {
  throw new Error('/api/operations/tasks/preflight command plan did not redact sensitive command preview');
}
console.log('ok /api/operations/tasks/preflight builds redacted execution plan');

const operationPreflightHighImpactCommandResponse = await fetch(`${baseUrl}/api/operations/tasks/preflight`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'sshCommand',
    targetMode: 'selected',
    serverIds: [connectedServer.id],
    command: 'apt install -y unzip',
    reason: 'preflight high-impact command should require confirmation',
  }),
});
if (!operationPreflightHighImpactCommandResponse.ok) {
  throw new Error(`/api/operations/tasks/preflight high-impact sshCommand returned HTTP ${operationPreflightHighImpactCommandResponse.status}`);
}
const operationPreflightHighImpactCommandBody = await operationPreflightHighImpactCommandResponse.json();
if (
  operationPreflightHighImpactCommandBody.ok !== true
  || operationPreflightHighImpactCommandBody.requiresConfirmation !== true
  || operationPreflightHighImpactCommandBody.plan?.commandPreview !== 'apt install -y unzip'
  || !operationPreflightHighImpactCommandBody.plan?.impact?.includes('after operator confirmation')
  || !operationPreflightHighImpactCommandBody.issues?.some((issue) => issue.code === 'OPERATIONS_CONFIRMATION_REQUIRED' && issue.severity === 'warn')
) {
  throw new Error('/api/operations/tasks/preflight did not warn before high-impact SSH command execution');
}
const operationHighImpactBlockedResponse = await fetch(`${baseUrl}/api/operations/tasks`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'sshCommand',
    targetMode: 'selected',
    serverIds: [connectedServer.id],
    command: 'apt install -y unzip',
    reason: 'pre-release high-impact command confirmation guard',
  }),
});
if (operationHighImpactBlockedResponse.status !== 409) {
  throw new Error(`/api/operations/tasks high-impact sshCommand should require confirmation, got HTTP ${operationHighImpactBlockedResponse.status}`);
}
console.log('ok /api/operations/tasks/preflight warns before high-impact SSH commands');

const operationHealthResponse = await fetch(`${baseUrl}/api/operations/tasks`, {
  method: 'POST',
  headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'healthCheck',
    targetMode: 'selected',
    serverIds: [connectedServer.id],
    correlationId: operationPreflightReadyBody.correlationId,
  }),
});
if (operationHealthResponse.status !== 202) {
  throw new Error(`/api/operations/tasks healthCheck returned HTTP ${operationHealthResponse.status}`);
}
const operationHealthBody = await operationHealthResponse.json();
if (
  operationHealthBody.status !== 'completed'
  || operationHealthBody.correlationId !== operationPreflightReadyBody.correlationId
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
if (!auditBody.items.some((item) => item.action === 'OPERATIONS_PREFLIGHT' && item.status === 'success' && item.detail?.includes('Plan:'))) {
  throw new Error('/api/audit/events did not include successful operations preflight plan evidence');
}
if (!auditBody.items.some((item) => item.action === 'OPERATIONS_PREFLIGHT' && item.status === 'blocked' && item.detail?.includes('blocking issue'))) {
  throw new Error('/api/audit/events did not include blocked operations preflight evidence');
}
const operationPreflightAudit = auditBody.items.find((item) => item.action === 'OPERATIONS_PREFLIGHT' && item.status === 'success' && item.target === connectedServer.id && item.detail?.includes('Health check'));
const operationTaskAudit = auditBody.items.find((item) => item.action === 'OPERATIONS_TASK' && item.status === 'success' && item.target === connectedServer.id && item.detail?.includes('healthCheck completed'));
if (!operationPreflightAudit || !operationTaskAudit) {
  throw new Error('/api/audit/events did not include linkable operations preflight and execution evidence');
}
if (
  operationPreflightAudit.correlationId !== operationPreflightReadyBody.correlationId
  || operationTaskAudit.correlationId !== operationPreflightReadyBody.correlationId
) {
  throw new Error('/api/audit/events did not preserve operations preflight/execution correlation IDs');
}
if (new Date(operationTaskAudit.createdAt).getTime() < new Date(operationPreflightAudit.createdAt).getTime()) {
  throw new Error('/api/audit/events operation execution audit appeared before its preflight');
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
const commandAuditEntry = auditBody.items.find((item) => (
  item.action === 'SERVER_SSH_COMMAND'
  && item.detail?.includes('SSH command executed')
  && item.detail?.includes('uptime')
  && item.target === connectedServer.id
));
if (!commandAuditEntry || commandAuditEntry.correlationId !== commandBody.correlationId) {
  throw new Error('/api/audit/events did not preserve server SSH command correlation ID');
}
const shellAuditCorrelationIds = new Set(
  auditBody.items
    .filter((item) => item.action === 'SERVER_SSH_COMMAND' && item.detail?.includes('SSH shell opened') && item.target === connectedServer.id)
    .map((item) => item.correlationId),
);
const expectedShellCorrelationIds = [shellBody.correlationId, shellLongBody.correlationId, shellInterruptBody.correlationId];
const missingShellCorrelationIds = expectedShellCorrelationIds.filter((correlationId) => !shellAuditCorrelationIds.has(correlationId));
if (missingShellCorrelationIds.length > 0) {
  throw new Error(`/api/audit/events did not preserve SSH shell correlation IDs: ${missingShellCorrelationIds.join(', ')}`);
}
const actionAuditEntry = auditBody.items.find((item) => item.action === 'SERVER_ACTION' && item.correlationId === actionBody.correlationId);
if (!actionAuditEntry || actionAuditEntry.correlationId !== actionBody.correlationId) {
  throw new Error('/api/audit/events did not preserve server action correlation ID');
}
const auditPayload = JSON.stringify(auditBody);
if (auditPayload.includes(smokePrivateKeyMarker) || auditPayload.includes(smokePrivateKeyPassphrase)) {
  throw new Error('/api/audit/events leaked SSH private key material');
}
if (auditPayload.includes(operationPreflightCommandSecret)) {
  throw new Error('/api/audit/events leaked sensitive operations preflight command preview');
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

const readinessResponse = await fetch(`${baseUrl}/api/audit/readiness`, { headers: authHeaders });
if (!readinessResponse.ok) {
  throw new Error(`/api/audit/readiness returned HTTP ${readinessResponse.status}`);
}
const readinessBody = await readinessResponse.json();
if (
  !Number.isInteger(readinessBody.score)
  || readinessBody.summary?.totalChecks !== readinessBody.checks?.length
  || !readinessBody.checks?.some((check) => check.id === 'audit-failures' && check.severity !== 'info')
  || !readinessBody.blockers?.some((check) => check.id === 'audit-failures')
  || typeof readinessBody.nextBestAction !== 'string'
) {
  throw new Error('/api/audit/readiness did not reflect active audit risk evidence');
}
const readinessPayload = JSON.stringify(readinessBody);
if (
  readinessPayload.includes(sensitiveAuditSecret)
  || readinessPayload.includes(sensitiveSshSecret)
  || readinessPayload.includes(smokePrivateKeyMarker)
  || readinessPayload.includes(smokePrivateKeyPassphrase)
) {
  throw new Error('/api/audit/readiness leaked sensitive audit or SSH material');
}
console.log('ok /api/audit/readiness aggregates release evidence without secrets');

const readinessSnapshotResponse = await fetch(`${baseUrl}/api/audit/readiness/snapshots`, {
  method: 'POST',
  headers: authHeaders,
});
if (readinessSnapshotResponse.status !== 201) {
  throw new Error(`/api/audit/readiness/snapshots returned HTTP ${readinessSnapshotResponse.status}`);
}
const readinessSnapshotBody = await readinessSnapshotResponse.json();
if (
  readinessSnapshotBody.ok !== true
  || !readinessSnapshotBody.snapshot?.id
  || readinessSnapshotBody.snapshot?.score !== readinessBody.score
  || readinessSnapshotBody.readiness?.history?.trend?.snapshotCount < 1
) {
  throw new Error('/api/audit/readiness/snapshots returned unexpected history payload');
}
const secondReadinessSnapshotResponse = await fetch(`${baseUrl}/api/audit/readiness/snapshots`, {
  method: 'POST',
  headers: authHeaders,
});
const secondReadinessSnapshotBody = await secondReadinessSnapshotResponse.json();
if (
  !secondReadinessSnapshotResponse.ok
  || secondReadinessSnapshotBody.readiness?.history?.trend?.snapshotCount < 2
  || !['flat', 'up', 'down'].includes(secondReadinessSnapshotBody.readiness?.history?.trend?.direction)
) {
  throw new Error('/api/audit/readiness/snapshots did not preserve readiness trend history');
}
if (JSON.stringify(secondReadinessSnapshotBody).includes(sensitiveAuditSecret) || JSON.stringify(secondReadinessSnapshotBody).includes(sensitiveSshSecret)) {
  throw new Error('/api/audit/readiness/snapshots leaked sensitive material');
}
console.log('ok /api/audit/readiness/snapshots records trend evidence without secrets');

const readinessReportResponse = await fetch(`${baseUrl}/api/audit/readiness/report`, { headers: authHeaders });
if (!readinessReportResponse.ok) {
  throw new Error(`/api/audit/readiness/report returned HTTP ${readinessReportResponse.status}`);
}
const readinessReportBody = await readinessReportResponse.json();
if (
  readinessReportBody.contentType !== 'text/markdown'
  || !readinessReportBody.markdown?.includes('## Blockers')
  || !readinessReportBody.markdown?.includes('## Recent Snapshots')
  || !readinessReportBody.markdown?.includes('Audit failures')
) {
  throw new Error('/api/audit/readiness/report returned incomplete Markdown report');
}
if (
  readinessReportBody.markdown.includes(sensitiveAuditSecret)
  || readinessReportBody.markdown.includes(sensitiveSshSecret)
  || readinessReportBody.markdown.includes(smokePrivateKeyMarker)
  || readinessReportBody.markdown.includes(smokePrivateKeyPassphrase)
  || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(readinessReportBody.markdown)
) {
  throw new Error('/api/audit/readiness/report leaked sensitive material');
}
console.log('ok /api/audit/readiness/report exports sanitized Markdown evidence');

const diagnosticExportResponse = await fetch(`${baseUrl}/api/audit/diagnostics/export`, { headers: authHeaders });
if (!diagnosticExportResponse.ok) {
  throw new Error(`/api/audit/diagnostics/export returned HTTP ${diagnosticExportResponse.status}`);
}
const diagnosticExportBody = await diagnosticExportResponse.json();
const diagnosticPayload = JSON.stringify(diagnosticExportBody);
if (
  diagnosticExportBody.contentType !== 'application/json'
  || !diagnosticExportBody.filename?.startsWith('colipas-diagnostics-')
  || !diagnosticExportBody.readiness?.checks?.some((check) => check.id === 'runtime-secret-posture')
  || typeof diagnosticExportBody.config?.ai?.baseUrlHost !== 'string'
  || !Number.isInteger(diagnosticExportBody.inventory?.servers?.connectedSsh)
  || !Number.isInteger(diagnosticExportBody.sshTerminal?.activeSessions)
  || !Number.isInteger(diagnosticExportBody.sshTerminal?.websocket?.openedShells)
  || !Number.isInteger(diagnosticExportBody.sshTerminal?.websocket?.outputBytes)
) {
  throw new Error('/api/audit/diagnostics/export returned incomplete diagnostic bundle');
}
if (
  diagnosticExportBody.sshTerminal.websocket.openedShells < 1
  || diagnosticExportBody.sshTerminal.websocket.outputBytes < 1
  || !Array.isArray(diagnosticExportBody.sshTerminal.recentEvidence)
  || !diagnosticExportBody.sshTerminal.recentEvidence.some((item) => item.transcriptLines > 0 && item.transcriptChars > 0)
) {
  throw new Error('/api/audit/diagnostics/export did not include SSH terminal observability evidence');
}
if (
  diagnosticPayload.includes(sensitiveAuditSecret)
  || diagnosticPayload.includes(sensitiveSshSecret)
  || diagnosticPayload.includes(smokePrivateKeyMarker)
  || diagnosticPayload.includes(smokePrivateKeyPassphrase)
  || diagnosticPayload.includes('admin123456')
  || diagnosticPayload.includes('verify-production-session-secret')
  || diagnosticPayload.includes('"publicIp"')
  || diagnosticPayload.includes('"privateIp"')
  || diagnosticPayload.includes('"detail"')
  || diagnosticPayload.includes('"sessionId"')
  || diagnosticPayload.includes('simulated$ whoami')
  || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(diagnosticPayload)
) {
  throw new Error('/api/audit/diagnostics/export leaked sensitive or asset-identifying material');
}
console.log('ok /api/audit/diagnostics/export exports sanitized aggregate diagnostics');

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
const remediatedReadinessResponse = await fetch(`${baseUrl}/api/audit/readiness`, { headers: authHeaders });
const remediatedReadinessBody = await remediatedReadinessResponse.json();
const remediatedAuditFailureCheck = remediatedReadinessBody.checks?.find((check) => check.id === 'audit-failures');
if (
  !remediatedReadinessResponse.ok
  || remediatedAuditFailureCheck?.severity !== 'info'
  || remediatedReadinessBody.blockers?.some((check) => check.id === 'audit-failures')
) {
  throw new Error('/api/audit/readiness did not respect audit remediation closure');
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

  if (aiConsoleSource.includes('sessionStorage.setItem') || aiConsoleSource.includes('aiProviderSessionKey')) {
    throw new Error('AI API key must not be cached in browser storage');
  }

  if (!aiConsoleSource.includes('saveAiProviderSettings(provider)') || !aiConsoleSource.includes('fetchAiProviderSettings()')) {
    throw new Error('AI provider settings must load from and save to the server database');
  }

  if (!aiConsoleSource.includes('modelRequestSeqRef') || !aiConsoleSource.includes('modelRequestSeqRef.current !== requestSeq')) {
    throw new Error('AI model refresh must ignore stale model-list responses');
  }

  if (!aiConsoleSource.includes('streamChunkBufferRef') || !aiConsoleSource.includes('aiStreamFlushIntervalMs')) {
    throw new Error('AI streaming output must be buffered to avoid one React render per network chunk');
  }

  if (!aiConsoleSource.includes('aiTransientStatusTtlMs') || !aiConsoleSource.includes('setConnectionTest(null)')) {
    throw new Error('AI transient status chips must auto-clear so they do not squeeze the chat panel');
  }

  if (!aiConsoleSource.includes('providerCustody') || !aiConsoleSource.includes('ai.keyCustodyDatabase')) {
    throw new Error('AI settings panel must expose server-side key custody state after saving provider settings');
  }

  if (!aiConsoleSource.includes('window.localStorage.removeItem(aiStateStorageKey)')) {
    throw new Error('AI console must clear legacy persisted chat state from localStorage');
  }

  if (aiConsoleSource.includes('localStorage.setItem(aiStateStorageKey') || aiConsoleSource.includes('setItem(aiStateStorageKey')) {
    throw new Error('AI console must not persist full chat transcripts to localStorage');
  }

  console.log('ok AI provider storage strips API key, persists keys server-side, and AI chat transcripts stay session-only');
}

function assertAccountUiGuards() {
  const loginSource = fs.readFileSync(new URL('../src/app/LoginPage.tsx', import.meta.url), 'utf8');
  const marketingSource = fs.readFileSync(new URL('../src/app/MarketingPage.tsx', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
  const brandIconSource = fs.readFileSync(new URL('../src/app/BrandIcon.tsx', import.meta.url), 'utf8');
  const indexSource = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const publicIconSource = fs.readFileSync(new URL('../public/colipas-icon.svg', import.meta.url), 'utf8');
  const ciSource = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const serverAppSource = fs.readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
  const serverUpdateSource = fs.readFileSync(new URL('../deploy/server-update.sh', import.meta.url), 'utf8');
  const authSource = fs.readFileSync(new URL('../src/server/services/authService.ts', import.meta.url), 'utf8');
  const inventorySource = fs.readFileSync(new URL('../src/modules/servers/ServerInventory.tsx', import.meta.url), 'utf8');
  const globalCss = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  const i18nSource = fs.readFileSync(new URL('../src/i18n.tsx', import.meta.url), 'utf8');
  const verifyProductionSource = fs.readFileSync(new URL('../scripts/verify-production.mjs', import.meta.url), 'utf8');
  const releaseDeploySource = fs.readFileSync(new URL('../scripts/release-deploy.ps1', import.meta.url), 'utf8');
  const publicPagesCheckSource = fs.readFileSync(new URL('../scripts/public-pages-check.mjs', import.meta.url), 'utf8');
  const ciWorkflowSource = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const dockerfileSource = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const composeSource = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const systemdSource = fs.readFileSync(new URL('../deploy/colipas.service', import.meta.url), 'utf8');
  const dockerUpdateSource = fs.readFileSync(new URL('../deploy/docker-update.sh', import.meta.url), 'utf8');
  const evidenceCheckSource = fs.readFileSync(new URL('../deploy/release-evidence-check.mjs', import.meta.url), 'utf8');
  const gitignoreSource = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');

  if (loginSource.includes("useState('admin')") || loginSource.includes('value="admin"')) {
    throw new Error('Login page must not prefill the admin username');
  }
  if (
    marketingSource.includes("useState('admin')")
    || marketingSource.includes('admin / admin123456')
    || marketingSource.includes('默认演示账号')
  ) {
    throw new Error('Marketing login must not prefill or publish default admin credentials');
  }
  if (appSource.includes("session.user?.username ?? 'admin'") || !appSource.includes('accountDisplayLabel')) {
    throw new Error('Authenticated account UI must not display admin as a fallback label');
  }
  if (
    !appSource.includes('const accountDisplayLabel = sessionIdentity || sidebarDisplayLabel;')
    || !appSource.includes('<b>{accountDisplayLabel}</b>')
    || !appSource.includes('title={sessionTooltip}')
  ) {
    throw new Error('Topbar account settings entry must display the authenticated login username, not the sidebar profile name');
  }
  if (!appSource.includes('<strong>{sidebarDisplayLabel}</strong>')) {
    throw new Error('Sidebar brand must keep the custom profile display name separate from the topbar login username');
  }
  const accountTriggerSource = appSource.match(/<button[\s\S]*?className="session-chip account-settings-trigger"[\s\S]*?<\/button>/)?.[0] ?? '';
  if (
    !accountTriggerSource.includes('<b>{accountDisplayLabel}</b>')
    || accountTriggerSource.includes('AvatarMark')
    || accountTriggerSource.includes('BrandIcon')
    || accountTriggerSource.includes('<img')
  ) {
    throw new Error('Topbar account settings trigger must display only the login username without an avatar or brand image');
  }
  if (globalCss.includes('.session-chip .brand-mark.mini') || globalCss.includes('.session-chip svg')) {
    throw new Error('Topbar account chip must not reserve image or SVG styling; it is text-only');
  }

  const brandIconFragments = [
    '<link rel="icon" type="image/svg+xml" href="/colipas-icon.svg?v=20260530-brand3" />',
    'export function BrandIcon',
    'viewBox="0 0 64 64"',
    'A clear cloud terminal mark',
    'app-brand-mark',
    'marketing-brand-mark',
    '.brand-mark svg',
    'cat >"$LANDING_ROOT/colipas-icon.svg"',
    '<link rel="icon" type="image/svg+xml" href="/colipas-icon.svg?v=20260530-brand3">',
    '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">',
  ];
  const brandIconSourceBundle = `${indexSource}\n${publicIconSource}\n${brandIconSource}\n${loginSource}\n${marketingSource}\n${appSource}\n${globalCss}\n${serverUpdateSource}`;
  const missingBrandIcon = brandIconFragments.filter((fragment) => !brandIconSourceBundle.includes(fragment));
  if (missingBrandIcon.length) {
    throw new Error(`CoLiPas brand icon replacement is incomplete: ${missingBrandIcon.join(', ')}`);
  }
  if (
    !loginSource.includes('href="https://github.com/nmklio/CoLiPas"')
    || !loginSource.includes('login-github-link')
    || !loginSource.includes('aria-label="GitHub"')
    || !loginSource.includes('login-panel-header')
    || !marketingSource.includes('deploy-inline-link')
    || !serverUpdateSource.includes('patch_landing_page_ui')
    || !serverUpdateSource.includes('write_docs_page')
    || !serverUpdateSource.includes('https://github.com/nmklio/CoLiPas')
    || !serverUpdateSource.includes('href="/docs.html"')
    || !serverUpdateSource.includes('colipas landing balanced ui v8')
    || !serverUpdateSource.includes('landingIcon(kind, className)')
    || !serverUpdateSource.includes('replacePositionCard(')
    || !serverUpdateSource.includes('new RegExp(`<article class="position-card')
    || !serverUpdateSource.includes('position-flow-card')
    || !serverUpdateSource.includes('position-step')
    || !serverUpdateSource.includes('position-state')
    || !serverUpdateSource.includes('position-flow-terminal')
    || !serverUpdateSource.includes('position-flow-ai')
    || !serverUpdateSource.includes('position-flow-shield')
    || !serverUpdateSource.includes("replaceAll(/<title>[\\s\\S]*?<\\/title>/g")
    || !serverUpdateSource.includes('<img class="brand-mark" src="/colipas-icon.svg"')
    || !serverUpdateSource.includes('icon feature-icon')
    || !serverUpdateSource.includes('position-icon')
    || !serverUpdateSource.includes('deploy-icon')
    || !serverUpdateSource.includes('replaceAll(/<section class="closing">[\\s\\S]*?<\\/section>\\s*/g, \'\')')
    || !serverUpdateSource.includes('云服务器管理与 AI 运维后台')
    || !serverUpdateSource.includes('COLIPAS_RESET_ADMIN_PASSWORD')
    || !serverUpdateSource.includes('SSH_ORIGINAL_COMMAND')
    || !serverUpdateSource.includes('reset_admin_password_if_requested')
    || !serverUpdateSource.includes('install_deploy_sudo_env_keep')
    || !serverUpdateSource.includes('colipas-deploy-env-keep')
    || !serverUpdateSource.includes('install_deploy_forced_command_env_preserve')
    || !serverUpdateSource.includes('--preserve-env=SSH_ORIGINAL_COMMAND,COLIPAS_RESET_ADMIN_PASSWORD')
    || !serverUpdateSource.includes('try_files /docs.html =404')
    || !serverUpdateSource.includes('CoLiPas cloud server management panel docs page ready')
    || !serverUpdateSource.includes('体验测试地址')
    || !serverUpdateSource.includes('href="/colipas-icon.svg?v=20260530-brand3"')
    || !serverUpdateSource.includes('location = /favicon.ico')
    || !serverUpdateSource.includes('受保护的环境变量注入公网地址和初始密码')
    || !serverUpdateSource.includes('不会在结束时回显已提供的密码')
    || !serverUpdateSource.includes('为什么未验证的服务器不会显示已接入？')
    || !serverUpdateSource.includes('不要将 Vite 5173 作为生产入口')
    || !serverAppSource.includes("app.get('/favicon.ico'")
    || !serverAppSource.includes("response.type('image/svg+xml')")
    || !serverUpdateSource.includes('Cache-Control "no-store, max-age=0" always')
  ) {
    throw new Error('Deployment, docs, and login pages must expose public navigation without fake docs links');
  }

  const publicPageGuardFragments = [
    "PUBLIC_PAGES_MODE: 'admin'",
    "['scripts/public-pages-check.mjs']",
    'Production target browser validation',
    '$env:PUBLIC_PAGES_BASE_URL = $Target.publicBaseUrl',
    'Invoke-ProductionBrowserValidation',
    '[int]$MaxAttempts = 3',
    'Start-Sleep -Seconds $RetryDelaySeconds',
    'foreach ($target in $script:SuccessfulDeployTargets)',
    'Assert-NoTargetUpdateFailures',
    'skipPublicValidation',
    'buildLandingCheck',
    'buildDocsCheck',
    'buildAdminCheck',
    'assertNoHorizontalOverflow',
    'assertNoBadBoxes',
    'assertSensitiveTextAbsent',
    'expectTextAbsent',
    'landing legacy footer product description',
    'landing feature SVG icons',
    'landing redesigned flow position cards',
    'landing position flow step numbers',
    'landing position flow state pills',
    'landing legacy position icon blocks',
    'landing legacy numbered position badges',
    'landing deploy SVG icons',
    'CoLiPas - 多云服务器管理面板',
    '云服务器管理与 AI 运维后台',
    "path.resolve('output', 'public-pages-check')",
    "waitUntil: 'domcontentloaded'",
    'static.cloudflareinsights.com',
    '/beacon.min.js',
    '/docs.html',
    '/admin/',
    'https://github.com/nmklio/CoLiPas',
    'input[autocomplete="username"]',
  ];
  const publicPageGuardSource = `${verifyProductionSource}\n${releaseDeploySource}\n${publicPagesCheckSource}`;
  const missingPublicPageGuard = publicPageGuardFragments.filter((fragment) => !publicPageGuardSource.includes(fragment));
  if (missingPublicPageGuard.length) {
    throw new Error(`Public landing/docs/admin browser validation is incomplete: ${missingPublicPageGuard.join(', ')}`);
  }

  const localGreyDiagnosticGuardFragments = [
    'configureNodeReports()',
    'process.report.reportOnFatalError = true',
    'process.report.reportOnUncaughtException = true',
    'writeFailureDiagnostics(error)',
    'keepVerifyDataOnFailure',
    'Application server exited early during',
    'serverLog.stderr',
    'verify-production kept diagnostics',
  ];
  const missingLocalGreyDiagnosticGuard = localGreyDiagnosticGuardFragments.filter((fragment) => !verifyProductionSource.includes(fragment));
  if (missingLocalGreyDiagnosticGuard.length || !gitignoreSource.includes('.tmp-verify-data/')) {
    throw new Error(`Local grey test diagnostics are incomplete: ${missingLocalGreyDiagnosticGuard.join(', ') || '.tmp-verify-data/'}`);
  }

  const ciGuardFragments = [
    'concurrency:',
    'cancel-in-progress: true',
    'timeout-minutes:',
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
    'command -v google-chrome',
    'npm test',
  ];
  const missingCiGuard = ciGuardFragments.filter((fragment) => !ciWorkflowSource.includes(fragment));
  if (missingCiGuard.length) {
    throw new Error(`CI workflow is missing timeout/cancellation guardrails: ${missingCiGuard.join(', ')}`);
  }

  const deploymentEvidenceGuardFragments = [
    'RELEASE_GIT_COMMIT',
    'RELEASE_TARGET_NAME',
    'RELEASE_PUBLIC_URL',
    'RELEASE_DEPLOYMENT_MODE',
    'RELEASE_DEPLOYED_AT',
    'ConvertTo-ShellSingleQuoted',
    'RELEASE_ARTIFACT_ID=$safeArtifact',
    '$script:PublishedCommitSha',
    'throw "Target $($Target.name) update failed with exit code $LASTEXITCODE."',
    'generate_release_verify_token',
    'write_release_evidence_env',
    'ensure_current_build',
    'if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then',
    'reexec_runtime_update_script_if_needed',
    'COLIPAS_UPDATE_SCRIPT_REEXECED',
    'exec "$RUNTIME_UPDATE_SCRIPT"',
    'verify_release_evidence',
    "grep -Ev '^(RELEASE_VERIFY_TOKEN|RELEASE_TARGET_NAME|RELEASE_CHANNEL|RELEASE_DEPLOYMENT_MODE|RELEASE_PUBLIC_URL|RELEASE_GIT_COMMIT|RELEASE_ARTIFACT_ID|RELEASE_DEPLOYED_AT)='",
    "printf 'RELEASE_VERIFY_TOKEN=%s\\n'",
    'RELEASE_VERIFY_ATTEMPTS',
    'fetchReleaseVerification(endpoint, token, maxAttempts, retryDelayMs)',
    'docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --build --remove-orphans',
    "grep -Ev '^(RELEASE_TARGET_NAME|RELEASE_CHANNEL|RELEASE_DEPLOYMENT_MODE|RELEASE_PUBLIC_URL|RELEASE_GIT_COMMIT|RELEASE_ARTIFACT_ID|RELEASE_DEPLOYED_AT)=' .env",
    "b.release?.gitCommit===e",
    "e==='unknown'",
    'deploy/release-evidence-check.mjs',
    'verify_release_evidence',
    'security evidence UI marker is missing',
    'docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" exec -T colipas node deploy/release-evidence-check.mjs',
    'ARG RELEASE_GIT_COMMIT',
    'RELEASE_ARTIFACT_ID',
    'Environment=RELEASE_DEPLOYMENT_MODE=systemd',
  ];
  const deploymentEvidenceGuardSource = `${verifyProductionSource}\n${releaseDeploySource}\n${dockerfileSource}\n${composeSource}\n${systemdSource}\n${serverUpdateSource}\n${dockerUpdateSource}\n${evidenceCheckSource}`;
  const missingDeploymentEvidenceGuard = deploymentEvidenceGuardFragments.filter((fragment) => !deploymentEvidenceGuardSource.includes(fragment));
  if (missingDeploymentEvidenceGuard.length) {
    throw new Error(`Deployment evidence environment propagation is incomplete: ${missingDeploymentEvidenceGuard.join(', ')}`);
  }

  const avatarFragments = [
    'avatarImage',
    'handleAvatarUpload',
    "new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])",
    'file.size > avatarMaxBytes',
    'const avatarMaxBytes = 2 * 1024 * 1024',
    'readFileAsDataUrl',
    '<AvatarMark profile={profile}',
    'className="avatar-upload-row"',
    'settingsMessageTtlMs',
    'setSettingsSuccess(\'\')',
  ];
  const missingAvatar = avatarFragments.filter((fragment) => !appSource.includes(fragment));
  if (missingAvatar.length) {
    throw new Error(`Account avatar upload UI is incomplete: ${missingAvatar.join(', ')}`);
  }
  if (
    appSource.includes("t('account.avatarText')")
    || appSource.includes('profileDraft.avatarText')
    || appSource.includes('placeholder="CP"')
    || i18nSource.includes("'account.avatarText': '备用文字'")
    || i18nSource.includes("'account.avatarText': 'Fallback text'")
  ) {
    throw new Error('Account appearance UI must not expose fallback avatar text controls');
  }

  const backendFragments = [
    "express.json({ limit: '3mb' })",
    'const avatarMaxBytes = 2 * 1024 * 1024',
    'avatarMaxDataUrlLength',
    'function isSafeAvatarDataUrl',
    'data:image\\/(png|jpeg|webp|gif)',
    'Buffer.byteLength(match[2], \'base64\') <= avatarMaxBytes',
  ];
  const backendSource = `${serverAppSource}\n${authSource}`;
  const missingBackend = backendFragments.filter((fragment) => !backendSource.includes(fragment));
  if (missingBackend.length) {
    throw new Error(`Account avatar backend safety guards are incomplete: ${missingBackend.join(', ')}`);
  }

  const serverFormFragments = [
    'const [formDismissed, setFormDismissed] = useState(false)',
    'allServers.length === 0 && !formDismissed',
    'setFormDismissed(true)',
    'setFormDismissed(false)',
  ];
  const missingServerForm = serverFormFragments.filter((fragment) => !inventorySource.includes(fragment));
  if (missingServerForm.length) {
    throw new Error(`Server connect form hide behavior is incomplete: ${missingServerForm.join(', ')}`);
  }

  const cssFragments = [
    '.brand-mark img',
    '.brand-mark svg',
    '.avatar-upload-row',
    'width: min(448px, calc(100vw - 288px))',
    'box-shadow: 0 26px 72px rgba(12, 30, 35, 0.18)',
    'display: flex',
    '.ai-dock-body.chat-mode',
    'grid-template-rows: auto auto minmax(0, 1fr) auto auto',
    '.ai-dock-body.settings-mode',
    'grid-template-rows: minmax(0, 1fr)',
    'overflow: hidden',
    '.ai-dock-settings input[type="range"]',
    'grid-template-columns: minmax(0, 1fr) auto',
    'border-radius: 999px',
    '.ai-empty-panel',
    '.ai-status-stack',
    '.login-panel-header',
    '.login-github-link',
    '.deploy-inline-link',
  ];
  const missingCss = cssFragments.filter((fragment) => !globalCss.includes(fragment));
  if (missingCss.length) {
    throw new Error(`Account/AI UI CSS guards are incomplete: ${missingCss.join(', ')}`);
  }

  if (!ciSource.includes('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH') || !ciSource.includes('Verify system Chrome')) {
    throw new Error('GitHub Actions must configure a system Chrome path before browser E2E smoke tests');
  }
  if (!ciSource.includes('actions/checkout@v6') || !ciSource.includes('actions/setup-node@v6') || !ciSource.includes('node-version: 24')) {
    throw new Error('GitHub Actions must use Node 24-compatible v6 actions to avoid deprecated Node 20 runner warnings');
  }

  for (const key of ['account.avatarImage', 'account.removeAvatarImage', 'account.avatarImageInvalid', 'account.avatarImageTooLarge']) {
    const count = (i18nSource.match(new RegExp(key.replace('.', '\\.'), 'g')) ?? []).length;
    if (count < 3) {
      throw new Error(`Account avatar i18n key is missing languages: ${key}`);
    }
  }

  console.log('ok account UI avoids admin prefill, supports safe avatar upload, and keeps server form hideable');
}

function assertCommandPaletteGuards() {
  const appSource = fs.readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
  const globalCss = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  const i18nSource = fs.readFileSync(new URL('../src/i18n.tsx', import.meta.url), 'utf8');
  const browserE2eSource = fs.readFileSync(new URL('../scripts/browser-e2e.mjs', import.meta.url), 'utf8');

  const appFragments = [
    'const [commandPaletteOpen, setCommandPaletteOpen]',
    'event.ctrlKey || event.metaKey',
    "key === 'k'",
    'setCommandPaletteOpen(true)',
    'function openCommandPalette()',
    'function runFirstCommandPaletteAction()',
    'className="command-trigger"',
    'className="command-palette-backdrop"',
    'role="dialog"',
    'role="listbox"',
    'role="option"',
    'app.commandSearchPlaceholder',
  ];
  const missingApp = appFragments.filter((fragment) => !appSource.includes(fragment));
  if (missingApp.length) {
    throw new Error(`Command palette UI wiring is incomplete: ${missingApp.join(', ')}`);
  }

  const cssFragments = [
    '.command-trigger',
    '.command-palette-backdrop',
    '.command-palette-search',
    '.command-palette-item',
    '@media (max-width: 820px)',
  ];
  const missingCss = cssFragments.filter((fragment) => !globalCss.includes(fragment));
  if (missingCss.length) {
    throw new Error(`Command palette responsive styling is incomplete: ${missingCss.join(', ')}`);
  }

  const i18nKeys = [
    'app.commandAccount',
    'app.commandEmpty',
    'app.commandGoSection',
    'app.commandNavigation',
    'app.commandOpenAi',
    'app.commandPalette',
    'app.commandRefresh',
    'app.commandSearchPlaceholder',
    'app.commandTools',
    'app.openCommandPalette',
  ];
  for (const key of i18nKeys) {
    const appearances = i18nSource.match(new RegExp(`'${key}'`, 'g'))?.length ?? 0;
    if (appearances < 3) {
      throw new Error(`Command palette i18n key is missing languages: ${key}`);
    }
  }

  if (
    !browserE2eSource.includes('async function assertCommandPalette')
    || !browserE2eSource.includes("keyboard.press('Control+K')")
    || !browserE2eSource.includes('ok browser e2e covers command palette keyboard and mouse actions')
  ) {
    throw new Error('Command palette must be covered by browser keyboard and mouse regression checks');
  }

  console.log('ok command palette provides keyboard navigation, responsive UI, and i18n coverage');
}

function assertAiStreamingCompatibility() {
  const aiServiceSource = fs.readFileSync(new URL('../src/server/services/aiService.ts', import.meta.url), 'utf8');
  const aiSettingsSource = fs.readFileSync(new URL('../src/server/services/aiSettingsService.ts', import.meta.url), 'utf8');
  const aiConfigSource = fs.readFileSync(new URL('../src/modules/ai/aiConfig.ts', import.meta.url), 'utf8');
  const aiBackendSource = `${aiServiceSource}\n${aiSettingsSource}`;
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
      return !aiBackendSource.includes('AI Base URL must not include username, password, query parameters, or fragments');
    }
    return !aiBackendSource.includes(fragment);
  });
  if (missing.length) {
    throw new Error(`AI stream parser compatibility is incomplete: ${missing.join(', ')}`);
  }

  const forbiddenFragments = [
    'const body = await response.text();',
    'body.slice(0, 160)',
    'provider: aiProvider.baseUrl',
  ];
  const regressions = forbiddenFragments.filter((fragment) => aiBackendSource.includes(fragment));
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
    'executionPlan',
    'function buildExecutionPlan(',
    'safetyNote',
    'shellEvidence',
    'extractPriorExecutionEvidence(chatHistory)',
    'formatShellEvidenceForPrompt(shellEvidence)',
    'Recent sanitized SSH terminal evidence',
    'No factual SSH execution evidence is available',
    'Local evidence boundary',
    'Local guarded execution plan',
    'questionNeedsLiveSshEvidence',
    'questionRequestsDirectSshExecution',
    'questionNeedsNetworkEvidence',
    'isLocalEvidenceBoundaryAnswer',
    'extractSafeRequestedSshCommand',
    'getSshCommandConfirmationReason(command)',
    'requiresConfirmation: Boolean(confirmationReason)',
    'confirmationReason: confirmationReason || undefined',
    '(?:(?:[:=]|：)\\\\s*|\\\\s+)',
    'chinesePolitePrefix',
    'chineseSoftener',
    'root@host is only terminal context',
    'Execution evidence:',
    'collectTopServerRisks(servers, eventRisk, aiRiskResultLimit)',
    'summarizeOpenEventRisk(openEvents)',
    'formatOpenEventsForLocalAnswer(openEvents)',
    'const serverIds = selectedServer ? [selectedServer.id] : []',
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
    'aiExecutionCopyByLanguage',
    'handleExecuteAiPlan',
    'aiTaskDecision',
    "useState<'allow' | 'cancel'>('cancel')",
    "executionPlan?.requiresConfirmation ? 'cancel' : 'allow'",
    'aiTaskReason',
    'formatExecutionCommand(executionPlan)',
    'className="risk"',
    'Confirmation required',
    'confirmationReasonLabel',
    'executionPlan.confirmationReason',
    'ai-execution-choice-group',
    'preflightOperationTask(payload)',
    'createOperationTask({',
    'appendExecutionEvidenceMessage(sessionId, result',
    'buildExecutionEvidenceMessage(result',
    'Execution evidence:',
    'ai-execution-card',
    'message.status === \'cached\'',
    'cachedResult.answer',
    'meta: analysisToMessageMeta(result)',
    'const serverById = useMemo(() => new Map(servers.map((server) => [server.id, server])), [servers])',
    'const selectedServer = serverById.get(activeSession.selectedServerId)',
    'return changed ? next : current',
    'collapsed ? \'\' : buildOpsPrompt(selectedServers, events)',
    'if (session.selectedServerId === \'all\' || serverById.has(session.selectedServerId))',
    'serverById.get(serverId)?.name ?? serverId',
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
    'executionPlan?: AiExecutionPlan',
    'requiresConfirmation?: boolean',
    'confirmationReason?: string',
  ];
  const missingApi = apiFragments.filter((fragment) => !apiClientSource.includes(fragment));
  if (missingApi.length) {
    throw new Error(`AI client force-refresh support is incomplete: ${missingApi.join(', ')}`);
  }

  const promptFragments = [
    'Current CoLiPas Cloud Server Management Panel operations context',
    'Use this context only when it is relevant to the user question',
    'Do not invent servers',
    'Large inventories are summarized',
    'promptServerSampleLimit',
    'insertTopServer(highLoadServers',
    'topCountGroups(providerCounts',
    'Server inventory:',
    'High-load servers:',
    'Open operation/security events:',
  ];
  const missingPrompt = promptFragments.filter((fragment) => !promptSource.includes(fragment));
  if (missingPrompt.length) {
    throw new Error(`AI prompt grounding is incomplete: ${missingPrompt.join(', ')}`);
  }
  if (promptSource.includes('servers.map((server) => [') || promptSource.includes('.sort((a, b) => Math.max(b.cpu')) {
    throw new Error('AI prompt builder must summarize large inventories instead of rendering or sorting every server');
  }
  if (aiServiceSource.includes('connectedTargets.map((server) => server.id)')) {
    throw new Error('AI execution plans must not serialize every connected server id for allConnected targets');
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
  const performanceFragments = [
    'const serverCountsByProvider = useMemo(() => countServersByProvider(servers), [servers])',
    'function countServersByProvider(servers: ServerNode[])',
    'serverCountsByProvider.get(account.provider) ?? 0',
  ];
  const missingPerformance = performanceFragments.filter((fragment) => !cloudSource.includes(fragment));
  if (missingPerformance.length) {
    throw new Error(`Cloud accounts server count derivation must stay single-pass: ${missingPerformance.join(', ')}`);
  }
  if (cloudSource.includes('servers.filter((server) => server.provider === account.provider).length')) {
    throw new Error('Cloud account cards must not rescan the full server list per account');
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
    'grid-template-columns: minmax(0, 1fr)',
    'width: min(448px, calc(100vw - 288px))',
    'height: min(660px, calc(100vh - 88px))',
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

function assertSessionCookieSecurityGuards() {
  const configSource = fs.readFileSync(new URL('../src/server/config.ts', import.meta.url), 'utf8');
  const authSource = fs.readFileSync(new URL('../src/server/services/authService.ts', import.meta.url), 'utf8');
  const requiredFragments = [
    'COLIPAS_SECURE_COOKIES',
    "parsed.RELEASE_PUBLIC_URL.toLowerCase().startsWith('https://')",
    'secureCookies:',
    'secure: config.auth.secureCookies',
  ];
  const sources = `${configSource}\n${authSource}`;
  const missing = requiredFragments.filter((fragment) => !sources.includes(fragment));
  if (missing.length) {
    throw new Error(`Session cookie security guard is incomplete: ${missing.join(', ')}`);
  }

  const insecureFragments = [
    "secure: config.nodeEnv === 'production' && process.env.COLIPAS_SECURE_COOKIES === '1'",
    "secure: process.env.COLIPAS_SECURE_COOKIES === '1'",
  ];
  const insecure = insecureFragments.filter((fragment) => authSource.includes(fragment));
  if (insecure.length) {
    throw new Error(`Session cookie Secure flag must not depend only on manual env toggles: ${insecure.join(', ')}`);
  }

  console.log('ok session cookies auto-enable Secure for HTTPS production URLs');
}

function assertSqlitePersistenceGuards() {
  const databaseSource = fs.readFileSync(new URL('../src/server/services/database.ts', import.meta.url), 'utf8');
  const inventoryServiceSource = fs.readFileSync(new URL('../src/server/services/inventoryService.ts', import.meta.url), 'utf8');
  const auditServiceSource = fs.readFileSync(new URL('../src/server/services/auditService.ts', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
  const sshAccessSource = fs.readFileSync(new URL('../src/server/services/sshAccessService.ts', import.meta.url), 'utf8');
  const diagnosticServiceSource = fs.readFileSync(new URL('../src/server/services/diagnosticService.ts', import.meta.url), 'utf8');
  const releaseVerificationSource = fs.readFileSync(new URL('../src/server/services/releaseVerificationService.ts', import.meta.url), 'utf8');
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
    'export function upsertServerRow',
    'export function deleteServerRow',
    'export function upsertCredentialRow',
    'export function deleteCredentialRow',
    'export function insertAuditRow',
    'DELETE FROM audit_entries',
    'LIMIT 200',
    'upsertServerRow(server)',
    'insertAuditRow(latestEntry)',
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
  const overviewMetricGuardFragments = [
    'serverMetricsCacheTtlMs',
    'serverMetricsFailureBackoffMs',
    'serverMetricsConcurrency',
    'serverMetricsRefreshBudgetMs',
    'metricsRefreshInFlight',
    'shouldRefreshServerMetrics',
    'runWithConcurrency(staleServers, serverMetricsConcurrency, refreshSingleServerMetrics)',
    'await Promise.race([',
  ];
  const missingOverviewMetricGuardFragments = overviewMetricGuardFragments.filter((fragment) => !inventoryServiceSource.includes(fragment));
  if (missingOverviewMetricGuardFragments.length) {
    throw new Error(`Overview SSH metric refresh must be cached, bounded, and non-blocking: ${missingOverviewMetricGuardFragments.join(', ')}`);
  }
  if (/Promise\.all\(\s*servers\.map[\s\S]*collectSshMetrics/.test(inventoryServiceSource)) {
    throw new Error('Overview metric refresh must not collect SSH metrics for every server with unbounded Promise.all');
  }

  const sshMetricFragments = [
    'sleep 0.5',
    'normalizeLiveCpuMetric(values.cpu, hasCpuSample)',
    'hasCpuSample && clamped < 1',
  ];
  const missingSshMetricFragments = sshMetricFragments.filter((fragment) => !sshAccessSource.includes(fragment));
  if (missingSshMetricFragments.length) {
    throw new Error(`SSH live CPU metric guard is incomplete: ${missingSshMetricFragments.join(', ')}`);
  }

  const inventorySummaryFragments = [
    'export function summarizeServerInventory',
    'export function buildServerInventorySnapshot',
    'export function countOpenOperationEvents',
    'const inventory = buildServerInventorySnapshot()',
    'connectedSsh: inventory.summary.sshConnected',
    'avgCpu: inventory.summary.avgCpu',
    'busiestServer: inventory.summary.busiestServer',
    'const inventorySummary = summarizeServerInventory()',
  ];
  const inventorySummarySource = `${inventoryServiceSource}\n${appSource}\n${diagnosticServiceSource}\n${releaseVerificationSource}`;
  const missingInventorySummaryFragments = inventorySummaryFragments.filter((fragment) => !inventorySummarySource.includes(fragment));
  if (missingInventorySummaryFragments.length) {
    throw new Error(`Inventory summary fast path is incomplete: ${missingInventorySummaryFragments.join(', ')}`);
  }
  if (appSource.includes("servers.filter((server) => resolveServerLifecycleStatus(server) === 'running')")) {
    throw new Error('/api/overview must use the shared inventory summary instead of rescanning server status');
  }
  if (diagnosticServiceSource.includes('listServers({})') || releaseVerificationSource.includes('listServers({})')) {
    throw new Error('Diagnostic and release evidence paths must use summarized inventory metrics');
  }
  const paginationFastPathFragments = [
    'buildServerFilterMatcher(filters)',
    'collectServerPageWithTotal(snapshot.items, matcher, pagination)',
    'page = {\n        total: page.total,\n        items: collectServerPage(snapshot.items, matcher, pagination),',
    'function hasServerPagination(query: Record<string, unknown>)',
  ];
  const missingPaginationFastPathFragments = paginationFastPathFragments.filter((fragment) => !inventoryServiceSource.includes(fragment));
  if (missingPaginationFastPathFragments.length) {
    throw new Error(`Server inventory pagination fast path is incomplete: ${missingPaginationFastPathFragments.join(', ')}`);
  }
  if (inventoryServiceSource.includes('filteredItems.slice(pagination.offset')) {
    throw new Error('Paginated server inventory must not allocate the full filtered result before slicing');
  }
  const serverIndexFragments = [
    'const serverById = new Map<string, ServerNode>()',
    'const serverByName = new Map<string, ServerNode>()',
    'const serverByPublicIp = new Map<string, ServerNode>()',
    'export function getServerById(serverId: string)',
    'findExistingServerByIdentity(parsed.name, parsed.publicIp)',
    'rebuildServerIndexes()',
    'indexServer(server)',
    'unindexServer(server)',
    'const server = getServerById(serverId)',
  ];
  const missingServerIndexFragments = serverIndexFragments.filter((fragment) => !inventoryServiceSource.includes(fragment));
  if (missingServerIndexFragments.length) {
    throw new Error(`Server lookup index guard is incomplete: ${missingServerIndexFragments.join(', ')}`);
  }
  if (inventoryServiceSource.includes('servers.find((item) => item.id === serverId)')) {
    throw new Error('Server id lookups must use the indexed getServerById path');
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
    'overview.summary.connectedSsh',
    'overview.summary.avgCpu',
    'overview.summary.busiestServer',
    "activeSection === 'servers' ? filterServers(overview.servers, filters) : []",
    "if (filters.region === 'all' && !(filters.regionScope?.length))",
  ];
  const missingFrontend = frontendRequired.filter((fragment) => !frontendSource.includes(fragment));
  if (missingFrontend.length) {
    throw new Error(`Overview auto-refresh concurrency guard is incomplete: ${missingFrontend.join(', ')}`);
  }

  console.log('ok SQLite persistence layer stores structural data without churn from health, identity inspect, or overview polling');
}

function assertRepositoryIgnoreGuards() {
  const gitignoreSource = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  const dockerignoreSource = fs.readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');
  const requiredGitignore = [
    '.env',
    '.env.*',
    '!.env.example',
    '.data/',
    '.tmp-verify-data/',
    'output/',
    '*.log',
    '*.sqlite',
    '*.sqlite-*',
    '*.db',
    '*.db-*',
    'release-targets.local.json',
    'release-targets*.local.json',
  ];
  const requiredDockerignore = [
    '.env',
    '.env.*',
    '!.env.example',
    '.data',
    '.tmp-verify-data',
    'output',
    '*.log',
    '*.sqlite',
    '*.sqlite-*',
    '*.db',
    '*.db-*',
    'release-targets.local.json',
  ];
  const missingGitignore = requiredGitignore.filter((fragment) => !gitignoreSource.includes(fragment));
  const missingDockerignore = requiredDockerignore.filter((fragment) => !dockerignoreSource.includes(fragment));
  if (missingGitignore.length || missingDockerignore.length) {
    throw new Error(
      `Repository ignore guards are incomplete: gitignore=${missingGitignore.join(', ') || 'ok'} dockerignore=${missingDockerignore.join(', ') || 'ok'}`,
    );
  }

  console.log('ok repository and Docker build contexts exclude secrets, runtime data, logs, and local release config');
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

function assertStandalonePerformanceCheckGuards() {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const performanceSource = fs.readFileSync(new URL('../scripts/performance-check.mjs', import.meta.url), 'utf8');
  const requiredFragments = [
    'const explicitBaseUrl = process.env.PERF_BASE_URL',
    'if (!baseUrl) {',
    'startLocalServer(port, baseUrl)',
    'COLIPAS_DATA_DIR: tempDataDir',
    'waitForLocalHealth(targetBaseUrl, child',
    'fs.rmSync(tempDataDir',
    'getAvailablePort(Number(process.env.PERF_PORT ?? 18080))',
  ];
  const missing = requiredFragments.filter((fragment) => !performanceSource.includes(fragment));
  if (packageJson.scripts?.perf !== 'npm run build && node scripts/performance-check.mjs' || missing.length) {
    throw new Error(`Standalone performance check guard is incomplete: ${missing.join(', ') || 'package script'}`);
  }

  console.log('ok standalone performance check starts an isolated local server');
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

function assertInteractiveDeployDocsAndScriptGuards() {
  const installerSource = fs.readFileSync(new URL('../scripts/one-click-deploy.sh', import.meta.url), 'utf8');
  const readmeSource = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const cnReadmeSource = fs.readFileSync(new URL('../README_CN.md', import.meta.url), 'utf8');
  const jpReadmeSource = fs.readFileSync(new URL('../README_JP.md', import.meta.url), 'utf8');
  const installerRequired = [
    'CoLiPas cloud server management panel interactive deployment',
    'COLIPAS_DRY_RUN',
    'COLIPAS_NON_INTERACTIVE',
    'COLIPAS_TTY',
    'choose_mode',
    'Existing .env found; keeping current secrets and runtime settings.',
    'Dry run complete. No packages installed, files changed, or services started.',
    'COLIPAS_ASSUME_YES=1',
    'Initial admin password, leave blank to generate one',
    'ADMIN_PASSWORD_GENERATED=0',
    'Initial password: provided by installer input; not printed again.',
  ];
  const missingInstaller = installerRequired.filter((fragment) => !installerSource.includes(fragment));
  if (missingInstaller.length) {
    throw new Error(`Interactive deploy script guard is incomplete: ${missingInstaller.join(', ')}`);
  }

  const docs = [
    ['README.md', readmeSource, 'Docker One-Command Deploy', 'Native Linux + systemd One-Command Deploy', 'Deployment users only run the installer or Compose workflow'],
    ['README_CN.md', cnReadmeSource, 'Docker 一键部署', '原生 Linux + systemd 一键部署', '部署用户只需要运行下面的一键脚本'],
    ['README_JP.md', jpReadmeSource, 'Docker ワンコマンドデプロイ', 'ネイティブ Linux + systemd ワンコマンドデプロイ', '下のワンコマンドスクリプトを実行するだけ'],
  ];
  for (const [name, source, dockerPhrase, nativePhrase, noPublishMessage] of docs) {
    if (
      !source.includes(dockerPhrase)
      || !source.includes(nativePhrase)
      || !source.includes('one-click-deploy.sh | sudo env \\')
      || !source.includes('COLIPAS_DEPLOY_MODE=docker')
      || !source.includes('COLIPAS_DEPLOY_MODE=native')
      || !source.includes('  bash')
      || !source.includes('COLIPAS_ASSUME_YES=1')
      || !source.includes(noPublishMessage)
      || source.includes('docker pull heiyue797/colipas:latest')
      || source.includes('docker pull ghcr.io/nmklio/colipas:latest')
    ) {
      throw new Error(`${name} must keep Docker and native Linux one-command deploy paths`);
    }
  }

  const docsMustExplainPasswordOutput = [
    ['README.md', readmeSource, 'does not print it again in the terminal output'],
    ['README_CN.md', cnReadmeSource, '不会在部署结束时再次打印'],
    ['README_JP.md', jpReadmeSource, 'デプロイ完了時に再表示されません'],
  ];
  for (const [name, source, phrase] of docsMustExplainPasswordOutput) {
    if (!source.includes(phrase)) {
      throw new Error(`${name} must explain that provided installer passwords are not printed again`);
    }
  }

  const forbiddenVisibleCopy = [
    'ChangeThisStrongPassword123',
    'NewStrongPassword123',
    'admin123456',
    '不要把真实密码写进公开仓库或截图',
    '公开仓库或截图',
    'CoLiPas云服务器管理面板面向',
    '截图里的真实资产',
    '类 VNC',
    '乱填',
    '云维',
    '当作正式服务',
    '登录控制台',
    '开发者改代码后再上线',
    '演示后台',
    '演示登录',
    '默认演示密码',
    '是不是固定',
    '备用模型',
    '每个模块都不是摆设',
    '排障时先看这里',
    '便于别人下载后部署',
  ];
  const visibleCopySources = [
    ['README.md', readmeSource],
    ['README_CN.md', cnReadmeSource],
    ['README_JP.md', jpReadmeSource],
    ['DocsPage.tsx', fs.readFileSync(new URL('../src/app/DocsPage.tsx', import.meta.url), 'utf8')],
    ['MarketingPage.tsx', fs.readFileSync(new URL('../src/app/MarketingPage.tsx', import.meta.url), 'utf8')],
    ['server-update.sh', fs.readFileSync(new URL('../deploy/server-update.sh', import.meta.url), 'utf8')],
  ];
  for (const [name, source] of visibleCopySources) {
    const badPhrase = forbiddenVisibleCopy.find((phrase) => source.includes(phrase));
    if (badPhrase) {
      throw new Error(`${name} contains unpolished visible copy: ${badPhrase}`);
    }
  }

  console.log('ok Docker and native Linux one-command deploy docs are guarded');
}

function assertContainerRegistryPublishGuards() {
  const workflowSource = fs.readFileSync(new URL('../.github/workflows/docker-publish.yml', import.meta.url), 'utf8');
  const readmeSource = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const cnReadmeSource = fs.readFileSync(new URL('../README_CN.md', import.meta.url), 'utf8');
  const jpReadmeSource = fs.readFileSync(new URL('../README_JP.md', import.meta.url), 'utf8');
  const requiredWorkflow = [
    'name: docker-publish',
    'packages: write',
    'ghcr.io/${{ github.repository_owner }}/colipas',
    'docker.io/heiyue797/colipas',
    'docker/login-action@v3',
    'docker/metadata-action@v5',
    'docker/build-push-action@v6',
    'push: true',
    'RELEASE_GIT_COMMIT=${{ github.sha }}',
    'type=sha,prefix=sha-,format=short',
  ];
  const missingWorkflow = requiredWorkflow.filter((fragment) => !workflowSource.includes(fragment));
  if (missingWorkflow.length) {
    throw new Error(`Docker registry publish workflow is incomplete: ${missingWorkflow.join(', ')}`);
  }

  const docs = [
    ['README.md', readmeSource, 'Docker One-Command Deploy', 'Native Linux + systemd One-Command Deploy', 'Deployment users only run the installer or Compose workflow'],
    ['README_CN.md', cnReadmeSource, 'Docker 一键部署', '原生 Linux + systemd 一键部署', '部署用户只需要运行下面的一键脚本'],
    ['README_JP.md', jpReadmeSource, 'Docker ワンコマンドデプロイ', 'ネイティブ Linux + systemd ワンコマンドデプロイ', '下のワンコマンドスクリプトを実行するだけ'],
  ];
  for (const [name, source, heading, nativeHeading, noPublishMessage] of docs) {
    const confusingPublishingPhrases = [
      'Every `master` push publishes',
      '每次推送到 `master`',
      '`master` に push されるたび',
    ];
    if (
      !source.includes(heading)
      || !source.includes(nativeHeading)
      || !source.includes('one-click-deploy.sh')
      || !source.includes('COLIPAS_DEPLOY_MODE=docker')
      || !source.includes('COLIPAS_DEPLOY_MODE=native')
      || !source.includes(noPublishMessage)
    ) {
      throw new Error(`${name} must document Docker one-command deploy without asking users to publish images`);
    }
    const confusingPhrase = confusingPublishingPhrases.find((fragment) => source.includes(fragment));
    if (confusingPhrase) {
      throw new Error(`${name} must keep Docker deployment docs user-facing; confusing publisher phrase found: ${confusingPhrase}`);
    }
  }

  console.log('ok Docker one-command deploy and registry image usage are guarded');
}

async function assertReleaseDeployTargetPlanGuards() {
  const { spawnSync } = await import('node:child_process');
  const releaseDeploySource = fs.readFileSync(new URL('../scripts/release-deploy.ps1', import.meta.url), 'utf8');
  if (!releaseDeploySource.includes('function Get-GitCommitTreeSha')) {
    throw new Error('Release deploy fallback must centralize git tree lookup');
  }
  if (!releaseDeploySource.includes('git show -s --format=%T $Revision')) {
    throw new Error('Release deploy fallback must use shell-stable git tree lookup');
  }
  if (/rev-parse\s+"[^"]*\^\{tree\}"/.test(releaseDeploySource)) {
    throw new Error('Release deploy fallback must not depend on PowerShell-sensitive ^{tree} rev parsing');
  }
  if (
    !releaseDeploySource.includes('function Get-GitBlobContentBase64')
    || !releaseDeploySource.includes('git cat-file blob $BlobSha')
    || releaseDeploySource.includes('[IO.File]::ReadAllBytes($localPath)')
  ) {
    throw new Error('Release deploy API fallback must upload committed git blob bytes, not CRLF-normalized working-tree files');
  }
  const termarkDeployFragments = [
    'termarkAssetId',
    'termarkTimeoutSeconds',
    'Require-Command "termark"',
    'termark exec $Target.termarkAssetId --stdin --timeout $timeoutSeconds',
    'COLIPAS_TERMARK_SELFTEST_CAPTURE',
  ];
  const missingTermarkDeploy = termarkDeployFragments.filter((fragment) => !releaseDeploySource.includes(fragment));
  if (missingTermarkDeploy.length) {
    throw new Error(`Release deploy Termark routing is incomplete: ${missingTermarkDeploy.join(', ')}`);
  }

  const plan = {
    targets: [
      {
        name: 'systemd-primary',
        host: 'colipas-prod',
        user: 'colipas-deploy',
        command: 'sudo /usr/local/sbin/colipas-update',
        sshKey: '~/.ssh/colipas_deploy_rsa',
        publicBaseUrl: 'https://colipas.example.com',
        publicMode: 'public',
        deploymentMode: 'systemd',
      },
      {
        name: 'docker-secondary',
        host: 'colipas-cp',
        user: 'root',
        command: 'sudo /usr/local/sbin/colipas-cp-update',
        sshKey: '~/.ssh/colipas_deploy_rsa',
        publicBaseUrl: 'https://cp.example.com',
        publicMode: 'admin',
        deploymentMode: 'docker',
      },
      {
        name: 'disabled-extra',
        enabled: false,
        host: 'unused-alias',
        user: 'root',
        command: 'sudo unused',
      },
    ],
  };
  const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
  const result = spawnSync(shell, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'scripts/release-deploy.ps1',
    '-PlanOnly',
    '-TargetsJson',
    JSON.stringify(plan),
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`Release deploy plan guard failed: ${result.stderr || result.stdout}`);
  }

  const parsed = JSON.parse(result.stdout.trim());
  const targets = Array.isArray(parsed) ? parsed : [parsed];
  if (targets.length !== 2) {
    throw new Error(`Release deploy plan should include two enabled targets, got ${targets.length}`);
  }
  if (
    targets[0].host !== 'colipas-prod'
    || targets[1].host !== 'colipas-cp'
    || targets[1].command !== 'sudo /usr/local/sbin/colipas-cp-update'
    || targets[0].deploymentMode !== 'systemd'
    || targets[1].deploymentMode !== 'docker'
    || targets.some((target) => Object.hasOwn(target, 'enabled'))
    || targets.some((target) => /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(JSON.stringify(target)))
  ) {
    throw new Error('Release deploy plan did not preserve sanitized multi-target routing');
  }

  const selfTest = spawnSync(shell, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'scripts/release-deploy.ps1',
    '-SelfTest',
    '-TargetsJson',
    JSON.stringify({ targets: [{ name: 'selftest', host: 'mock-host', user: 'mock-user', command: 'mock-command' }] }),
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  if (
    selfTest.status !== 0
    || !selfTest.stdout.includes('ok release deploy GitHub API JSON fallback uses BOM-free temp-file input')
    || !selfTest.stdout.includes('ok release deploy continues updating healthy targets and reports partial failures')
  ) {
    throw new Error(`Release deploy GitHub API fallback self-test failed: ${selfTest.stderr || selfTest.stdout}`);
  }

  console.log('ok release deploy supports sanitized multi-target publish plans, API fallback, and partial-failure isolation self-tests');
}

function assertOverviewMapInteractionGuards() {
  const overviewSource = fs.readFileSync(new URL('../src/modules/overview/MonitoringOverview.tsx', import.meta.url), 'utf8');
  const requiredFragments = [
    'moved: boolean',
    'suppressMapClickRef.current = drag.moved',
    'Math.hypot(deltaX, deltaY) > 5',
    'const tooltipServerNameLimit = 6',
    'serverNames: []',
    'if (group.serverNames.length < tooltipServerNameLimit)',
    'function collectTooltipServerNames(regions: RegionNode[])',
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
    "import { formatCountryName, formatRegionName, percentClass, statusLabel } from '../../utils/format'",
    'const regionName = (region: string) => formatRegionName(region, language)',
    'aria-label={`${t(\'overview.focusRegion\')}: ${regionName(region.region)}`}',
    'onClick={() => focusRegion(region)}',
    'function buildRegionHover(region: RegionNode, formatRegion: (region: string) => string): CountryHover',
    'setPinnedCountry(buildRegionHover(region, regionName))',
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
    'providerCount, busiestServers } = overviewStats',
    'providerCount: providers.size',
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
    'const mapCountryShapes: MapCountryShape[] = countries.features.map',
    "path: mapPath(typedCountry) ?? ''",
    'centroid: [centroid[0], centroid[1]]',
    '{mapCountryShapes.map((country) =>',
    'd={country.path}',
    'country.centroid[0]',
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
  if (overviewSource.includes('serverNames: items.map((server) => server.name)') || overviewSource.includes('regions.flatMap((region) => region.serverNames)')) {
    throw new Error('Overview map tooltip must not retain every server name for large inventories');
  }
  if (overviewSource.includes('new Set(servers.map((server) => server.provider)).size')) {
    throw new Error('Overview provider count must reuse single-pass stats instead of rescanning during render');
  }
  if (overviewSource.includes('{countries.features.map((country) =>') || overviewSource.includes('const path = mapPath(country as Feature<Geometry>)')) {
    throw new Error('Overview map must precompute country SVG paths instead of recalculating them during React render');
  }
  if (overviewSource.includes('const center = mapPath.centroid(country);')) {
    throw new Error('Overview map must reuse precomputed country centroids for hover anchors');
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
    'margin-bottom: 0',
    '.content:not(.ai-collapsed) .map-controls',
    'position: absolute',
    'z-index: 9',
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
    "navigateToSection('servers')",
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
    'const hasScopedRegionFilter = scopedRegions.size > 0',
    "const hasSelectedRegionFilter = !hasScopedRegionFilter && filters.region !== 'all'",
    'const serverRegion = normalizeFilterValue(server.region)',
    'hasScopedRegionFilter || hasSelectedRegionFilter',
    'scopedRegions.has(serverRegion)',
    'serverRegion !== selectedRegion',
    'function normalizeFilterValue(value: string)',
    'const serverSearchTextCache = new WeakMap',
    'function getServerSearchText(server: ServerNode)',
    '!getServerSearchText(server).includes(query)',
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
    'const regions = useMemo(() => buildSortedRegions(allServers), [allServers])',
    'const scopedRegions = useMemo(() => normalizeScopedRegions(filters.regionScope), [filters.regionScope])',
    'const visibleConnectedServerCount = useMemo(() => countConnectedServers(servers), [servers])',
    'const visibleSummary = useMemo(() => {',
    'const providers = new Set<string>()',
    'const serverRegions = new Set<string>()',
    'const visibleMaxLoadServer = visibleSummary.maxLoadServer',
    'const visibleProviderCount = visibleSummary.providerCount',
    'const visibleRegionCount = visibleSummary.regionCount',
    'const visibleAvgLoad = visibleSummary.avgLoad',
    'servers.mapRegionScope',
    'servers.clearRegionScope',
    'scopedRegions.length > 0',
    'regionScope: undefined',
    'function buildSortedRegions(servers: ServerNode[])',
    'function normalizeScopedRegions(regions: string[] | undefined)',
    'function countConnectedServers(servers: ServerNode[])',
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
  const globalCss = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  const i18nSource = fs.readFileSync(new URL('../src/i18n.tsx', import.meta.url), 'utf8');

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

  const requiredTraceFragments = [
    'onAuditTraceOpen?: (correlationId: string) => void',
    'const [lastActionTraceId, setLastActionTraceId] = useState(\'\')',
    '{ traceId: result.correlationId }',
    'setLastActionTraceId(options.traceId ?? \'\')',
    'onAuditTraceOpen?.(lastActionTraceId)',
    "t('common.viewTrace')",
    'action-trace-box',
    'inline-trace-button',
  ];
  const missingTrace = requiredTraceFragments.filter((fragment) => !inventorySource.includes(fragment));
  if (missingTrace.length) {
    throw new Error(`Server action audit trace navigation is incomplete: ${missingTrace.join(', ')}`);
  }

  const traceCssFragments = ['.action-trace-box', '.inline-trace-button'];
  const missingTraceCss = traceCssFragments.filter((fragment) => !globalCss.includes(fragment));
  if (missingTraceCss.length) {
    throw new Error(`Server action audit trace CSS is incomplete: ${missingTraceCss.join(', ')}`);
  }

  const viewTraceI18nCount = (i18nSource.match(/common\.viewTrace/g) ?? []).length;
  if (viewTraceI18nCount < 3) {
    throw new Error('Common audit trace navigation i18n key is missing languages');
  }

  console.log('ok server lifecycle status maps SSH access to running/unconnected and power actions to stopped/running');
}

function assertSshTerminalRealtimeGuards() {
  const inventorySource = fs.readFileSync(new URL('../src/modules/servers/ServerInventory.tsx', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
  const sshServiceSource = fs.readFileSync(new URL('../src/server/services/sshAccessService.ts', import.meta.url), 'utf8');
  const sshSocketSource = fs.readFileSync(new URL('../src/server/sshShellSocket.ts', import.meta.url), 'utf8');
  const apiClientSource = fs.readFileSync(new URL('../src/services/apiClient.ts', import.meta.url), 'utf8');
  const redactionSource = fs.readFileSync(new URL('../src/server/services/sensitiveRedaction.ts', import.meta.url), 'utf8');
  const globalCssSource = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  const viteSource = fs.readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

  const requiredFrontendFragments = [
    "import type { Terminal as XTerm",
    "import type { FitAddon } from '@xterm/addon-fit'",
    "import('@xterm/xterm')",
    "import('@xterm/addon-fit')",
    "import('@xterm/xterm/css/xterm.css?inline')",
    'injectTerminalCss(xtermCss.default)',
    "document.getElementById('colipas-xterm-css')",
    'openServerShell(server.id, getTerminalDimensions())',
    'streamServerShell(',
    'connectServerShellSocket(',
    'queueTerminalWrite(terminal, event.content)',
    'function flushTerminalWriteBuffer(',
    'terminalWriteBaseChunkSize',
    'terminalWriteLargeChunkSize',
    'const terminalWriteLargeBacklogThreshold = 64 * 1024',
    'const terminalWriteImmediateThreshold = 256',
    'const terminalCompatibleInputFlushMs = 4',
    'const terminalRuntimePrefetchDelayMs = 250',
    'const terminalNetworkUiRefreshMs = 900',
    'void loadTerminalRuntime()',
    'getTerminalWriteChunkSize(content.length)',
    'window.requestAnimationFrame',
    'terminalWriteBufferRef.current.length <= terminalWriteImmediateThreshold',
    'xtermRef.current?.onData((data) => {',
    'queueTerminalInput(sessionId, data)',
    'function flushTerminalInput(',
    'terminalInputChainRef.current',
    'terminalInputInFlightRef',
    'terminalInputFlushAgainRef',
    'terminalNetworkRenderedRef',
    'shouldRenderTerminalNetworkStats(renderedStats, nextStats, now',
    'function shouldRenderTerminalNetworkStats(',
    'terminalNetworkDisplayKey(renderedStats) === terminalNetworkDisplayKey(nextStats)',
    'function clearTerminalNetworkStats()',
    'const allServersById = useMemo(() => buildServerById(allServers), [allServers])',
    'allServersById.get(sshPanelServerId)',
    'function buildServerById(servers: ServerNode[])',
    "terminalShellSocketRef.current.sendInput(data)",
    'function interruptTerminalCommand()',
    "sendTerminalInput(sessionId, '\\u0003')",
    'fetchServerShellStatus',
    'activeShellCount',
    'servers.activeShellSessionsShort',
    'refreshShellStatus',
    'const [terminalShellId, setTerminalShellId]',
    'terminalLifecycleSeqRef.current += 1',
    'isCurrentTerminalLifecycle(server.id, lifecycleSeq)',
    'closeServerShell(shell.sessionId).catch(() => undefined)',
    'pushTerminalResize(terminalShellIdRef.current, getTerminalDimensions())',
    'terminalShellTransportRef.current === \'websocket\' && terminalShellSocketRef.current',
    'function closeSshConsole()',
    'setSshConsoleOpen(false)',
    'setSshPanelServerId(\'\')',
    'setLoginProbe(null)',
    'setSshRunning(false)',
    'setSshInterrupting(false)',
    "showActionMessage(t('servers.sshDisconnectedMessage'",
    'terminalShellServerIdRef.current',
    'terminalDataSubscriptionRef.current?.dispose()',
    'terminalResizeObserverRef.current',
    'terminalShellStreamRef.current?.close()',
    'const canOpenTerminal = connected',
    'function copyTerminalOutput()',
    'terminal.getSelection()',
    'getVisibleTerminalText(terminal)',
    'function clearTerminalOutput()',
    'terminal.clear()',
  ];
  const missingFrontend = requiredFrontendFragments.filter((fragment) => !inventorySource.includes(fragment));
  if (missingFrontend.length) {
    throw new Error(`SSH terminal realtime frontend guard is incomplete: ${missingFrontend.join(', ')}`);
  }

  if (inventorySource.includes('disabled={sshRunning}')) {
    throw new Error('SSH terminal input must remain usable while the remote process is running');
  }
  if (inventorySource.includes('ssh-terminal-input-line') || inventorySource.includes('normalizeInteractiveCommand')) {
    throw new Error('SSH terminal must not use a command-submit input or rewrite interactive command text');
  }
  if (inventorySource.includes('function updateTerminalNetworkStats(metrics: ServerShellSocketMetrics) {\n    setTerminalNetworkStats({')) {
    throw new Error('SSH terminal network telemetry must be throttled before touching React state');
  }
  if (inventorySource.includes('allServers.find((server) => server.id === sshPanelServerId)')) {
    throw new Error('SSH terminal active server lookup must use an indexed Map for large inventories');
  }
  const requiredToolLabels = [
    'servers.terminalTools',
    'servers.copyTerminalOutput',
    'servers.clearTerminalOutput',
    'servers.terminalCopied',
    'servers.terminalCleared',
    'servers.disconnectSsh',
    'servers.sshDisconnectedMessage',
    'servers.sendCtrlC',
    'servers.sshInterrupting',
    'servers.sshInterruptSent',
    'servers.sshInterruptUnavailable',
    'servers.activeShellSessions',
    'servers.activeShellSessionsShort',
  ];
  const missingToolLabels = requiredToolLabels.filter((key) => !inventorySource.includes(key) || !fs.readFileSync(new URL('../src/i18n.tsx', import.meta.url), 'utf8').includes(key));
  if (missingToolLabels.length) {
    throw new Error(`SSH terminal tool i18n or UI wiring is incomplete: ${missingToolLabels.join(', ')}`);
  }
  const closeSshConsoleMatch = inventorySource.match(/function closeSshConsole\(\)\s*\{(?<body>[\s\S]+?)\n  \}\n\n  async function startTerminalLogin/);
  if (!closeSshConsoleMatch?.groups?.body?.includes('setSshConsoleOpen(false)')) {
    throw new Error('SSH terminal close handler must hide the modal');
  }
  if (!closeSshConsoleMatch.groups.body.includes('closeActiveShellSession()') || !closeSshConsoleMatch.groups.body.includes('disposeXterm()')) {
    throw new Error('Closing the SSH panel must disconnect the active shell and dispose xterm');
  }
  if (!viteSource.includes("return 'vendor-terminal'")) {
    throw new Error('xterm runtime must stay in a separate terminal chunk');
  }

  const requiredBackendFragments = [
    'client.shell({',
    "term: 'xterm-256color'",
    'activeSshShellSessions',
    'emitSshShellEvent(session, { type: \'stdout\'',
    "command === 'colipas-long-output'",
    "command === 'colipas-hang'",
    "let inputBuffer = ''",
    "for (const char of input)",
    "runSimulatedShellCommand(shell, command",
    "input.includes('\\u0003')",
    "content: `^C\\r\\n${simulatedShellPrompt}`",
    'stream.setWindow(rows, cols',
    'content: chunk.toString(\'utf8\')',
    'content: event.content',
    'sshShellIdleTimeoutMs',
    'const sshShellEvidencePruneIntervalMs = 60 * 1000',
    'let lastSshShellEvidencePruneAt = 0',
    'function maybePruneRecentSshShellEvidence()',
    'if (session.history.length > sshShellHistoryLimit)',
    'if (record.events.length > sshShellEvidenceLimit)',
    'export function getSshShellSessionStats',
    'oldestConnectedAt',
    'newestConnectedAt',
  ];
  const missingBackend = requiredBackendFragments.filter((fragment) => !sshServiceSource.includes(fragment));
  if (missingBackend.length) {
    throw new Error(`SSH shell PTY backend guard is incomplete: ${missingBackend.join(', ')}`);
  }

  const requiredApiFragments = [
    "app.post('/api/servers/shells'",
    "app.get('/api/servers/shells/status'",
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
    'export async function resizeServerShell',
    'export async function closeServerShell',
    'export async function fetchServerShellStatus',
    'const shellSocketInputFlushMs = 2',
    'const shellSocketInputChunkSize = 8000',
    'input.includes(\'\\u0003\')',
    'window.setTimeout(flushInput, shellSocketInputFlushMs)',
    'flushInput();',
  ];
  const missingClient = requiredClientFragments.filter((fragment) => !apiClientSource.includes(fragment));
  if (missingClient.length) {
    throw new Error(`SSH shell API client guard is incomplete: ${missingClient.join(', ')}`);
  }

  const socketRequired = [
    "new WebSocketServer({",
    "if (path !== '/api/servers/shells/ws')",
    'bindSshShellSocket(webSocket)',
    "type: 'ready'",
    "type: 'open'",
    "type: 'close'",
    'getCurrentSession(request as Parameters<typeof getCurrentSession>[0], config)',
    'tuneUpgradeSocket(socket)',
    'tcpSocket.setNoDelay?.(true)',
    'tcpSocket.setKeepAlive?.(true, 10000)',
    'closeServerShell({ sessionId })',
    'const shellSocketOutputFlushMs = 4',
    'const shellSocketOutputImmediateChars = 16',
    'const shellSocketOutputFlushMaxChars = 96 * 1024',
    'const shellSocketDiagnosticsTouchIntervalMs = 250',
    'let shellSocketDiagnosticsLastTouchAt = 0',
    'function bindSshShellSocket',
    'let pendingOutputEvent: SshShellStreamEvent | null = null',
    'pendingOutputEvent.content?.length',
    'pendingOutputEvent.content?.length ?? 0) <= shellSocketOutputImmediateChars',
    'setTimeout(flushOutput, shellSocketOutputFlushMs)',
    'touchDiagnostics(true)',
    'function touchDiagnostics(force = false)',
    'new Date(now).toISOString()',
    'sendShellEvent(event)',
  ];
  const missingSocket = socketRequired.filter((fragment) => !sshSocketSource.includes(fragment));
  if (missingSocket.length) {
    throw new Error(`SSH shell websocket bridge guard is incomplete: ${missingSocket.join(', ')}`);
  }
  const socketReadyIndex = sshSocketSource.indexOf("type: 'ready'");
  const socketSubscribeIndex = sshSocketSource.indexOf('unsubscribe = subscribeServerShell');
  if (socketReadyIndex === -1 || socketSubscribeIndex === -1 || socketSubscribeIndex > socketReadyIndex) {
    throw new Error('SSH WebSocket bridge must subscribe to shell output before sending ready to avoid blank terminals');
  }
  const xtermHelpersCss = globalCssSource.match(/\.ssh-terminal-screen \.xterm-helpers \{(?<body>[\s\S]+?)\n\}/)?.groups?.body ?? '';
  const xtermTextareaCss = globalCssSource.match(/\.ssh-terminal-screen \.xterm-helper-textarea \{(?<body>[\s\S]+?)\n\}/)?.groups?.body ?? '';
  if (!xtermHelpersCss || !xtermTextareaCss || /(?:width|height|min-width|min-height):\s*0\s*!important/.test(`${xtermHelpersCss}\n${xtermTextareaCss}`)) {
    throw new Error('SSH terminal xterm helper input must remain nonzero sized so browser keyboard capture stays reliable');
  }

  const redactionRequired = [
    'const redactionTriggerPattern',
    '\\b(?:access_token',
    'if (!redactionTriggerPattern.test(value))',
    'return redactionRules.reduce',
  ];
  const missingRedaction = redactionRequired.filter((fragment) => !redactionSource.includes(fragment));
  if (missingRedaction.length) {
    throw new Error(`SSH shell redaction fast path guard is incomplete: ${missingRedaction.join(', ')}`);
  }

  console.log('ok SSH terminal uses live PTY shell streaming and keeps input responsive');
}

function assertSshKeyAuthenticationGuards() {
  const inventorySource = fs.readFileSync(new URL('../src/modules/servers/ServerInventory.tsx', import.meta.url), 'utf8');
  const sshServiceSource = fs.readFileSync(new URL('../src/server/services/sshAccessService.ts', import.meta.url), 'utf8');
  const i18nSource = fs.readFileSync(new URL('../src/i18n.tsx', import.meta.url), 'utf8');
  const globalCss = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');

  const frontendFragments = [
    'privateKeyFileRef',
    'importPrivateKeyFile',
    'type="file"',
    'accept=".pem,.key,.txt,.ppk"',
    'spellCheck={false}',
    "t('servers.importPrivateKey')",
    "t('servers.privateKeyFileTooLarge')",
  ];
  const missingFrontend = frontendFragments.filter((fragment) => !inventorySource.includes(fragment));
  if (missingFrontend.length) {
    throw new Error(`SSH key-auth frontend guards are incomplete: ${missingFrontend.join(', ')}`);
  }

  const backendFragments = [
    'privateKey: z.string().max(64 * 1024)',
    'privateKeyBlockPattern',
    'puttyPrivateKeyPattern',
    'function isSupportedPrivateKey',
    'ssh2.utils.parseKey(normalized',
    'SSH private key must be a PEM/OpenSSH/PPK private key block',
  ];
  const missingBackend = backendFragments.filter((fragment) => !sshServiceSource.includes(fragment));
  if (missingBackend.length) {
    throw new Error(`SSH key-auth backend validation guards are incomplete: ${missingBackend.join(', ')}`);
  }

  const cssFragments = ['.connect-form-label-row', '.inline-import-button', '.visually-hidden'];
  const missingCss = cssFragments.filter((fragment) => !globalCss.includes(fragment));
  if (missingCss.length) {
    throw new Error(`SSH key-auth import CSS is incomplete: ${missingCss.join(', ')}`);
  }

  for (const key of ['servers.importPrivateKey', 'servers.privateKeyImported', 'servers.privateKeyImportFailed', 'servers.privateKeyFileTooLarge']) {
    const count = (i18nSource.match(new RegExp(key.replace('.', '\\.'), 'g')) ?? []).length;
    if (count < 3) {
      throw new Error(`SSH key-auth i18n key is missing languages: ${key}`);
    }
  }

  console.log('ok SSH private-key authentication supports file import, validation, and i18n coverage');
}

function assertMobileTopbarKeepsCoreActions() {
  const globalCss = fs.readFileSync(new URL('../src/styles/global.css', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
  const mobileSection = globalCss.slice(globalCss.indexOf('@media (max-width: 820px)'));
  if (/\.topbar-actions\s*\{[^}]*display:\s*none/i.test(mobileSection)) {
    throw new Error('Mobile topbar must keep language, refresh, session, and logout actions visible');
  }

  const requiredFragments = [
    '.topbar-actions {',
    'overflow-x: auto',
    '.language-switcher',
    '.topbar-language-switcher',
    '.language-switcher-options',
    '.language-switcher-option',
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
    'height: min(72vh, 600px, calc(100vh - 24px))',
    'min-height: min(420px, calc(100vh - 24px))',
    '.content:not(.ai-collapsed) main',
    'padding-bottom: 34px',
    '.content:not(.ai-collapsed) .map-controls',
    'position: absolute',
    'bottom: 9px',
    'z-index: 9',
    '.ai-launcher',
  ];
  const missing = requiredFragments.filter((fragment) => !mobileSection.includes(fragment));
  if (missing.length) {
    throw new Error(`Mobile topbar core actions are incomplete: ${missing.join(', ')}`);
  }

  const appRequiredFragments = [
    'role="group"',
    'aria-pressed={language === option.id}',
    'onClick={() => setLanguage(option.id)}',
    '{option.shortLabel}',
  ];
  const missingAppFragments = appRequiredFragments.filter((fragment) => !appSource.includes(fragment));
  if (missingAppFragments.length) {
    throw new Error(`Topbar language switcher behavior is incomplete: ${missingAppFragments.join(', ')}`);
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
    "const openEvents = useMemo(() => events.filter((event) => event.status === 'open'), [events])",
    'const auditStatusSummary = useMemo(() => summarizeAuditStatus(auditEntries), [auditEntries])',
    'const relationGroups = useMemo(() => groupSecurityRelationItems(relationItems), [relationItems])',
    'const riskyCheckCount = useMemo(() => checks.reduce',
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
    'selectedOperationTrace',
    'activeTraceId',
    'focusTraceId',
    'onTraceFocused',
    'firstMatchedAudit || auditEntries.length > 0',
    '!activeTraceId || auditEntries.some((entry) => entry.correlationId === activeTraceId)',
    'window.setTimeout(refreshMissingTrace, 350)',
    'attempts < 4',
    'applyTraceFilter(selectedAudit.correlationId',
    'entry.correlationId === activeTraceId',
    'entry.correlationId]',
    'setActiveTraceId(\'\')',
    'security-trace-filter-banner',
    'copy.traceApplied(shortenOperationCorrelationId(activeTraceId), filteredAudits.length)',
    'copy.viewTrace',
    'copy.clearTrace',
    'copy.copyTraceLink',
    'copy.traceLinkCopied',
    'function copyTraceLink()',
    'navigator.clipboard.writeText(url)',
    'buildReleaseEvidenceBrief({',
    'function buildReleaseEvidenceBrief(',
    'function sanitizeEvidenceBriefText(value: string)',
    "replace(/\\bsk-[A-Za-z0-9_-]{12,}\\b/g, '[redacted-api-key]')",
    "replace(/\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/g, '[redacted-ip]')",
    'function copyEvidenceBrief()',
    'navigator.clipboard.writeText(evidenceBrief.text)',
    'security-evidence-brief',
    'security-evidence-metrics',
    'data-release-deployment-evidence="true"',
    'parseDeploymentEvidence(deploymentCheck.evidence)',
    'copy.evidenceDeploymentDetail(evidenceBrief.deployment.channel, evidenceBrief.deployment.deploymentMode, evidenceBrief.deployment.publicHost)',
    'copy.evidenceBriefCopied',
    'copy.evidenceAuditDetail(activeAuditIssues.blocked, activeAuditIssues.failed, successRate, auditTotal)',
    'function summarizeAuditStatus(auditEntries: AuditEntry[])',
    'function groupSecurityRelationItems(items: SecurityRelationItem[])',
    'security-trace-filter-actions',
    'buildOperationAuditTrace(selectedAudit, auditEntries, copy, locale)',
    'function buildOperationAuditTrace(',
    'if (!isCorrelatableAuditAction(action))',
    'getRelatedOperationAuditEntries(selectedAudit, auditEntries, selectedTime, selectedSignature)',
    'isCorrelatableAuditAction(entry.action.toUpperCase())',
    "action === 'SERVER_ACTION'",
    "action === 'SERVER_SSH_COMMAND'",
    'entry.correlationId === selectedAudit.correlationId',
    'shortenOperationCorrelationId(selectedAudit.correlationId)',
    'operationTraceCorrelation',
    'getOperationAuditSignature(selectedAudit)',
    '15 * 60 * 1000',
    'copy.operationTraceElapsed',
    'security-audit-trace',
    'operationTraceTitle',
    'operationTraceNoExecution',
    "action === 'CUSTOM_API_TEST'",
    "action.startsWith('SERVER_') || action === 'OPERATIONS_PREFLIGHT' || action === 'OPERATIONS_TASK'",
    "action === 'OPERATIONS_PREFLIGHT' || action === 'OPERATIONS_TASK'",
    'auditDomainAuth',
    'auditNextSshRisk',
    'copy.blockedFailedCount(blockedCount, failedCount)',
    'copy.blockedFailedCount(auditIssues.blocked, auditIssues.failed)',
    'copy.configRelationDetail(corsOriginText, count(\'cors\'))',
    'copy.secretPostureDetail(config?.security.credentialEncryptionKeyConfigured === true)',
    'copy.configRelationDetail(config?.ai.baseUrl ?? copy.unavailable, count(\'ai\'))',
    'copy.configRelationDetail(apiHostText, count(\'api\'))',
    'fetchReleaseReadiness()',
    'security-readiness-card',
    'applyReadinessFilter(check)',
    'recordReleaseReadinessSnapshot()',
    'fetchReleaseReadinessReport()',
    'copy.readinessTrend(readiness.history.trend.direction, readiness.history.trend.deltaScore)',
    'copy.snapshotRecorded(result.snapshot.score)',
    'copy.reportExported',
    'fetchDiagnosticExport()',
    'diagnosticCopy.exported',
    'diagnosticCopy.failed',
  ];
  const missing = requiredFragments.filter((fragment) => !securitySource.includes(fragment));
  if (missing.length) {
    throw new Error(`Security audit relation/load guards are incomplete: ${missing.join(', ')}`);
  }

  const forbiddenPerformanceFragments = [
    "const openEvents = events.filter((event) => event.status === 'open');",
    "auditEntries.filter((entry) => entry.status === 'success').length",
    "const runtimeItems = relationItems.filter((item) => item.key === 'runtime'",
    "const secretItems = relationItems.filter((item) => item.key === 'ai'",
  ];
  const performanceRegressions = forbiddenPerformanceFragments.filter((fragment) => securitySource.includes(fragment));
  if (performanceRegressions.length) {
    throw new Error(`Security audit panel must keep expensive derivations memoized: ${performanceRegressions.join(', ')}`);
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
    '.security-audit-trace',
    '.security-audit-trace-steps',
    '.security-audit-trace-actions',
    '.security-trace-filter-banner',
    '.security-trace-filter-actions',
    '.security-audit-trace.blocked',
    '.security-audit-trace.failed',
    '.security-remediation-card',
    '.security-remediation-list',
    '.security-remediation-item',
    '.security-readiness-card',
    '.security-readiness-meter',
    '.security-readiness-trend',
    '.security-readiness-actions',
    '.security-readiness-blocker',
    '.security-evidence-brief',
    '.security-evidence-metrics',
    '.security-evidence-footer',
    '.security-evidence-metric.fail',
    '.security-deployment-evidence',
    '.config-state.action',
  ];
  const missingCss = cssFragments.filter((fragment) => !globalCss.includes(fragment));
  if (missingCss.length) {
    throw new Error(`Security audit insight CSS is incomplete: ${missingCss.join(', ')}`);
  }

  const appSource = fs.readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
  const frontendAppSource = fs.readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
  const auditServiceSource = fs.readFileSync(new URL('../src/server/services/auditService.ts', import.meta.url), 'utf8');
  const diagnosticServiceSource = fs.readFileSync(new URL('../src/server/services/diagnosticService.ts', import.meta.url), 'utf8');
  const readinessServiceSource = fs.readFileSync(new URL('../src/server/services/releaseReadinessService.ts', import.meta.url), 'utf8');
  const releaseVerificationServiceSource = fs.readFileSync(new URL('../src/server/services/releaseVerificationService.ts', import.meta.url), 'utf8');
  const apiClientSource = fs.readFileSync(new URL('../src/services/apiClient.ts', import.meta.url), 'utf8');
  const remediationFragments = [
    "app.get('/api/audit/readiness'",
    "app.post('/api/audit/readiness/snapshots'",
    "app.get('/api/audit/readiness/report'",
    "app.get('/api/audit/diagnostics/export'",
    "app.get('/api/release/verify'",
    'isReleaseVerificationEnabled(config)',
    'isReleaseVerificationAuthorized(config, getBearerToken(request.headers.authorization))',
    'response.setHeader(\'Cache-Control\', \'no-store\')',
    'buildReleaseReadiness(config)',
    'buildReleaseReadinessReport(config)',
    'buildDiagnosticExport(config)',
    'buildReleaseVerification(config)',
    'buildReleaseDeploymentEvidence(config)',
    'recordReleaseReadinessSnapshot(config)',
    'export function buildReleaseReadiness(config',
    'export function buildReleaseReadinessReport(config',
    'export function buildDiagnosticExport(config',
    'export function buildReleaseVerification(config',
    'config.releaseVerification.tokenConfigured',
    "return crypto.timingSafeEqual(leftBuffer, rightBuffer)",
    "replace(/\\bsk-[A-Za-z0-9_-]{12,}\\b/g, '[redacted-api-key]')",
    "replace(/\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/g, '[redacted-ip]')",
    "/\\/assets\\/[^\"']+\\.(?:js|css)/g",
    'inspectFrontendAsset(distDir, asset)',
    "featureMarkers: Object.fromEntries(featureMarkers.map((marker) => [marker, combinedContent.includes(marker)]))",
    'runtime-secret-posture',
    'deployment-evidence',
    "relatedModule: 'deployment'",
    'config.security.adminPasswordDefault',
    'sanitizeReportText',
    'writeAppSetting(readinessHistorySettingId',
    'getLastRemediationTime(auditEntries, \'audit-errors\')',
    'nextBestAction',
    "fetcher('/api/audit/readiness'",
    "fetcher('/api/audit/readiness/snapshots'",
    "fetcher('/api/audit/readiness/report'",
    "fetcher('/api/audit/diagnostics/export'",
    "app.post('/api/audit/remediate'",
    'remediateSecurityRisk(request.body, session.user.username)',
    "z.enum(['acknowledgeCheck', 'acknowledgeAuditFailures', 'closeOpenEvents', 'reviewRuntime'])",
    "action: 'SECURITY_REMEDIATION'",
    "target: parsed.target",
    "fetcher('/api/audit/remediate'",
  ];
  const remediationCombined = [appSource, auditServiceSource, diagnosticServiceSource, readinessServiceSource, releaseVerificationServiceSource, apiClientSource].join('\n');
  const missingRemediation = remediationFragments.filter((fragment) => !remediationCombined.includes(fragment));
  if (missingRemediation.length) {
    throw new Error(`Security audit remediation API is incomplete: ${missingRemediation.join(', ')}`);
  }

  const traceNavigationFragments = [
    'interface HashRoute',
    'function readHashRoute(): HashRoute',
    'function writeHashRoute(section: SectionId, traceId = \'\')',
    'function normalizeTraceRouteId(value: string | null | undefined)',
    '/^(ops|srv)-trace-[a-f0-9-]{36}$/',
    'const initialHashRouteRef = useRef<HashRoute | null>(null)',
    'const [securityTraceFocusId, setSecurityTraceFocusId] = useState(initialHashRouteRef.current.traceId)',
    'window.addEventListener(\'hashchange\', syncRouteFromHash)',
    'function navigateToSection(section: SectionId)',
    'function openSecurityTrace(correlationId: string)',
    'writeHashRoute(\'security\', traceId)',
    'function handleSecurityTraceFilterChange(correlationId: string)',
    'onTraceFilterChange={handleSecurityTraceFilterChange}',
    'onAuditTraceOpen={openSecurityTrace}',
    'focusTraceId={securityTraceFocusId}',
    'onTraceFocused={() => setSecurityTraceFocusId(\'\')}',
  ];
  const missingTraceNavigation = traceNavigationFragments.filter((fragment) => !frontendAppSource.includes(fragment));
  if (missingTraceNavigation.length) {
    throw new Error(`Cross-module audit trace navigation is incomplete: ${missingTraceNavigation.join(', ')}`);
  }

  for (const fragment of ['copyTraceLink', 'traceLinkCopied']) {
    const count = (securitySource.match(new RegExp(fragment, 'g')) ?? []).length;
    if (count < 4) {
      throw new Error(`Security trace-link copy text is missing languages: ${fragment}`);
    }
  }

  const browserE2eSource = fs.readFileSync(new URL('../scripts/browser-e2e.mjs', import.meta.url), 'utf8');
  const browserRequiredFragments = [
    'assertAccountSettingsAndAiChat',
    'save avatar and name',
    'avatar and display name updated',
    'open ai chat',
    '.ai-message.assistant.done .ai-message-content',
    'waitForFunction((expectedAnswer) => {',
    'lastAssistant.classList.contains(\'cached\')',
    'AI cached answer should match the first local rule answer',
    '.ai-execution-card',
    '.ai-execution-command code',
    'allow execution',
    'getByRole(\'button\', { name: /^submit$/i })',
    '.ai-execution-result pre',
    'assertDesktopAiDockLayout',
    'desktop-ai-dock-chat',
    'desktop-ai-dock-settings',
    'assertOperationsResultTraceRoundTrip',
    'waitForAuditEvents(targetPage, traceIdFromUrl)',
    'assertMobileConsoleAndMap',
    '{ width: 390, height: 844 }',
    'assertElementWithinViewport',
    'assertNoHorizontalOverflow',
    '.account-modal',
    '.ai-dock',
    '.cloud-map',
    '.world-map-svg',
    '.map-country.active',
    '.map-tooltip.pinned',
    'Mobile map pinned tooltip disappeared before users could interact with it',
    'mobile map to servers linkage',
    'assertMobileModuleLayoutSweep',
    'assertMobileSection',
    'assertSingleColumnStack',
    'assertElementHorizontallyWithinViewport',
    '.server-workspace-row',
    '.connect-form.open',
    '.ops-builder',
    '.api-template-grid',
    '.api-config-panel',
    '.security-control-grid',
    '.security-audit-detail-card',
    'mobile servers, operations, custom API, and security layout linkage',
    'captureVisualEvidence',
    "path.resolve('output', 'browser-e2e')",
    'desktop-security-trace',
    'mobile-map-to-servers',
    'mobile-security-audit',
    'Browser visual evidence',
    'uniqueByteCount',
    'assertLoginGitHubLink',
    "getByRole('link', { name: /^GitHub$/i })",
    "chromium.launch(executablePath ? { executablePath, headless: true } : { headless: true })",
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ];
  const missingBrowserFragments = browserRequiredFragments.filter((fragment) => !browserE2eSource.includes(fragment));
  if (missingBrowserFragments.length) {
    throw new Error(`Browser grey E2E coverage is incomplete: ${missingBrowserFragments.join(', ')}`);
  }

  console.log('ok security audit relation filters, remediation actions, load errors, and insight cards are guarded');
}

function assertOperationsTargetSelectionGuards() {
  const operationsSource = fs.readFileSync(new URL('../src/modules/operations/OperationsCenter.tsx', import.meta.url), 'utf8');
  const serviceSource = fs.readFileSync(new URL('../src/server/services/operationsService.ts', import.meta.url), 'utf8');
  const sshCommandRiskSource = fs.readFileSync(new URL('../src/shared/sshCommandRisk.ts', import.meta.url), 'utf8');
  const inventorySource = fs.readFileSync(new URL('../src/server/services/inventoryService.ts', import.meta.url), 'utf8');
  const serverActionsSource = fs.readFileSync(new URL('../src/server/services/serverActions.ts', import.meta.url), 'utf8');
  const auditServiceSource = fs.readFileSync(new URL('../src/server/services/auditService.ts', import.meta.url), 'utf8');
  const appSource = fs.readFileSync(new URL('../src/server/app.ts', import.meta.url), 'utf8');
  const apiClientSource = fs.readFileSync(new URL('../src/services/apiClient.ts', import.meta.url), 'utf8');
  const frontendRequired = [
    'const sshRequiredTask = taskType !== \'assetSync\'',
    'const operationServerGroups = useMemo(() => buildOperationServerGroups(servers), [servers])',
    'const { connectedServers, warningServers } = operationServerGroups',
    'function buildOperationServerGroups(servers: ServerNode[])',
    'if (sshRequiredTask && targetMode === \'allServers\')',
    '<option value="allServers" disabled={sshRequiredTask}>',
    'activeSelectedServerIds',
    'eligibleServerIds',
    'opsServerChoiceBatchSize',
    'visibleEligibleServers',
    'activeSelectedServerIdSet.has(server.id)',
    'ops-server-choice-window',
    'resolvePreviewCount(targetMode, eligibleServers.length, activeSelectedServerIds.length)',
    'serverIds: targetMode === \'selected\' ? activeSelectedServerIds : []',
    'setSelectedServerIds((current) => current.filter((id) => eligibleServerIds.has(id)))',
    'preflightOperationTask(preflightPayload)',
    'buildTaskPayload(false)',
    'ops-preflight-card',
    'ops-preflight-plan',
    'ops-preflight-targets',
    'preflight.plan.title',
    'preflight.plan.commandPreview',
    'target.runnable',
    'target.issues.length',
    'preflightStatusText',
    'preflightTone(preflight)',
    'onAuditTraceOpen?: (correlationId: string) => void',
    'const canOpenActiveTaskTrace = Boolean(',
    "activeTask.status !== 'running'",
    "activeTask.correlationId.startsWith('ops-trace-')",
    '{canOpenActiveTaskTrace && (',
    'onAuditTraceOpen?.(activeTask.correlationId)',
    'shortTraceId(task.correlationId)',
    'inline-trace-button',
    'preflight.targetsTruncated',
    'formatPreflightTruncation(preflight, language)',
    'ops-preflight-truncated',
  ];
  const missingFrontend = frontendRequired.filter((fragment) => !operationsSource.includes(fragment));
  if (missingFrontend.length) {
    throw new Error(`Operations target selection guard is incomplete: ${missingFrontend.join(', ')}`);
  }
  if (operationsSource.includes('selectedServerIds.filter((id) => eligibleServers.some(')) {
    throw new Error('Operations selected target preview regressed to nested scans');
  }
  if (operationsSource.includes('eligibleServers.map((server) => (')) {
    throw new Error('Operations selected target picker must render visibleEligibleServers, not every eligible server');
  }
  if (
    operationsSource.includes('const connectedServers = useMemo(() => servers.filter((server) => server.ssh?.connected), [servers]);')
    || operationsSource.includes("servers.filter((server) => server.status === 'warning' || server.cpu > 80 || server.disk > 85)")
  ) {
    throw new Error('Operations panel must derive connected and warning server groups in one pass');
  }

  const serviceRequired = [
    'OPERATIONS_TARGETS_UNCONNECTED',
    'OPERATIONS_TARGETS_NOT_FOUND',
    'allServers includes servers that are not SSH-connected',
    'All server targets must be SSH-connected for this operation',
    'selected servers are not SSH-connected',
    'Selected servers must be SSH-connected for this operation',
    'selected servers do not exist',
    'export function preflightOperationTask(input: unknown)',
    'requiresConfirmation',
    'requiredConfirmationReason(parsed)',
    'getSshCommandConfirmationReason(task.command)',
    'correlationId',
    'buildOperationCorrelationId()',
    'const correlationId = parsed.correlationId || buildOperationCorrelationId()',
    "z.string().trim().regex(/^ops-trace-[a-f0-9-]{36}$/).optional()",
    'sshConnected: Boolean(server.ssh?.connected)',
    'const disconnected = requiresSsh && status === \'unconnected\'',
    'const runnable = !disconnected',
    'buildTargetPreflightIssues(parsed, server, requiresConfirmation)',
    'buildPreflightPlan(parsed',
    'sanitizeCommandPreview(task.command)',
    'riskSummary',
    "action: 'OPERATIONS_PREFLIGHT'",
    'correlationId,',
    'buildPreflightAuditDetail(response)',
    'status: \'missing\'',
    'runnable: false',
    'const operationPreflightTargetLimit = 120',
    'existingPreflightTargets.length < operationPreflightTargetLimit',
    'targetsTruncated: omittedPreflightTargets > 0 || undefined',
    'omittedTargets: omittedPreflightTargets > 0 ? omittedPreflightTargets : undefined',
    'const operationOutputLimit = 200',
    'const operationExecutionConcurrency',
    'executeOperationTargets(taskId, parsed, targets)',
    'Math.min(operationExecutionConcurrency, targets.length)',
    'results[index] = await executeTarget(taskId, task, targets[index])',
    'outputs.length < operationOutputLimit',
    'outputsTruncated: omittedOutputs > 0 || undefined',
    'omittedOutputs: omittedOutputs > 0 ? omittedOutputs : undefined',
  ];
  const missingService = serviceRequired.filter((fragment) => !serviceSource.includes(fragment));
  if (missingService.length) {
    throw new Error(`Operations service selected target guard is incomplete: ${missingService.join(', ')}`);
  }

  const riskRequired = [
    'highImpactSshCommandPattern',
    'export function getSshCommandConfirmationReason(command: string)',
    'high-impact SSH command',
  ];
  const missingRisk = riskRequired.filter((fragment) => !sshCommandRiskSource.includes(fragment));
  if (missingRisk.length) {
    throw new Error(`Shared SSH command risk guard is incomplete: ${missingRisk.join(', ')}`);
  }

  if (!auditServiceSource.includes("| 'OPERATIONS_PREFLIGHT'")) {
    throw new Error('Operations preflight audit action is not registered');
  }
  if (!auditServiceSource.includes('correlationId?: string')) {
    throw new Error('Audit entries must preserve optional operation correlation IDs');
  }

  const serverCorrelationRequired = [
    'export function buildServerAuditCorrelationId()',
    "return `srv-trace-${crypto.randomUUID()}`",
    'correlationId: serverAuditCorrelationSchema',
    'const correlationId = parsed.correlationId || buildServerAuditCorrelationId()',
    "z.string().trim().regex(/^srv-trace-[a-f0-9-]{36}$/).optional()",
    'correlationId,',
  ];
  const serverCorrelationCombined = `${inventorySource}\n${serverActionsSource}`;
  const missingServerCorrelation = serverCorrelationRequired.filter((fragment) => !serverCorrelationCombined.includes(fragment));
  if (missingServerCorrelation.length) {
    throw new Error(`Server action/SSH audit correlation is incomplete: ${missingServerCorrelation.join(', ')}`);
  }

  const preflightRouteRequired = [
    "app.post('/api/operations/tasks/preflight'",
    'preflightOperationTask(request.body)',
    "fetcher('/api/operations/tasks/preflight'",
    'OperationTaskPreflightResponse',
  ];
  const routeAndClientSource = `${appSource}\n${apiClientSource}`;
  const missingPreflightRoute = preflightRouteRequired.filter((fragment) => !routeAndClientSource.includes(fragment));
  if (missingPreflightRoute.length) {
    throw new Error(`Operations preflight API route or client is incomplete: ${missingPreflightRoute.join(', ')}`);
  }

  console.log('ok operations target selection guards stale and unconnected targets');
}

function assertInventorySnapshotCacheGuards() {
  const inventorySource = fs.readFileSync(new URL('../src/server/services/inventoryService.ts', import.meta.url), 'utf8');
  const requiredFragments = [
    'let serverInventoryRevision = 0',
    'let cachedServerInventorySnapshot',
    'function markServerInventoryChanged()',
    'function getCachedServerInventorySnapshot()',
    'cachedServerInventorySnapshot?.revision !== serverInventoryRevision',
    'cachedServerInventorySnapshot.snapshot.summary.openEvents = countOpenOperationEvents()',
    'if (inputServers === servers) {',
    'markServerInventoryChanged();',
    'applyServerMetricState(',
    'function collectServerPageWithTotal(',
    'let page = collectServerPageWithTotal(snapshot.items, matcher, pagination)',
  ];
  const missing = requiredFragments.filter((fragment) => !inventorySource.includes(fragment));
  if (missing.length) {
    throw new Error(`Inventory snapshot cache guard is incomplete: ${missing.join(', ')}`);
  }

  const cacheRegressionFragments = [
    'export function summarizeServerInventory(inputServers: ServerNode[] = servers): ServerInventorySummary {\n  return collectServerInventory(inputServers, false).summary;',
    'export function buildServerInventorySnapshot(inputServers: ServerNode[] = servers): ServerInventorySnapshot {\n  const collected = collectServerInventory(inputServers, true);',
  ];
  const regressions = cacheRegressionFragments.filter((fragment) => inventorySource.includes(fragment));
  if (regressions.length) {
    throw new Error('Inventory snapshot builders regressed to unconditional full recomputation');
  }

  console.log('ok inventory snapshot cache avoids repeated full recomputation');
}

function assertLocalizedFormatCacheGuards() {
  const formatSource = fs.readFileSync(new URL('../src/utils/format.ts', import.meta.url), 'utf8');
  const requiredFragments = [
    'const localizedFormatCacheLimit = 2048',
    'const countryNameCache = new Map<string, string>()',
    'const regionNameCache = new Map<string, string>()',
    'cacheLocalizedFormat(countryNameCache',
    'cacheLocalizedFormat(regionNameCache',
    'cache.delete(oldestKey)',
  ];
  const missing = requiredFragments.filter((fragment) => !formatSource.includes(fragment));
  if (missing.length) {
    throw new Error(`Localized format cache guard is incomplete: ${missing.join(', ')}`);
  }

  console.log('ok localized region and country labels use bounded caches');
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

function nextTemporarySimulatedSshPublicIp() {
  const host = 200 + (temporarySimulatedSshServerSequence++ % 50);
  return `198.51.100.${host}`;
}

async function createTemporarySimulatedSshServer(overrides = {}) {
  const serverResponse = await fetch(`${baseUrl}/api/servers`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: overrides.name ?? `ws-shell-${Date.now()}`,
      provider: 'Smoke Lab',
      region: overrides.region ?? 'US - Los Angeles',
      publicIp: overrides.publicIp ?? nextTemporarySimulatedSshPublicIp(),
      privateIp: overrides.privateIp ?? '10.88.0.77',
      os: overrides.os ?? 'Debian 12',
      tags: ['smoke', 'ssh', 'websocket'],
      ssh: {
        host: overrides.host ?? 'simulated-smoke.local',
        port: overrides.port ?? 22,
        username: overrides.username ?? 'root',
        authType: 'password',
        password: 'smoke-simulated-only',
        verifyMode: 'simulate',
      },
    }),
  });

  if (!serverResponse.ok) {
    throw new Error(`/api/servers websocket setup returned HTTP ${serverResponse.status}`);
  }

  return await serverResponse.json();
}

async function assertUnauthorizedShellWebSocket() {
  const socket = new WebSocket(`${socketBaseUrl}/api/servers/shells/ws`);
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('SSH WebSocket unauthorized check timed out'));
    }, 2500);

    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error('SSH WebSocket unauthorized upgrade unexpectedly opened'));
    });

    socket.addEventListener('close', () => {
      clearTimeout(timeout);
      resolve(true);
    });

    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      resolve(true);
    });

    socket.on('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      resolve(true);
    });
  });
}

async function exerciseShellWebSocket(serverId) {
  const socket = new WebSocket(`${socketBaseUrl}/api/servers/shells/ws`, {
    headers: authHeaders,
  });
  let readySessionId = '';
  let text = '';
  let closed = false;
  let readyResolver = () => undefined;
  let readyReject = () => undefined;

  const readyPromise = new Promise((resolve, reject) => {
    readyResolver = resolve;
    readyReject = reject;
  });

  const closePromise = new Promise((resolve, reject) => {
    socket.addEventListener('close', () => {
      closed = true;
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('SSH WebSocket shell connection failed'));
    });
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      reject(new Error('SSH WebSocket shell connection was rejected'));
    });
    socket.addEventListener('close', () => {
      if (!readySessionId) {
        readyReject(new Error('SSH WebSocket shell closed before readiness'));
      }
    });
  });

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'open', serverId, cols: 100, rows: 28 }));
  });

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(String(event.data));
    if (payload.type === 'ready') {
      readySessionId = payload.sessionId;
      readyResolver(payload);
      socket.send(JSON.stringify({ type: 'input', data: 'whoami\n' }));
      return;
    }
    if (payload.type === 'stdout' && payload.content) {
      text += payload.content;
      if (text.includes('command simulated.')) {
        socket.send(JSON.stringify({ type: 'close' }));
      }
      return;
    }
    if (payload.type === 'close') {
      closed = true;
      return;
    }
    if (payload.type === 'error') {
      readyReject(new Error(payload.message ?? 'SSH WebSocket shell returned error'));
    }
  });

  await readyPromise;
  await closePromise;
  if (!readySessionId) {
    throw new Error('SSH WebSocket shell did not report session readiness');
  }
  return { text, closed, sessionId: readySessionId };
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
