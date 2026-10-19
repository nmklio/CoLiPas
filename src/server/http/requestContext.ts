import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Request correlation + structured access logging + in-process API metrics.
 *
 * Design notes:
 *  - Correlation ids let a browser console error, an nginx access line and a
 *    server log line be matched without exposing anything user-specific.
 *  - Only the pathname is logged. Query strings are never emitted, because they
 *    can carry tokens and user data.
 *  - Logging is the noisy part and is switchable (`COLIPAS_REQUEST_LOG=0`);
 *    counters stay on so `/api/health/` keeps reporting load either way.
 *  - Static asset requests are not logged, keeping the access stream readable.
 */

const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const STATIC_ASSET_PATH = /\.(?:js|mjs|css|map|png|svg|jpe?g|webp|avif|ico|woff2?|ttf)$/i;
const LATENCY_SAMPLE_LIMIT = 512;

export interface RequestContextOptions {
  enabled: boolean;
  slowRequestMs?: number;
  now?: () => number;
}

export interface RequestMetricsSnapshot {
  total: number;
  ok: number;
  clientError: number;
  serverError: number;
  aborted: number;
  slow: number;
  inFlight: number;
  latencyMs: { p50: number | null; p95: number | null; max: number | null };
  windowSize: number;
}

const counters = {
  total: 0,
  ok: 0,
  clientError: 0,
  serverError: 0,
  aborted: 0,
  slow: 0,
  inFlight: 0,
};

const latencySamples: number[] = [];

function recordLatency(durationMs: number) {
  latencySamples.push(durationMs);
  if (latencySamples.length > LATENCY_SAMPLE_LIMIT) {
    latencySamples.splice(0, latencySamples.length - LATENCY_SAMPLE_LIMIT);
  }
}

function percentile(sortedSamples: number[], fraction: number) {
  if (sortedSamples.length === 0) {
    return null;
  }
  const index = Math.min(sortedSamples.length - 1, Math.max(0, Math.ceil(fraction * sortedSamples.length) - 1));
  return Math.round(sortedSamples[index]);
}

export function readRequestMetrics(): RequestMetricsSnapshot {
  const sortedSamples = [...latencySamples].sort((left, right) => left - right);
  return {
    total: counters.total,
    ok: counters.ok,
    clientError: counters.clientError,
    serverError: counters.serverError,
    aborted: counters.aborted,
    slow: counters.slow,
    inFlight: counters.inFlight,
    latencyMs: {
      p50: percentile(sortedSamples, 0.5),
      p95: percentile(sortedSamples, 0.95),
      max: sortedSamples.length > 0 ? Math.round(sortedSamples[sortedSamples.length - 1]) : null,
    },
    windowSize: sortedSamples.length,
  };
}

/** Test helper: reset counters between assertions. */
export function resetRequestMetrics() {
  counters.total = 0;
  counters.ok = 0;
  counters.clientError = 0;
  counters.serverError = 0;
  counters.aborted = 0;
  counters.slow = 0;
  counters.inFlight = 0;
  latencySamples.length = 0;
}

export function getRequestId(response: Response): string {
  const id = response.locals?.requestId;
  return typeof id === 'string' ? id : '';
}

function resolveIncomingRequestId(request: Request): string {
  const header = request.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
}

export function createRequestContext(options: RequestContextOptions) {
  const slowRequestMs = options.slowRequestMs ?? 1000;
  const now = options.now ?? (() => Date.now());

  return function requestContext(request: Request, response: Response, next: NextFunction) {
    const startedAt = now();
    const requestId = resolveIncomingRequestId(request);
    response.locals.requestId = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);

    const pathname = request.path || '/';
    const isApiRequest = pathname.startsWith('/api');
    const isStaticAsset = STATIC_ASSET_PATH.test(pathname);

    if (isApiRequest) {
      counters.inFlight += 1;
    }

    let settled = false;
    const finish = (aborted: boolean) => {
      if (settled) {
        return;
      }
      settled = true;

      const durationMs = Math.max(0, now() - startedAt);
      const status = aborted ? 0 : response.statusCode;

      if (isApiRequest) {
        counters.inFlight = Math.max(0, counters.inFlight - 1);
        counters.total += 1;
        recordLatency(durationMs);
        if (aborted) {
          counters.aborted += 1;
        } else if (status >= 500) {
          counters.serverError += 1;
        } else if (status >= 400) {
          counters.clientError += 1;
        } else {
          counters.ok += 1;
        }
        if (durationMs >= slowRequestMs) {
          counters.slow += 1;
        }
      }

      if (!options.enabled || isStaticAsset) {
        return;
      }

      const level = aborted || status >= 500 ? 'warn' : durationMs >= slowRequestMs ? 'info' : 'debug';
      const payload = {
        t: new Date().toISOString(),
        level,
        msg: 'http',
        id: requestId,
        method: request.method,
        path: pathname,
        status: aborted ? 'aborted' : status,
        ms: Math.round(durationMs),
      };

      // Warnings always surface; routine lines respect COLIPAS_LOG_LEVEL when set.
      if (level === 'debug' && !shouldLogDebug()) {
        return;
      }
      console.log(JSON.stringify(payload));
    };

    response.once('finish', () => finish(false));
    response.once('close', () => finish(!response.writableFinished));

    next();
  };
}

function shouldLogDebug() {
  const level = (process.env.COLIPAS_LOG_LEVEL ?? '').trim().toLowerCase();
  return level === 'debug' || level === 'trace';
}
