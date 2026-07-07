import { z } from 'zod';
import { recordAudit } from './auditService.js';
import { readAppSetting, writeAppSetting } from './database.js';

const sshProductionProbeHistoryKey = 'ssh-production-probe-history.v1';
const sshProductionProbeHistoryLimit = 24;
const sshProductionProbeRecentLimit = 6;

const probeRecordSchema = z.object({
  targetLabel: z.string().trim().min(1).max(80),
  deploymentMode: z.string().trim().min(1).max(40),
  ok: z.boolean(),
  durationMs: z.coerce.number().min(0).max(120_000).optional(),
  activeShellsAfter: z.coerce.number().int().min(0).max(200).nullable().optional(),
  inventory: z.object({
    total: z.coerce.number().int().min(0).max(100_000),
    connected: z.coerce.number().int().min(0).max(100_000),
    modes: z.record(z.string(), z.coerce.number().int().min(0).max(100_000)).optional().default({}),
  }),
  probes: z.array(z.object({
    kind: z.string().trim().min(1).max(40),
    mode: z.string().trim().min(1).max(40),
    ok: z.boolean(),
    sessionReady: z.boolean(),
    durationMs: z.coerce.number().min(0).max(60_000).nullable().optional(),
  })).min(1).max(6),
  recordedAt: z.string().trim().max(80).optional(),
});

const storedProbeSchema = z.object({
  version: z.literal(1),
  id: z.string().trim().min(1).max(80),
  recordedAt: z.string().trim().min(1).max(80),
  targetLabel: z.string().trim().min(1).max(80),
  deploymentMode: z.string().trim().min(1).max(40),
  ok: z.boolean(),
  cleanupOk: z.boolean(),
  totalServers: z.number().int().min(0),
  connectedServers: z.number().int().min(0),
  modeSummary: z.record(z.string(), z.number().int().min(0)),
  probeCount: z.number().int().min(1),
  failedProbeCount: z.number().int().min(0),
  sessionReadyCount: z.number().int().min(0),
  primaryKind: z.string().trim().min(1).max(80),
  primaryMode: z.string().trim().min(1).max(80),
  roundTripMs: z.number().min(0).nullable(),
  durationMs: z.number().min(0).nullable(),
});

type StoredSshProductionProbeRecord = z.infer<typeof storedProbeSchema>;

export interface SshProductionProbeTrendSummary {
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
}

export function recordSshProductionProbe(input: unknown, actor: string) {
  const parsed = probeRecordSchema.parse(input);
  const now = toIsoTimestamp(parsed.recordedAt);
  const targetLabel = sanitizeHumanLabel(parsed.targetLabel, 'Production target');
  const deploymentMode = sanitizeHumanLabel(parsed.deploymentMode, 'production');
  const probeCount = parsed.probes.length;
  const sessionReadyCount = parsed.probes.filter((probe) => probe.sessionReady).length;
  const failedProbeCount = parsed.probes.filter((probe) => !probe.ok || !probe.sessionReady).length;
  const modeSummaryEntries = Object.entries(parsed.inventory.modes)
    .map(([mode, count]) => [sanitizeHumanLabel(mode, 'unknown'), count] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const modeSummary = Object.fromEntries(modeSummaryEntries);
  const primaryProbe = parsed.probes[0];
  const roundTripValues = parsed.probes
    .map((probe) => (typeof probe.durationMs === 'number' && Number.isFinite(probe.durationMs) ? probe.durationMs : null))
    .filter((value): value is number => value !== null);
  const roundTripMs = roundTripValues.length > 0
    ? Math.round(roundTripValues.reduce((total, value) => total + value, 0) / roundTripValues.length)
    : null;
  const durationMs = typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs)
    ? Math.round(parsed.durationMs)
    : roundTripMs;

  const record: StoredSshProductionProbeRecord = {
    version: 1,
    id: `ssh-prod-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    recordedAt: now,
    targetLabel,
    deploymentMode,
    ok: parsed.ok && failedProbeCount === 0,
    cleanupOk: (parsed.activeShellsAfter ?? 0) === 0,
    totalServers: parsed.inventory.total,
    connectedServers: Math.min(parsed.inventory.connected, parsed.inventory.total),
    modeSummary,
    probeCount,
    failedProbeCount,
    sessionReadyCount,
    primaryKind: sanitizeHumanLabel(primaryProbe.kind, 'probe'),
    primaryMode: sanitizeHumanLabel(primaryProbe.mode, 'unknown'),
    roundTripMs,
    durationMs,
  };

  const history = [record, ...loadSshProductionProbeHistory()]
    .slice(0, sshProductionProbeHistoryLimit);
  writeAppSetting(sshProductionProbeHistoryKey, history);

  const audit = recordAudit({
    action: 'SSH_PRODUCTION_PROBE',
    actor,
    target: targetLabel,
    status: record.ok ? 'success' : 'failed',
    detail: `Recorded sanitized production SSH probe for ${targetLabel} (${deploymentMode}); ${record.probeCount} probe(s), ${record.failedProbeCount} issue(s), cleanup ${record.cleanupOk ? 'ok' : 'pending'}.`,
  });

  return {
    ok: true,
    sample: record,
    trend: getSshProductionProbeTrend(),
    audit,
  };
}

export function getSshProductionProbeTrend(): SshProductionProbeTrendSummary {
  const history = loadSshProductionProbeHistory();
  if (history.length === 0) {
    return {
      samples: 0,
      tone: 'warn',
      targetLabel: null,
      deploymentMode: null,
      successRate: 0,
      sessionReadyRate: 0,
      cleanupRate: 0,
      latestRoundTripMs: null,
      averageRoundTripMs: null,
      previousRoundTripMs: null,
      direction: 'unknown',
      recent: [],
    };
  }

  const recent = history.slice(0, sshProductionProbeRecentLimit);
  const latest = recent[0];
  const previousWithLatency = recent
    .slice(1)
    .find((item) => typeof item.roundTripMs === 'number' && Number.isFinite(item.roundTripMs)) ?? null;
  const latestRoundTripMs = typeof latest.roundTripMs === 'number' ? latest.roundTripMs : null;
  const previousRoundTripMs = previousWithLatency?.roundTripMs ?? null;
  const roundTripValues = history
    .map((item) => item.roundTripMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const averageRoundTripMs = roundTripValues.length > 0
    ? Math.round(roundTripValues.reduce((total, value) => total + value, 0) / roundTripValues.length)
    : null;
  const totalProbeCount = history.reduce((total, item) => total + item.probeCount, 0);
  const totalSessionReady = history.reduce((total, item) => total + item.sessionReadyCount, 0);
  const successRate = toPercent(history.filter((item) => item.ok).length, history.length);
  const sessionReadyRate = toPercent(totalSessionReady, totalProbeCount);
  const cleanupRate = toPercent(history.filter((item) => item.cleanupOk).length, history.length);
  const direction = inferDirection(latestRoundTripMs, previousRoundTripMs);
  const tone = determineTrendTone(latest, successRate, sessionReadyRate, cleanupRate, direction);

  return {
    samples: history.length,
    tone,
    targetLabel: latest.targetLabel,
    deploymentMode: latest.deploymentMode,
    successRate,
    sessionReadyRate,
    cleanupRate,
    latestRoundTripMs,
    averageRoundTripMs,
    previousRoundTripMs,
    direction,
    recent: recent.map((item) => ({
      id: item.id,
      recordedAt: item.recordedAt,
      targetLabel: item.targetLabel,
      deploymentMode: item.deploymentMode,
      ok: item.ok,
      cleanupOk: item.cleanupOk,
      roundTripMs: item.roundTripMs,
      probeCount: item.probeCount,
      failedProbeCount: item.failedProbeCount,
      sessionReadyCount: item.sessionReadyCount,
      primaryKind: item.primaryKind,
      primaryMode: item.primaryMode,
      tone: determineSampleTone(item),
    })),
  };
}

function loadSshProductionProbeHistory() {
  const row = readAppSetting(sshProductionProbeHistoryKey);
  if (!row) {
    return [] as StoredSshProductionProbeRecord[];
  }

  try {
    return z.array(storedProbeSchema).parse(JSON.parse(row.payload))
      .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
      .slice(0, sshProductionProbeHistoryLimit);
  } catch {
    return [];
  }
}

function determineTrendTone(
  latest: StoredSshProductionProbeRecord,
  successRate: number,
  sessionReadyRate: number,
  cleanupRate: number,
  direction: SshProductionProbeTrendSummary['direction'],
) {
  if (!latest.ok || !latest.cleanupOk || latest.failedProbeCount > 0 || latest.sessionReadyCount < latest.probeCount) {
    return 'fail';
  }
  if (
    successRate < 100
    || sessionReadyRate < 100
    || cleanupRate < 100
    || direction === 'degrading'
    || (typeof latest.roundTripMs === 'number' && latest.roundTripMs >= 1800)
  ) {
    return 'warn';
  }
  return 'ok';
}

function determineSampleTone(sample: StoredSshProductionProbeRecord) {
  if (!sample.ok || !sample.cleanupOk || sample.failedProbeCount > 0 || sample.sessionReadyCount < sample.probeCount) {
    return 'fail';
  }
  if (typeof sample.roundTripMs === 'number' && sample.roundTripMs >= 1800) {
    return 'warn';
  }
  return 'ok';
}

function inferDirection(latest: number | null, previous: number | null): SshProductionProbeTrendSummary['direction'] {
  if (latest === null || previous === null) {
    return 'unknown';
  }
  const delta = latest - previous;
  if (Math.abs(delta) < 120) {
    return 'stable';
  }
  return delta < 0 ? 'improving' : 'degrading';
}

function sanitizeHumanLabel(value: string, fallback: string) {
  const sanitized = value
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s._-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return sanitized || fallback;
}

function toIsoTimestamp(value?: string) {
  if (!value) {
    return new Date().toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function toPercent(value: number, total: number) {
  if (total <= 0) {
    return 0;
  }
  return Math.round((value / total) * 100);
}
