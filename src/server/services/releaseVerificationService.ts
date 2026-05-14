import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ReleaseVerificationResponse } from '../../types.js';
import type { RuntimeConfig } from '../config.js';
import { buildReleaseReadiness } from './releaseReadinessService.js';
import { listAuditEntries } from './auditService.js';
import { listCloudAccounts, summarizeServerInventory } from './inventoryService.js';
import { buildReleaseDeploymentEvidence } from './deploymentEvidenceService.js';

export function isReleaseVerificationEnabled(config: RuntimeConfig) {
  return config.releaseVerification.tokenConfigured;
}

export function isReleaseVerificationAuthorized(config: RuntimeConfig, token: string | undefined) {
  if (!isReleaseVerificationEnabled(config) || !token) {
    return false;
  }

  return timingSafeEqual(token, config.releaseVerification.token);
}

export function buildReleaseVerification(config: RuntimeConfig): ReleaseVerificationResponse {
  const generatedAt = new Date().toISOString();
  const readiness = buildReleaseReadiness(config);
  const auditEntries = listAuditEntries();
  const cloudAccounts = listCloudAccounts();
  const inventorySummary = summarizeServerInventory();
  const frontend = inspectFrontendBundle();
  const deployment = buildReleaseDeploymentEvidence(config);
  const auditByStatus = auditEntries.reduce(
    (summary, entry) => {
      summary[entry.status] += 1;
      return summary;
    },
    { success: 0, blocked: 0, failed: 0 },
  );

  return {
    ok: true,
    generatedAt,
    runtime: {
      nodeEnv: config.nodeEnv,
      uptimeSeconds: Math.round(process.uptime()),
    },
    deployment,
    frontend,
    readiness: {
      score: readiness.score,
      status: readiness.status,
      summary: readiness.summary,
      blockerCount: readiness.blockers.length,
      nextBestAction: sanitizeVerificationText(readiness.nextBestAction),
    },
    audit: {
      total: auditEntries.length,
      byStatus: auditByStatus,
      last24h: auditEntries.filter((entry) => Date.now() - new Date(entry.createdAt).getTime() <= 24 * 60 * 60 * 1000).length,
    },
    inventory: {
      servers: {
        total: inventorySummary.total,
        running: inventorySummary.running,
        stopped: inventorySummary.stopped,
        unconnected: inventorySummary.unconnected,
        sshConnected: inventorySummary.sshConnected,
      },
      cloudAccounts: {
        total: cloudAccounts.length,
        connected: cloudAccounts.filter((account) => account.status === 'connected').length,
        warning: cloudAccounts.filter((account) => account.status === 'warning').length,
        disconnected: cloudAccounts.filter((account) => account.status === 'disconnected').length,
      },
      openEvents: inventorySummary.openEvents,
      regions: inventorySummary.regions,
    },
    security: {
      adminPasswordDefault: config.security.adminPasswordDefault,
      sessionSecretDefault: config.security.sessionSecretDefault,
      credentialEncryptionKeyConfigured: config.security.credentialEncryptionKeyConfigured,
      credentialEncryptionKeyDefault: config.security.credentialEncryptionKeyDefault,
    },
  };
}

function inspectFrontendBundle(): ReleaseVerificationResponse['frontend'] {
  const distDir = path.resolve(process.cwd(), 'dist');
  const indexPath = path.join(distDir, 'index.html');
  const indexHtml = readText(indexPath);
  const assetRefs = [...indexHtml.matchAll(/\/assets\/[^"']+\.(?:js|css)/g)]
    .map((match) => match[0])
    .filter((value, index, items) => items.indexOf(value) === index);
  const assets = assetRefs.map((asset) => inspectFrontendAsset(distDir, asset));
  const combinedContent = [indexHtml, ...assets.map((asset) => asset.content)].join('\n');
  const featureMarkers = [
    'security-evidence-brief',
    'cloud-map',
    'ai-dock',
    'ssh-console',
    'api-workbench',
  ];

  return {
    indexHash: hashText(indexHtml),
    scripts: assets.map(({ content: _content, ...asset }) => asset),
    featureMarkers: Object.fromEntries(featureMarkers.map((marker) => [marker, combinedContent.includes(marker)])),
  };
}

function inspectFrontendAsset(distDir: string, assetRef: string) {
  const relativeAsset = assetRef.replace(/^\/+/, '');
  const assetPath = path.join(distDir, relativeAsset);
  const content = readText(assetPath);
  return {
    path: assetRef,
    bytes: Buffer.byteLength(content),
    hash: hashText(content),
    content,
  };
}

function readText(filePath: string) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function hashText(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function timingSafeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sanitizeVerificationText(value: string) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-api-key]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]');
}
