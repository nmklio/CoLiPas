import crypto from 'node:crypto';
import { cloudAccounts, operationEvents } from '../../data/mockData.js';
import { buildServerInventorySnapshot, getServerInventoryRevision } from './inventoryService.js';

interface OverviewHttpSnapshot {
  body: string;
  bytes: number;
  etag: string;
  revision: string;
}

let cachedOverviewSnapshot: (OverviewHttpSnapshot & { cacheKey: string }) | null = null;

export function buildOverviewHttpSnapshot(): OverviewHttpSnapshot {
  const inventoryRevision = getServerInventoryRevision();
  const relatedStateSignature = fingerprint(JSON.stringify({ cloudAccounts, operationEvents }));
  const cacheKey = `${inventoryRevision}:${relatedStateSignature}`;

  if (cachedOverviewSnapshot?.cacheKey === cacheKey) {
    return cachedOverviewSnapshot;
  }

  const inventory = buildServerInventorySnapshot();
  const body = JSON.stringify({
    cloudAccounts,
    servers: inventory.items,
    operationEvents,
    summary: {
      totalServers: inventory.summary.total,
      onlineServers: inventory.summary.running,
      openEvents: inventory.summary.openEvents,
      connectedSsh: inventory.summary.sshConnected,
      avgCpu: inventory.summary.avgCpu,
      telemetryFresh: inventory.summary.telemetryFresh,
      telemetryStale: inventory.summary.telemetryStale,
      telemetryUnavailable: inventory.summary.telemetryUnavailable,
      busiestServer: inventory.summary.busiestServer,
    },
  });
  const contentSignature = fingerprint(body);

  cachedOverviewSnapshot = {
    cacheKey,
    body,
    bytes: Buffer.byteLength(body),
    etag: `"colipas-overview-${contentSignature}"`,
    revision: `${inventoryRevision}-${relatedStateSignature.slice(0, 10)}`,
  };
  return cachedOverviewSnapshot;
}

export function matchesOverviewEtag(header: string | string[] | undefined, etag: string) {
  if (!header) {
    return false;
  }

  const expected = normalizeEtag(etag);
  return (Array.isArray(header) ? header : [header]).some((value) => (
    value.split(',').some((candidate) => {
      const normalized = normalizeEtag(candidate.trim());
      return normalized === '*' || normalized === expected;
    })
  ));
}

function normalizeEtag(value: string) {
  return value.replace(/^W\//i, '').trim();
}

function fingerprint(value: string) {
  return crypto.createHash('sha256').update(value).digest('base64url').slice(0, 22);
}
