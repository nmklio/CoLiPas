import { operationEvents, servers } from '../../data/mockData.js';
import type {
  ReleaseReadinessCheck,
  ReleaseReadinessHistory,
  ReleaseReadinessResponse,
  ReleaseReadinessSnapshot,
  ReleaseReadinessSnapshotResponse,
  ReleaseReadinessTrend,
} from '../../types.js';
import { RuntimeConfig } from '../config.js';
import { getDatabasePath, readAppSetting, writeAppSetting } from './database.js';
import { listAuditEntries } from './auditService.js';
import { resolveServerLifecycleStatus } from '../../shared/serverFilters.js';

const readinessHistorySettingId = 'release-readiness-history';
const maxReadinessSnapshots = 12;

export function buildReleaseReadiness(config: RuntimeConfig): ReleaseReadinessResponse {
  const auditEntries = listAuditEntries();
  const activeAuditIssues = getActiveAuditIssues();
  const connectedServers = servers.filter((server) => resolveServerLifecycleStatus(server) !== 'unconnected');
  const openEvents = operationEvents.filter((event) => event.status === 'open');
  const databaseName = getDatabasePath().split(/[\\/]/).pop() ?? 'unknown';

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
      severity: config.ai.apiKey ? 'info' : 'warn',
      passed: Boolean(config.ai.apiKey),
      value: config.ai.apiKey ? config.ai.model : 'simulation mode',
      evidence: config.ai.apiKey ? `Server-side AI model configured: ${config.ai.model}` : 'No server AI key configured; local rule analysis remains available.',
      recommendedAction: config.ai.apiKey ? 'Continue using server-side key custody.' : 'Add AI_API_KEY on the server when real model answers are required.',
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
