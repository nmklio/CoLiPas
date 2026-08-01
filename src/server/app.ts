import fs from 'node:fs';
import path from 'node:path';
import compression from 'compression';
import cors from 'cors';
import express, { ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { cloudAccounts, operationEvents, servers } from '../data/mockData.js';
import { RuntimeConfig, loadConfig } from './config.js';
import { isHttpError } from './httpErrors.js';
import { analyzeOperations, listAiModels, streamAiAnalysis, testAiConnection } from './services/aiService.js';
import { loadAiProviderSettings, saveAiProviderSettings } from './services/aiSettingsService.js';
import { buildConfigSummary } from './services/configSummary.js';
import { listAuditEntries, recordAudit, remediateSecurityRisk } from './services/auditService.js';
import {
  buildAccountPayload,
  changeAdminPassword,
  getCurrentSession,
  getLoginThrottleStatus,
  listAccountSessions,
  login,
  logout,
  requireSession,
  revokeAccountSession,
  revokeOtherAccountSessions,
  updateConsoleProfile,
} from './services/authService.js';
import { executeCustomApiProxy } from './services/customApiProxy.js';
import { getDatabasePath } from './services/database.js';
import { buildDiagnosticExport } from './services/diagnosticService.js';
import { createMaintenanceWindow, deleteMaintenanceWindow, listMaintenanceWindows } from './services/maintenanceWindowService.js';
import { createOperationTask, preflightOperationTask } from './services/operationsService.js';
import { buildOverviewHttpSnapshot, matchesOverviewEtag } from './services/overviewSnapshotService.js';
import { createReleaseEvidenceShare, listReleaseEvidenceShares, readPublicReleaseEvidenceShare, revokeReleaseEvidenceShare } from './services/releaseEvidenceShareService.js';
import { buildReleaseReadiness, buildReleaseReadinessReport, getReleaseGatePolicy, recordReleaseReadinessSnapshot, updateReleaseGatePolicy } from './services/releaseReadinessService.js';
import { checkReleaseSyncHealth } from './services/releaseSyncHealthService.js';
import { buildReleaseVerification, isReleaseVerificationAuthorized, isReleaseVerificationEnabled } from './services/releaseVerificationService.js';
import { getResourceAlertPolicy, updateResourceAlertPolicy } from './services/resourceAlertPolicyService.js';
import { claimSshProductionProbeScheduleRun, getSshProductionProbeSchedule, recordSshProductionProbe, updateSshProductionProbeSchedule } from './services/sshProductionProbeService.js';
import { createSshRunbookCommand, deleteSshRunbookCommand, importSshRunbookCommands, listSshRunbookCommands, markSshRunbookCommandUsed, reorderSshRunbookCommands, updateSshRunbookCommand, updateSshRunbookCommandPin } from './services/sshRunbookService.js';
import {
  buildServerInventorySnapshot,
  bulkImportServers,
  closeServerShell,
  connectServer,
  deleteServer,
  getServerShellEvidence,
  getServerMetricHistory,
  getServerShellStatus,
  inspectServerIdentity,
  listCloudAccounts,
  listOperationEvents,
  listServers,
  openServerShell,
  recordServerShellSelfTest,
  refreshServerMetrics,
  resizeServerShell,
  runServerCommand,
  runServerDiagnostic,
  streamServerCommand,
  subscribeServerShell,
  updateServer,
  writeServerShell,
} from './services/inventoryService.js';
import { executeServerAction } from './services/serverActions.js';

export function createApp(config: RuntimeConfig = loadConfig()) {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '3mb' }));
  app.use(
    '/api',
    cors((request, callback) => {
      const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
      const host = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host;
      const isSameHostOrigin = Boolean(
        origin && host && (origin === `http://${host}` || origin === `https://${host}`),
      );

      if (!origin || config.corsOrigins.includes(origin) || isSameHostOrigin) {
        callback(null, { origin: origin || false });
        return;
      }

      callback(new Error(`CORS origin blocked: ${origin}`), { origin: false });
    }),
  );

  app.get('/api/health', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      status: 'ok',
      nodeEnv: config.nodeEnv,
      database: {
        driver: 'sqlite',
        name: path.basename(getDatabasePath()),
      },
      release: {
        targetName: config.release.targetName || 'local',
        deploymentMode: config.release.deploymentMode || 'node',
        gitCommit: config.release.gitCommit ? config.release.gitCommit.slice(0, 12) : '',
      },
      uptime: Math.round(process.uptime()),
      time: new Date().toISOString(),
    });
  });

  app.get('/api/release/verify', (request, response) => {
    if (!isReleaseVerificationEnabled(config)) {
      response.status(404).json({ error: { code: 'RELEASE_VERIFY_DISABLED', message: 'Release verification is disabled' } });
      return;
    }

    if (!isReleaseVerificationAuthorized(config, getBearerToken(request.headers.authorization))) {
      response.status(401).json({ error: { code: 'RELEASE_VERIFY_UNAUTHORIZED', message: 'Release verification token is invalid' } });
      return;
    }

    response.setHeader('Cache-Control', 'no-store');
    response.json(buildReleaseVerification(config));
  });

  app.get('/api/public/release-evidence/:token', (request, response, next) => {
    try {
      response.setHeader('Cache-Control', 'no-store, private');
      response.json(readPublicReleaseEvidenceShare(request.params.token));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/login', (request, response, next) => {
    try {
      const session = login(request.body, request, response, config);
      recordAudit({
        action: 'AUTH_LOGIN',
        actor: session.user.username,
        target: 'auth',
        status: 'success',
        detail: 'Operator signed in',
      });
      response.json(session);
    } catch (error) {
      recordAudit({
        action: 'AUTH_LOGIN',
        actor: getAttemptedUsername(request.body),
        target: 'auth',
        status: 'failed',
        detail: error instanceof Error ? error.message : 'Operator sign-in failed',
      });
      const throttle = getLoginThrottleStatus(request.body, request);
      if (throttle.throttled) {
        response.setHeader('Retry-After', String(throttle.retryAfterSeconds));
      }
      next(error);
    }
  });

  app.post('/api/auth/logout', (request, response) => {
    const session = getCurrentSession(request, config);
    recordAudit({
      action: 'AUTH_LOGOUT',
      actor: session?.user.username ?? 'anonymous',
      target: 'auth',
      status: 'success',
      detail: 'Operator signed out',
    });
    response.json(logout(request, response, config));
  });

  app.get('/api/auth/session', (request, response) => {
    const session = getCurrentSession(request, config);
    response.json(session ?? { authenticated: false });
  });

  app.use('/api', (request, _response, next) => {
    if (
      request.path === '/health'
      || request.path === '/release/verify'
      || request.path.startsWith('/auth/')
      || request.path.startsWith('/public/release-evidence/')
    ) {
      next();
      return;
    }

    try {
      requireSession(request, config);
      next();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/account', (request, response, next) => {
    try {
      response.json(buildAccountPayload(request, config));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/release/sync-health', async (_request, response, next) => {
    try {
      response.setHeader('Cache-Control', 'no-store');
      response.json(await checkReleaseSyncHealth(config));
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/account/profile', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const profile = updateConsoleProfile(request.body);
      recordAudit({
        action: 'PROFILE_UPDATE',
        actor: session.user.username,
        target: 'account-profile',
        status: 'success',
        detail: 'Console profile updated',
      });
      response.json({ profile });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/account/sessions', (request, response, next) => {
    try {
      response.setHeader('Cache-Control', 'no-store');
      response.json(listAccountSessions(request, config));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/account/sessions/:sessionId', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const result = revokeAccountSession(request.params.sessionId, request, config);
      recordAudit({
        action: 'AUTH_SESSION_REVOKE',
        actor: session.user.username,
        target: 'account-session',
        status: 'success',
        detail: 'Administrator revoked one other login session',
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/account/sessions/revoke-others', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const result = revokeOtherAccountSessions(request, config);
      recordAudit({
        action: 'AUTH_SESSION_REVOKE_OTHERS',
        actor: session.user.username,
        target: 'account-sessions',
        status: 'success',
        detail: `Administrator revoked ${result.revoked} other login session(s)`,
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/account/password', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const result = changeAdminPassword(request.body, request, config);
      recordAudit({
        action: 'AUTH_PASSWORD_CHANGE',
        actor: session.user.username,
        target: 'admin-account',
        status: 'success',
        detail: 'Administrator password changed and other sessions were revoked',
      });
      response.json(result);
    } catch (error) {
      recordAudit({
        action: 'AUTH_PASSWORD_CHANGE',
        actor: getCurrentSession(request, config)?.user.username ?? 'anonymous',
        target: 'admin-account',
        status: 'failed',
        detail: error instanceof Error ? error.message : 'Password change failed',
      });
      next(error);
    }
  });

  app.get('/api/overview', async (request, response, next) => {
    try {
      await refreshServerMetrics();
    } catch (error) {
      next(error);
      return;
    }

    const snapshot = buildOverviewHttpSnapshot();
    response.setHeader('Cache-Control', 'private, no-cache');
    response.setHeader('ETag', snapshot.etag);
    response.setHeader('X-CoLiPas-Overview-Bytes', String(snapshot.bytes));
    response.setHeader('X-CoLiPas-Overview-Revision', snapshot.revision);
    response.vary('Cookie');

    if (matchesOverviewEtag(request.headers['if-none-match'], snapshot.etag)) {
      response.status(304).end();
      return;
    }

    response.type('application/json').send(snapshot.body);
  });

  app.get('/api/monitoring/resource-alert-policy', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.json(getResourceAlertPolicy());
  });

  app.put('/api/monitoring/resource-alert-policy', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const result = updateResourceAlertPolicy(request.body);
      recordAudit({
        action: 'RESOURCE_ALERT_POLICY_UPDATE',
        actor: session.user.username,
        target: 'monitoring-resource-alert-policy',
        status: 'success',
        detail: `Resource alerts ${result.policy.enabled ? 'enabled' : 'paused'}; CPU ${result.policy.cpuThreshold}%, memory ${result.policy.memoryThreshold}%, disk ${result.policy.diskThreshold}%, reminder ${result.policy.reminderMinutes} minutes`,
      });
      response.setHeader('Cache-Control', 'no-store');
      response.json(result);
    } catch (error) {
      recordAudit({
        action: 'RESOURCE_ALERT_POLICY_UPDATE',
        actor: getCurrentSession(request, config)?.user.username ?? 'anonymous',
        target: 'monitoring-resource-alert-policy',
        status: 'failed',
        detail: 'Resource alert policy update was rejected',
      });
      next(error);
    }
  });

  app.get('/api/config', (_request, response) => {
    response.json(buildConfigSummary(config));
  });

  app.get('/api/ai/provider', (_request, response) => {
    response.json(loadAiProviderSettings(config));
  });

  app.put('/api/ai/provider', (request, response, next) => {
    try {
      const result = saveAiProviderSettings(request.body, config);
      recordAudit({
        action: 'AI_PROVIDER_SAVE',
        actor: 'operator',
        target: result.provider.model,
        status: 'success',
        detail: result.hasStoredApiKey ? 'AI provider saved with encrypted database key custody' : 'AI provider saved without changing key custody',
      });
      response.json(result);
    } catch (error) {
      recordAudit({
        action: 'AI_PROVIDER_SAVE',
        actor: 'operator',
        target: request.body?.model ?? 'unknown',
        status: 'failed',
        detail: error instanceof Error ? error.message : 'AI provider save failed',
      });
      next(error);
    }
  });

  app.get('/api/cloud/accounts', (_request, response) => {
    response.json({ items: listCloudAccounts() });
  });

  app.get('/api/servers', (request, response) => {
    response.json(listServers(request.query));
  });

  app.get('/api/servers/:serverId/metric-history', (request, response, next) => {
    try {
      response.setHeader('Cache-Control', 'private, max-age=15');
      response.json(getServerMetricHistory(request.params.serverId, request.query.window));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/servers', async (request, response, next) => {
    try {
      response.status(201).json(await connectServer(request.body));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/servers/inspect', async (request, response, next) => {
    try {
      const result = await inspectServerIdentity(request.body);
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/servers/:serverId', async (request, response, next) => {
    try {
      response.json(await updateServer(request.params.serverId, request.body));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/servers/:serverId', (request, response, next) => {
    try {
      response.json(deleteServer(request.params.serverId));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/operations/events', (_request, response) => {
    response.json({ items: listOperationEvents() });
  });

  app.post('/api/servers/import', (request, response, next) => {
    try {
      response.status(201).json(bulkImportServers(request.body));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/operations/maintenance-windows', (_request, response) => {
    response.json({ items: listMaintenanceWindows() });
  });

  app.post('/api/operations/maintenance-windows', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const result = createMaintenanceWindow(request.body, servers);
      recordAudit({
        action: 'MAINTENANCE_WINDOW_CREATE',
        actor: session.user.username,
        target: 'operations-maintenance-window',
        status: 'success',
        detail: `Maintenance window created: ${result.window.title} (${result.window.scope})`,
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/operations/maintenance-windows/:windowId', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const result = deleteMaintenanceWindow(request.params.windowId);
      recordAudit({
        action: 'MAINTENANCE_WINDOW_DELETE',
        actor: session.user.username,
        target: 'operations-maintenance-window',
        status: 'success',
        detail: 'Maintenance window deleted',
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/operations/tasks', async (request, response, next) => {
    try {
      response.status(202).json(await createOperationTask(request.body));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/operations/tasks/preflight', (request, response, next) => {
    try {
      response.json(preflightOperationTask(request.body));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/ai/analyze', async (request, response, next) => {
    try {
      const result = await analyzeOperations(request.body, {
        servers,
        events: operationEvents,
        shellEvidence: getServerShellEvidence(resolveAiShellEvidenceServerIds(request.body?.serverId)),
      }, config);
      recordAudit({
        action: 'AI_ANALYZE',
        actor: 'operator',
        target: result.model,
        status: 'success',
        detail: result.simulated ? 'Simulated AI analysis returned' : 'AI analysis returned',
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/ai/test', async (request, response, next) => {
    try {
      const result = await testAiConnection(request.body, config);
      recordAudit({
        action: 'AI_TEST',
        actor: 'operator',
        target: result.model,
        status: 'success',
        detail: `AI connection test succeeded in ${result.latencyMs}ms`,
      });
      response.json(result);
    } catch (error) {
      recordAudit({
        action: 'AI_TEST',
        actor: 'operator',
        target: request.body?.provider?.model ?? 'unknown',
        status: 'failed',
        detail: error instanceof Error ? error.message : 'AI connection test failed',
      });
      next(error);
    }
  });

  app.post('/api/ai/models', async (request, response, next) => {
    try {
      response.json(await listAiModels(request.body, config));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/ai/stream', async (request, response, next) => {
    let streamStarted = false;
    const writeEvent = (payload: unknown) => {
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
      flushSse(response);
    };

    try {
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders();
      streamStarted = true;

      const result = await streamAiAnalysis(request.body, {
        servers,
        events: operationEvents,
        shellEvidence: getServerShellEvidence(resolveAiShellEvidenceServerIds(request.body?.serverId)),
      }, config, (chunk) => {
        writeEvent({ type: 'chunk', content: chunk });
      });

      recordAudit({
        action: 'AI_ANALYZE',
        actor: 'operator',
        target: result.model,
        status: 'success',
        detail: result.simulated ? 'Simulated streaming AI analysis returned' : 'Streaming AI analysis returned',
      });
      writeEvent({ type: 'done', result });
      response.end();
    } catch (error) {
      recordAudit({
        action: 'AI_ANALYZE',
        actor: 'operator',
        target: request.body?.provider?.model ?? 'unknown',
        status: 'failed',
        detail: error instanceof Error ? error.message : 'Streaming AI analysis failed',
      });

      if (streamStarted && !response.writableEnded) {
        writeEvent({
          type: 'error',
          message: error instanceof Error ? error.message : 'AI streaming request failed',
        });
        response.end();
        return;
      }

      next(error);
    }
  });

  app.post('/api/custom-apis/test', async (request, response, next) => {
    const auditTarget = sanitizeAuditTarget(request.body?.url);
    try {
      const result = await executeCustomApiProxy(request.body, config);
      recordAudit({
        action: 'CUSTOM_API_TEST',
        actor: 'operator',
        target: auditTarget,
        status: result.ok ? 'success' : 'failed',
        detail: `Custom API returned HTTP ${result.status}`,
      });
      response.json(result);
    } catch (error) {
      recordAudit({
        action: 'CUSTOM_API_TEST',
        actor: 'operator',
        target: auditTarget,
        status: 'blocked',
        detail: error instanceof Error ? error.message : 'Custom API request blocked',
      });
      next(error);
    }
  });

  app.post('/api/servers/actions', async (request, response, next) => {
    try {
      response.status(202).json(await executeServerAction(request.body));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/servers/commands', async (request, response, next) => {
    try {
      response.json(await runServerCommand(request.body));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/servers/commands/stream', async (request, response, next) => {
    let streamStarted = false;
    const controller = new AbortController();
    const writeEvent = (payload: unknown) => {
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
      flushSse(response);
    };

    response.on('close', () => {
      if (!response.writableEnded) {
        controller.abort();
      }
    });

    try {
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders();
      streamStarted = true;

      const result = await streamServerCommand(request.body, (event) => writeEvent(event), {
        signal: controller.signal,
        timeoutMs: 30000,
      });
      writeEvent({ type: 'done', result });
      response.end();
    } catch (error) {
      recordAudit({
        action: 'SERVER_SSH_COMMAND',
        actor: 'operator',
        target: request.body?.serverId ?? 'unknown',
        status: 'failed',
        detail: error instanceof Error ? error.message : 'SSH stream command failed',
        correlationId: typeof request.body?.correlationId === 'string' ? request.body.correlationId : undefined,
      });

      if (streamStarted && !response.writableEnded) {
        writeEvent({
          type: 'error',
          message: error instanceof Error ? error.message : 'SSH stream command failed',
        });
        response.end();
        return;
      }

      next(error);
    }
  });

  app.post('/api/servers/shells', async (request, response, next) => {
    try {
      response.status(201).json(await openServerShell(request.body));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/servers/shells/status', (_request, response) => {
    response.json(getServerShellStatus());
  });

  app.get('/api/servers/ssh-runbook', (request, response, next) => {
    try {
      requireSession(request, config);
      response.json({ commands: listSshRunbookCommands() });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/servers/ssh-runbook', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const command = createSshRunbookCommand(request.body);
      recordAudit({
        action: 'SSH_RUNBOOK_CREATE',
        actor: session.user.username,
        target: 'ssh-runbook',
        status: 'success',
        detail: `SSH runbook command saved: ${command.title}`,
      });
      response.status(201).json(command);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/servers/ssh-runbook/import', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const result = importSshRunbookCommands(request.body);
      recordAudit({
        action: 'SSH_RUNBOOK_IMPORT',
        actor: session.user.username,
        target: 'ssh-runbook',
        status: 'success',
        detail: `SSH runbook pack imported: ${result.imported.length} added, ${result.skipped.length} skipped`,
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/servers/ssh-runbook/reorder', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const commands = reorderSshRunbookCommands(request.body);
      recordAudit({
        action: 'SSH_RUNBOOK_REORDER',
        actor: session.user.username,
        target: 'ssh-runbook',
        status: 'success',
        detail: `SSH runbook commands reordered: ${commands.length}`,
      });
      response.json({ commands });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/servers/ssh-runbook/:commandId/pin', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const result = updateSshRunbookCommandPin(request.params.commandId, request.body);
      recordAudit({
        action: 'SSH_RUNBOOK_PIN',
        actor: session.user.username,
        target: 'ssh-runbook',
        status: 'success',
        detail: `SSH runbook command ${result.command.pinned ? 'pinned' : 'unpinned'}: ${result.command.title}`,
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/servers/ssh-runbook/:commandId/use', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const result = markSshRunbookCommandUsed(request.params.commandId, request.body);
      recordAudit({
        action: 'SSH_RUNBOOK_USE',
        actor: session.user.username,
        target: 'ssh-runbook',
        status: 'success',
        detail: `SSH runbook command used via ${result.command.lastUsedMode}: ${result.command.title}`,
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/servers/ssh-runbook/:commandId', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const command = updateSshRunbookCommand(request.params.commandId, request.body);
      recordAudit({
        action: 'SSH_RUNBOOK_UPDATE',
        actor: session.user.username,
        target: 'ssh-runbook',
        status: 'success',
        detail: `SSH runbook command updated: ${command.title}`,
      });
      response.json(command);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/servers/ssh-runbook/:commandId', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const result = deleteSshRunbookCommand(request.params.commandId);
      recordAudit({
        action: 'SSH_RUNBOOK_DELETE',
        actor: session.user.username,
        target: 'ssh-runbook',
        status: 'success',
        detail: 'SSH runbook command deleted',
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/servers/shells/:sessionId/stream', (request, response, next) => {
    let unsubscribe: (() => void) | null = null;
    const writeEvent = (payload: unknown) => {
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
      flushSse(response);
    };

    try {
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders();

      unsubscribe = subscribeServerShell(
        {
          sessionId: request.params.sessionId,
          replay: request.query.replay,
        },
        writeEvent,
      );
      response.write(': connected\n\n');
      flushSse(response);
      response.on('close', () => {
        unsubscribe?.();
      });
    } catch (error) {
      unsubscribe?.();
      if (!response.headersSent) {
        next(error);
        return;
      }
      writeEvent({
        type: 'error',
        message: error instanceof Error ? error.message : 'SSH shell stream failed',
      });
      response.end();
    }
  });

  app.post('/api/servers/shells/:sessionId/input', (request, response, next) => {
    try {
      response.json(writeServerShell({
        sessionId: request.params.sessionId,
        input: request.body?.input,
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/servers/shells/:sessionId/resize', (request, response, next) => {
    try {
      response.json(resizeServerShell({
        sessionId: request.params.sessionId,
        cols: request.body?.cols,
        rows: request.body?.rows,
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/servers/shells/:sessionId/self-test', (request, response, next) => {
    try {
      response.json(recordServerShellSelfTest({
        sessionId: request.params.sessionId,
        status: request.body?.status,
        lines: request.body?.lines,
        durationMs: request.body?.durationMs,
        linesPerSecond: request.body?.linesPerSecond,
        firstResponseMs: request.body?.firstResponseMs,
        outputSpanMs: request.body?.outputSpanMs,
        rttMs: request.body?.rttMs,
        throughputBytesPerSecond: request.body?.throughputBytesPerSecond,
        networkLabel: request.body?.networkLabel,
      }));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/servers/shells/:sessionId', (request, response, next) => {
    try {
      response.json(closeServerShell({ sessionId: request.params.sessionId }));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/servers/:serverId/diagnostics', async (request, response, next) => {
    try {
      response.json(await runServerDiagnostic(request.params.serverId));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/audit/events', (_request, response) => {
    response.json({ items: listAuditEntries() });
  });

  app.get('/api/audit/readiness', (_request, response) => {
    response.json(buildReleaseReadiness(config));
  });

  app.get('/api/audit/readiness/policy', (_request, response) => {
    response.json(getReleaseGatePolicy(config));
  });

  app.put('/api/audit/readiness/policy', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      response.json(updateReleaseGatePolicy(config, request.body, session.user.username));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/audit/readiness/snapshots', (_request, response) => {
    response.status(201).json(recordReleaseReadinessSnapshot(config));
  });

  app.get('/api/audit/readiness/report', (_request, response) => {
    response.json(buildReleaseReadinessReport(config));
  });

  app.get('/api/audit/readiness/shares', (_request, response) => {
    response.json(listReleaseEvidenceShares());
  });

  app.post('/api/audit/readiness/shares', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      response.status(201).json(createReleaseEvidenceShare(config, request.body, session.user.username));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/audit/readiness/shares/:shareId', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      response.json(revokeReleaseEvidenceShare(request.params.shareId, session.user.username));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/audit/diagnostics/export', (_request, response) => {
    response.json(buildDiagnosticExport(config));
  });

  app.post('/api/audit/ssh-production-probes', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      response.status(201).json(recordSshProductionProbe(request.body, session.user.username));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/audit/ssh-production-probes/schedule', (_request, response) => {
    response.json(getSshProductionProbeSchedule());
  });

  app.put('/api/audit/ssh-production-probes/schedule', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      response.json(updateSshProductionProbeSchedule(request.body, session.user.username));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/audit/ssh-production-probes/schedule/claim', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      response.json(claimSshProductionProbeScheduleRun(session.user.username));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/audit/remediate', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      response.json(remediateSecurityRisk(request.body, session.user.username));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/audit/ssh-support-ticket-copy', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      const sections = clampSupportTicketSections(request.body?.sections);
      const severity = normalizeSupportTicketSeverity(request.body?.tone);
      const audit = recordAudit({
        action: 'SSH_SUPPORT_TICKET_COPY',
        actor: session.user.username,
        target: 'ssh-support-ticket',
        status: 'success',
        detail: `SSH lag ticket template copied with ${sections} sanitized evidence section(s); severity ${severity}.`,
      });
      response.status(201).json({ ok: true, audit });
    } catch (error) {
      next(error);
    }
  });

  const distDir = path.resolve(process.cwd(), 'dist');
  const iconPath = path.join(distDir, 'colipas-icon.svg');
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    app.get('/favicon.ico', (_request, response, next) => {
      if (!fs.existsSync(iconPath)) {
        next();
        return;
      }

      response.type('image/svg+xml');
      response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      response.setHeader('Pragma', 'no-cache');
      response.setHeader('Expires', '0');
      response.sendFile(iconPath);
    });

    app.use(
      express.static(distDir, {
        index: false,
        etag: false,
        maxAge: 0,
        setHeaders(response) {
          response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          response.setHeader('Pragma', 'no-cache');
          response.setHeader('Expires', '0');
        },
      }),
    );
    app.get(/^(?!\/api\/).*/, (_request, response) => {
      response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      response.setHeader('Pragma', 'no-cache');
      response.setHeader('Expires', '0');
      response.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'API route not found' } });
  });

  app.use(errorHandler);

  return app;
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (isJsonParseError(error)) {
    response.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Invalid JSON request body',
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request payload',
        details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
    });
    return;
  }

  if (isHttpError(error)) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }

  response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
};

function getAttemptedUsername(input: unknown) {
  if (!input || typeof input !== 'object' || !('username' in input)) {
    return 'anonymous';
  }

  const value = (input as { username?: unknown }).username;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : 'anonymous';
}

function flushSse(response: express.Response) {
  (response as express.Response & { flush?: () => void }).flush?.();
}

function resolveAiShellEvidenceServerIds(serverId: unknown) {
  if (typeof serverId === 'string' && serverId.trim() && serverId !== 'all') {
    return [serverId.trim()];
  }

  return undefined;
}

function getBearerToken(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function clampSupportTicketSections(value: unknown) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(20, Math.round(number)));
}

function normalizeSupportTicketSeverity(value: unknown) {
  return value === 'ok' || value === 'warn' || value === 'fail' ? value : 'unknown';
}

function isJsonParseError(error: unknown) {
  return Boolean(
    error
      && typeof error === 'object'
      && 'type' in error
      && (error as { type?: unknown }).type === 'entity.parse.failed'
      && 'status' in error
      && (error as { status?: unknown }).status === 400,
  );
}

function sanitizeAuditTarget(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    return 'unknown';
  }

  try {
    const url = new URL(value);
    const sensitiveKeys = new Set([
      'access_token',
      'api_key',
      'apikey',
      'auth',
      'authorization',
      'bearer',
      'client_secret',
      'key',
      'password',
      'secret',
      'signature',
      'token',
    ]);
    url.username = '';
    url.password = '';
    url.searchParams.forEach((_paramValue, key) => {
      if (sensitiveKeys.has(key.toLowerCase())) {
        url.searchParams.set(key, '[redacted]');
      }
    });
    return url.toString().slice(0, 500);
  } catch {
    return value.replace(/([?&](?:access_token|api_key|apikey|auth|authorization|bearer|client_secret|key|password|secret|signature|token)=)[^&\s]+/gi, '$1[redacted]').slice(0, 500);
  }
}
