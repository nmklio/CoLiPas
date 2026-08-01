import type { ServerNode, ServerTelemetry } from '../types.js';

export interface ServerMetricSampleState {
  sampledAt: number;
  failedAt: number;
}

export function recordServerTelemetrySuccess(sampledAt: number): ServerMetricSampleState {
  return {
    sampledAt: normalizeTimestamp(sampledAt),
    failedAt: 0,
  };
}

export function recordServerTelemetryFailure(
  previous: ServerMetricSampleState | undefined,
  failedAt: number,
): ServerMetricSampleState {
  return {
    sampledAt: previous?.sampledAt ?? 0,
    failedAt: normalizeTimestamp(failedAt),
  };
}

export function resolveServerTelemetry(
  connected: boolean,
  sample: ServerMetricSampleState | undefined,
): ServerTelemetry {
  if (!connected || !sample || sample.sampledAt <= 0) {
    return { status: 'unavailable', sampledAt: null };
  }

  return {
    status: sample.failedAt > sample.sampledAt ? 'stale' : 'fresh',
    sampledAt: new Date(sample.sampledAt).toISOString(),
  };
}

export function hasFreshServerTelemetry(server: Pick<ServerNode, 'telemetry'>) {
  return server.telemetry?.status === 'fresh';
}

function normalizeTimestamp(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
