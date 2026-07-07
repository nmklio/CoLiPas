import { z } from 'zod';
import { operationEvents, servers } from '../../data/mockData.js';
import type {
  ReleaseGatePolicy,
  ReleaseReadinessCheck,
  ReleaseReadinessHistory,
  ReleaseReadinessReportResponse,
  ReleaseReadinessResponse,
  ReleaseReadinessSnapshot,
  ReleaseReadinessSnapshotResponse,
  ReleaseReadinessTrend,
} from '../../types.js';
import { RuntimeConfig } from '../config.js';
import { getDatabasePath, readAppSetting, writeAppSetting } from './database.js';
import { listAuditEntries, recordAudit } from './auditService.js';
import { resolveServerLifecycleStatus } from '../../shared/serverFilters.js';
import { buildReleaseDeploymentEvidence } from './deploymentEvidenceService.js';
import { getAiProviderStatus } from './aiSettingsService.js';

const readinessHistorySettingId = 'release-readiness-history';
const readinessGatePolicySettingId = 'release-gate-policy.v1';
const maxReadinessSnapshots = 12;
const gatePolicyScoreOptions = [60, 70, 80, 90] as const;
const gatePolicyWarningOptions = [0, 1, 2, 3, 5] as const;

const storedGatePolicySchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  minScore: z.number().int().min(0).max(100),
  maxWarnings: z.number().int().min(0).max(20),
  requireZeroFailures: z.boolean(),
  requireConnectedSsh: z.boolean(),
  requireAiProvider: z.boolean(),
  updatedAt: z.string().trim().min(1).max(80).nullable(),
  updatedBy: z.string().trim().min(1).max(80).nullable(),
});

const gatePolicyUpdateSchema = z.object({
  enabled: z.boolean(),
  minScore: z.coerce.number().int().refine((value) => gatePolicyScoreOptions.includes(value as (typeof gatePolicyScoreOptions)[number]), 'Release gate score floor is invalid'),
  maxWarnings: z.coerce.number().int().refine((value) => gatePolicyWarningOptions.includes(value as (typeof gatePolicyWarningOptions)[number]), 'Release gate warning ceiling is invalid'),
  requireZeroFailures: z.boolean(),
  requireConnectedSsh: z.boolean(),
  requireAiProvider: z.boolean(),
});

type StoredReleaseGatePolicy = z.infer<typeof storedGatePolicySchema>;
type ReleaseGatePolicyInput = Pick<
  ReleaseGatePolicy,
  | 'enabled'
  | 'minScore'
  | 'maxWarnings'
  | 'requireZeroFailures'
  | 'requireConnectedSsh'
  | 'requireAiProvider'
  | 'updatedAt'
  | 'updatedBy'
>;

export function buildReleaseReadiness(config: RuntimeConfig): ReleaseReadinessResponse {
  const auditEntries = listAuditEntries();
  const activeAuditIssues = getActiveAuditIssues();
  const connectedServers = servers.filter((server) => resolveServerLifecycleStatus(server) !== 'unconnected');
  const openEvents = operationEvents.filter((event) => event.status === 'open');
  const databaseName = getDatabasePath().split(/[\\/]/).pop() ?? 'unknown';
  const deploymentEvidence = buildReleaseDeploymentEvidence(config);
  const aiProvider = getAiProviderStatus(config);
  const defaultSecretIssues = [
    config.security.adminPasswordDefault ? 'admin password' : '',
    config.security.sessionSecretDefault ? 'session secret' : '',
    config.security.credentialEncryptionKeyDefault ? 'credential encryption key' : '',
  ].filter(Boolean);

  const checks: ReleaseReadinessCheck[] = [
    {
      id: 'runtime-production',
      label: 'Runtime environment',
      severity: config.nodeEnv === 'production' ? 'info' : 'warn',
      passed: config.nodeEnv === 'production',
      value: config.nodeEnv,
      evidence: `NODE_ENV=${config.nodeEnv}`,
      recommendedAction: config.nodeEnv === 'production' ? 'Keep production runtime guard active.' : 'Use NODE_ENV=production before public release.',
      relatedModule: 'runtime',
    },
    {
      id: 'database-online',
      label: 'SQLite persistence',
      severity: 'info',
      passed: true,
      value: databaseName,
      evidence: `SQLite store opened as ${databaseName}`,
      recommendedAction: 'Keep database backup and WAL checkpoint checks in the release runbook.',
      relatedModule: 'database',
    },
    {
      id: 'deployment-evidence',
      label: 'Deployment evidence',
      severity: deploymentEvidence.configured ? 'info' : 'warn',
      passed: deploymentEvidence.configured,
      value: deploymentEvidence.gitCommit,
      evidence: deploymentEvidence.evidence,
      recommendedAction: deploymentEvidence.configured
        ? 'Keep RELEASE_TARGET_NAME, RELEASE_PUBLIC_URL, and RELEASE_GIT_COMMIT updated from the release pipeline.'
        : 'Set RELEASE_TARGET_NAME, RELEASE_PUBLIC_URL, and RELEASE_GIT_COMMIT so every running instance reports sanitized deployment coverage.',
      relatedModule: 'deployment',
    },
    {
      id: 'runtime-secret-posture',
      label: 'Runtime secret posture',
      severity: defaultSecretIssues.length > 0 ? 'fail' : 'info',
      passed: defaultSecretIssues.length === 0,
      value: defaultSecretIssues.length > 0 ? `${defaultSecretIssues.length} default(s)` : 'hardened',
      evidence: defaultSecretIssues.length > 0
        ? `Default runtime secret(s) detected: ${defaultSecretIssues.join(', ')}`
        : 'Admin password, session secret, and SSH credential encryption key are not using built-in defaults.',
      recommendedAction: defaultSecretIssues.length > 0
        ? 'Set ADMIN_PASSWORD, SESSION_SECRET, and CREDENTIAL_ENCRYPTION_KEY to unique production values before release.'
        : 'Keep production secrets outside the repository and rotate them through the deployment environment.',
      relatedModule: 'security',
    },
    {
      id: 'api-allowlist',
      label: 'Custom API allowlist',
      severity: config.customApiAllowedHosts.length > 0 ? 'info' : 'fail',
      passed: config.customApiAllowedHosts.length > 0,
      value: `${config.customApiAllowedHosts.length} host(s)`,
      evidence: config.customApiAllowedHosts.length > 0 ? 'Outbound custom API proxy is constrained by host allowlist.' : 'No custom API host allowlist is configured.',
      recommendedAction: 'Configure CUSTOM_API_ALLOWED_HOSTS with only required upstream domains.',
      relatedModule: 'api',
    },
    {
      id: 'ai-runtime',
      label: 'AI provider key',
      severity: aiProvider.configured ? 'info' : 'warn',
      passed: aiProvider.configured,
      value: aiProvider.configured ? aiProvider.model : 'simulation mode',
      evidence: aiProvider.configured
        ? `Server-side AI model configured through ${aiProvider.managedBy} custody: ${aiProvider.model}`
        : 'No server AI key configured; local rule analysis remains available.',
      recommendedAction: aiProvider.configured ? 'Continue using server-side key custody.' : 'Save an AI provider key in settings or set AI_API_KEY on the server when real model answers are required.',
      relatedModule: 'ai',
    },
    {
      id: 'ssh-coverage',
      label: 'SSH coverage',
      severity: connectedServers.length > 0 ? 'info' : 'warn',
      passed: connectedServers.length > 0,
      value: `${connectedServers.length}/${servers.length}`,
      evidence: `${connectedServers.length} of ${servers.length} server asset(s) are SSH-connected.`,
      recommendedAction: connectedServers.length > 0 ? 'Run a sample health check before release.' : 'Connect at least one server with password or key authentication to verify terminal flows.',
      relatedModule: 'ssh',
    },
    {
      id: 'open-events',
      label: 'Open operation events',
      severity: openEvents.length === 0 ? 'info' : 'warn',
      passed: openEvents.length === 0,
      value: `${openEvents.length}`,
      evidence: `${openEvents.length} open event(s) are waiting in the operations queue.`,
      recommendedAction: openEvents.length === 0 ? 'No event action required.' : 'Review and close open events from security remediation or operations center.',
      relatedModule: 'events',
    },
    {
      id: 'audit-failures',
      label: 'Audit failures',
      severity: activeAuditIssues.some((entry) => entry.status === 'failed') ? 'fail' : activeAuditIssues.length > 0 ? 'warn' : 'info',
      passed: activeAuditIssues.length === 0,
      value: `${activeAuditIssues.length}`,
      evidence: `${activeAuditIssues.length} blocked or failed audit item(s) remain active.`,
      recommendedAction: activeAuditIssues.length === 0 ? 'Keep audit export available for release evidence.' : 'Review failed/blocked audit records and remediate before release.',
      relatedModule: 'audit',
    },
  ];

  const failures = checks.filter((check) => check.severity === 'fail').length;
  const warnings = checks.filter((check) => check.severity === 'warn').length;
  const passed = checks.filter((check) => check.passed).length;
  const score = Math.max(0, Math.round((passed / checks.length) * 100 - failures * 12 - warnings * 4));
  const blockers = checks.filter((check) => check.severity === 'fail' || (!check.passed && check.relatedModule === 'audit'));
  const gatePolicy = evaluateReleaseGatePolicy(loadStoredReleaseGatePolicy(), {
    score,
    warnings,
    failures,
    connectedSsh: connectedServers.length,
    aiConfigured: aiProvider.configured,
  });
  const currentSnapshot = createSnapshot({
    score,
    status: failures > 0 ? 'blocked' : warnings > 0 ? 'review' : 'ready',
    summary: {
      totalChecks: checks.length,
      passed,
      warnings,
      failures,
    },
    blockers,
    nextBestAction: blockers[0]?.recommendedAction ?? checks.find((check) => !check.passed)?.recommendedAction ?? 'Run the regular smoke suite and publish through the release pipeline.',
  });
  const persistedHistory = loadReadinessHistory();
  const history = buildHistory(currentSnapshot, persistedHistory.snapshots);

  return {
    score,
    status: currentSnapshot.status,
    generatedAt: new Date().toISOString(),
    summary: currentSnapshot.summary,
    checks,
    blockers,
    nextBestAction: currentSnapshot.nextBestAction,
    history,
    gatePolicy,
  };
}

export function getReleaseGatePolicy(config: RuntimeConfig) {
  return buildReleaseReadiness(config).gatePolicy;
}

export function updateReleaseGatePolicy(config: RuntimeConfig, input: unknown, actor: string) {
  const parsed = gatePolicyUpdateSchema.parse(input);
  const next: StoredReleaseGatePolicy = {
    version: 1,
    enabled: parsed.enabled,
    minScore: parsed.minScore,
    maxWarnings: parsed.maxWarnings,
    requireZeroFailures: parsed.requireZeroFailures,
    requireConnectedSsh: parsed.requireConnectedSsh,
    requireAiProvider: parsed.requireAiProvider,
    updatedAt: new Date().toISOString(),
    updatedBy: sanitizeActor(actor),
  };
  writeAppSetting(readinessGatePolicySettingId, next);
  recordAudit({
    action: 'RELEASE_GATE_POLICY_UPDATE',
    actor: sanitizeActor(actor),
    target: 'release-gate-policy',
    status: 'success',
    detail: `Release gate policy ${next.enabled ? 'enabled' : 'disabled'} at score ${next.minScore}, max warnings ${next.maxWarnings}, zero failures ${next.requireZeroFailures ? 'on' : 'off'}, SSH ${next.requireConnectedSsh ? 'required' : 'optional'}, AI ${next.requireAiProvider ? 'required' : 'optional'}.`,
  });
  const readiness = buildReleaseReadiness(config);
  return {
    ok: true,
    policy: readiness.gatePolicy,
    readiness,
  };
}

export function recordReleaseReadinessSnapshot(config: RuntimeConfig): ReleaseReadinessSnapshotResponse {
  const readiness = buildReleaseReadiness(config);
  const snapshot = createSnapshot({
    score: readiness.score,
    status: readiness.status,
    summary: readiness.summary,
    blockers: readiness.blockers,
    nextBestAction: readiness.nextBestAction,
  });
  const history = loadReadinessHistory();
  const snapshots = [snapshot, ...history.snapshots.filter((item) => item.id !== snapshot.id)].slice(0, maxReadinessSnapshots);
  const savedHistory = buildHistory(snapshot, snapshots);
  writeAppSetting(readinessHistorySettingId, { snapshots: savedHistory.snapshots });

  return {
    ok: true,
    snapshot,
    readiness: {
      ...readiness,
      history: savedHistory,
    },
  };
}

export function buildReleaseReadinessReport(config: RuntimeConfig): ReleaseReadinessReportResponse {
  const readiness = buildReleaseReadiness(config);
  const generatedAt = new Date().toISOString();
  const trend = readiness.history.trend;
  const latestSnapshots = readiness.history.snapshots.slice(0, 5);
  const markdown = [
    '# CoLiPas云服务器管理面板 Release Readiness Report',
    '',
    `- Generated at: ${generatedAt}`,
    `- Score: ${readiness.score}`,
    `- Status: ${readiness.status}`,
    `- Checks: ${readiness.summary.passed}/${readiness.summary.totalChecks} passed`,
    `- Findings: ${readiness.summary.failures} blockers / ${readiness.summary.warnings} warnings`,
    `- Trend: ${formatTrend(trend.direction, trend.deltaScore, trend.previousScore)}`,
    `- Snapshot count: ${trend.snapshotCount}`,
    '',
    '## Next Best Action',
    '',
    `- ${readiness.nextBestAction}`,
    '',
    '## Release Gate Policy',
    '',
    ...formatGatePolicy(readiness.gatePolicy),
    '',
    '## Blockers',
    '',
    ...formatReportBlockers(readiness.blockers),
    '',
    '## Checks',
    '',
    ...readiness.checks.map((check) => [
      `### ${check.label}`,
      '',
      `- Severity: ${check.severity}`,
      `- Passed: ${check.passed ? 'yes' : 'no'}`,
      `- Value: ${sanitizeReportText(check.value)}`,
      `- Evidence: ${sanitizeReportText(check.evidence)}`,
      `- Recommended action: ${sanitizeReportText(check.recommendedAction)}`,
      `- Related module: ${check.relatedModule}`,
      '',
    ].join('\n')),
    '## Recent Snapshots',
    '',
    ...formatReportSnapshots(latestSnapshots),
  ].join('\n');

  return {
    generatedAt,
    filename: `colipas-readiness-${generatedAt.slice(0, 10)}.md`,
    contentType: 'text/markdown',
    markdown,
  };
}

export function getActiveAuditIssues() {
  const auditEntries = listAuditEntries();
  const lastAuditReview = getLastRemediationTime(auditEntries, 'audit-errors');
  return auditEntries.filter((entry) => {
    if (entry.action === 'SECURITY_REMEDIATION') {
      return false;
    }

    if (lastAuditReview && new Date(entry.createdAt).getTime() <= lastAuditReview) {
      return false;
    }

    return entry.status === 'blocked' || entry.status === 'failed';
  });
}

function formatReportBlockers(blockers: ReleaseReadinessCheck[]) {
  if (blockers.length === 0) {
    return ['- No blocking readiness checks.'];
  }

  return blockers.map((blocker) => `- ${blocker.label}: ${sanitizeReportText(blocker.evidence)} Next: ${sanitizeReportText(blocker.recommendedAction)}`);
}

function formatReportSnapshots(snapshots: ReleaseReadinessSnapshot[]) {
  if (snapshots.length === 0) {
    return ['- No recorded snapshots yet.'];
  }

  return snapshots.map((snapshot) => `- ${snapshot.createdAt}: score ${snapshot.score}, status ${snapshot.status}, blockers ${snapshot.blockerLabels.length ? snapshot.blockerLabels.map(sanitizeReportText).join(', ') : 'none'}`);
}

function formatGatePolicy(policy: ReleaseGatePolicy) {
  return [
    `- Enabled: ${policy.enabled ? 'yes' : 'no'}`,
    `- Decision: ${policy.status}`,
    `- Score floor: ${policy.minScore}`,
    `- Warning ceiling: ${policy.maxWarnings}`,
    `- Required guards: zero failures ${policy.requireZeroFailures ? 'yes' : 'no'}, SSH coverage ${policy.requireConnectedSsh ? 'yes' : 'no'}, AI provider ${policy.requireAiProvider ? 'yes' : 'no'}`,
    `- Observed state: score ${policy.observed.score}, warnings ${policy.observed.warnings}, failures ${policy.observed.failures}, SSH ${policy.observed.connectedSsh}, AI configured ${policy.observed.aiConfigured ? 'yes' : 'no'}`,
    ...(policy.reasons.length > 0 ? policy.reasons.map((reason) => `- Reason: ${sanitizeReportText(reason)}`) : ['- Reason: gate satisfied']),
  ];
}

function formatTrend(direction: ReleaseReadinessTrend['direction'], deltaScore: number, previousScore?: number) {
  if (direction === 'new') {
    return 'no previous snapshot';
  }

  const previous = typeof previousScore === 'number' ? ` from ${previousScore}` : '';
  if (direction === 'up') {
    return `up ${deltaScore} point(s)${previous}`;
  }
  if (direction === 'down') {
    return `down ${Math.abs(deltaScore)} point(s)${previous}`;
  }
  return `flat${previous}`;
}

function sanitizeReportText(value: string) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-api-key]')
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/\/\/([^/\s:@]+):([^@\s/]+)@/g, '//[redacted]@')
    .slice(0, 1000);
}

function loadStoredReleaseGatePolicy() {
  try {
    const row = readAppSetting(readinessGatePolicySettingId);
    if (!row) {
      return null;
    }
    return storedGatePolicySchema.parse(JSON.parse(row.payload));
  } catch {
    return null;
  }
}

export function evaluateReleaseGatePolicy(
  stored: ReleaseGatePolicyInput | StoredReleaseGatePolicy | null | undefined,
  observed: ReleaseGatePolicy['observed'],
): ReleaseGatePolicy {
  const policy: ReleaseGatePolicyInput = stored ? {
    enabled: stored.enabled,
    minScore: stored.minScore,
    maxWarnings: stored.maxWarnings,
    requireZeroFailures: stored.requireZeroFailures,
    requireConnectedSsh: stored.requireConnectedSsh,
    requireAiProvider: stored.requireAiProvider,
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  } : {
    enabled: true,
    minScore: 80,
    maxWarnings: 1,
    requireZeroFailures: true,
    requireConnectedSsh: true,
    requireAiProvider: false,
    updatedAt: null,
    updatedBy: null,
  };
  const reasons: string[] = [];

  if (policy.enabled) {
    if (observed.score < policy.minScore) {
      reasons.push(`Readiness score ${observed.score} is below the gate floor ${policy.minScore}.`);
    }
    if (observed.warnings > policy.maxWarnings) {
      reasons.push(`Warning count ${observed.warnings} exceeds the gate ceiling ${policy.maxWarnings}.`);
    }
    if (policy.requireZeroFailures && observed.failures > 0) {
      reasons.push(`${observed.failures} blocking release check(s) are still failing.`);
    }
    if (policy.requireConnectedSsh && observed.connectedSsh === 0) {
      reasons.push('No SSH-connected server is available for release validation.');
    }
    if (policy.requireAiProvider && !observed.aiConfigured) {
      reasons.push('No server-side AI provider key is configured for the release gate.');
    }
  }

  return {
    enabled: policy.enabled,
    minScore: policy.minScore,
    maxWarnings: policy.maxWarnings,
    requireZeroFailures: policy.requireZeroFailures,
    requireConnectedSsh: policy.requireConnectedSsh,
    requireAiProvider: policy.requireAiProvider,
    updatedAt: policy.updatedAt,
    updatedBy: policy.updatedBy,
    status: !policy.enabled ? 'disabled' : reasons.length > 0 ? 'blocked' : 'pass',
    allowedToRelease: !policy.enabled || reasons.length === 0,
    activeRuleCount: policy.enabled
      ? 2
        + Number(policy.requireZeroFailures)
        + Number(policy.requireConnectedSsh)
        + Number(policy.requireAiProvider)
      : 0,
    reasons,
    observed,
  };
}

function sanitizeActor(value: string) {
  const sanitized = value
    .replace(/[^\p{L}\p{N}_.@-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return sanitized || 'operator';
}

function createSnapshot(input: {
  score: number;
  status: ReleaseReadinessSnapshot['status'];
  summary: ReleaseReadinessSnapshot['summary'];
  blockers: ReleaseReadinessCheck[];
  nextBestAction: string;
}): ReleaseReadinessSnapshot {
  const createdAt = new Date().toISOString();
  return {
    id: `ready-${createdAt.replace(/[:.]/g, '-')}`,
    createdAt,
    score: input.score,
    status: input.status,
    summary: input.summary,
    blockerIds: input.blockers.map((check) => check.id),
    blockerLabels: input.blockers.map((check) => check.label),
    nextBestAction: input.nextBestAction,
  };
}

function loadReadinessHistory(): ReleaseReadinessHistory {
  try {
    const row = readAppSetting(readinessHistorySettingId);
    if (!row) {
      return buildHistory(null, []);
    }

    const parsed = JSON.parse(row.payload) as { snapshots?: ReleaseReadinessSnapshot[] };
    const snapshots = Array.isArray(parsed.snapshots)
      ? parsed.snapshots.filter(isReadinessSnapshot).slice(0, maxReadinessSnapshots)
      : [];
    return buildHistory(null, snapshots);
  } catch {
    return buildHistory(null, []);
  }
}

function buildHistory(current: ReleaseReadinessSnapshot | null, snapshots: ReleaseReadinessSnapshot[]): ReleaseReadinessHistory {
  const orderedSnapshots = snapshots.slice(0, maxReadinessSnapshots);
  return {
    snapshots: orderedSnapshots,
    trend: buildTrend(current ?? orderedSnapshots[0] ?? null, orderedSnapshots),
  };
}

function buildTrend(current: ReleaseReadinessSnapshot | null, snapshots: ReleaseReadinessSnapshot[]): ReleaseReadinessTrend {
  if (!current) {
    return {
      direction: 'new',
      deltaScore: 0,
      snapshotCount: 0,
      changedBlockers: [],
    };
  }

  const previous = snapshots.find((snapshot) => snapshot.id !== current.id);
  if (!previous) {
    return {
      direction: snapshots.length > 0 ? 'flat' : 'new',
      deltaScore: 0,
      snapshotCount: snapshots.length,
      changedBlockers: [],
    };
  }

  const deltaScore = current.score - previous.score;
  const previousBlockers = new Set(previous.blockerIds);
  const currentBlockers = new Set(current.blockerIds);
  const changedBlockers = [
    ...current.blockerLabels.filter((label, index) => !previousBlockers.has(current.blockerIds[index])),
    ...previous.blockerLabels.filter((label, index) => !currentBlockers.has(previous.blockerIds[index])),
  ];

  return {
    direction: deltaScore > 0 ? 'up' : deltaScore < 0 ? 'down' : 'flat',
    deltaScore,
    previousScore: previous.score,
    snapshotCount: snapshots.length,
    changedBlockers,
  };
}

function getLastRemediationTime(auditEntries: ReturnType<typeof listAuditEntries>, target: string) {
  const remediation = auditEntries.find((entry) => entry.action === 'SECURITY_REMEDIATION' && entry.target === target);
  return remediation ? new Date(remediation.createdAt).getTime() : 0;
}

function isReadinessSnapshot(value: unknown): value is ReleaseReadinessSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const snapshot = value as Partial<ReleaseReadinessSnapshot>;
  return (
    typeof snapshot.id === 'string'
    && typeof snapshot.createdAt === 'string'
    && typeof snapshot.score === 'number'
    && (snapshot.status === 'ready' || snapshot.status === 'review' || snapshot.status === 'blocked')
    && Array.isArray(snapshot.blockerIds)
    && Array.isArray(snapshot.blockerLabels)
    && typeof snapshot.nextBestAction === 'string'
  );
}
