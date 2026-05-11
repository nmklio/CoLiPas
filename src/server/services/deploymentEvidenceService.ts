import fs from 'node:fs';
import path from 'node:path';
import type { ReleaseDeploymentEvidence } from '../../types.js';
import type { RuntimeConfig } from '../config.js';

let cachedGitCommit: string | null | undefined;

export function buildReleaseDeploymentEvidence(config: RuntimeConfig): ReleaseDeploymentEvidence {
  const gitCommit = sanitizeGitCommit(config.release.gitCommit || readGitCommit() || '');
  const publicHost = sanitizePublicHost(config.release.publicUrl);
  const targetName = sanitizeLabel(config.release.targetName) || (config.nodeEnv === 'production' ? 'production-instance' : 'local-dev');
  const channel = sanitizeLabel(config.release.channel) || config.nodeEnv;
  const deploymentMode = sanitizeLabel(config.release.deploymentMode) || 'node';
  const deployedAt = sanitizeTimestamp(config.release.deployedAt);
  const artifactId = sanitizeArtifactId(config.release.artifactId);
  const configured = gitCommit !== 'unknown' || publicHost !== 'not configured' || targetName !== 'local-dev';
  const evidenceParts = [
    `target=${targetName}`,
    `channel=${channel}`,
    `mode=${deploymentMode}`,
    `commit=${gitCommit}`,
    `host=${publicHost}`,
  ];

  if (artifactId !== 'not configured') {
    evidenceParts.push(`artifact=${artifactId}`);
  }
  if (deployedAt !== 'not configured') {
    evidenceParts.push(`deployed=${deployedAt}`);
  }

  return {
    targetName,
    channel,
    deploymentMode,
    publicHost,
    gitCommit,
    artifactId,
    deployedAt,
    configured,
    evidence: evidenceParts.join(' / '),
  };
}

function readGitCommit() {
  if (cachedGitCommit !== undefined) {
    return cachedGitCommit;
  }

  cachedGitCommit = null;
  try {
    const gitDir = path.resolve(process.cwd(), '.git');
    const headPath = path.join(gitDir, 'HEAD');
    const head = fs.readFileSync(headPath, 'utf8').trim();
    if (/^[a-f0-9]{40}$/i.test(head)) {
      cachedGitCommit = head.slice(0, 12);
      return cachedGitCommit;
    }

    const refMatch = head.match(/^ref:\s+(.+)$/);
    if (!refMatch) {
      return cachedGitCommit;
    }

    const refPath = path.join(gitDir, refMatch[1]);
    if (fs.existsSync(refPath)) {
      const ref = fs.readFileSync(refPath, 'utf8').trim();
      cachedGitCommit = /^[a-f0-9]{40}$/i.test(ref) ? ref.slice(0, 12) : null;
      return cachedGitCommit;
    }

    const packedRefs = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    const escapedRef = escapeRegExp(refMatch[1]);
    const packedMatch = packedRefs.match(new RegExp(`^([a-f0-9]{40}) ${escapedRef}$`, 'im'));
    cachedGitCommit = packedMatch ? packedMatch[1].slice(0, 12) : null;
    return cachedGitCommit;
  } catch {
    cachedGitCommit = null;
    return cachedGitCommit;
  }
}

function sanitizePublicHost(value: string) {
  if (!value.trim()) {
    return 'not configured';
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (!hostname) {
      return 'not configured';
    }
    if (isIpAddress(hostname)) {
      return '[redacted-host]';
    }
    return sanitizeLabel(hostname) || 'not configured';
  } catch {
    const trimmed = value.trim().replace(/^https?:\/\//i, '').split(/[/?#]/)[0].toLowerCase();
    if (!trimmed) {
      return 'not configured';
    }
    if (isIpAddress(trimmed)) {
      return '[redacted-host]';
    }
    return sanitizeLabel(trimmed) || 'not configured';
  }
}

function sanitizeGitCommit(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/[a-f0-9]{7,40}/i);
  return match ? match[0].slice(0, 12) : 'unknown';
}

function sanitizeArtifactId(value: string) {
  const sanitized = sanitizeLabel(value);
  return sanitized || 'not configured';
}

function sanitizeTimestamp(value: string) {
  if (!value.trim()) {
    return 'not configured';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'not configured';
  }
  return date.toISOString();
}

function sanitizeLabel(value: string) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-api-key]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]')
    .replace(/[^a-z0-9._:/-]+/gi, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 96);
}

function isIpAddress(value: string) {
  if (/^\[[0-9a-f:]+\]$/i.test(value) || /^[0-9a-f:]+$/i.test(value) && value.includes(':')) {
    return true;
  }

  const octets = value.split('.').map((part) => Number(part));
  return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
