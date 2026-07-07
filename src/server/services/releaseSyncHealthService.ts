import { performance } from 'node:perf_hooks';
import type { ReleaseSyncHealthResponse, ReleaseSyncTargetHealth, ReleaseSyncTargetStatus } from '../../types.js';
import type { RuntimeConfig } from '../config.js';

const RELEASE_SYNC_TIMEOUT_MS = 3500;

export async function checkReleaseSyncHealth(config: RuntimeConfig): Promise<ReleaseSyncHealthResponse> {
  const generatedAt = new Date().toISOString();
  const expectedCommit = shortCommit(config.release.gitCommit);
  const targets = await Promise.all(
    config.release.syncTargets.map((target) => checkReleaseSyncTarget(target.name, target.baseUrl, expectedCommit)),
  );
  const summary = targets.reduce(
    (accumulator, target) => {
      accumulator.total += 1;
      accumulator[target.status] += 1;
      return accumulator;
    },
    { total: 0, ok: 0, mismatch: 0, unreachable: 0, invalid: 0 },
  );

  return {
    ok: targets.length > 0 && summary.ok === targets.length,
    generatedAt,
    expectedCommit,
    summary,
    targets,
  };
}

async function checkReleaseSyncTarget(name: string, baseUrl: string, expectedCommit: string): Promise<ReleaseSyncTargetHealth> {
  const checkedAt = new Date().toISOString();
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELEASE_SYNC_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/health`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const responseMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      return buildTargetHealth(name, 'unreachable', expectedCommit, '', '', responseMs, checkedAt, `Health HTTP ${response.status}`);
    }

    const body = await response.json() as {
      status?: string;
      release?: {
        gitCommit?: string;
        deploymentMode?: string;
      };
    };
    const observedCommit = shortCommit(body.release?.gitCommit ?? '');
    const deploymentMode = sanitizeSyncText(body.release?.deploymentMode ?? '');
    if (body.status !== 'ok' || !observedCommit) {
      return buildTargetHealth(name, 'invalid', expectedCommit, observedCommit, deploymentMode, responseMs, checkedAt, 'Health payload missing release evidence');
    }

    const status: ReleaseSyncTargetStatus = expectedCommit && observedCommit === expectedCommit ? 'ok' : 'mismatch';
    return buildTargetHealth(
      name,
      status,
      expectedCommit,
      observedCommit,
      deploymentMode,
      responseMs,
      checkedAt,
      status === 'ok' ? 'Commit matched expected release' : 'Commit differs from expected release',
    );
  } catch (error) {
    const responseMs = Math.round(performance.now() - startedAt);
    return buildTargetHealth(
      name,
      'unreachable',
      expectedCommit,
      '',
      '',
      responseMs,
      checkedAt,
      error instanceof Error && error.name === 'AbortError' ? 'Health request timed out' : 'Health request failed',
    );
  } finally {
    clearTimeout(timeout);
  }
}

function buildTargetHealth(
  name: string,
  status: ReleaseSyncTargetStatus,
  expectedCommit: string,
  observedCommit: string,
  deploymentMode: string,
  responseMs: number | null,
  checkedAt: string,
  detail: string,
): ReleaseSyncTargetHealth {
  return {
    name: sanitizeSyncText(name).slice(0, 48) || 'target',
    status,
    expectedCommit,
    observedCommit,
    deploymentMode: sanitizeSyncText(deploymentMode).slice(0, 32),
    responseMs,
    checkedAt,
    detail: sanitizeSyncText(detail),
  };
}

function shortCommit(value: string) {
  return sanitizeSyncText(value).replace(/[^a-f0-9]/gi, '').slice(0, 12);
}

function sanitizeSyncText(value: string) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-api-key]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]')
    .trim();
}
