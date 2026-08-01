import { z } from 'zod';
import type {
  ServerMetricHistoryPoint,
  ServerMetricHistoryResponse,
  ServerMetricHistoryWindow,
  ServerMetricValues,
  ServerNode,
} from '../../types.js';
import { HttpError } from '../httpErrors.js';
import {
  insertServerMetricHistoryRow,
  loadServerMetricHistoryRows,
  readLatestServerMetricHistorySampleAt,
} from './database.js';

const historyWindowDurations: Record<ServerMetricHistoryWindow, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

export const serverMetricHistoryWindowSchema = z.enum(['1h', '6h', '24h', '7d']);
export const serverMetricHistoryRecordIntervalMs = readEnvInteger(
  'COLIPAS_METRIC_HISTORY_INTERVAL_MS',
  5 * 60 * 1000,
  1000,
  60 * 60 * 1000,
);
const serverMetricHistoryRetentionMs = readEnvInteger(
  'COLIPAS_METRIC_HISTORY_RETENTION_MS',
  7 * 24 * 60 * 60 * 1000,
  60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
);
const serverMetricHistoryMaxPointsPerServer = readEnvInteger(
  'COLIPAS_METRIC_HISTORY_MAX_POINTS_PER_SERVER',
  2016,
  48,
  10_000,
);
export const serverMetricHistoryResponsePointLimit = 240;
const latestRecordedAtByServer = new Map<string, number>();

export function recordServerMetricHistory(server: ServerNode, sampledAt: number) {
  const source = server.ssh?.verifyMode;
  if (!server.ssh?.connected || (source !== 'real' && source !== 'simulate')) {
    return false;
  }

  const normalizedSampledAt = normalizeTimestamp(sampledAt);
  if (normalizedSampledAt <= 0) {
    return false;
  }

  let latestRecordedAt = latestRecordedAtByServer.get(server.id);
  if (latestRecordedAt === undefined) {
    latestRecordedAt = readLatestServerMetricHistorySampleAt(server.id) ?? 0;
    latestRecordedAtByServer.set(server.id, latestRecordedAt);
  }
  if (latestRecordedAt > 0 && normalizedSampledAt - latestRecordedAt < serverMetricHistoryRecordIntervalMs) {
    return false;
  }

  const inserted = insertServerMetricHistoryRow({
    server_id: server.id,
    sampled_at: normalizedSampledAt,
    cpu: normalizeMetric(server.cpu),
    memory: normalizeMetric(server.memory),
    disk: normalizeMetric(server.disk),
    source,
  }, normalizedSampledAt - serverMetricHistoryRetentionMs, serverMetricHistoryMaxPointsPerServer);
  if (inserted) {
    latestRecordedAtByServer.set(server.id, normalizedSampledAt);
  }
  return inserted;
}

export function forgetServerMetricHistoryState(serverId: string) {
  latestRecordedAtByServer.delete(serverId);
}

export function buildServerMetricHistory(
  server: ServerNode,
  rawWindow: unknown,
  now = Date.now(),
): ServerMetricHistoryResponse {
  const window = parseHistoryWindow(rawWindow);
  const normalizedNow = normalizeTimestamp(now) || Date.now();
  const from = normalizedNow - historyWindowDurations[window];
  const rows = loadServerMetricHistoryRows(server.id, from);
  const rawPoints = rows.flatMap<ServerMetricHistoryPoint>((row) => {
    const sampledAt = normalizeTimestamp(row.sampled_at);
    if (sampledAt <= 0 || (row.source !== 'real' && row.source !== 'simulate')) {
      return [];
    }
    return [{
      sampledAt: new Date(sampledAt).toISOString(),
      cpu: normalizeMetric(row.cpu),
      memory: normalizeMetric(row.memory),
      disk: normalizeMetric(row.disk),
      source: row.source,
    }];
  });
  const points = downsampleServerMetricHistory(rawPoints, serverMetricHistoryResponsePointLimit);

  return {
    server: {
      id: server.id,
      name: server.name,
    },
    window,
    range: {
      from: new Date(from).toISOString(),
      to: new Date(normalizedNow).toISOString(),
    },
    telemetry: server.telemetry ?? { status: 'unavailable', sampledAt: null },
    summary: buildMetricHistorySummary(rawPoints, points.length),
    points,
  };
}

export function downsampleServerMetricHistory(
  points: ServerMetricHistoryPoint[],
  limit = serverMetricHistoryResponsePointLimit,
) {
  const boundedLimit = Math.max(3, Math.floor(limit));
  if (points.length <= boundedLimit) {
    return points;
  }

  const samples = points.map((point) => ({ point, time: Date.parse(point.sampledAt) }));
  const selected: ServerMetricHistoryPoint[] = [points[0]];
  const interiorCount = points.length - 2;
  const bucketCount = boundedLimit - 2;
  let anchorIndex = 0;

  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const bucketStart = 1 + Math.floor((bucketIndex * interiorCount) / bucketCount);
    const bucketEnd = 1 + Math.floor(((bucketIndex + 1) * interiorCount) / bucketCount);
    const nextStart = bucketEnd;
    const nextEnd = bucketIndex === bucketCount - 1
      ? points.length
      : 1 + Math.floor(((bucketIndex + 2) * interiorCount) / bucketCount);
    const nextAverage = averageSample(samples, nextStart, nextEnd);
    const anchor = samples[anchorIndex];
    let selectedIndex = bucketStart;
    let selectedScore = -1;

    for (let index = bucketStart; index < bucketEnd; index += 1) {
      const score = multiMetricTriangleScore(anchor, samples[index], nextAverage);
      if (score > selectedScore) {
        selectedScore = score;
        selectedIndex = index;
      }
    }

    selected.push(points[selectedIndex]);
    anchorIndex = selectedIndex;
  }

  selected.push(points[points.length - 1]);
  return selected;
}

function buildMetricHistorySummary(
  points: ServerMetricHistoryPoint[],
  returnedPoints: number,
): ServerMetricHistoryResponse['summary'] {
  const sources: ServerMetricHistoryResponse['summary']['sources'] = { real: 0, simulate: 0 };
  if (points.length === 0) {
    return {
      rawPoints: 0,
      returnedPoints,
      intervalMinutes: Math.max(1, Math.round(serverMetricHistoryRecordIntervalMs / 60_000)),
      continuityPercent: null,
      latest: null,
      average: null,
      peak: null,
      change: null,
      trend: 'insufficient' as const,
      sources,
    };
  }

  const totals: ServerMetricValues = { cpu: 0, memory: 0, disk: 0 };
  const peak: ServerMetricValues = { cpu: 0, memory: 0, disk: 0 };
  for (const point of points) {
    totals.cpu += point.cpu;
    totals.memory += point.memory;
    totals.disk += point.disk;
    peak.cpu = Math.max(peak.cpu, point.cpu);
    peak.memory = Math.max(peak.memory, point.memory);
    peak.disk = Math.max(peak.disk, point.disk);
    sources[point.source] += 1;
  }

  const first = points[0];
  const last = points[points.length - 1];
  const latest = pickMetricValues(last);
  const average = {
    cpu: Math.round(totals.cpu / points.length),
    memory: Math.round(totals.memory / points.length),
    disk: Math.round(totals.disk / points.length),
  };
  const change = points.length > 1 ? {
    cpu: last.cpu - first.cpu,
    memory: last.memory - first.memory,
    disk: last.disk - first.disk,
  } : null;
  const strongestChange = change
    ? [change.cpu, change.memory, change.disk].reduce((current, value) => (
      Math.abs(value) > Math.abs(current) ? value : current
    ), 0)
    : 0;
  const trend = !change
    ? 'insufficient'
    : Math.abs(strongestChange) < 3
      ? 'stable'
      : strongestChange > 0
        ? 'rising'
        : 'falling';
  const firstAt = Date.parse(first.sampledAt);
  const lastAt = Date.parse(last.sampledAt);
  const expectedPoints = points.length > 1 && Number.isFinite(firstAt) && Number.isFinite(lastAt)
    ? Math.floor(Math.max(0, lastAt - firstAt) / serverMetricHistoryRecordIntervalMs) + 1
    : 1;

  return {
    rawPoints: points.length,
    returnedPoints,
    intervalMinutes: Math.max(1, Math.round(serverMetricHistoryRecordIntervalMs / 60_000)),
    continuityPercent: points.length > 1
      ? Math.min(100, Math.round((points.length / Math.max(1, expectedPoints)) * 100))
      : null,
    latest,
    average,
    peak,
    change,
    trend,
    sources,
  };
}

function parseHistoryWindow(rawWindow: unknown): ServerMetricHistoryWindow {
  const candidate = Array.isArray(rawWindow) ? rawWindow[0] : rawWindow;
  const result = serverMetricHistoryWindowSchema.safeParse(candidate ?? '24h');
  if (!result.success) {
    throw new HttpError(400, 'Metric history window must be one of 1h, 6h, 24h, or 7d', 'INVALID_METRIC_HISTORY_WINDOW');
  }
  return result.data;
}

function averageSample(
  samples: Array<{ point: ServerMetricHistoryPoint; time: number }>,
  start: number,
  end: number,
) {
  const boundedStart = Math.min(samples.length - 1, Math.max(0, start));
  const boundedEnd = Math.min(samples.length, Math.max(boundedStart + 1, end));
  let time = 0;
  const values: ServerMetricValues = { cpu: 0, memory: 0, disk: 0 };
  for (let index = boundedStart; index < boundedEnd; index += 1) {
    time += samples[index].time;
    values.cpu += samples[index].point.cpu;
    values.memory += samples[index].point.memory;
    values.disk += samples[index].point.disk;
  }
  const count = boundedEnd - boundedStart;
  return {
    time: time / count,
    point: {
      sampledAt: new Date(time / count).toISOString(),
      cpu: values.cpu / count,
      memory: values.memory / count,
      disk: values.disk / count,
      source: samples[boundedStart].point.source,
    },
  };
}

function multiMetricTriangleScore(
  anchor: { point: ServerMetricHistoryPoint; time: number },
  candidate: { point: ServerMetricHistoryPoint; time: number },
  target: { point: ServerMetricHistoryPoint; time: number },
) {
  const leftSpan = anchor.time - target.time;
  const candidateSpan = candidate.time - anchor.time;
  return (['cpu', 'memory', 'disk'] as const).reduce((score, metric) => score + Math.abs(
    leftSpan * (candidate.point[metric] - anchor.point[metric])
      - candidateSpan * (target.point[metric] - anchor.point[metric]),
  ), 0);
}

function pickMetricValues(point: ServerMetricHistoryPoint): ServerMetricValues {
  return {
    cpu: point.cpu,
    memory: point.memory,
    disk: point.disk,
  };
}

function normalizeMetric(value: number) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
}

function normalizeTimestamp(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function readEnvInteger(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}
