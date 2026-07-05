import path from 'node:path';
import type { DiagnosticExportResponse } from '../../types.js';
import type { RuntimeConfig } from '../config.js';
import { getDatabasePath } from './database.js';
import { buildReleaseReadiness } from './releaseReadinessService.js';
import { listAuditEntries } from './auditService.js';
import { getServerShellEvidence, getServerShellSelfTest, getServerShellSelfTestTrend, getServerShellSessionReplays, getServerShellStatus, listCloudAccounts, summarizeServerInventory } from './inventoryService.js';
import { getAiProviderStatus } from './aiSettingsService.js';
import { getSshShellSocketDiagnostics } from '../sshShellSocket.js';

export function buildDiagnosticExport(config: RuntimeConfig): DiagnosticExportResponse {
  const generatedAt = new Date().toISOString();
  const readiness = buildReleaseReadiness(config);
  const auditEntries = listAuditEntries();
  const cloudAccounts = listCloudAccounts();
  const inventorySummary = summarizeServerInventory();
  const aiProvider = getAiProviderStatus(config);
  const shellStatus = getServerShellStatus();
  const shellSocketDiagnostics = getSshShellSocketDiagnostics();
  const shellEvidence = getServerShellEvidence();
  const shellSessionReplays = getServerShellSessionReplays();

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
        baseUrlHost: getHostLabel(aiProvider.baseUrl),
        model: aiProvider.model,
        configured: aiProvider.configured,
        managedBy: aiProvider.managedBy,
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
        total: inventorySummary.total,
        running: inventorySummary.running,
        stopped: inventorySummary.stopped,
        unconnected: inventorySummary.unconnected,
        connectedSsh: inventorySummary.sshConnected,
      },
      cloudAccounts: {
        total: cloudAccounts.length,
        connected: cloudAccounts.filter((account) => account.status === 'connected').length,
        warning: cloudAccounts.filter((account) => account.status === 'warning').length,
        disconnected: cloudAccounts.filter((account) => account.status === 'disconnected').length,
        providers: new Set(cloudAccounts.map((account) => account.provider)).size,
      },
      regions: inventorySummary.regions,
      customProviders: inventorySummary.customProviders,
      openEvents: inventorySummary.openEvents,
    },
    sshTerminal: {
      activeSessions: shellStatus.activeCount,
      byMode: shellStatus.byMode,
      oldestConnectedAt: shellStatus.oldestConnectedAt,
      newestConnectedAt: shellStatus.newestConnectedAt,
      websocket: shellSocketDiagnostics,
      lastSelfTest: getServerShellSelfTest(),
      selfTestTrend: getServerShellSelfTestTrend(),
      recentEvidence: shellEvidence.map((item) => ({
        serverName: item.serverName,
        mode: item.mode,
        active: item.active,
        updatedAt: item.updatedAt,
        transcriptLines: countTranscriptLines(item.transcript),
        transcriptChars: item.transcript.length,
      })),
      sessionReplays: shellSessionReplays.map((item) => ({
        serverName: item.serverName,
        mode: item.mode,
        active: item.active,
        connectedAt: item.connectedAt,
        closedAt: item.closedAt,
        durationMs: item.durationMs,
        inputEvents: item.inputEvents,
        inputBytes: item.inputBytes,
        inputSubmits: item.inputSubmits,
        outputEvents: item.outputEvents,
        outputBytes: item.outputBytes,
        outputLines: item.outputLines,
        errorCount: item.errorCount,
        closeSignal: item.closeSignal,
        lastEventAt: item.lastEventAt,
        timeline: item.timeline.map((event) => ({
          type: event.type,
          at: event.at,
          bytes: event.bytes,
          lines: event.lines,
        })),
      })),
    },
  };
}

function countTranscriptLines(value: string) {
  return value.split('\n').filter((line) => line.trim()).length;
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
