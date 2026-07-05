import type { Server as HttpServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { RuntimeConfig } from './config.js';
import { getCurrentSession } from './services/authService.js';
import {
  closeServerShell,
  openServerShell,
  resizeServerShell,
  subscribeServerShell,
  writeServerShell,
} from './services/inventoryService.js';
import type { SshShellStreamEvent } from './services/sshAccessService.js';

type ClientMessage =
  | { type: 'open'; serverId?: unknown; cols?: unknown; rows?: unknown }
  | { type: 'input'; data?: unknown }
  | { type: 'resize'; cols?: unknown; rows?: unknown }
  | { type: 'ping'; sentAt?: unknown }
  | { type: 'close' };

const shellSocketInputFlushMs = 6;
const shellSocketInputFlushMaxChars = 8 * 1024;
const shellSocketOutputFlushMs = 4;
const shellSocketOutputFlushMaxChars = 96 * 1024;
const shellSocketDiagnosticsTouchIntervalMs = 250;

export interface SshShellSocketDiagnostics {
  totalConnections: number;
  activeConnections: number;
  openedShells: number;
  closedShells: number;
  inputEvents: number;
  inputFlushes: number;
  inputBytes: number;
  outputEvents: number;
  outputFlushes: number;
  outputBytes: number;
  pingCount: number;
  pongCount: number;
  errors: number;
  lastActivityAt: string | null;
}

const shellSocketDiagnostics: SshShellSocketDiagnostics = {
  totalConnections: 0,
  activeConnections: 0,
  openedShells: 0,
  closedShells: 0,
  inputEvents: 0,
  inputFlushes: 0,
  inputBytes: 0,
  outputEvents: 0,
  outputFlushes: 0,
  outputBytes: 0,
  pingCount: 0,
  pongCount: 0,
  errors: 0,
  lastActivityAt: null,
};
let shellSocketDiagnosticsLastTouchAt = 0;

export function getSshShellSocketDiagnostics(): SshShellSocketDiagnostics {
  return { ...shellSocketDiagnostics };
}

export function attachSshShellSocketServer(server: HttpServer, config: RuntimeConfig) {
  const socketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
  });

  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== '/api/servers/shells/ws') {
      socket.destroy();
      return;
    }

    if (!getCurrentSession(request as Parameters<typeof getCurrentSession>[0], config)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    tuneUpgradeSocket(socket);

    socketServer.handleUpgrade(request, socket, head, (webSocket) => {
      socketServer.emit('connection', webSocket, request);
    });
  });

  socketServer.on('connection', (webSocket) => {
    bindSshShellSocket(webSocket);
  });
}

function bindSshShellSocket(webSocket: WebSocket) {
  let sessionId = '';
  let unsubscribe: (() => void) | null = null;
  let closing = false;
  let socketClosed = false;
  let pendingInput = '';
  let inputFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingOutputEvent: SshShellStreamEvent | null = null;
  let outputFlushTimer: ReturnType<typeof setTimeout> | null = null;

  shellSocketDiagnostics.totalConnections += 1;
  shellSocketDiagnostics.activeConnections += 1;
  touchDiagnostics(true);

  const send = (payload: unknown) => {
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.send(JSON.stringify(payload));
    }
  };

  const clearInputFlushTimer = () => {
    if (inputFlushTimer) {
      clearTimeout(inputFlushTimer);
      inputFlushTimer = null;
    }
  };

  const flushInput = () => {
    clearInputFlushTimer();
    const input = pendingInput;
    pendingInput = '';
    if (!input || !sessionId || closing) {
      return;
    }

    writeServerShell({ sessionId, input });
    shellSocketDiagnostics.inputFlushes += 1;
    touchDiagnostics();
  };

  const safeFlushInput = () => {
    try {
      flushInput();
    } catch (error) {
      shellSocketDiagnostics.errors += 1;
      touchDiagnostics(true);
      send({
        type: 'error',
        message: error instanceof Error ? error.message : 'SSH input failed',
      });
      cleanup();
    }
  };

  const queueInput = (input: string) => {
    pendingInput += input;
    if (
      input.includes('\r')
      || input.includes('\n')
      || input.includes('\u0003')
      || pendingInput.length >= shellSocketInputFlushMaxChars
    ) {
      flushInput();
      return;
    }

    if (!inputFlushTimer) {
      inputFlushTimer = setTimeout(safeFlushInput, shellSocketInputFlushMs);
    }
  };

  const clearPendingInput = () => {
    clearInputFlushTimer();
    pendingInput = '';
  };

  const flushOutput = () => {
    if (outputFlushTimer) {
      clearTimeout(outputFlushTimer);
      outputFlushTimer = null;
    }
    if (pendingOutputEvent) {
      const event = pendingOutputEvent;
      pendingOutputEvent = null;
      send(event);
      shellSocketDiagnostics.outputFlushes += 1;
      touchDiagnostics();
    }
  };

  const sendShellEvent = (event: SshShellStreamEvent) => {
    if ((event.type === 'stdout' || event.type === 'stderr') && typeof event.content === 'string') {
      shellSocketDiagnostics.outputEvents += 1;
      shellSocketDiagnostics.outputBytes += Buffer.byteLength(event.content, 'utf8');
      touchDiagnostics();
    }

    if (event.type !== 'stdout' && event.type !== 'stderr') {
      flushOutput();
      send(event);
      return;
    }

    if (pendingOutputEvent?.type === event.type) {
      pendingOutputEvent = {
        ...event,
        content: `${pendingOutputEvent.content ?? ''}${event.content ?? ''}`,
      };
    } else {
      flushOutput();
      pendingOutputEvent = event;
    }

    if ((pendingOutputEvent.content?.length ?? 0) >= shellSocketOutputFlushMaxChars) {
      flushOutput();
      return;
    }

    if (!outputFlushTimer) {
      outputFlushTimer = setTimeout(flushOutput, shellSocketOutputFlushMs);
    }
  };

  const cleanup = () => {
    if (closing) {
      return;
    }
    closing = true;
    clearPendingInput();
    flushOutput();
    unsubscribe?.();
    unsubscribe = null;
    if (sessionId) {
      closeServerShell({ sessionId });
      sessionId = '';
      shellSocketDiagnostics.closedShells += 1;
      touchDiagnostics(true);
    }
  };

  const markSocketClosed = () => {
    if (socketClosed) {
      return;
    }
    socketClosed = true;
    shellSocketDiagnostics.activeConnections = Math.max(0, shellSocketDiagnostics.activeConnections - 1);
    touchDiagnostics(true);
  };

  webSocket.on('message', async (raw) => {
    try {
      touchDiagnostics();
      const message = JSON.parse(raw.toString('utf8')) as ClientMessage;
      if (message.type === 'open') {
        if (sessionId || closing) {
          return;
        }

        const shell = await openServerShell({
          serverId: message.serverId,
          cols: message.cols,
          rows: message.rows,
        });
        if (closing) {
          closeServerShell({ sessionId: shell.sessionId });
          return;
        }
        sessionId = shell.sessionId;
        unsubscribe = subscribeServerShell({ sessionId, replay: 1 }, (event: SshShellStreamEvent) => {
          sendShellEvent(event);
          if (event.type === 'close') {
            cleanup();
            webSocket.close(1000, 'shell closed');
          }
        });
        shellSocketDiagnostics.openedShells += 1;
        touchDiagnostics(true);
        send({
          type: 'ready',
          serverId: shell.serverId,
          serverName: shell.serverName,
          correlationId: shell.correlationId,
          sessionId: shell.sessionId,
          mode: shell.mode,
          connectedAt: shell.connectedAt,
        });
        if (closing) {
          cleanup();
          return;
        }
        return;
      }

      if (!sessionId) {
        send({ type: 'error', message: 'SSH shell session not ready' });
        return;
      }

      if (message.type === 'input') {
        const input = typeof message.data === 'string' ? message.data : '';
        shellSocketDiagnostics.inputEvents += 1;
        shellSocketDiagnostics.inputBytes += Buffer.byteLength(input, 'utf8');
        touchDiagnostics();
        queueInput(input);
        return;
      }

      if (message.type === 'resize') {
        resizeServerShell({ sessionId, cols: message.cols, rows: message.rows });
        return;
      }

      if (message.type === 'ping') {
        shellSocketDiagnostics.pingCount += 1;
        shellSocketDiagnostics.pongCount += 1;
        touchDiagnostics();
        send({ type: 'pong', sentAt: message.sentAt, receivedAt: Date.now() });
        return;
      }

      if (message.type === 'close') {
        flushInput();
        cleanup();
        send({ type: 'close', signal: 'closed' });
        webSocket.close(1000, 'closed');
      }
    } catch (error) {
      shellSocketDiagnostics.errors += 1;
      touchDiagnostics(true);
      if (sessionId) {
        cleanup();
      }
      send({
        type: 'error',
        message: error instanceof Error ? error.message : 'SSH WebSocket failed',
      });
    }
  });

  webSocket.on('close', () => {
    markSocketClosed();
    clearPendingInput();
    if (outputFlushTimer) {
      clearTimeout(outputFlushTimer);
      outputFlushTimer = null;
    }
    pendingOutputEvent = null;
    cleanup();
  });
  webSocket.on('error', () => {
    markSocketClosed();
    shellSocketDiagnostics.errors += 1;
    touchDiagnostics(true);
    cleanup();
  });
}

function touchDiagnostics(force = false) {
  const now = Date.now();
  if (!force && now - shellSocketDiagnosticsLastTouchAt < shellSocketDiagnosticsTouchIntervalMs) {
    return;
  }
  shellSocketDiagnosticsLastTouchAt = now;
  shellSocketDiagnostics.lastActivityAt = new Date(now).toISOString();
}

function tuneUpgradeSocket(socket: unknown) {
  const tcpSocket = socket as {
    setNoDelay?: (noDelay?: boolean) => void;
    setKeepAlive?: (enable?: boolean, initialDelay?: number) => void;
  };
  tcpSocket.setNoDelay?.(true);
  tcpSocket.setKeepAlive?.(true, 10000);
}
