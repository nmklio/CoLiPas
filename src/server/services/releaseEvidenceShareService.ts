import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  PublicReleaseEvidenceShare,
  ReleaseEvidenceShareAdmin,
  ReleaseEvidenceShareCreateResponse,
  ReleaseEvidenceShareListResponse,
  ReleaseEvidenceShareState,
  ReleaseReadinessResponse,
} from '../../types.js';
import type { RuntimeConfig } from '../config.js';
import { HttpError } from '../httpErrors.js';
import { recordAudit } from './auditService.js';
import { readAppSetting, writeAppSetting } from './database.js';
import { buildReleaseReadiness } from './releaseReadinessService.js';

const evidenceShareSettingId = 'release-evidence-shares.v1';
const maxActiveShares = 8;
const tokenBytes = 32;
const expirationHours = [1, 24, 72] as const;

const createShareSchema = z.object({
  expiresInHours: z.coerce.number().int().refine(
    (value) => expirationHours.includes(value as (typeof expirationHours)[number]),
    'Evidence share expiry is invalid',
  ).default(24),
});

const storedShareSchema = z.object({
  version: z.literal(1),
  id: z.string().trim().regex(/^release-share-[a-f0-9-]{36}$/),
  tokenHash: z.string().trim().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  createdBy: z.string().trim().min(1).max(80),
  revokedAt: z.string().datetime().nullable(),
  accessedAt: z.string().datetime().nullable(),
  accessCount: z.number().int().min(0).max(100_000_000),
  snapshot: z.object({
    version: z.literal(1),
    sharedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    score: z.number().int().min(0).max(100),
    status: z.enum(['ready', 'review', 'blocked']),
    summary: z.object({
      totalChecks: z.number().int().min(0).max(100),
      passed: z.number().int().min(0).max(100),
      warnings: z.number().int().min(0).max(100),
      failures: z.number().int().min(0).max(100),
    }),
    gate: z.object({
      status: z.enum(['disabled', 'pass', 'blocked']),
      allowedToRelease: z.boolean(),
    }),
    highlights: z.array(z.object({
      id: z.string().trim().min(1).max(80),
      label: z.string().trim().min(1).max(120),
      severity: z.enum(['info', 'warn', 'fail']),
      passed: z.boolean(),
    })).max(8),
    nextBestAction: z.string().trim().min(1).max(700),
    disclosure: z.string().trim().min(1).max(700),
  }),
});

type StoredReleaseEvidenceShare = z.infer<typeof storedShareSchema>;

export function createReleaseEvidenceShare(
  config: RuntimeConfig,
  input: unknown,
  actor: string,
): ReleaseEvidenceShareCreateResponse {
  const { expiresInHours } = createShareSchema.parse(input ?? {});
  const now = new Date();
  const stored = loadStoredShares();
  const activeCount = stored.filter((share) => resolveShareState(share, now) === 'active').length;
  if (activeCount >= maxActiveShares) {
    throw new HttpError(409, `At most ${maxActiveShares} active evidence shares are allowed. Revoke an existing share first.`, 'RELEASE_EVIDENCE_SHARE_LIMIT');
  }

  const token = randomBytes(tokenBytes).toString('base64url');
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiresInHours * 60 * 60 * 1000).toISOString();
  const readiness = buildReleaseReadiness(config);
  const share: StoredReleaseEvidenceShare = {
    version: 1,
    id: `release-share-${randomUUID()}`,
    tokenHash: hashToken(token),
    createdAt,
    expiresAt,
    createdBy: sanitizeActor(actor),
    revokedAt: null,
    accessedAt: null,
    accessCount: 0,
    snapshot: createPublicSnapshot(readiness, createdAt, expiresAt),
  };

  persistShares([share, ...stored]);
  recordAudit({
    action: 'RELEASE_EVIDENCE_SHARE_CREATE',
    actor: share.createdBy,
    target: share.id,
    status: 'success',
    detail: `Sanitized release evidence share created with ${expiresInHours}h expiry.`,
  });

  return {
    ok: true,
    share: toAdminShare(share, now),
    sharePath: `/share/release/${token}`,
  };
}

export function listReleaseEvidenceShares(): ReleaseEvidenceShareListResponse {
  const now = new Date();
  return {
    items: loadStoredShares()
      .map((share) => toAdminShare(share, now))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  };
}

export function revokeReleaseEvidenceShare(id: string, actor: string) {
  const normalizedId = z.string().trim().regex(/^release-share-[a-f0-9-]{36}$/).parse(id);
  const now = new Date();
  const shares = loadStoredShares();
  const target = shares.find((share) => share.id === normalizedId);
  if (!target) {
    throw new HttpError(404, 'Evidence share not found.', 'RELEASE_EVIDENCE_SHARE_NOT_FOUND');
  }

  if (!target.revokedAt) {
    target.revokedAt = now.toISOString();
    persistShares(shares);
    recordAudit({
      action: 'RELEASE_EVIDENCE_SHARE_REVOKE',
      actor: sanitizeActor(actor),
      target: target.id,
      status: 'success',
      detail: 'Sanitized release evidence share revoked.',
    });
  }

  return {
    ok: true,
    share: toAdminShare(target, now),
  };
}

export function readPublicReleaseEvidenceShare(token: string): PublicReleaseEvidenceShare {
  const normalizedToken = z.string().trim().regex(/^[A-Za-z0-9_-]{40,96}$/).safeParse(token);
  if (!normalizedToken.success) {
    throw new HttpError(404, 'Shared evidence is unavailable.', 'RELEASE_EVIDENCE_SHARE_UNAVAILABLE');
  }

  const now = new Date();
  const shares = loadStoredShares();
  const share = shares.find((item) => safeTokenHashEqual(item.tokenHash, hashToken(normalizedToken.data)));
  if (!share || resolveShareState(share, now) !== 'active') {
    throw new HttpError(404, 'Shared evidence is unavailable.', 'RELEASE_EVIDENCE_SHARE_UNAVAILABLE');
  }

  share.accessCount = Math.min(100_000_000, share.accessCount + 1);
  share.accessedAt = now.toISOString();
  persistShares(shares);
  recordAudit({
    action: 'RELEASE_EVIDENCE_SHARE_READ',
    actor: 'public-share',
    target: share.id,
    status: 'success',
    detail: 'Sanitized release evidence share viewed.',
  });

  return share.snapshot;
}

function createPublicSnapshot(
  readiness: ReleaseReadinessResponse,
  sharedAt: string,
  expiresAt: string,
): PublicReleaseEvidenceShare {
  const actionableChecks = [
    ...readiness.checks.filter((check) => check.severity === 'fail' || check.severity === 'warn'),
    ...readiness.checks.filter((check) => check.severity === 'info'),
  ].slice(0, 6);

  return {
    version: 1,
    sharedAt,
    expiresAt,
    score: readiness.score,
    status: readiness.status,
    summary: {
      totalChecks: readiness.summary.totalChecks,
      passed: readiness.summary.passed,
      warnings: readiness.summary.warnings,
      failures: readiness.summary.failures,
    },
    gate: {
      status: readiness.gatePolicy.status,
      allowedToRelease: readiness.gatePolicy.allowedToRelease,
    },
    highlights: actionableChecks.map((check) => ({
      id: check.id,
      label: sanitizeSnapshotText(check.label, 120),
      severity: check.severity,
      passed: check.passed,
    })),
    nextBestAction: sanitizeSnapshotText(readiness.nextBestAction, 700),
    disclosure: 'This fixed, read-only snapshot contains aggregate release checks only. Server addresses, deployment targets, commit identifiers, commands, credentials, audit details, and user data are excluded.',
  };
}

function loadStoredShares() {
  try {
    const row = readAppSetting(evidenceShareSettingId);
    if (!row) {
      return [] as StoredReleaseEvidenceShare[];
    }
    const parsed = z.object({ shares: z.array(storedShareSchema) }).parse(JSON.parse(row.payload));
    return parsed.shares;
  } catch {
    return [] as StoredReleaseEvidenceShare[];
  }
}

function persistShares(shares: StoredReleaseEvidenceShare[]) {
  writeAppSetting(evidenceShareSettingId, {
    shares: shares
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  });
}

function toAdminShare(share: StoredReleaseEvidenceShare, now: Date): ReleaseEvidenceShareAdmin {
  return {
    id: share.id,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    createdBy: share.createdBy,
    revokedAt: share.revokedAt,
    accessedAt: share.accessedAt,
    accessCount: share.accessCount,
    state: resolveShareState(share, now),
    snapshot: {
      score: share.snapshot.score,
      status: share.snapshot.status,
      summary: share.snapshot.summary,
    },
  };
}

function resolveShareState(share: StoredReleaseEvidenceShare, now: Date): ReleaseEvidenceShareState {
  if (share.revokedAt) {
    return 'revoked';
  }
  if (new Date(share.expiresAt).getTime() <= now.getTime()) {
    return 'expired';
  }
  return 'active';
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function safeTokenHashEqual(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function sanitizeActor(value: string) {
  const sanitized = value
    .replace(/[^\p{L}\p{N}_.@-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return sanitized || 'operator';
}

function sanitizeSnapshotText(value: string, maxLength: number) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-api-key]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/\/\/([^/\s:@]+):([^@\s/]+)@/g, '//[redacted]@')
    .replace(/\b[a-f0-9]{7,64}\b/gi, '[redacted-id]')
    .slice(0, maxLength)
    .trim() || 'Review the sanitized release readiness snapshot.';
}
