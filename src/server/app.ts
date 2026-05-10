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
import { buildConfigSummary } from './services/configSummary.js';
import { listAuditEntries, recordAudit, remediateSecurityRisk } from './services/auditService.js';
import { buildAccountPayload, changeAdminPassword, getCurrentSession, getLoginThrottleStatus, login, logout, requireSession, updateConsoleProfile } from './services/authService.js';
import { executeCustomApiProxy } from './services/customApiProxy.js';
import { getDatabasePath } from './services/database.js';
import { buildDiagnosticExport } from './services/diagnosticService.js';
import { createOperationTask, preflightOperationTask } from './services/operationsService.js';
import { buildReleaseReadiness, buildReleaseReadinessReport, recordReleaseReadinessSnapshot } from './services/releaseReadinessService.js';
import {
  closeServerShell,
  connectServer,
  deleteServer,
  inspectServerIdentity,
  listCloudAccounts,
  listOperationEvents,
  listServers,
  openServerShell,
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
import { resolveServerLifecycleStatus } from '../shared/serverFilters.js';

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
    response.json({
      status: 'ok',
      nodeEnv: config.nodeEnv,
      database: {
        driver: 'sqlite',
        name: path.basename(getDatabasePath()),
      },
      uptime: Math.round(process.uptime()),
      time: new Date().toISOString(),
    });
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
    response.json(logout(request, response));
  });

  app.get('/api/auth/session', (request, response) => {
    const session = getCurrentSession(request, config);
    response.json(session ?? { authenticated: false });
  });

  app.use('/api', (request, _response, next) => {
    if (request.path === '/health' || request.path.startsWith('/auth/')) {
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

  app.get('/api/overview', async (_request, response, next) => {
    try {
      await refreshServerMetrics();
    } catch (error) {
      next(error);
      return;
    }

    response.json({
      cloudAccounts,
      servers: servers.map((server) => ({
        ...server,
        status: resolveServerLifecycleStatus(server),
      })),
      operationEvents,
      summary: {
        totalServers: servers.length,
        onlineServers: servers.filter((server) => resolveServerLifecycleStatus(server) === 'running').length,
        openEvents: operationEvents.filter((event) => event.status === 'open').length,
      },
    });
  });

  app.get('/api/config', (_request, response) => {
    response.json(buildConfigSummary(config));
  });

  app.get('/api/cloud/accounts', (_request, response) => {
    response.json({ items: listCloudAccounts() });
  });

  app.get('/api/servers', (request, response) => {
    response.json(listServers(request.query));
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
      const result = await analyzeOperations(request.body, { servers, events: operationEvents }, config);
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

      const result = await streamAiAnalysis(request.body, { servers, events: operationEvents }, config, (chunk) => {
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

      unsubscribe = subscribeServerShell({ sessionId: request.params.sessionId }, writeEvent);
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

  app.post('/api/audit/readiness/snapshots', (_request, response) => {
    response.status(201).json(recordReleaseReadinessSnapshot(config));
  });

  app.get('/api/audit/readiness/report', (_request, response) => {
    response.json(buildReleaseReadinessReport(config));
  });

  app.get('/api/audit/diagnostics/export', (_request, response) => {
    response.json(buildDiagnosticExport(config));
  });

  app.post('/api/audit/remediate', (request, response, next) => {
    try {
      const session = requireSession(request, config);
      response.json(remediateSecurityRisk(request.body, session.user.username));
    } catch (error) {
      next(error);
    }
  });

  const distDir = path.resolve(process.cwd(), 'dist');
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
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
