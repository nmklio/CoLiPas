import { cloudAccounts, operationEvents, servers } from '../data/mockData';
import {
  AIProviderConfig,
  AuditCorrelationId,
  CloudProvider,
  CustomApiConfig,
  OperationEvent,
  OperationTaskTargetMode,
  OperationTaskType,
  OperationTaskPreflightResponse,
  OperationTaskRequest,
  OperationTaskResponse,
  MaintenanceWindow,
  MaintenanceWindowScope,
  DiagnosticExportResponse,
  ReleaseReadinessReportResponse,
  ReleaseReadinessResponse,
  ReleaseReadinessSnapshotResponse,
  ReleaseEvidenceShareCreateResponse,
  ReleaseEvidenceShareListResponse,
  ReleaseSyncHealthResponse,
  ReleaseGatePolicy,
  ServerNode,
  SshRunbookCommand,
  SshAuthType,
  SshVerifyMode,
} from '../types';

export interface OverviewResponse {
  cloudAccounts: typeof cloudAccounts;
  servers: ServerNode[];
  operationEvents: OperationEvent[];
  summary: {
    totalServers: number;
    onlineServers: number;
    openEvents: number;
    connectedSsh?: number;
    avgCpu?: number;
    busiestServer?: ServerNode;
  };
}

export interface AiAnalysisResponse {
  provider: string;
  model: string;
  prompt: string;
  answer: string;
  simulated: boolean;
  cached?: boolean;
  generatedAt?: string;
  executionPlan?: AiExecutionPlan;
}

export interface AiExecutionPlan {
  title: string;
  summary: string;
  targetMode: OperationTaskTargetMode;
  serverIds: string[];
  operation: OperationTaskType;
  command?: string;
  reason: string;
  confirmed?: boolean;
  requiresConfirmation?: boolean;
  confirmationReason?: string;
  safetyNote: string;
}

export interface AiChatRequestMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiConnectionTestResponse {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  checkedAt: string;
  message: string;
}

export interface AiModelsResponse {
  models: string[];
  provider: string;
  source: 'upstream' | 'fallback';
  message: string;
}

export interface ConfigSummaryResponse {
  nodeEnv: string;
  corsOrigins: string[];
  customApiAllowedHosts: string[];
  customApiTimeoutMs: number;
  ai: {
    baseUrl: string;
    model: string;
    configured: boolean;
    hasStoredApiKey?: boolean;
    managedBy?: 'database' | 'environment' | 'none';
  };
  security: {
    adminPasswordDefault: boolean;
    sessionSecretDefault: boolean;
    credentialEncryptionKeyConfigured: boolean;
    credentialEncryptionKeyDefault: boolean;
  };
}

export interface AiProviderSettingsResponse {
  provider: AIProviderConfig;
  configured: boolean;
  hasStoredApiKey: boolean;
  managedBy: 'database' | 'environment' | 'none';
  updatedAt: string | null;
}

export interface SecurityRemediationResponse {
  ok: boolean;
  type: 'acknowledgeCheck' | 'acknowledgeAuditFailures' | 'closeOpenEvents' | 'reviewRuntime';
  target: string;
  affected: number;
  audit: {
    id: string;
    action: string;
    actor: string;
    target: string;
    status: 'success' | 'blocked' | 'failed';
    detail: string;
    createdAt: string;
  };
}

export interface CustomApiTestResponse {
  ok: boolean;
  status: number;
  durationMs: number;
  headers: Record<string, string>;
  bodyText: string;
}

export interface ServerDiagnosticResponse {
  serverId: string;
  serverName: string;
  mode: SshVerifyMode;
  command: string;
  output: string;
  checkedAt: string;
}

export interface ServerCommandResponse {
  serverId: string;
  serverName: string;
  correlationId: AuditCorrelationId;
  command: string;
  output: string;
  executedAt: string;
}

export interface ServerCommandStreamEvent {
  type: 'start' | 'stdout' | 'stderr' | 'done' | 'timeout' | 'error';
  content?: string;
  message?: string;
  code?: number | null;
  signal?: string | null;
  output?: string;
  result?: ServerCommandResponse;
}

export interface ServerShellResponse {
  serverId: string;
  serverName: string;
  correlationId: AuditCorrelationId;
  sessionId: string;
  mode: SshVerifyMode;
  connectedAt: string;
}

export interface ServerShellStatusResponse {
  activeCount: number;
  byMode: Record<SshVerifyMode, number>;
  oldestConnectedAt: string | null;
  newestConnectedAt: string | null;
}

export interface SshRunbookResponse {
  commands: SshRunbookCommand[];
}

export interface SshRunbookImportResponse extends SshRunbookResponse {
  imported: SshRunbookCommand[];
  skipped: string[];
}

export interface SshRunbookPinResponse extends SshRunbookResponse {
  command: SshRunbookCommand;
}

export interface SshRunbookUseResponse extends SshRunbookResponse {
  command: SshRunbookCommand;
}

export interface MaintenanceWindowsResponse {
  items: MaintenanceWindow[];
}

export interface MaintenanceWindowMutationResponse {
  window: MaintenanceWindow;
  windows: MaintenanceWindow[];
}

export interface MaintenanceWindowDeleteResponse {
  ok: boolean;
  id: string;
  windows: MaintenanceWindow[];
}

export interface MaintenanceWindowPayload {
  title: string;
  note?: string;
  scope: MaintenanceWindowScope;
  serverIds?: string[];
  startsAt: string;
  endsAt: string;
}

export interface ServerShellStreamEvent {
  type: 'start' | 'stdout' | 'stderr' | 'close' | 'error';
  content?: string;
  message?: string;
  code?: number | null;
  signal?: string | null;
  connectedAt?: string;
}

export interface ServerShellSocketReady extends ServerShellResponse {
  type: 'ready';
}

export interface ServerShellSocketPong {
  type: 'pong';
  sentAt?: number;
  receivedAt?: number;
}

export interface ServerShellSocketMetrics {
  bytesReceived: number;
  throughputBytesPerSecond: number;
  rttMs: number | null;
}

export interface ServerShellSocketCloseEvent {
  opened: boolean;
  ready: boolean;
  code: number;
  reason: string;
}

export interface ServerShellSelfTestPayload {
  status: 'complete' | 'timeout' | 'failed';
  lines: number;
  durationMs: number;
  linesPerSecond: number;
  firstResponseMs?: number;
  outputSpanMs?: number;
  rttMs?: number | null;
  throughputBytesPerSecond?: number;
  networkLabel: string;
}

export interface SshSupportTicketCopyAuditPayload {
  sections: number;
  tone: 'ok' | 'warn' | 'fail';
}

export interface SshProductionProbePayload {
  targetLabel: string;
  deploymentMode: string;
  ok: boolean;
  durationMs: number;
  activeShellsAfter: number | null;
  inventory: {
    total: number;
    connected: number;
    modes: Record<string, number>;
  };
  probes: Array<{
    kind: string;
    mode: string;
    ok: boolean;
    sessionReady: boolean;
    durationMs: number | null;
  }>;
  recordedAt?: string;
}

export interface SshProductionProbeScheduleResponse {
  enabled: boolean;
  autoRunBrowserProbe: boolean;
  intervalMinutes: 30 | 60 | 180 | 720 | 1440;
  intervalOptions: Array<30 | 60 | 180 | 720 | 1440>;
  lastAutoRunAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  nextDueAt: string | null;
  dueNow: boolean;
  overdue: boolean;
  alertTone: 'ok' | 'warn' | 'fail';
}

export interface SshProductionProbeScheduleUpdatePayload {
  enabled: boolean;
  autoRunBrowserProbe: boolean;
  intervalMinutes: SshProductionProbeScheduleResponse['intervalMinutes'];
}

export interface ReleaseGatePolicyUpdatePayload {
  enabled: boolean;
  minScore: number;
  maxWarnings: number;
  requireZeroFailures: boolean;
  requireConnectedSsh: boolean;
  requireAiProvider: boolean;
}

export interface ServerActionResponse extends ServerCommandResponse {
  id: string;
  action: 'powerOn' | 'shutdown' | 'reboot';
  status: 'dry-run' | 'executed';
  reason: string;
  command: string;
  output: string;
  executedAt: string;
}

export interface ServerIdentityResponse {
  region: string;
  os: string;
  sources: {
    region: 'input' | 'ip' | 'ssh' | 'simulate' | 'fallback';
    os: 'input' | 'ip' | 'ssh' | 'simulate' | 'fallback';
  };
  detectedAt: string;
}

export interface ConnectServerPayload {
  name: string;
  provider: CloudProvider;
  region: string;
  publicIp: string;
  privateIp: string;
  os: string;
  tags: string[];
  ssh: {
    host?: string;
    port: number;
    username: string;
    authType: SshAuthType;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    verifyMode: SshVerifyMode;
  };
}

export interface AuthSession {
  authenticated: boolean;
  user?: {
    username: string;
    role: string;
  };
  profile?: AccountProfile;
  expiresAt?: string;
  ttlSeconds?: number;
}

export interface AccountProfile {
  displayName: string;
  avatarText: string;
  avatarImage?: string;
}

export interface AccountPayload {
  session: AuthSession;
  profile: AccountProfile;
}

export interface AccountSessionSummary {
  id: string;
  current: boolean;
  deviceLabel: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface AccountSessionsResponse {
  items: AccountSessionSummary[];
  summary: {
    active: number;
    otherSessions: number;
    maxActive: number;
    available: number;
    atCapacity: boolean;
    persistent: boolean;
  };
}

export class AuthRequiredError extends Error {
  constructor(message = 'AUTH_REQUIRED') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

const fallbackOverview: OverviewResponse = {
  cloudAccounts,
  servers,
  operationEvents,
  summary: {
    totalServers: servers.length,
    onlineServers: servers.filter((server) => server.status === 'running').length,
    openEvents: operationEvents.filter((event) => event.status === 'open').length,
  },
};

export async function fetchOverview(fetcher: typeof fetch = fetch): Promise<{ data: OverviewResponse; source: 'api' | 'fallback' }> {
  try {
    const response = await fetcher('/api/overview');
    if (response.status === 401) {
      throw new AuthRequiredError();
    }
    if (!response.ok) {
      throw new Error(`Overview API returned ${response.status}`);
    }
    return { data: (await response.json()) as OverviewResponse, source: 'api' };
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      throw error;
    }
    return { data: fallbackOverview, source: 'fallback' };
  }
}

export async function fetchAuthSession(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/auth/session', {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as AuthSession;
}

export async function login(username: string, password: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as AuthSession;
}

export async function logout(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as AuthSession;
}

export async function fetchAccount(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/account', {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as AccountPayload;
}

export async function updateAccountProfile(profile: AccountProfile, fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/account/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(profile),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as { profile: AccountProfile };
}

export async function fetchAccountSessions(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/account/sessions', {
    credentials: 'include',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as AccountSessionsResponse;
}

export async function revokeAccountSession(sessionId: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/account/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as {
    ok: true;
    revoked: number;
    sessions: AccountSessionsResponse;
  };
}

export async function revokeOtherAccountSessions(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/account/sessions/revoke-others', {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as {
    ok: true;
    revoked: number;
    sessions: AccountSessionsResponse;
  };
}

export async function changeAccountPassword(
  currentPassword: string,
  newPassword: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher('/api/account/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ currentPassword, newPassword }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as { ok: true; changedAt: string };
}

export async function fetchConfigSummary(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/config');
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ConfigSummaryResponse;
}

export async function fetchAiProviderSettings(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/ai/provider');
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as AiProviderSettingsResponse;
}

export async function saveAiProviderSettings(provider: AIProviderConfig, fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/ai/provider', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(provider),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as AiProviderSettingsResponse;
}

export async function requestAiAnalysis(
  question: string,
  provider?: AIProviderConfig,
  serverId?: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher('/api/ai/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, provider, serverId }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as AiAnalysisResponse;
}

export async function streamAiAnalysis(
  question: string,
  provider: AIProviderConfig,
  serverId: string,
  onChunk: (chunk: string) => void,
  options: { forceRefresh?: boolean; messages?: AiChatRequestMessage[]; signal?: AbortSignal } = {},
  fetcher: typeof fetch = fetch,
): Promise<AiAnalysisResponse> {
  const response = await fetcher('/api/ai/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question,
      provider,
      serverId,
      forceRefresh: options.forceRefresh === true,
      messages: options.messages ?? [],
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  if (!response.body) {
    throw new Error('AI stream did not return a readable body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const streamState: { result?: AiAnalysisResponse; error?: string } = {};

  const consumeEvent = (eventText: string) => {
    const dataText = eventText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');

    if (!dataText) {
      return;
    }

    const payload = JSON.parse(dataText) as {
      type?: 'chunk' | 'done' | 'error';
      content?: string;
      result?: AiAnalysisResponse;
      message?: string;
    };

    if (payload.type === 'chunk' && payload.content) {
      onChunk(payload.content);
    }

    if (payload.type === 'done' && payload.result) {
      streamState.result = payload.result;
    }

    if (payload.type === 'error') {
      streamState.error = payload.message || 'AI stream failed';
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const eventText of events) {
      consumeEvent(eventText);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    consumeEvent(buffer);
  }

  if (streamState.error) {
    throw new Error(streamState.error);
  }

  if (!streamState.result) {
    throw new Error('AI stream ended without a final result');
  }

  return streamState.result;
}

export async function testAiConnection(provider: AIProviderConfig, fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/ai/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as AiConnectionTestResponse;
}

export async function fetchAiModels(provider: AIProviderConfig, fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/ai/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as AiModelsResponse;
}

export async function testCustomApi(config: CustomApiConfig, fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/custom-apis/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as CustomApiTestResponse;
}

export async function remediateSecurityRisk(
  payload: { type: SecurityRemediationResponse['type']; target: string; note?: string },
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher('/api/audit/remediate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as SecurityRemediationResponse;
}

export async function fetchReleaseReadiness(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/audit/readiness');

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ReleaseReadinessResponse;
}

export async function fetchReleaseSyncHealth(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/release/sync-health');

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ReleaseSyncHealthResponse;
}

export async function fetchReleaseGatePolicy(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/audit/readiness/policy');

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ReleaseGatePolicy;
}

export async function recordReleaseReadinessSnapshot(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/audit/readiness/snapshots', {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ReleaseReadinessSnapshotResponse;
}

export async function updateReleaseGatePolicy(
  payload: ReleaseGatePolicyUpdatePayload,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher('/api/audit/readiness/policy', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as {
    ok: true;
    policy: ReleaseGatePolicy;
    readiness: ReleaseReadinessResponse;
  };
}

export async function fetchReleaseReadinessReport(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/audit/readiness/report');

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ReleaseReadinessReportResponse;
}

export async function fetchReleaseEvidenceShares(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/audit/readiness/shares');

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ReleaseEvidenceShareListResponse;
}

export async function createReleaseEvidenceShare(
  payload: { expiresInHours: 1 | 24 | 72 },
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher('/api/audit/readiness/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ReleaseEvidenceShareCreateResponse;
}

export async function revokeReleaseEvidenceShare(shareId: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/audit/readiness/shares/${encodeURIComponent(shareId)}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as {
    ok: true;
    share: ReleaseEvidenceShareListResponse['items'][number];
  };
}

export interface BulkImportServerPayload {
  name: string;
  provider: CloudProvider;
  region: string;
  publicIp: string;
  privateIp: string;
  os: string;
  tags: string[];
}

export interface BulkImportServersResponse {
  items: ServerNode[];
  skipped: Array<{
    row: number;
    name: string;
    reason: 'duplicate-name' | 'duplicate-public-ip';
  }>;
  summary: {
    requested: number;
    imported: number;
    skipped: number;
  };
}

export async function fetchDiagnosticExport(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/audit/diagnostics/export');

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as DiagnosticExportResponse;
}

export async function connectServer(payload: ConnectServerPayload, fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ServerNode;
}

export async function bulkImportServers(items: BulkImportServerPayload[], fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/servers/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as BulkImportServersResponse;
}

export async function inspectServerIdentity(payload: Pick<ConnectServerPayload, 'publicIp' | 'region' | 'os' | 'ssh'>, fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/servers/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ServerIdentityResponse;
}

export async function updateServer(serverId: string, payload: ConnectServerPayload, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/servers/${encodeURIComponent(serverId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ServerNode;
}

export async function deleteServer(serverId: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/servers/${encodeURIComponent(serverId)}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as { id: string; deleted: boolean };
}

export async function runServerDiagnostic(serverId: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/servers/${encodeURIComponent(serverId)}/diagnostics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ServerDiagnosticResponse;
}

export async function executeServerAction(
  serverId: string,
  action: ServerActionResponse['action'],
  reason: string,
  confirmed = false,
  correlationId?: AuditCorrelationId,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher('/api/servers/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId, action, reason, confirmed, correlationId }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ServerActionResponse;
}

export async function runServerCommand(serverId: string, command: string, fetcher: typeof fetch = fetch, correlationId?: AuditCorrelationId) {
  const response = await fetcher('/api/servers/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId, command, correlationId }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ServerCommandResponse;
}

export async function streamServerCommand(
  serverId: string,
  command: string,
  onEvent: (event: ServerCommandStreamEvent) => void,
  options: { signal?: AbortSignal; fetcher?: typeof fetch; correlationId?: AuditCorrelationId } = {},
): Promise<ServerCommandResponse | null> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher('/api/servers/commands/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId, command, correlationId: options.correlationId }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  if (!response.body) {
    throw new Error('SSH stream did not return a readable body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ServerCommandResponse | null = null;
  let streamError = '';

  const consumeEvent = (eventText: string) => {
    const dataText = eventText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');

    if (!dataText) {
      return;
    }

    const payload = JSON.parse(dataText) as ServerCommandStreamEvent;
    onEvent(payload);
    if (payload.type === 'done' && payload.result) {
      result = payload.result;
    }
    if (payload.type === 'error') {
      streamError = payload.message || 'SSH stream command failed';
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const eventText of events) {
      consumeEvent(eventText);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    consumeEvent(buffer);
  }

  if (streamError) {
    throw new Error(streamError);
  }

  return result;
}

export async function openServerShell(
  serverId: string,
  dimensions: { cols?: number; rows?: number } = {},
  fetcher: typeof fetch = fetch,
  correlationId?: AuditCorrelationId,
) {
  const response = await fetcher('/api/servers/shells', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId, ...dimensions, correlationId }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ServerShellResponse;
}

export async function fetchServerShellStatus(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/servers/shells/status');

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ServerShellStatusResponse;
}

export async function fetchSshRunbookCommands(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/servers/ssh-runbook');

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as SshRunbookResponse;
}

export async function createSshRunbookCommand(
  payload: Pick<SshRunbookCommand, 'title' | 'command'>,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher('/api/servers/ssh-runbook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as SshRunbookCommand;
}

export async function updateSshRunbookCommand(
  commandId: string,
  payload: Pick<SshRunbookCommand, 'title' | 'command'>,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(`/api/servers/ssh-runbook/${encodeURIComponent(commandId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as SshRunbookCommand;
}

export async function importSshRunbookCommands(
  commands: Array<Pick<SshRunbookCommand, 'title' | 'command'>>,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher('/api/servers/ssh-runbook/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as SshRunbookImportResponse;
}

export async function updateSshRunbookCommandPin(commandId: string, pinned: boolean, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/servers/ssh-runbook/${encodeURIComponent(commandId)}/pin`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as SshRunbookPinResponse;
}

export async function markSshRunbookCommandUsed(commandId: string, mode: 'insert' | 'run', fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/servers/ssh-runbook/${encodeURIComponent(commandId)}/use`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as SshRunbookUseResponse;
}

export async function reorderSshRunbookCommands(commandIds: string[], fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/servers/ssh-runbook/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commandIds }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as SshRunbookResponse;
}

export async function deleteSshRunbookCommand(commandId: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/servers/ssh-runbook/${encodeURIComponent(commandId)}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as { ok: boolean; id: string };
}

export async function writeServerShell(sessionId: string, input: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/servers/shells/${encodeURIComponent(sessionId)}/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
}

export async function resizeServerShell(
  sessionId: string,
  dimensions: { cols: number; rows: number },
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(`/api/servers/shells/${encodeURIComponent(sessionId)}/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dimensions),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
}

export async function recordServerShellSelfTest(
  sessionId: string,
  payload: ServerShellSelfTestPayload,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(`/api/servers/shells/${encodeURIComponent(sessionId)}/self-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as ServerShellSelfTestPayload & {
    serverName: string;
    mode: SshVerifyMode;
    bottleneck: 'healthy' | 'network' | 'throughput' | 'terminal' | 'connection';
    recordedAt: string;
    active: boolean;
  };
}

export async function closeServerShell(sessionId: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/servers/shells/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(await readApiError(response));
  }
}

export async function recordSshSupportTicketCopy(
  payload: SshSupportTicketCopyAuditPayload,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher('/api/audit/ssh-support-ticket-copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as {
    ok: true;
    audit: {
      action: 'SSH_SUPPORT_TICKET_COPY';
      target: 'ssh-support-ticket';
      detail: string;
    };
  };
}

export async function recordSshProductionProbe(
  payload: SshProductionProbePayload,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher('/api/audit/ssh-production-probes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as {
    ok: true;
    trend: DiagnosticExportResponse['sshTerminal']['productionProbeTrend'];
  };
}

export async function fetchSshProductionProbeSchedule(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/audit/ssh-production-probes/schedule', {
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as SshProductionProbeScheduleResponse;
}

export async function updateSshProductionProbeSchedule(
  payload: SshProductionProbeScheduleUpdatePayload,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher('/api/audit/ssh-production-probes/schedule', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as {
    ok: true;
    schedule: SshProductionProbeScheduleResponse;
  };
}

export async function claimSshProductionProbeScheduleRun(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/audit/ssh-production-probes/schedule/claim', {
    method: 'POST',
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as {
    ok: true;
    claimed: boolean;
    schedule: SshProductionProbeScheduleResponse;
  };
}

export function streamServerShell(
  sessionId: string,
  onEvent: (event: ServerShellStreamEvent) => void,
  onError: (error: Error) => void,
  options: { replayHistory?: boolean } = {},
) {
  const replayHistoryQuery = options.replayHistory === false ? '?replay=0' : '';
  const source = new EventSource(`/api/servers/shells/${encodeURIComponent(sessionId)}/stream${replayHistoryQuery}`);
  source.onmessage = (event) => {
    try {
      onEvent(JSON.parse(event.data) as ServerShellStreamEvent);
    } catch (error) {
      onError(error instanceof Error ? error : new Error('Invalid SSH shell stream event'));
    }
  };
  source.onerror = () => {
    onError(new Error('SSH shell stream disconnected'));
  };
  return source;
}

export function connectServerShellSocket(
  serverId: string,
  dimensions: { cols?: number; rows?: number },
  onEvent: (event: ServerShellStreamEvent) => void,
  onReady: (event: ServerShellSocketReady) => void,
  onError: (error: Error) => void,
  onMetrics?: (metrics: ServerShellSocketMetrics) => void,
  onClose?: (event: ServerShellSocketCloseEvent) => void,
  onOpen?: () => void,
) {
  const shellSocketInputFlushMs = 2;
  const shellSocketInputChunkSize = 8000;
  const shellSocketImmediateInputSize = 8;
  const shellSocketBackpressureBytes = 64 * 1024;
  const shellSocketPingIntervalMs = 4000;
  const shellSocketMetricsIntervalMs = 1000;
  const socket = new WebSocket(buildServerShellSocketUrl());
  let opened = false;
  let ready = false;
  let pendingInput = '';
  let inputFlushTimer: number | null = null;
  let pingTimer: number | null = null;
  let metricsTimer: number | null = null;
  let bytesReceived = 0;
  let lastMetricsBytes = 0;
  let lastMetricsAt = performance.now();
  let latestRttMs: number | null = null;
  let pendingReadyResize: { cols: number; rows: number } | null = null;

  const canSendShellPayload = () => ready && socket.readyState === WebSocket.OPEN;

  const sendInputChunk = (input: string) => {
    if (canSendShellPayload()) {
      socket.send(JSON.stringify({ type: 'input', data: input }));
    }
  };

  const flushInput = () => {
    if (inputFlushTimer !== null) {
      window.clearTimeout(inputFlushTimer);
      inputFlushTimer = null;
    }
    if (!pendingInput || !canSendShellPayload()) {
      return;
    }
    const input = pendingInput;
    pendingInput = '';
    for (let offset = 0; offset < input.length; offset += shellSocketInputChunkSize) {
      sendInputChunk(input.slice(offset, offset + shellSocketInputChunkSize));
    }
  };

  const queueInput = (input: string) => {
    if (!input || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)) {
      return;
    }

    if (
      ready
      && !pendingInput
      && input.length <= shellSocketImmediateInputSize
      && socket.bufferedAmount < shellSocketBackpressureBytes
    ) {
      sendInputChunk(input);
      return;
    }

    pendingInput += input;
    if (
      input.includes('\r')
      || input.includes('\n')
      || input.includes('\u0003')
      || pendingInput.length >= shellSocketInputChunkSize
    ) {
      flushInput();
      return;
    }

    if (!ready) {
      return;
    }

    if (inputFlushTimer === null) {
      inputFlushTimer = window.setTimeout(flushInput, shellSocketInputFlushMs);
    }
  };

  const emitMetrics = () => {
    if (!onMetrics) {
      return;
    }
    const now = performance.now();
    const elapsedSeconds = Math.max((now - lastMetricsAt) / 1000, 0.001);
    const throughputBytesPerSecond = Math.round((bytesReceived - lastMetricsBytes) / elapsedSeconds);
    lastMetricsBytes = bytesReceived;
    lastMetricsAt = now;
    onMetrics({
      bytesReceived,
      throughputBytesPerSecond,
      rttMs: latestRttMs,
    });
  };

  const sendPing = () => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping', sentAt: performance.now() }));
    }
  };

  const stopTimers = () => {
    if (inputFlushTimer !== null) {
      window.clearTimeout(inputFlushTimer);
      inputFlushTimer = null;
    }
    if (pingTimer !== null) {
      window.clearInterval(pingTimer);
      pingTimer = null;
    }
    if (metricsTimer !== null) {
      window.clearInterval(metricsTimer);
      metricsTimer = null;
    }
  };

  socket.addEventListener('open', () => {
    opened = true;
    socket.send(JSON.stringify({ type: 'open', serverId, ...dimensions }));
    onOpen?.();
  });

  socket.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(String(event.data)) as ServerShellStreamEvent | ServerShellSocketReady | ServerShellSocketPong;
      if (payload.type === 'ready') {
        ready = true;
        onReady(payload);
        if (pendingReadyResize) {
          socket.send(JSON.stringify({ type: 'resize', ...pendingReadyResize }));
          pendingReadyResize = null;
        }
        flushInput();
        sendPing();
        pingTimer = window.setInterval(sendPing, shellSocketPingIntervalMs);
        metricsTimer = window.setInterval(emitMetrics, shellSocketMetricsIntervalMs);
        return;
      }
      if (payload.type === 'pong') {
        const sentAt = typeof payload.sentAt === 'number' ? payload.sentAt : null;
        latestRttMs = sentAt === null ? latestRttMs : Math.max(0, Math.round(performance.now() - sentAt));
        emitMetrics();
        return;
      }
      if (payload.type === 'error') {
        const error = new Error(payload.message || 'SSH shell stream failed');
        onError(error);
        if (/session not ready/i.test(error.message) && socket.readyState === WebSocket.OPEN) {
          socket.close(4001, 'shell not ready');
        }
        return;
      }
      if (typeof payload.content === 'string') {
        bytesReceived += payload.content.length;
        if (payload.content.length >= 1024) {
          emitMetrics();
        }
      }
      onEvent(payload);
    } catch (error) {
      onError(error instanceof Error ? error : new Error('Invalid SSH WebSocket event'));
    }
  });

  socket.addEventListener('error', () => {
    onError(new Error('SSH WebSocket connection failed'));
  });

  socket.addEventListener('close', (event) => {
    stopTimers();
    pendingInput = '';
    if (!opened || !ready) {
      onError(new Error('SSH WebSocket connection closed before opening'));
    }
    onClose?.({
      opened,
      ready,
      code: event.code,
      reason: event.reason,
    });
  });

  return {
    sendInput(input: string) {
      queueInput(input);
    },
    resize(nextDimensions: { cols: number; rows: number }) {
      if (canSendShellPayload()) {
        socket.send(JSON.stringify({ type: 'resize', ...nextDimensions }));
        return;
      }
      pendingReadyResize = nextDimensions;
    },
    close() {
      flushInput();
      stopTimers();
      pendingInput = '';
      pendingReadyResize = null;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'close' }));
      }
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    },
  };
}

function buildServerShellSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/servers/shells/ws`;
}

export async function createOperationTask(payload: OperationTaskRequest, fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/operations/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as OperationTaskResponse;
}

export async function fetchMaintenanceWindows(fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/operations/maintenance-windows');

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as MaintenanceWindowsResponse;
}

export async function createMaintenanceWindow(payload: MaintenanceWindowPayload, fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/operations/maintenance-windows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as MaintenanceWindowMutationResponse;
}

export async function deleteMaintenanceWindow(windowId: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/operations/maintenance-windows/${encodeURIComponent(windowId)}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as MaintenanceWindowDeleteResponse;
}

export async function preflightOperationTask(payload: OperationTaskRequest, fetcher: typeof fetch = fetch) {
  const response = await fetcher('/api/operations/tasks/preflight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  return (await response.json()) as OperationTaskPreflightResponse;
}

async function readApiError(response: Response) {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `API returned ${response.status}`;
  } catch {
    return `API returned ${response.status}`;
  }
}
