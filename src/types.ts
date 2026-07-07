export type CloudProvider = string;

export type CloudAccountStatus = 'connected' | 'warning' | 'disconnected';

export interface CloudAccount {
  id: string;
  provider: CloudProvider;
  name: string;
  regionCount: number;
  status: CloudAccountStatus;
  lastSync: string;
  monthlyCost: number;
}

export type ServerStatus = 'running' | 'stopped' | 'warning' | 'provisioning' | 'unconnected';

export type SshAuthType = 'password' | 'privateKey';

export type SshVerifyMode = 'assetOnly' | 'real' | 'simulate';

export interface ServerSshAccess {
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  connected: boolean;
  lastVerifiedAt: string;
  verifyMode: SshVerifyMode;
  fingerprint?: string;
}

export interface ServerNode {
  id: string;
  name: string;
  provider: CloudProvider;
  region: string;
  status: ServerStatus;
  publicIp: string;
  privateIp: string;
  os: string;
  cpu: number;
  memory: number;
  disk: number;
  tags: string[];
  ssh?: ServerSshAccess;
}

export interface SshRunbookCommand {
  id: string;
  title: string;
  command: string;
  pinned?: boolean;
  useCount?: number;
  lastUsedAt?: string;
  lastUsedMode?: 'insert' | 'run';
  createdAt: string;
  updatedAt: string;
}

export type EventSeverity = 'info' | 'warning' | 'critical';

export interface OperationEvent {
  id: string;
  time: string;
  title: string;
  severity: EventSeverity;
  source: string;
  status: 'open' | 'closed';
}

export interface AIProviderConfig {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
}

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CustomApiConfig {
  name: string;
  method: ApiMethod;
  url: string;
  headersText: string;
  bodyText: string;
  authToken?: string;
}

export interface PreparedApiRequest {
  method: ApiMethod;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export type OperationTaskType = 'assetSync' | 'healthCheck' | 'sshCommand' | 'powerOn' | 'shutdown' | 'reboot';

export type OperationTaskTargetMode = 'allServers' | 'allConnected' | 'selected';

export type OperationTaskStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed';

export type AuditCorrelationId = string;

export interface OperationTaskRequest {
  type: OperationTaskType;
  targetMode: OperationTaskTargetMode;
  serverIds?: string[];
  command?: string;
  reason?: string;
  confirmed?: boolean;
  correlationId?: AuditCorrelationId;
}

export interface OperationTaskPreflightIssue {
  code:
    | 'OPERATIONS_CONFIRMATION_REQUIRED'
    | 'OPERATIONS_NO_TARGETS'
    | 'OPERATIONS_TARGETS_NOT_FOUND'
    | 'OPERATIONS_TARGETS_UNCONNECTED';
  severity: 'warn' | 'block';
  message: string;
  count: number;
}

export interface OperationTaskPreflightTargetIssue {
  code: OperationTaskPreflightIssue['code'];
  severity: OperationTaskPreflightIssue['severity'];
  message: string;
}

export interface OperationTaskPreflightTarget {
  id: string;
  name: string;
  provider: CloudProvider;
  region: string;
  status: ServerStatus | 'missing';
  sshConnected: boolean;
  runnable: boolean;
  issues: OperationTaskPreflightTargetIssue[];
}

export interface OperationTaskPreflightResponse {
  ok: boolean;
  correlationId: AuditCorrelationId;
  type: OperationTaskType;
  targetMode: OperationTaskTargetMode;
  requiresSsh: boolean;
  requiresConfirmation: boolean;
  plan: {
    title: string;
    targetSummary: string;
    impact: string;
    commandPreview?: string;
    riskSummary: string;
  };
  summary: {
    totalTargets: number;
    runnableTargets: number;
    missingTargets: number;
    disconnectedTargets: number;
    blocked: number;
  };
  issues: OperationTaskPreflightIssue[];
  targets: OperationTaskPreflightTarget[];
  targetsTruncated?: boolean;
  targetLimit?: number;
  omittedTargets?: number;
  generatedAt: string;
}

export interface OperationTaskTargetResult {
  serverId: string;
  serverName: string;
  status: 'success' | 'failed' | 'skipped';
  output: string;
  command?: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface OperationTaskResponse {
  id: string;
  correlationId: AuditCorrelationId;
  type: OperationTaskType;
  targetMode: OperationTaskTargetMode;
  status: OperationTaskStatus;
  startedAt: string;
  finishedAt: string;
  summary: {
    total: number;
    success: number;
    failed: number;
    skipped: number;
  };
  outputs: OperationTaskTargetResult[];
  outputsTruncated?: boolean;
  outputLimit?: number;
  omittedOutputs?: number;
  message: string;
}

export type ReleaseReadinessSeverity = 'info' | 'warn' | 'fail';

export type ReleaseReadinessModule = 'ai' | 'api' | 'audit' | 'database' | 'deployment' | 'events' | 'runtime' | 'security' | 'servers' | 'ssh';

export interface ReleaseReadinessCheck {
  id: string;
  label: string;
  severity: ReleaseReadinessSeverity;
  passed: boolean;
  value: string;
  evidence: string;
  recommendedAction: string;
  relatedModule: ReleaseReadinessModule;
}

export type ReleaseReadinessStatus = 'ready' | 'review' | 'blocked';

export type ReleaseReadinessTrendDirection = 'up' | 'down' | 'flat' | 'new';

export interface ReleaseReadinessSnapshot {
  id: string;
  createdAt: string;
  score: number;
  status: ReleaseReadinessStatus;
  summary: ReleaseReadinessResponse['summary'];
  blockerIds: string[];
  blockerLabels: string[];
  nextBestAction: string;
}

export interface ReleaseReadinessTrend {
  direction: ReleaseReadinessTrendDirection;
  deltaScore: number;
  previousScore?: number;
  snapshotCount: number;
  changedBlockers: string[];
}

export interface ReleaseReadinessHistory {
  snapshots: ReleaseReadinessSnapshot[];
  trend: ReleaseReadinessTrend;
}

export interface ReleaseReadinessResponse {
  score: number;
  status: ReleaseReadinessStatus;
  generatedAt: string;
  summary: {
    totalChecks: number;
    passed: number;
    warnings: number;
    failures: number;
  };
  checks: ReleaseReadinessCheck[];
  blockers: ReleaseReadinessCheck[];
  nextBestAction: string;
  history: ReleaseReadinessHistory;
}

export interface ReleaseReadinessSnapshotResponse {
  ok: true;
  snapshot: ReleaseReadinessSnapshot;
  readiness: ReleaseReadinessResponse;
}

export interface ReleaseReadinessReportResponse {
  generatedAt: string;
  filename: string;
  contentType: 'text/markdown';
  markdown: string;
}

export interface DiagnosticExportResponse {
  generatedAt: string;
  filename: string;
  contentType: 'application/json';
  runtime: {
    nodeEnv: string;
    uptimeSeconds: number;
    database: {
      driver: 'sqlite';
      name: string;
    };
  };
  config: {
    customApiAllowedHosts: number;
    customApiTimeoutMs: number;
    ai: {
      baseUrlHost: string;
      model: string;
      configured: boolean;
      managedBy?: 'database' | 'environment' | 'none';
    };
    security: {
      adminPasswordDefault: boolean;
      sessionSecretDefault: boolean;
      credentialEncryptionKeyConfigured: boolean;
      credentialEncryptionKeyDefault: boolean;
    };
  };
  readiness: {
    score: number;
    status: ReleaseReadinessStatus;
    summary: ReleaseReadinessResponse['summary'];
    nextBestAction: string;
    checks: Array<Pick<ReleaseReadinessCheck, 'id' | 'label' | 'severity' | 'passed' | 'value' | 'relatedModule'>>;
  };
  audit: {
    total: number;
    byStatus: Record<'success' | 'blocked' | 'failed', number>;
    byAction: Record<string, number>;
    last24h: number;
  };
  inventory: {
    servers: {
      total: number;
      running: number;
      stopped: number;
      unconnected: number;
      connectedSsh: number;
    };
    cloudAccounts: {
      total: number;
      connected: number;
      warning: number;
      disconnected: number;
      providers: number;
    };
    regions: number;
    customProviders: number;
    openEvents: number;
  };
  sshTerminal: {
    activeSessions: number;
    byMode: Record<SshVerifyMode, number>;
    oldestConnectedAt: string | null;
    newestConnectedAt: string | null;
    websocket: {
      totalConnections: number;
      activeConnections: number;
      openedShells: number;
      closedShells: number;
      inputEvents: number;
      inputFlushes: number;
      inputBytes: number;
      outputEvents: number;
      outputFlushes: number;
      outputBytes: number;
      pingCount: number;
      pongCount: number;
      errors: number;
      lastActivityAt: string | null;
    };
    lastSelfTest: {
      serverName: string;
      mode: SshVerifyMode;
      status: 'complete' | 'timeout' | 'failed';
      lines: number;
      durationMs: number;
      linesPerSecond: number;
      firstResponseMs: number;
      outputSpanMs: number;
      rttMs: number | null;
      throughputBytesPerSecond: number;
      networkLabel: string;
      bottleneck: 'healthy' | 'network' | 'throughput' | 'terminal' | 'connection';
      recordedAt: string;
      active: boolean;
    } | null;
    selfTestTrend: {
      samples: number;
      direction: 'unknown' | 'stable' | 'improving' | 'degrading';
      averageDurationMs: number;
      averageFirstResponseMs: number;
      averageOutputSpanMs: number;
      latestDurationMs: number;
      previousDurationMs: number | null;
      latestBottleneck: 'healthy' | 'network' | 'throughput' | 'terminal' | 'connection' | null;
    };
    productionProbeTrend: {
      samples: number;
      tone: 'ok' | 'warn' | 'fail';
      targetLabel: string | null;
      deploymentMode: string | null;
      successRate: number;
      sessionReadyRate: number;
      cleanupRate: number;
      latestRoundTripMs: number | null;
      averageRoundTripMs: number | null;
      previousRoundTripMs: number | null;
      direction: 'unknown' | 'stable' | 'improving' | 'degrading';
      recent: Array<{
        id: string;
        recordedAt: string;
        targetLabel: string;
        deploymentMode: string;
        ok: boolean;
        cleanupOk: boolean;
        roundTripMs: number | null;
        probeCount: number;
        failedProbeCount: number;
        sessionReadyCount: number;
        primaryKind: string;
        primaryMode: string;
        tone: 'ok' | 'warn' | 'fail';
      }>;
    };
    productionProbeSchedule: {
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
    };
    recentEvidence: Array<{
      serverName: string;
      mode: SshVerifyMode;
      active: boolean;
      updatedAt: string;
      transcriptLines: number;
      transcriptChars: number;
    }>;
    sessionReplays: Array<{
      serverName: string;
      mode: SshVerifyMode;
      active: boolean;
      connectedAt: string;
      closedAt: string | null;
      durationMs: number;
      inputEvents: number;
      inputBytes: number;
      inputSubmits: number;
      outputEvents: number;
      outputBytes: number;
      outputLines: number;
      errorCount: number;
      closeSignal: string | null;
      lastEventAt: string;
      timeline: Array<{
        type: 'start' | 'input' | 'stdout' | 'stderr' | 'close' | 'error';
        at: string;
        bytes: number;
        lines: number;
      }>;
    }>;
  };
}

export interface ReleaseDeploymentEvidence {
  targetName: string;
  channel: string;
  deploymentMode: string;
  publicHost: string;
  gitCommit: string;
  artifactId: string;
  deployedAt: string;
  configured: boolean;
  evidence: string;
}

export interface ReleaseVerificationResponse {
  ok: true;
  generatedAt: string;
  runtime: {
    nodeEnv: string;
    uptimeSeconds: number;
  };
  deployment: ReleaseDeploymentEvidence;
  frontend: {
    indexHash: string;
    scripts: Array<{
      path: string;
      bytes: number;
      hash: string;
    }>;
    featureMarkers: Record<string, boolean>;
  };
  readiness: {
    score: number;
    status: ReleaseReadinessStatus;
    summary: ReleaseReadinessResponse['summary'];
    blockerCount: number;
    nextBestAction: string;
  };
  audit: {
    total: number;
    byStatus: Record<'success' | 'blocked' | 'failed', number>;
    last24h: number;
  };
  inventory: {
    servers: {
      total: number;
      running: number;
      stopped: number;
      unconnected: number;
      sshConnected: number;
    };
    cloudAccounts: {
      total: number;
      connected: number;
      warning: number;
      disconnected: number;
    };
    openEvents: number;
    regions: number;
  };
  security: {
    adminPasswordDefault: boolean;
    sessionSecretDefault: boolean;
    credentialEncryptionKeyConfigured: boolean;
    credentialEncryptionKeyDefault: boolean;
  };
}
