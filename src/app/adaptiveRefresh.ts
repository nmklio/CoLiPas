export type AdaptiveRefreshStatus = 'active' | 'paused' | 'offline' | 'retrying';

export const adaptiveOverviewRefreshIntervals = {
  standardMs: 15_000,
  performanceMs: 30_000,
  maxRetryMs: 120_000,
} as const;

export function getOverviewRefreshInterval(performanceMode: boolean) {
  return performanceMode
    ? adaptiveOverviewRefreshIntervals.performanceMs
    : adaptiveOverviewRefreshIntervals.standardMs;
}

interface AdaptiveRefreshDelayOptions {
  performanceMode: boolean;
  failureCount?: number;
  lastSuccessAt: number | null;
  now?: number;
}

export function getAdaptiveRefreshDelay(options: AdaptiveRefreshDelayOptions) {
  const interval = getOverviewRefreshInterval(options.performanceMode);
  const failureCount = Math.max(0, Math.min(Math.trunc(options.failureCount ?? 0), 3));
  if (failureCount > 0) {
    return Math.min(interval * (2 ** failureCount), adaptiveOverviewRefreshIntervals.maxRetryMs);
  }

  if (options.lastSuccessAt === null) {
    return interval;
  }

  const age = Math.max(0, (options.now ?? Date.now()) - options.lastSuccessAt);
  return Math.max(0, interval - age);
}

export function getOverviewRefreshDelay(options: AdaptiveRefreshDelayOptions) {
  return getAdaptiveRefreshDelay(options);
}

export function resolveAdaptiveRefreshStatus(
  visibilityState: DocumentVisibilityState,
  online: boolean,
): Exclude<AdaptiveRefreshStatus, 'retrying'> {
  if (!online) {
    return 'offline';
  }
  return visibilityState === 'visible' ? 'active' : 'paused';
}
