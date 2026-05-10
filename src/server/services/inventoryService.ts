import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cloudAccounts, operationEvents, servers } from '../../data/mockData.js';
import { ServerFilters, customProviderFilterValue, filterServers, isCustomCloudProvider, resolveServerLifecycleStatus } from '../../shared/serverFilters.js';
import { z } from 'zod';
import type { CloudProvider, ServerNode, ServerStatus } from '../../types.js';
import { HttpError } from '../httpErrors.js';
import { recordAudit } from './auditService.js';
import { isTableEmpty, loadJsonRows, replaceCredentialRows, replaceServerRows } from './database.js';
import { redactSensitiveText } from './sensitiveRedaction.js';
import {
  StoredSshCredential,
  buildStoredSshCredential,
  closeSshShellSession,
  collectSshMetrics,
  openStoredSshShell,
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
const serverAuditCorrelationSchema = z.string().trim().regex(/^srv-trace-[a-f0-9-]{36}$/).optional();

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
  const providers = [
    'all',
    ...(servers.some((server) => isCustomCloudProvider(server.provider)) ? [customProviderFilterValue] : []),
    ...Array.from(new Set(servers.map((server) => server.provider))),
  ];
  const statuses: Array<Extract<ServerStatus, 'running' | 'stopped' | 'unconnected'> | 'all'> = ['all', 'running', 'stopped', 'unconnected'];
  const normalizedServers = servers.map(normalizeServerForResponse);
  const regions = ['all', ...Array.from(new Set(normalizedServers.map((server) => server.region)))];

  const filters: ServerFilters = {
    query: typeof query.q === 'string' ? query.q : '',
    provider: normalizeFilter(query.provider, providers, 'all'),
    status: normalizeFilter(query.status, statuses, 'all'),
    region: normalizeFilter(query.region, regions, 'all'),
  };

  return {
    filters,
    items: filterServers(normalizedServers, filters),
  };
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
  await Promise.all(servers.map(async (server) => {
    if (hasConnectedCredential(server)) {
      try {
        const credential = persistedCredentials.get(server.id);
        const ssh = server.ssh;
        if (credential && ssh) {
          const metrics = await collectSshMetrics(credential, ssh.verifyMode);
          Object.assign(server, metrics);
          server.status = normalizeServerRuntimeStatus(server);
          return;
        }
      } catch {
        // Fall through to local metric drift when live SSH metrics are temporarily unavailable.
      }
    }

    driftServerMetrics(server);
  }));
}

export async function connectServer(input: unknown) {
  const parsed = connectServerSchema.parse(input);
  const existingServer = servers.find((server) => server.name === parsed.name || server.publicIp === parsed.publicIp);
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

  const server: ServerNode = existingServer
    ? Object.assign(existingServer, {
        name: parsed.name,
        provider: parsed.provider,
        region: identity.region,
        status,
        publicIp: parsed.publicIp,
        privateIp: parsed.privateIp || '-',
        os: identity.os,
        tags: parsed.tags,
        ssh,
      })
    : {
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

  if (!existingServer) {
    servers.push(server);
  }

  if (ssh) {
    persistedCredentials.set(server.id, buildStoredSshCredential(parsed.ssh, ssh.host));
  }
  persistInventory();
  persistCredentials();

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
  const server = servers.find((item) => item.id === serverId);
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

  if (parsed.ssh && parsed.ssh.verifyMode !== 'assetOnly') {
    if (ssh) {
      persistedCredentials.set(server.id, buildStoredSshCredential(parsed.ssh, ssh.host));
    } else {
      persistedCredentials.delete(server.id);
    }
    persistCredentials();
  } else if (parsed.ssh?.verifyMode === 'assetOnly') {
    persistedCredentials.delete(server.id);
    persistCredentials();
  }

  persistInventory();
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
  const index = servers.findIndex((server) => server.id === serverId);
  if (index < 0) {
    throw new HttpError(404, 'Server not found', 'SERVER_NOT_FOUND');
  }

  const [server] = servers.splice(index, 1);
  persistedCredentials.delete(server.id);
  persistInventory();
  persistCredentials();

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
  const result = await openStoredSshShell(credential, server.ssh.verifyMode, {
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

export function subscribeServerShell(input: unknown, onEvent: (event: SshShellStreamEvent) => void) {
  const parsed = z.object({
    sessionId: z.string().min(1),
  }).parse(input);

  return subscribeSshShellSession(parsed.sessionId, onEvent);
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

export function closeServerShell(input: unknown) {
  const parsed = z.object({
    sessionId: z.string().min(1),
  }).parse(input);
  closeSshShellSession(parsed.sessionId);
  return { ok: true };
}

export function setServerRuntimeStatus(serverId: string, status: Extract<ServerStatus, 'running' | 'stopped' | 'warning'>) {
  const server = servers.find((item) => item.id === serverId);
  if (!server) {
    throw new HttpError(404, 'Server not found', 'SERVER_NOT_FOUND');
  }

  if (!server.ssh?.connected) {
    server.status = 'unconnected';
  } else {
    server.status = status;
  }
  persistInventory();

  return server.status;
}

export function getConnectedServerCredential(serverId: string, auditAction: 'SERVER_SSH_DIAGNOSTIC' | 'SERVER_ACTION' | 'SERVER_SSH_COMMAND') {
  const server = servers.find((item) => item.id === serverId);
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
  } catch {
    // Ignore unreadable local runtime data and keep the in-memory adapter state.
  }
}

function persistInventory() {
  replaceServerRows(servers);
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

function driftServerMetrics(server: ServerNode) {
  if (!hasConnectedCredential(server)) {
    server.cpu = 0;
    server.memory = 0;
    server.disk = 0;
    server.status = 'unconnected';
    return;
  }

  const phase = Date.now() / 1000 + hashText(server.id);
  server.cpu = driftMetric(server.cpu, Math.sin(phase / 19) * 8);
  server.memory = driftMetric(server.memory, Math.cos(phase / 23) * 5);
  server.disk = driftMetric(server.disk, Math.sin(phase / 37) * 2);
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
  const normalizedStatus = resolveServerLifecycleStatus({
    ...server,
    status: normalizeServerRuntimeStatus(server),
    ssh: hasConnectedCredential(server) ? server.ssh : undefined,
  });

  return {
    ...server,
    status: normalizedStatus,
    ssh: hasConnectedCredential(server) ? server.ssh : undefined,
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
