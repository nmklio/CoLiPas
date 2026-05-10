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

export interface OperationTaskRequest {
  type: OperationTaskType;
  targetMode: OperationTaskTargetMode;
  serverIds?: string[];
  command?: string;
  reason?: string;
  confirmed?: boolean;
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
  message: string;
}

export type ReleaseReadinessSeverity = 'info' | 'warn' | 'fail';

export interface ReleaseReadinessCheck {
  id: string;
  label: string;
  severity: ReleaseReadinessSeverity;
  passed: boolean;
  value: string;
  evidence: string;
  recommendedAction: string;
  relatedModule: 'ai' | 'api' | 'audit' | 'database' | 'events' | 'runtime' | 'servers' | 'ssh';
}

export interface ReleaseReadinessResponse {
  score: number;
  status: 'ready' | 'review' | 'blocked';
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
}
