import path from 'node:path';
import type { DiagnosticExportResponse } from '../../types.js';
import { isBaseCloudProvider } from '../../shared/serverFilters.js';
import type { RuntimeConfig } from '../config.js';
import { getDatabasePath } from './database.js';
import { buildReleaseReadiness } from './releaseReadinessService.js';
import { listAuditEntries } from './auditService.js';
import { listCloudAccounts, listOperationEvents, listServers } from './inventoryService.js';

export function buildDiagnosticExport(config: RuntimeConfig): DiagnosticExportResponse {
  const generatedAt = new Date().toISOString();
  const readiness = buildReleaseReadiness(config);
  const auditEntries = listAuditEntries();
  const inventory = listServers({});
  const serverItems = inventory.items;
  const cloudAccounts = listCloudAccounts();
  const operationEvents = listOperationEvents();

  return {
    generatedAt,
    filename: `colipas-diagnostics-${generatedAt.slice(0, 10)}.json`,
    contentType: 'application/json',
    runtime: {
      nodeEnv: config.nodeEnv,
      uptimeSeconds: Math.round(process.uptime()),
      database: {
        driver: 'sqlite',
        name: path.basename(getDatabasePath()),
      },
    },
    config: {
      customApiAllowedHosts: config.customApiAllowedHosts.length,
      customApiTimeoutMs: config.customApiTimeoutMs,
      ai: {
        baseUrlHost: getHostLabel(config.ai.baseUrl),
        model: config.ai.model,
        configured: Boolean(config.ai.apiKey),
      },
      security: config.security,
    },
    readiness: {
      score: readiness.score,
      status: readiness.status,
      summary: readiness.summary,
      nextBestAction: readiness.nextBestAction,
      checks: readiness.checks.map((check) => ({
        id: check.id,
        label: check.label,
        severity: check.severity,
        passed: check.passed,
        value: check.value,
        relatedModule: check.relatedModule,
      })),
    },
    audit: {
      total: auditEntries.length,
      byStatus: countByStatus(auditEntries),
      byAction: countBy(auditEntries.map((entry) => entry.action)),
      last24h: auditEntries.filter((entry) => Date.now() - new Date(entry.createdAt).getTime() <= 24 * 60 * 60 * 1000).length,
    },
    inventory: {
      servers: {
        total: serverItems.length,
        running: serverItems.filter((server) => server.status === 'running').length,
        stopped: serverItems.filter((server) => server.status === 'stopped').length,
        unconnected: serverItems.filter((server) => server.status === 'unconnected').length,
        connectedSsh: serverItems.filter((server) => server.ssh?.connected).length,
      },
      cloudAccounts: {
        total: cloudAccounts.length,
        connected: cloudAccounts.filter((account) => account.status === 'connected').length,
        warning: cloudAccounts.filter((account) => account.status === 'warning').length,
        disconnected: cloudAccounts.filter((account) => account.status === 'disconnected').length,
        providers: new Set(cloudAccounts.map((account) => account.provider)).size,
      },
      regions: new Set(serverItems.map((server) => server.region).filter(Boolean)).size,
      customProviders: new Set(serverItems.map((server) => server.provider).filter((provider) => !isBaseCloudProvider(provider))).size,
      openEvents: operationEvents.filter((event) => event.status === 'open').length,
    },
  };
}

function countByStatus(entries: ReturnType<typeof listAuditEntries>) {
  return entries.reduce(
    (summary, entry) => {
      summary[entry.status] += 1;
      return summary;
    },
    { success: 0, blocked: 0, failed: 0 },
  );
}

function countBy(values: string[]) {
  return values.reduce<Record<string, number>>((summary, value) => {
    summary[value] = (summary[value] ?? 0) + 1;
    return summary;
  }, {});
}

function getHostLabel(value: string) {
  try {
    return new URL(value).host || 'not-configured';
  } catch {
    return value.trim() ? 'custom-host' : 'not-configured';
  }
}
