import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cloudAccounts, operationEvents, servers } from '../../data/mockData.js';
import { ServerFilters, buildServerFilterMatcher, customProviderFilterValue, filterServers, isCustomCloudProvider } from '../../shared/serverFilters.js';
import { z } from 'zod';
import type { CloudProvider, ServerNode, ServerStatus } from '../../types.js';
import { HttpError } from '../httpErrors.js';
import { recordAudit } from './auditService.js';
import {
  deleteCredentialRow,
  deleteServerRow,
  isTableEmpty,
  loadJsonRows,
  replaceCredentialRows,
  replaceServerRows,
  upsertCredentialRow,
  upsertServerRow,
} from './database.js';
import { redactSensitiveText } from './sensitiveRedaction.js';
import {
  StoredSshCredential,
  buildStoredSshCredential,
  closeSshShellSession,
  getLastSshShellSelfTestResult,
  getRecentSshShellEvidence,
  collectSshMetrics,
  getSshShellSessionStats,
  openStoredSshShell,
  recordSshShellSelfTestResult,
  resizeSshShellSession,
  runStoredSshCommand,
  type SshCommandStreamEvent,
  type SshShellStreamEvent,
  runSshDiagnostic,
  sshCredentialSchema,
  streamStoredSshCommand,
  subscribeSshShellSession,
  verifySshAccess,
  writeSshShellSession,
} from './sshAccessService.js';
import { inspectServerIdentity, resolveServerIdentity } from './serverIdentityService.js';

const dataDir = process.env.COLIPAS_DATA_DIR || '.data';
const inventoryPath = path.resolve(process.cwd(), dataDir, 'inventory.json');
const credentialsPath = path.resolve(process.cwd(), dataDir, 'credentials.json');
const persistedCredentials = new Map<string, StoredSshCredential>();
const serverById = new Map<string, ServerNode>();
const serverByName = new Map<string, ServerNode>();
const serverByPublicIp = new Map<string, ServerNode>();
const serverMetricsCacheTtlMs = readEnvInteger('COLIPAS_METRICS_CACHE_TTL_MS', 30_000, 5_000, 300_000);
const serverMetricsFailureBackoffMs = readEnvInteger('COLIPAS_METRICS_FAILURE_BACKOFF_MS', 60_000, 5_000, 600_000);
const serverMetricsConcurrency = readEnvInteger('COLIPAS_METRICS_CONCURRENCY', 4, 1, 8);
const serverMetricsRefreshBudgetMs = readEnvInteger('COLIPAS_METRICS_REFRESH_BUDGET_MS', 160, 0, 2_000);
const serverMetricSamples = new Map<string, { sampledAt: number; failedAt: number }>();
let metricsRefreshInFlight: Promise<void> | null = null;
let serverInventoryRevision = 0;
let cachedServerInventorySnapshot: { revision: number; snapshot: ServerInventorySnapshot } | null = null;
const serverAuditCorrelationSchema = z.string().trim().regex(/^srv-trace-[a-f0-9-]{36}$/).optional();

export interface ServerInventorySummary {
  total: number;
  running: number;
  stopped: number;
  unconnected: number;
  warning: number;
  provisioning: number;
  sshConnected: number;
  regions: number;
  customProviders: number;
  avgCpu: number;
  openEvents: number;
  busiestServer?: ServerNode;
}

export interface ServerInventorySnapshot {
  items: ServerNode[];
  providers: string[];
  regions: string[];
  summary: ServerInventorySummary;
}

interface ServerPagination {
  page: number;
  pageSize: number;
  offset: number;
}

function normalizeFilter<T extends string>(value: unknown, allowed: readonly T[], fallback: T) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const match = allowed.find((item) => item.trim().toLowerCase() === value.trim().toLowerCase());
  return match ?? fallback;
}

export function listCloudAccounts() {
  return cloudAccounts;
}

export function listOperationEvents() {
  return operationEvents;
}

export function listServers(query: Record<string, unknown>) {
  const snapshot = buildServerInventorySnapshot();

  const providers = [
    'all',
    ...(snapshot.summary.customProviders > 0 ? [customProviderFilterValue] : []),
    ...snapshot.providers,
  ];
  const statuses: Array<Extract<ServerStatus, 'running' | 'stopped' | 'unconnected'> | 'all'> = ['all', 'running', 'stopped', 'unconnected'];
  const regions = ['all', ...snapshot.regions];

  const filters: ServerFilters = {
    query: typeof query.q === 'string' ? query.q : '',
    provider: normalizeFilter(query.provider, providers, 'all'),
    status: normalizeFilter(query.status, statuses, 'all'),
    region: normalizeFilter(query.region, regions, 'all'),
  };

  if (hasServerPagination(query)) {
    const matcher = buildServerFilterMatcher(filters);
    let pagination = parseServerPagination(query, Number.MAX_SAFE_INTEGER) as ServerPagination;
    let page = collectServerPageWithTotal(snapshot.items, matcher, pagination);
    if (page.items.length === 0 && page.total > 0 && pagination.offset >= page.total) {
      pagination = parseServerPagination(query, page.total) as ServerPagination;
      page = {
        total: page.total,
        items: collectServerPage(snapshot.items, matcher, pagination),
      };
    }

    return {
      filters,
      items: page.items,
      meta: {
        total: page.total,
        returned: page.items.length,
        page: pagination.page,
        pageSize: pagination.pageSize,
        hasMore: pagination.offset + page.items.length < page.total,
      },
    };
  }

  const filteredItems = filterServers(snapshot.items, filters);

  return {
    filters,
    items: filteredItems,
    meta: {
      total: filteredItems.length,
      returned: filteredItems.length,
      page: 1,
      pageSize: filteredItems.length,
      hasMore: false,
    },
  };
}

function collectServerPageWithTotal(items: ServerNode[], matcher: (server: ServerNode) => boolean, pagination: ServerPagination) {
  const pageItems: ServerNode[] = [];
  let total = 0;

  for (const server of items) {
    if (!matcher(server)) {
      continue;
    }

    if (total >= pagination.offset && pageItems.length < pagination.pageSize) {
      pageItems.push(server);
    }
    total += 1;
  }

  return { total, items: pageItems };
}

function collectServerPage(items: ServerNode[], matcher: (server: ServerNode) => boolean, pagination: ServerPagination) {
  const pageItems: ServerNode[] = [];
  const end = pagination.offset + pagination.pageSize;
  let matched = 0;

  for (const server of items) {
    if (!matcher(server)) {
      continue;
    }

    if (matched >= pagination.offset && pageItems.length < pagination.pageSize) {
      pageItems.push(server);
    }
    matched += 1;

    if (matched >= end) {
      break;
    }
  }

  return pageItems;
}

export function summarizeServerInventory(inputServers: ServerNode[] = servers): ServerInventorySummary {
  if (inputServers === servers) {
    const snapshot = getCachedServerInventorySnapshot();
    if (snapshot) {
      return snapshot.summary;
    }
  }

  return collectServerInventory(inputServers, false).summary;
}

export function buildServerInventorySnapshot(inputServers: ServerNode[] = servers): ServerInventorySnapshot {
  if (inputServers === servers) {
    const snapshot = getCachedServerInventorySnapshot();
    if (snapshot) {
      return snapshot;
    }
  }

  const collected = collectServerInventory(inputServers, true);
  const snapshot = {
    items: collected.items ?? [],
    providers: collected.providers,
    regions: collected.regions,
    summary: collected.summary,
  };

  if (inputServers === servers) {
    cachedServerInventorySnapshot = {
      revision: serverInventoryRevision,
      snapshot,
    };
  }

  return snapshot;
}

function collectServerInventory(inputServers: ServerNode[], includeItems: boolean) {
  const regions = new Set<string>();
  const providers = new Set<string>();
  const customProviders = new Set<string>();
  let running = 0;
  let stopped = 0;
  let unconnected = 0;
  let warning = 0;
  let provisioning = 0;
  let sshConnected = 0;
  let cpuTotal = 0;
  let busiestServer: ServerNode | undefined;
  let busiestLoad = -1;
  const items = includeItems ? [] as ServerNode[] : undefined;

  for (const server of inputServers) {
    const normalized = normalizeServerForResponse(server);
    if (items) {
      items.push(normalized);
    }

    const normalizedStatus = normalized.status;
    if (normalizedStatus === 'running') {
      running += 1;
    } else if (normalizedStatus === 'stopped') {
      stopped += 1;
    } else if (normalizedStatus === 'warning') {
      warning += 1;
    } else if (normalizedStatus === 'provisioning') {
      provisioning += 1;
    } else {
      unconnected += 1;
    }

    if (normalized.ssh?.connected) {
      sshConnected += 1;
    }
    if (normalized.region.trim()) {
      regions.add(normalized.region);
    }
    providers.add(normalized.provider);
    if (isCustomCloudProvider(normalized.provider)) {
      customProviders.add(normalized.provider);
    }

    cpuTotal += normalized.cpu;
    const load = Math.max(normalized.cpu, normalized.memory, normalized.disk);
    if (load > busiestLoad) {
      busiestLoad = load;
      busiestServer = normalized;
    }
  }

  const openEvents = countOpenOperationEvents();

  const summary: ServerInventorySummary = {
    total: inputServers.length,
    running,
    stopped,
    unconnected,
    warning,
    provisioning,
    sshConnected,
    regions: regions.size,
    customProviders: customProviders.size,
    avgCpu: inputServers.length > 0 ? Math.round(cpuTotal / inputServers.length) : 0,
    openEvents,
    ...(busiestServer ? { busiestServer } : {}),
  };

  return {
    items,
    providers: Array.from(providers),
    regions: Array.from(regions),
    summary,
  };
}

export function countOpenOperationEvents() {
  let openEvents = 0;
  for (const event of operationEvents) {
    if (event.status === 'open') {
      openEvents += 1;
    }
  }
  return openEvents;
}

export function getServerById(serverId: string) {
  return serverById.get(serverId);
}

function findExistingServerByIdentity(name: string, publicIp: string) {
  const nameMatch = serverByName.get(name);
  const ipMatch = serverByPublicIp.get(publicIp);

  if (nameMatch && ipMatch && nameMatch !== ipMatch) {
    return servers.indexOf(nameMatch) <= servers.indexOf(ipMatch) ? nameMatch : ipMatch;
  }

  return nameMatch ?? ipMatch;
}

function rebuildServerIndexes() {
  serverById.clear();
  serverByName.clear();
  serverByPublicIp.clear();
  for (const server of servers) {
    indexServer(server);
  }
}

function indexServer(server: ServerNode) {
  serverById.set(server.id, server);
  if (server.name) {
    serverByName.set(server.name, server);
  }
  if (server.publicIp) {
    serverByPublicIp.set(server.publicIp, server);
  }
}

function unindexServer(server: ServerNode) {
  if (serverById.get(server.id) === server) {
    serverById.delete(server.id);
  }
  if (server.name && serverByName.get(server.name) === server) {
    serverByName.delete(server.name);
  }
  if (server.publicIp && serverByPublicIp.get(server.publicIp) === server) {
    serverByPublicIp.delete(server.publicIp);
  }
}

function markServerInventoryChanged() {
  serverInventoryRevision += 1;
  cachedServerInventorySnapshot = null;
}

function getCachedServerInventorySnapshot() {
  if (cachedServerInventorySnapshot?.revision !== serverInventoryRevision) {
    return null;
  }

  cachedServerInventorySnapshot.snapshot.summary.openEvents = countOpenOperationEvents();
  return cachedServerInventorySnapshot.snapshot;
}

function parseServerPagination(query: Record<string, unknown>, total: number) {
  if (!hasServerPagination(query)) {
    return null;
  }

  const pageSize = clampInteger(readFirstQueryValue(query.pageSize ?? query.limit), 1, 500, 120);
  const explicitOffset = parseInteger(readFirstQueryValue(query.offset));
  const page = explicitOffset === null
    ? clampInteger(readFirstQueryValue(query.page), 1, Math.max(1, Math.ceil(Math.max(total, 1) / pageSize)), 1)
    : Math.floor(Math.max(0, explicitOffset) / pageSize) + 1;
  const offset = explicitOffset === null ? (page - 1) * pageSize : Math.max(0, explicitOffset);

  return { page, pageSize, offset };
}

function hasServerPagination(query: Record<string, unknown>) {
  return hasPaginationValue(query.page) || hasPaginationValue(query.pageSize) || hasPaginationValue(query.limit) || hasPaginationValue(query.offset);
}

function hasPaginationValue(value: unknown) {
  const candidate = readFirstQueryValue(value);
  return typeof candidate === 'string' && candidate.trim().length > 0;
}

function readFirstQueryValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.find((item) => typeof item === 'string');
  }
  return value;
}

function readEnvInteger(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name]);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseInteger(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const parsed = parseInteger(value);
  if (parsed === null) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

const cloudProviderSchema = z.string().trim().min(1).max(80);

const connectServerSchema = z.object({
  name: z.string().min(2).max(80),
  provider: cloudProviderSchema,
  region: z.string().trim().max(80).optional().default(''),
  publicIp: z.string().refine((value) => net.isIP(value) !== 0, 'Invalid public IP'),
  privateIp: z.string().refine((value) => value === '' || net.isIP(value) !== 0, 'Invalid private IP').optional().default(''),
  os: z.string().trim().max(120).optional().default(''),
  tags: z.array(z.string().min(1).max(24)).max(8).optional().default([]),
  ssh: sshCredentialSchema,
});

const updateServerSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  provider: cloudProviderSchema.optional(),
  region: z.string().trim().max(80).optional(),
  publicIp: z.string().refine((value) => net.isIP(value) !== 0, 'Invalid public IP').optional(),
  privateIp: z.string().refine((value) => value === '' || net.isIP(value) !== 0, 'Invalid private IP').optional(),
  os: z.string().trim().max(120).optional(),
  tags: z.array(z.string().min(1).max(24)).max(8).optional(),
  ssh: sshCredentialSchema.optional(),
});

export async function refreshServerMetrics() {
  const now = Date.now();
  const staleServers: ServerNode[] = [];

  for (const server of servers) {
    if (!hasConnectedCredential(server)) {
      serverMetricSamples.delete(server.id);
      driftServerMetrics(server);
      continue;
    }

    if (shouldRefreshServerMetrics(server, now)) {
      driftServerMetrics(server);
      staleServers.push(server);
    }
  }

  if (staleServers.length === 0 || metricsRefreshInFlight) {
    return;
  }

  metricsRefreshInFlight = refreshStaleServerMetrics(staleServers)
    .finally(() => {
      metricsRefreshInFlight = null;
    });

  if (serverMetricsRefreshBudgetMs <= 0) {
    return;
  }

  await Promise.race([
    metricsRefreshInFlight,
    wait(serverMetricsRefreshBudgetMs),
  ]);
}

export async function connectServer(input: unknown) {
  const parsed = connectServerSchema.parse(input);
  const existingServer = findExistingServerByIdentity(parsed.name, parsed.publicIp);
  const now = new Date().toISOString();
  const ssh = parsed.ssh.verifyMode === 'assetOnly'
    ? undefined
    : await buildVerifiedSshSummary(parsed.ssh, parsed.publicIp, now);
  const identity = await resolveServerIdentity({
    publicIp: parsed.publicIp,
    region: parsed.region,
    os: parsed.os,
    ssh: parsed.ssh,
    sshHost: ssh?.host,
  });
  const status = resolveServerStatus(ssh);

  let server: ServerNode;
  if (existingServer) {
    unindexServer(existingServer);
    server = Object.assign(existingServer, {
      name: parsed.name,
      provider: parsed.provider,
      region: identity.region,
      status,
      publicIp: parsed.publicIp,
      privateIp: parsed.privateIp || '-',
      os: identity.os,
      tags: parsed.tags,
      ssh,
    });
  } else {
    server = {
      id: `manual-${crypto.randomUUID()}`,
      name: parsed.name,
      provider: parsed.provider,
      region: identity.region,
      status,
      publicIp: parsed.publicIp,
      privateIp: parsed.privateIp || '-',
      os: identity.os,
      cpu: 0,
      memory: 0,
      disk: 0,
      tags: parsed.tags,
      ...(ssh ? { ssh } : {}),
    };
  }

  if (!existingServer) {
    servers.push(server);
  }
  indexServer(server);

  if (ssh) {
    persistedCredentials.set(server.id, buildStoredSshCredential(parsed.ssh, ssh.host));
  }
  markServerInventoryChanged();
  persistServer(server);

  if (ssh) {
    recordAudit({
      action: 'SERVER_SSH_VERIFY',
      actor: 'operator',
      target: server.id,
      status: 'success',
      detail: `${ssh.verifyMode === 'simulate' ? 'Simulated' : 'Verified'} SSH access for ${server.name} as ${ssh.username}@${ssh.host}:${ssh.port}`,
    });
  }

  recordAudit({
    action: 'SERVER_CONNECT',
    actor: 'operator',
    target: server.id,
    status: 'success',
    detail: `${existingServer ? 'Updated' : 'Connected'} server ${server.name}${ssh ? ' with SSH access' : ' as inventory only'}`,
  });

  return server;
}

export async function updateServer(serverId: string, input: unknown) {
  const server = getServerById(serverId);
  if (!server) {
    throw new HttpError(404, 'Server not found', 'SERVER_NOT_FOUND');
  }

  const parsed = updateServerSchema.parse(input);
  const now = new Date().toISOString();
  let ssh = server.ssh;

  if (parsed.ssh) {
    if (parsed.ssh.verifyMode === 'assetOnly') {
      ssh = undefined;
    } else {
      ssh = await buildVerifiedSshSummary(parsed.ssh, parsed.publicIp ?? server.publicIp, now);
    }
  }

  const identity = await resolveServerIdentity({
    publicIp: parsed.publicIp ?? server.publicIp,
    region: parsed.region ?? server.region,
    os: parsed.os ?? server.os,
    ssh: parsed.ssh,
    sshHost: ssh?.host ?? server.ssh?.host,
  });

  unindexServer(server);
  Object.assign(server, {
    name: parsed.name ?? server.name,
    provider: parsed.provider ?? server.provider,
    region: identity.region,
    status: parsed.ssh ? resolveServerStatus(ssh) : normalizeServerRuntimeStatus(server),
    publicIp: parsed.publicIp ?? server.publicIp,
    privateIp: parsed.privateIp !== undefined ? (parsed.privateIp || '-') : server.privateIp,
    os: identity.os,
    tags: parsed.tags ?? server.tags,
    ...(parsed.ssh ? { ssh } : {}),
  });
  indexServer(server);

  if (parsed.ssh && parsed.ssh.verifyMode !== 'assetOnly') {
    if (ssh) {
      persistedCredentials.set(server.id, buildStoredSshCredential(parsed.ssh, ssh.host));
    } else {
      persistedCredentials.delete(server.id);
    }
    persistCredential(server.id);
  } else if (parsed.ssh?.verifyMode === 'assetOnly') {
    persistedCredentials.delete(server.id);
    deleteCredentialRow(server.id);
  }

  markServerInventoryChanged();
  persistServer(server);
  recordAudit({
    action: 'SERVER_UPDATE',
    actor: 'operator',
    target: server.id,
    status: 'success',
    detail: `Updated server ${server.name}`,
  });

  return server;
}

export { inspectServerIdentity };

export function deleteServer(serverId: string) {
  const serverToDelete = getServerById(serverId);
  const index = serverToDelete ? servers.indexOf(serverToDelete) : -1;
  if (index < 0) {
    throw new HttpError(404, 'Server not found', 'SERVER_NOT_FOUND');
  }

  const [server] = servers.splice(index, 1);
  unindexServer(server);
  persistedCredentials.delete(server.id);
  markServerInventoryChanged();
  deleteServerRow(server.id);
  deleteCredentialRow(server.id);

  recordAudit({
    action: 'SERVER_DELETE',
    actor: 'operator',
    target: server.id,
    status: 'success',
    detail: `Deleted server ${server.name}`,
  });

  return { id: server.id, deleted: true };
}

export async function runServerDiagnostic(serverId: string) {
  const { server, credential } = getConnectedServerCredential(serverId, 'SERVER_SSH_DIAGNOSTIC');

  const diagnostic = await runSshDiagnostic(credential, server, server.ssh.verifyMode);
  recordAudit({
    action: 'SERVER_SSH_DIAGNOSTIC',
    actor: 'operator',
    target: server.id,
    status: 'success',
    detail: `SSH diagnostic completed for ${server.name}`,
  });

  return diagnostic;
}

export async function runServerCommand(input: unknown) {
  const parsed = z.object({
    serverId: z.string().min(1),
    command: z.string().trim().min(1).max(2000),
    correlationId: serverAuditCorrelationSchema,
  }).parse(input);
  const correlationId = parsed.correlationId || buildServerAuditCorrelationId();
  const { server, credential } = getConnectedServerCredential(parsed.serverId, 'SERVER_SSH_COMMAND');
  const result = await runStoredSshCommand(credential, parsed.command, server.ssh.verifyMode);

  recordAudit({
    action: 'SERVER_SSH_COMMAND',
    actor: 'operator',
    target: server.id,
    status: 'success',
    detail: `SSH command executed on ${server.name}: ${summarizeAuditCommand(parsed.command)}`,
    correlationId,
  });

  return {
    serverId: server.id,
    serverName: server.name,
    correlationId,
    ...result,
  };
}

export async function streamServerCommand(
  input: unknown,
  onEvent: (event: SshCommandStreamEvent) => void,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const parsed = z.object({
    serverId: z.string().min(1),
    command: z.string().trim().min(1).max(2000),
    correlationId: serverAuditCorrelationSchema,
  }).parse(input);
  const correlationId = parsed.correlationId || buildServerAuditCorrelationId();
  const { server, credential } = getConnectedServerCredential(parsed.serverId, 'SERVER_SSH_COMMAND');
  const result = await streamStoredSshCommand(credential, parsed.command, server.ssh.verifyMode, onEvent, options);

  recordAudit({
    action: 'SERVER_SSH_COMMAND',
    actor: 'operator',
    target: server.id,
    status: 'success',
    detail: `SSH command streamed on ${server.name}: ${summarizeAuditCommand(parsed.command)}`,
    correlationId,
  });

  return {
    serverId: server.id,
    serverName: server.name,
    correlationId,
    ...result,
  };
}

export async function openServerShell(input: unknown) {
  const parsed = z.object({
    serverId: z.string().min(1),
    cols: z.number().int().min(40).max(240).optional(),
    rows: z.number().int().min(12).max(80).optional(),
    correlationId: serverAuditCorrelationSchema,
  }).parse(input);
  const correlationId = parsed.correlationId || buildServerAuditCorrelationId();
  const { server, credential } = getConnectedServerCredential(parsed.serverId, 'SERVER_SSH_COMMAND');
  const result = await openStoredSshShell(credential, { id: server.id, name: server.name }, server.ssh.verifyMode, {
    cols: parsed.cols,
    rows: parsed.rows,
  });

  recordAudit({
    action: 'SERVER_SSH_COMMAND',
    actor: 'operator',
    target: server.id,
    status: 'success',
    detail: `SSH shell opened on ${server.name}`,
    correlationId,
  });

  return {
    serverId: server.id,
    serverName: server.name,
    correlationId,
    ...result,
  };
}

export function subscribeServerShell(
  input: unknown,
  onEvent: (event: SshShellStreamEvent) => void,
) {
  const parsed = z.object({
    sessionId: z.string().min(1),
    replay: z.coerce.number().int().optional(),
  }).parse(input);

  return subscribeSshShellSession(parsed.sessionId, onEvent, { replayHistory: parsed.replay !== 0 });
}

export function writeServerShell(input: unknown) {
  const parsed = z.object({
    sessionId: z.string().min(1),
    input: z.string().min(1).max(8000),
  }).parse(input);
  writeSshShellSession(parsed.sessionId, parsed.input);
  return { ok: true };
}

export function resizeServerShell(input: unknown) {
  const parsed = z.object({
    sessionId: z.string().min(1),
    cols: z.number().int().min(40).max(240),
    rows: z.number().int().min(12).max(80),
  }).parse(input);
  resizeSshShellSession(parsed.sessionId, parsed.cols, parsed.rows);
  return { ok: true };
}

export function recordServerShellSelfTest(input: unknown) {
  const parsed = z.object({
    sessionId: z.string().min(1),
    status: z.enum(['complete', 'timeout', 'failed']),
    lines: z.coerce.number().int().min(0).max(10000),
    durationMs: z.coerce.number().min(0).max(60_000),
    linesPerSecond: z.coerce.number().min(0).max(1_000_000),
    firstResponseMs: z.coerce.number().min(0).max(60_000).optional().default(0),
    outputSpanMs: z.coerce.number().min(0).max(60_000).optional().default(0),
    rttMs: z.coerce.number().min(0).max(60_000).nullable().optional(),
    throughputBytesPerSecond: z.coerce.number().min(0).max(1_000_000_000).optional().default(0),
    networkLabel: z.string().max(100).optional().default(''),
  }).parse(input);

  return recordSshShellSelfTestResult(parsed.sessionId, {
    status: parsed.status,
    lines: parsed.lines,
    durationMs: parsed.durationMs,
    linesPerSecond: parsed.linesPerSecond,
    firstResponseMs: parsed.firstResponseMs,
    outputSpanMs: parsed.outputSpanMs,
    rttMs: parsed.rttMs ?? null,
    throughputBytesPerSecond: parsed.throughputBytesPerSecond,
    networkLabel: parsed.networkLabel,
  });
}

export function closeServerShell(input: unknown) {
  const parsed = z.object({
    sessionId: z.string().min(1),
  }).parse(input);
  closeSshShellSession(parsed.sessionId);
  return { ok: true };
}

export function getServerShellStatus() {
  return getSshShellSessionStats();
}

export function getServerShellEvidence(serverIds?: string[]) {
  return getRecentSshShellEvidence(serverIds);
}

export function getServerShellSelfTest() {
  return getLastSshShellSelfTestResult();
}

export function setServerRuntimeStatus(serverId: string, status: Extract<ServerStatus, 'running' | 'stopped' | 'warning'>) {
  const server = getServerById(serverId);
  if (!server) {
    throw new HttpError(404, 'Server not found', 'SERVER_NOT_FOUND');
  }

  if (!server.ssh?.connected) {
    server.status = 'unconnected';
  } else {
    server.status = status;
  }
  markServerInventoryChanged();
  persistInventory();

  return server.status;
}

export function getConnectedServerCredential(serverId: string, auditAction: 'SERVER_SSH_DIAGNOSTIC' | 'SERVER_ACTION' | 'SERVER_SSH_COMMAND') {
  const server = getServerById(serverId);
  if (!server) {
    throw new HttpError(404, 'Server not found', 'SERVER_NOT_FOUND');
  }

  if (!server.ssh?.connected) {
    recordAudit({
      action: auditAction,
      actor: 'operator',
      target: server.id,
      status: 'blocked',
      detail: 'SSH operation blocked: server is not connected',
    });
    throw new HttpError(409, 'Server SSH access is not connected', 'SERVER_SSH_NOT_CONNECTED');
  }

  const credential = persistedCredentials.get(server.id);
  if (!credential) {
    recordAudit({
      action: auditAction,
      actor: 'operator',
      target: server.id,
      status: 'failed',
      detail: 'SSH operation failed: credential is missing',
    });
    throw new HttpError(409, 'Server SSH credential is missing; reconnect this server', 'SERVER_SSH_CREDENTIAL_MISSING');
  }

  return { server: server as ServerNode & { ssh: NonNullable<ServerNode['ssh']> }, credential };
}

function summarizeAuditCommand(command: string) {
  return redactSensitiveText(command).replace(/\s+/g, ' ').slice(0, 160);
}

export function buildServerAuditCorrelationId() {
  return `srv-trace-${crypto.randomUUID()}`;
}

loadPersistedCredentials();
loadPersistedInventory();

function loadPersistedInventory() {
  try {
    if (isTableEmpty('servers') && fs.existsSync(inventoryPath)) {
      const raw = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as { servers?: ServerNode[] };
      if (Array.isArray(raw.servers)) {
        replaceServerRows(raw.servers.map(normalizePersistedServer));
      }
    }

    const rows = loadJsonRows('servers');
    if (rows.length > 0) {
      servers.splice(0, servers.length, ...rows.map((row) => normalizePersistedServer(JSON.parse(row.payload) as ServerNode)));
    }
    rebuildServerIndexes();
    markServerInventoryChanged();
  } catch {
    // Ignore unreadable local runtime data and keep the in-memory adapter state.
    rebuildServerIndexes();
    markServerInventoryChanged();
  }
}

function persistInventory() {
  replaceServerRows(servers);
}

function persistServer(server: ServerNode) {
  upsertServerRow(server);
  if (hasConnectedCredential(server)) {
    persistCredential(server.id);
  } else {
    deleteCredentialRow(server.id);
  }
}

function loadPersistedCredentials() {
  try {
    if (isTableEmpty('credentials') && fs.existsSync(credentialsPath)) {
      const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as { credentials?: Record<string, StoredSshCredential> };
      replaceCredentialRows(raw.credentials ?? {});
    }

    for (const row of loadJsonRows('credentials')) {
      const credential = JSON.parse(row.payload) as StoredSshCredential;
      const serverId = row.id;
      persistedCredentials.set(serverId, credential);
    }
  } catch {
    // Ignore unreadable credential cache. Existing assets can be reconnected from the UI.
  }
}

function persistCredentials() {
  replaceCredentialRows(Object.fromEntries(persistedCredentials));
}

function persistCredential(serverId: string) {
  const credential = persistedCredentials.get(serverId);
  if (credential) {
    upsertCredentialRow(serverId, credential);
  } else {
    deleteCredentialRow(serverId);
  }
}

function shouldRefreshServerMetrics(server: ServerNode, now: number) {
  const sample = serverMetricSamples.get(server.id);
  if (!sample) {
    return true;
  }

  if (sample.failedAt > 0 && now - sample.failedAt < serverMetricsFailureBackoffMs) {
    return false;
  }

  return now - sample.sampledAt >= serverMetricsCacheTtlMs;
}

async function refreshStaleServerMetrics(staleServers: ServerNode[]) {
  await runWithConcurrency(staleServers, serverMetricsConcurrency, refreshSingleServerMetrics);
}

async function refreshSingleServerMetrics(server: ServerNode) {
  if (!hasConnectedCredential(server)) {
    serverMetricSamples.delete(server.id);
    driftServerMetrics(server);
    return;
  }

  const credential = persistedCredentials.get(server.id);
  const ssh = server.ssh;
  if (!credential || !ssh) {
    serverMetricSamples.delete(server.id);
    driftServerMetrics(server);
    return;
  }

  try {
    const metrics = await collectSshMetrics(credential, ssh.verifyMode);
    applyServerMetricState(server, metrics.cpu, metrics.memory, metrics.disk, normalizeServerRuntimeStatus({
      ...server,
      ...metrics,
    }));
    serverMetricSamples.set(server.id, { sampledAt: Date.now(), failedAt: 0 });
  } catch {
    serverMetricSamples.set(server.id, {
      sampledAt: Date.now(),
      failedAt: Date.now(),
    });
    driftServerMetrics(server);
  }
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(workers);
}

function wait(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

function driftServerMetrics(server: ServerNode) {
  if (!hasConnectedCredential(server)) {
    applyServerMetricState(server, 0, 0, 0, 'unconnected');
    return;
  }

  const phase = Date.now() / 1000 + hashText(server.id);
  applyServerMetricState(
    server,
    driftMetric(server.cpu, Math.sin(phase / 19) * 8),
    driftMetric(server.memory, Math.cos(phase / 23) * 5),
    driftMetric(server.disk, Math.sin(phase / 37) * 2),
    normalizeServerRuntimeStatus(server),
  );
}

function applyServerMetricState(server: ServerNode, cpu: number, memory: number, disk: number, status: ServerStatus) {
  if (server.cpu === cpu && server.memory === memory && server.disk === disk && server.status === status) {
    return;
  }

  server.cpu = cpu;
  server.memory = memory;
  server.disk = disk;
  server.status = status;
  markServerInventoryChanged();
}

function driftMetric(current: number, delta: number) {
  const base = current > 0 ? current : 12;
  return Math.max(0, Math.min(100, Math.round(base + delta)));
}

function hashText(value: string) {
  return value.split('').reduce((total, char) => total + char.charCodeAt(0), 0);
}

async function buildVerifiedSshSummary(input: z.infer<typeof sshCredentialSchema>, publicIp: string, verifiedAt: string) {
  const verification = await verifySshAccess(input, input.host || publicIp);

  return {
    host: verification.host,
    port: verification.port,
    username: verification.username,
    authType: verification.authType,
    connected: verification.connected,
    lastVerifiedAt: verifiedAt,
    verifyMode: verification.verifyMode,
    fingerprint: verification.fingerprint,
  };
}

function resolveServerStatus(ssh: ServerNode['ssh']): ServerStatus {
  if (!ssh?.connected) {
    return 'unconnected';
  }

  return 'running';
}

function normalizeServerRuntimeStatus(server: ServerNode): ServerStatus {
  if (!hasConnectedCredential(server)) {
    return 'unconnected';
  }

  if (server.status === 'stopped') {
    return server.status;
  }

  return resolveServerStatus(server.ssh);
}

function normalizeServerForResponse(server: ServerNode): ServerNode {
  const hasCredential = hasConnectedCredential(server);
  const normalizedStatus: Extract<ServerStatus, 'running' | 'stopped' | 'unconnected'> = hasCredential
    ? (server.status === 'stopped' ? 'stopped' : 'running')
    : 'unconnected';

  return {
    ...server,
    status: normalizedStatus,
    ssh: hasCredential ? server.ssh : undefined,
  };
}

function normalizePersistedServer(server: ServerNode): ServerNode {
  const hasCredential = Boolean(server.id && persistedCredentials.has(server.id));
  const ssh = hasCredential ? server.ssh : undefined;

  return {
    ...server,
    ssh,
    status: normalizeServerRuntimeStatus({ ...server, ssh }),
    cpu: ssh?.connected ? server.cpu : 0,
    memory: ssh?.connected ? server.memory : 0,
    disk: ssh?.connected ? server.disk : 0,
  };
}

function hasConnectedCredential(server: ServerNode) {
  return Boolean(server.ssh?.connected && persistedCredentials.has(server.id));
}
