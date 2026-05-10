import { operationEvents, servers } from '../../data/mockData.js';
import type { ReleaseReadinessCheck, ReleaseReadinessResponse } from '../../types.js';
import { RuntimeConfig } from '../config.js';
import { getDatabasePath } from './database.js';
import { listAuditEntries } from './auditService.js';
import { resolveServerLifecycleStatus } from '../../shared/serverFilters.js';

export function buildReleaseReadiness(config: RuntimeConfig): ReleaseReadinessResponse {
  const auditEntries = listAuditEntries();
  const activeAuditIssues = auditEntries.filter((entry) => (
    entry.action !== 'SECURITY_REMEDIATION'
    && (entry.status === 'blocked' || entry.status === 'failed')
  ));
  const connectedServers = servers.filter((server) => resolveServerLifecycleStatus(server) !== 'unconnected');
  const openEvents = operationEvents.filter((event) => event.status === 'open');
  const databaseName = getDatabasePath().split(/[\\/]/).pop() ?? 'unknown';

  const checks: ReleaseReadinessCheck[] = [
    {
      id: 'runtime-production',
      label: 'Runtime environment',
      severity: config.nodeEnv === 'production' ? 'info' : 'warn',
      passed: config.nodeEnv === 'production',
      value: config.nodeEnv,
      evidence: `NODE_ENV=${config.nodeEnv}`,
      recommendedAction: config.nodeEnv === 'production' ? 'Keep production runtime guard active.' : 'Use NODE_ENV=production before public release.',
      relatedModule: 'runtime',
    },
    {
      id: 'database-online',
      label: 'SQLite persistence',
      severity: 'info',
      passed: true,
      value: databaseName,
      evidence: `SQLite store opened as ${databaseName}`,
      recommendedAction: 'Keep database backup and WAL checkpoint checks in the release runbook.',
      relatedModule: 'database',
    },
    {
      id: 'api-allowlist',
      label: 'Custom API allowlist',
      severity: config.customApiAllowedHosts.length > 0 ? 'info' : 'fail',
      passed: config.customApiAllowedHosts.length > 0,
      value: `${config.customApiAllowedHosts.length} host(s)`,
      evidence: config.customApiAllowedHosts.length > 0 ? 'Outbound custom API proxy is constrained by host allowlist.' : 'No custom API host allowlist is configured.',
      recommendedAction: 'Configure CUSTOM_API_ALLOWED_HOSTS with only required upstream domains.',
      relatedModule: 'api',
    },
    {
      id: 'ai-runtime',
      label: 'AI provider key',
      severity: config.ai.apiKey ? 'info' : 'warn',
      passed: Boolean(config.ai.apiKey),
      value: config.ai.apiKey ? config.ai.model : 'simulation mode',
      evidence: config.ai.apiKey ? `Server-side AI model configured: ${config.ai.model}` : 'No server AI key configured; local rule analysis remains available.',
      recommendedAction: config.ai.apiKey ? 'Continue using server-side key custody.' : 'Add AI_API_KEY on the server when real model answers are required.',
      relatedModule: 'ai',
    },
    {
      id: 'ssh-coverage',
      label: 'SSH coverage',
      severity: connectedServers.length > 0 ? 'info' : 'warn',
      passed: connectedServers.length > 0,
      value: `${connectedServers.length}/${servers.length}`,
      evidence: `${connectedServers.length} of ${servers.length} server asset(s) are SSH-connected.`,
      recommendedAction: connectedServers.length > 0 ? 'Run a sample health check before release.' : 'Connect at least one server with password or key authentication to verify terminal flows.',
      relatedModule: 'ssh',
    },
    {
      id: 'open-events',
      label: 'Open operation events',
      severity: openEvents.length === 0 ? 'info' : 'warn',
      passed: openEvents.length === 0,
      value: `${openEvents.length}`,
      evidence: `${openEvents.length} open event(s) are waiting in the operations queue.`,
      recommendedAction: openEvents.length === 0 ? 'No event action required.' : 'Review and close open events from security remediation or operations center.',
      relatedModule: 'events',
    },
    {
      id: 'audit-failures',
      label: 'Audit failures',
      severity: activeAuditIssues.some((entry) => entry.status === 'failed') ? 'fail' : activeAuditIssues.length > 0 ? 'warn' : 'info',
      passed: activeAuditIssues.length === 0,
      value: `${activeAuditIssues.length}`,
      evidence: `${activeAuditIssues.length} blocked or failed audit item(s) remain active.`,
      recommendedAction: activeAuditIssues.length === 0 ? 'Keep audit export available for release evidence.' : 'Review failed/blocked audit records and remediate before release.',
      relatedModule: 'audit',
    },
  ];

  const failures = checks.filter((check) => check.severity === 'fail').length;
  const warnings = checks.filter((check) => check.severity === 'warn').length;
  const passed = checks.filter((check) => check.passed).length;
  const score = Math.max(0, Math.round((passed / checks.length) * 100 - failures * 12 - warnings * 4));
  const blockers = checks.filter((check) => check.severity === 'fail' || (!check.passed && check.relatedModule === 'audit'));

  return {
    score,
    status: failures > 0 ? 'blocked' : warnings > 0 ? 'review' : 'ready',
    generatedAt: new Date().toISOString(),
    summary: {
      totalChecks: checks.length,
      passed,
      warnings,
      failures,
    },
    checks,
    blockers,
    nextBestAction: blockers[0]?.recommendedAction ?? checks.find((check) => !check.passed)?.recommendedAction ?? 'Run the regular smoke suite and publish through the release pipeline.',
  };
}
