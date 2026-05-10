import crypto from 'node:crypto';
import ssh2, { Client, type ClientChannel } from 'ssh2';
import { z } from 'zod';
import type { SshAuthType, SshVerifyMode } from '../../types.js';
import { HttpError } from '../httpErrors.js';
import { redactSensitiveText } from './sensitiveRedaction.js';

const credentialSecret = crypto
  .createHash('sha256')
  .update(process.env.CREDENTIAL_ENCRYPTION_KEY || 'colipas-local-development-secret')
  .digest();
const sshReadyTimeoutMs = 5000;
const sshShellReadyTimeoutMs = 10000;
const sshShellIdleTimeoutMs = 20 * 60 * 1000;
const sshShellHistoryLimit = 120;
const privateKeyBlockPattern = /^-----BEGIN (?:OPENSSH PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|DSA PRIVATE KEY|PRIVATE KEY)-----[\s\S]+-----END (?:OPENSSH PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|DSA PRIVATE KEY|PRIVATE KEY)-----$/;
const puttyPrivateKeyPattern = /^PuTTY-User-Key-File-2: ssh-(?:rsa|dss)\r?\nEncryption: (?:aes256-cbc|none)\r?\nComment: [^\r\n]*\r?\nPublic-Lines: \d+\r?\n[\s\S]+?\r?\nPrivate-Lines: \d+\r?\n[\s\S]+?\r?\nPrivate-MAC: [^\r\n]+/;

export const sshCredentialSchema = z
  .object({
    host: z.string().min(1).max(255).optional(),
    port: z.coerce.number().int().min(1).max(65535).default(22),
    username: z.string().min(1).max(80),
    authType: z.enum(['password', 'privateKey']),
    password: z.string().max(2000).optional().default(''),
    privateKey: z.string().max(64 * 1024).optional().default(''),
    passphrase: z.string().max(2000).optional().default(''),
    verifyMode: z.enum(['assetOnly', 'real', 'simulate']).optional().default('assetOnly'),
  })
  .superRefine((value, context) => {
    if (value.verifyMode === 'assetOnly') {
      return;
    }

    if (value.authType === 'password' && !value.password) {
      context.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'SSH password is required',
      });
    }

    if (value.authType === 'privateKey') {
      if (!value.privateKey) {
        context.addIssue({
          code: 'custom',
          path: ['privateKey'],
          message: 'SSH private key is required',
        });
        return;
      }

      if (!isSupportedPrivateKey(value.privateKey, value.passphrase)) {
        context.addIssue({
          code: 'custom',
          path: ['privateKey'],
          message: 'SSH private key must be a PEM/OpenSSH/PPK private key block',
        });
      }
    }
  });

export type SshCredentialInput = z.infer<typeof sshCredentialSchema>;

function isSupportedPrivateKey(value: string, passphrase?: string) {
  const normalized = value.trim();
  if (!privateKeyBlockPattern.test(normalized) && !puttyPrivateKeyPattern.test(normalized)) {
    return false;
  }

  const parsed = ssh2.utils.parseKey(normalized, passphrase || undefined);
  return !(parsed instanceof Error) && parsed.isPrivateKey();
}

export interface StoredSshCredential {
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  encryptedSecret: string;
  encryptedPassphrase?: string;
  updatedAt: string;
}

export interface SshDiagnosticResult {
  serverId: string;
  serverName: string;
  mode: SshVerifyMode;
  command: string;
  output: string;
  checkedAt: string;
}

export interface SshCommandResult {
  command: string;
  output: string;
  executedAt: string;
}

export interface SshCommandStreamEvent {
  type: 'start' | 'stdout' | 'stderr' | 'done' | 'timeout';
  content?: string;
  code?: number | null;
  signal?: string | null;
  output?: string;
  executedAt?: string;
}

export interface SshShellSessionResult {
  sessionId: string;
  mode: SshVerifyMode;
  connectedAt: string;
}

export interface SshShellStreamEvent {
  type: 'start' | 'stdout' | 'stderr' | 'close' | 'error';
  content?: string;
  message?: string;
  code?: number | null;
  signal?: string | null;
  connectedAt?: string;
}

type SshShellListener = (event: SshShellStreamEvent) => void;

interface ActiveSshShellSession {
  id: string;
  mode: SshVerifyMode;
  connectedAt: string;
  history: SshShellStreamEvent[];
  listeners: Set<SshShellListener>;
  write: (input: string) => void;
  resize: (cols: number, rows: number) => void;
  close: (reason?: string) => void;
  touch: () => void;
  idleTimer: ReturnType<typeof setTimeout>;
  closed: boolean;
}

const activeSshShellSessions = new Map<string, ActiveSshShellSession>();

export interface SshVerificationResult {
  connected: boolean;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  verifyMode: SshVerifyMode;
  fingerprint?: string;
}

export async function verifySshAccess(input: SshCredentialInput, fallbackHost: string): Promise<SshVerificationResult> {
  const host = input.host?.trim() || fallbackHost;
  if (!host) {
    throw new HttpError(400, 'SSH host is required', 'SSH_HOST_REQUIRED');
  }

  if (input.verifyMode === 'simulate') {
    return {
      connected: true,
      host,
      port: input.port,
      username: input.username,
      authType: input.authType,
      verifyMode: input.verifyMode,
      fingerprint: `simulated:${hashFingerprint(`${host}:${input.port}:${input.username}`)}`,
    };
  }

  await connectSsh(input, host);

  return {
    connected: true,
    host,
    port: input.port,
    username: input.username,
    authType: input.authType,
    verifyMode: 'real',
    fingerprint: hashFingerprint(`${host}:${input.port}:${input.username}:${Date.now()}`),
  };
}

export function buildStoredSshCredential(input: SshCredentialInput, host: string): StoredSshCredential {
  const secret = input.authType === 'password' ? input.password : input.privateKey;

  return {
    host,
    port: input.port,
    username: input.username,
    authType: input.authType,
    encryptedSecret: encryptSecret(secret),
    encryptedPassphrase: input.authType === 'privateKey' && input.passphrase ? encryptSecret(input.passphrase) : undefined,
    updatedAt: new Date().toISOString(),
  };
}

export async function runSshDiagnostic(
  credential: StoredSshCredential,
  server: { id: string; name: string; os: string; publicIp: string },
  mode: SshVerifyMode,
): Promise<SshDiagnosticResult> {
  const command = 'printf "host=$(hostname)\\n"; uname -a; uptime; df -h / | tail -1';

  if (mode === 'simulate') {
    return {
      serverId: server.id,
      serverName: server.name,
      mode,
      command,
      output: [
        `host=${server.name}`,
        `${server.os} ${server.publicIp} simulated-kernel`,
        'up 3 days, 4 users, load average: 0.12, 0.18, 0.21',
        '/dev/sim-root 40G 12G 28G 30% /',
      ].join('\n'),
      checkedAt: new Date().toISOString(),
    };
  }

  const output = await execSshCommand(credential, command);

  return {
    serverId: server.id,
    serverName: server.name,
    mode,
    command,
    output,
    checkedAt: new Date().toISOString(),
  };
}

export async function runStoredSshCommand(credential: StoredSshCredential, command: string, mode: SshVerifyMode): Promise<SshCommandResult> {
  if (mode === 'simulate') {
    return {
      command: redactSensitiveText(command),
      output: redactSensitiveText(`simulated$ ${command}\n命令已模拟执行。`),
      executedAt: new Date().toISOString(),
    };
  }

  return {
    command: redactSensitiveText(command),
    output: await execSshCommand(credential, command),
    executedAt: new Date().toISOString(),
  };
}

export async function streamStoredSshCommand(
  credential: StoredSshCredential,
  command: string,
  mode: SshVerifyMode,
  onEvent: (event: SshCommandStreamEvent) => void,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SshCommandResult> {
  if (mode === 'simulate') {
    const output = redactSensitiveText(`simulated$ ${command}\n命令已模拟执行。`);
    onEvent({ type: 'start', executedAt: new Date().toISOString() });
    for (const line of output.split('\n')) {
      onEvent({ type: 'stdout', content: `${line}\n` });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    onEvent({ type: 'done', code: 0, output });
    return {
      command: redactSensitiveText(command),
      output,
      executedAt: new Date().toISOString(),
    };
  }

  return execSshCommandStream(credential, command, onEvent, options);
}

export async function openStoredSshShell(
  credential: StoredSshCredential,
  mode: SshVerifyMode,
  options: { cols?: number; rows?: number } = {},
): Promise<SshShellSessionResult> {
  return mode === 'simulate'
    ? openSimulatedSshShell(mode)
    : openRealSshShell(credential, mode, options);
}

export function subscribeSshShellSession(sessionId: string, listener: SshShellListener) {
  const session = activeSshShellSessions.get(sessionId);
  if (!session || session.closed) {
    throw new HttpError(404, 'SSH shell session not found', 'SSH_SHELL_NOT_FOUND');
  }

  session.listeners.add(listener);
  session.touch();
  session.history.forEach(listener);

  return () => {
    session.listeners.delete(listener);
  };
}

export function writeSshShellSession(sessionId: string, input: string) {
  const session = getActiveShellSession(sessionId);
  session.touch();
  session.write(input);
}

export function resizeSshShellSession(sessionId: string, cols: number, rows: number) {
  const session = getActiveShellSession(sessionId);
  session.touch();
  session.resize(cols, rows);
}

export function closeSshShellSession(sessionId: string) {
  const session = activeSshShellSessions.get(sessionId);
  if (!session || session.closed) {
    return;
  }
  session.close('closed');
}

export async function collectSshMetrics(credential: StoredSshCredential, mode: SshVerifyMode) {
  const command = [
    'cpu1=$(awk \'/^cpu / {print $2+$3+$4+$5+$6+$7+$8+$9 ":" $5+$6}\' /proc/stat)',
    'sleep 0.2',
    'cpu2=$(awk \'/^cpu / {print $2+$3+$4+$5+$6+$7+$8+$9 ":" $5+$6}\' /proc/stat)',
    'cpu=$(awk -F: -v a="$cpu1" -v b="$cpu2" \'BEGIN {split(a,x,":"); split(b,y,":"); dt=y[1]-x[1]; di=y[2]-x[2]; if (dt>0) printf "%.0f", 100-(di*100/dt); else print 0}\')',
    'mem=$(free | awk \'/Mem:/ {printf "%.0f", $3*100/$2}\')',
    'disk=$(df -P / | awk \'NR==2 {gsub("%","",$5); print $5}\')',
    'printf "cpu=%s\\nmem=%s\\ndisk=%s\\n" "$cpu" "$mem" "$disk"',
  ].join('; ');

  if (mode === 'simulate') {
    const seed = Date.now() / 1000;
    return {
      cpu: clampMetric(18 + Math.round(Math.sin(seed / 17) * 12)),
      memory: clampMetric(42 + Math.round(Math.sin(seed / 23) * 10)),
      disk: clampMetric(31 + Math.round(Math.sin(seed / 31) * 4)),
    };
  }

  const output = await execSshCommand(credential, command);
  return parseMetricsOutput(output);
}

function connectSsh(input: SshCredentialInput, host: string) {
  return new Promise<void>((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      client.destroy();
      reject(new HttpError(408, 'SSH 连接超时，请先确认服务器 22 端口、防火墙、安全组和 SSH 凭据；也可以先选择“仅登记资产”。', 'SSH_TIMEOUT'));
    }, sshReadyTimeoutMs);

    client
      .on('ready', () => {
        clearTimeout(timer);
        client.end();
        resolve();
      })
      .on('error', (error) => {
        clearTimeout(timer);
        reject(new HttpError(422, `SSH 连接失败：${redactSensitiveText(error.message)}`, 'SSH_CONNECT_FAILED'));
      })
      .connect({
        host,
        port: input.port,
        username: input.username,
        readyTimeout: sshReadyTimeoutMs,
        password: input.authType === 'password' ? input.password : undefined,
        privateKey: input.authType === 'privateKey' ? input.privateKey : undefined,
        passphrase: input.authType === 'privateKey' && input.passphrase ? input.passphrase : undefined,
        keepaliveInterval: 0,
      });
  });
}

function execSshCommand(credential: StoredSshCredential, command: string) {
  return new Promise<string>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let output = '';
    let errorOutput = '';
    const timer = setTimeout(() => {
      client.destroy();
      reject(new HttpError(408, 'SSH 诊断超时，请检查服务器 SSH 连通性。', 'SSH_DIAGNOSTIC_TIMEOUT'));
    }, 12000);

    client
      .on('ready', () => {
        client.exec(command, (error, stream) => {
          if (error) {
            clearTimeout(timer);
            client.end();
            reject(new HttpError(422, `SSH diagnostic failed: ${redactSensitiveText(error.message)}`, 'SSH_DIAGNOSTIC_FAILED'));
            return;
          }

          stream
            .on('close', (code: number | null) => {
              if (settled) {
                return;
              }
              settled = true;
              clearTimeout(timer);
              client.end();

              if (errorOutput) {
                output += output.endsWith('\n') || output.length === 0 ? errorOutput : `\n${errorOutput}`;
              }

              if (code && code !== 0) {
                reject(new HttpError(422, redactSensitiveText(output.trim()) || `SSH command exited with ${code}`, 'SSH_DIAGNOSTIC_FAILED'));
                return;
              }

              resolve(redactSensitiveText(output.trim()).slice(0, 8000));
            })
            .on('data', (chunk: Buffer) => {
              output += chunk.toString('utf8');
            });

          stream.stderr.on('data', (chunk: Buffer) => {
            errorOutput += chunk.toString('utf8');
          });
        });
      })
      .on('error', (error) => {
        clearTimeout(timer);
        reject(new HttpError(422, `SSH diagnostic failed: ${redactSensitiveText(error.message)}`, 'SSH_DIAGNOSTIC_FAILED'));
      })
      .connect({
        host: credential.host,
        port: credential.port,
        username: credential.username,
        readyTimeout: 10000,
        password: credential.authType === 'password' ? decryptSecret(credential.encryptedSecret) : undefined,
        privateKey: credential.authType === 'privateKey' ? decryptSecret(credential.encryptedSecret) : undefined,
        passphrase: credential.authType === 'privateKey' && credential.encryptedPassphrase ? decryptSecret(credential.encryptedPassphrase) : undefined,
        keepaliveInterval: 0,
      });
  });
}

function execSshCommandStream(
  credential: StoredSshCredential,
  command: string,
  onEvent: (event: SshCommandStreamEvent) => void,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  return new Promise<SshCommandResult>((resolve, reject) => {
    const client = new Client();
    const timeoutMs = options.timeoutMs ?? 30000;
    let settled = false;
    let output = '';
    let errorOutput = '';
    let commandStream: { close: () => void; signal: (signalName: string) => void } | null = null;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      client.end();
      callback();
    };

    const abort = () => {
      commandStream?.signal('INT');
      commandStream?.close();
      client.destroy();
      finish(() => {
        const combinedOutput = redactSensitiveText(output + errorOutput).trim();
        onEvent({ type: 'timeout', output: combinedOutput });
        resolve({
          command: redactSensitiveText(command),
          output: combinedOutput,
          executedAt: new Date().toISOString(),
        });
      });
    };

    const timer = setTimeout(abort, timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });

    client
      .on('ready', () => {
        onEvent({ type: 'start', executedAt: new Date().toISOString() });
        client.exec(command, (error, stream) => {
          if (error) {
            finish(() => {
              reject(new HttpError(422, `SSH command failed: ${redactSensitiveText(error.message)}`, 'SSH_COMMAND_FAILED'));
            });
            return;
          }

          commandStream = stream;
          stream
            .on('close', (code: number | null, signal: string | null) => {
              finish(() => {
                const visibleError = redactSensitiveText(errorOutput);
                if (visibleError) {
                  onEvent({ type: 'stderr', content: visibleError });
                }

                const combinedOutput = redactSensitiveText(output + (visibleError ? `\n${visibleError}` : '')).trim().slice(0, 12000);
                onEvent({ type: 'done', code, signal, output: combinedOutput });

                if (code && code !== 0) {
                  reject(new HttpError(422, combinedOutput || `SSH command exited with ${code}`, 'SSH_COMMAND_FAILED'));
                  return;
                }

                resolve({
                  command: redactSensitiveText(command),
                  output: combinedOutput,
                  executedAt: new Date().toISOString(),
                });
              });
            })
            .on('data', (chunk: Buffer) => {
              const content = redactSensitiveText(chunk.toString('utf8'));
              output += content;
              onEvent({ type: 'stdout', content });
            });

          stream.stderr.on('data', (chunk: Buffer) => {
            const content = redactSensitiveText(chunk.toString('utf8'));
            errorOutput += content;
            onEvent({ type: 'stderr', content });
          });
        });
      })
      .on('error', (error) => {
        finish(() => {
          reject(new HttpError(422, `SSH command failed: ${redactSensitiveText(error.message)}`, 'SSH_COMMAND_FAILED'));
        });
      })
      .connect({
        host: credential.host,
        port: credential.port,
        username: credential.username,
        readyTimeout: 10000,
        password: credential.authType === 'password' ? decryptSecret(credential.encryptedSecret) : undefined,
        privateKey: credential.authType === 'privateKey' ? decryptSecret(credential.encryptedSecret) : undefined,
        passphrase: credential.authType === 'privateKey' && credential.encryptedPassphrase ? decryptSecret(credential.encryptedPassphrase) : undefined,
        keepaliveInterval: 10000,
      });
  });
}

function openSimulatedSshShell(mode: SshVerifyMode): SshShellSessionResult {
  const connectedAt = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  const shell = registerSshShellSession({
    id: sessionId,
    mode,
    connectedAt,
    write: (input) => {
      const command = input.replace(/\r?\n$/, '').trim();
      if (!command) {
        emitSshShellEvent(shell, { type: 'stdout', content: 'simulated$ ' });
        return;
      }
      if (command === 'clear') {
        emitSshShellEvent(shell, { type: 'stdout', content: '\x1b[2J\x1b[Hsimulated$ ' });
        return;
      }
      emitSshShellEvent(shell, {
        type: 'stdout',
        content: redactSensitiveText(`\r\nsimulated$ ${command}\r\n命令已模拟执行。\r\nsimulated$ `),
      });
    },
    resize: () => undefined,
    close: () => undefined,
  });

  queueMicrotask(() => {
    emitSshShellEvent(shell, { type: 'start', connectedAt });
    emitSshShellEvent(shell, { type: 'stdout', content: 'CoLiPas simulated SSH shell\r\nsimulated$ ' });
  });

  return {
    sessionId,
    mode,
    connectedAt,
  };
}

function openRealSshShell(
  credential: StoredSshCredential,
  mode: SshVerifyMode,
  options: { cols?: number; rows?: number } = {},
) {
  return new Promise<SshShellSessionResult>((resolve, reject) => {
    const client = new Client();
    const sessionId = crypto.randomUUID();
    const connectedAt = new Date().toISOString();
    let settled = false;
    let registeredSession: ActiveSshShellSession | null = null;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      client.destroy();
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(new HttpError(408, 'SSH shell connection timed out', 'SSH_SHELL_TIMEOUT'));
    }, sshShellReadyTimeoutMs);

    client
      .on('ready', () => {
        client.shell({
          term: 'xterm-256color',
          cols: clampShellDimension(options.cols, 40, 240, 120),
          rows: clampShellDimension(options.rows, 12, 80, 32),
          width: 960,
          height: 640,
        }, (error, stream) => {
          if (error) {
            fail(new HttpError(422, `SSH shell failed: ${redactSensitiveText(error.message)}`, 'SSH_SHELL_FAILED'));
            return;
          }

          clearTimeout(timer);
          registeredSession = registerRealShellSession(sessionId, mode, connectedAt, client, stream);
          settled = true;
          emitSshShellEvent(registeredSession, { type: 'start', connectedAt });
          resolve({ sessionId, mode, connectedAt });
        });
      })
      .on('error', (error) => {
        if (registeredSession) {
          emitSshShellEvent(registeredSession, {
            type: 'error',
            message: `SSH shell failed: ${redactSensitiveText(error.message)}`,
          });
          registeredSession.close('error');
          return;
        }
        fail(new HttpError(422, `SSH shell failed: ${redactSensitiveText(error.message)}`, 'SSH_SHELL_FAILED'));
      })
      .connect({
        host: credential.host,
        port: credential.port,
        username: credential.username,
        readyTimeout: sshShellReadyTimeoutMs,
        password: credential.authType === 'password' ? decryptSecret(credential.encryptedSecret) : undefined,
        privateKey: credential.authType === 'privateKey' ? decryptSecret(credential.encryptedSecret) : undefined,
        passphrase: credential.authType === 'privateKey' && credential.encryptedPassphrase ? decryptSecret(credential.encryptedPassphrase) : undefined,
        keepaliveInterval: 10000,
      });
  });
}

function registerRealShellSession(
  sessionId: string,
  mode: SshVerifyMode,
  connectedAt: string,
  client: Client,
  stream: ClientChannel,
) {
  let session: ActiveSshShellSession;
  session = registerSshShellSession({
    id: sessionId,
    mode,
    connectedAt,
    write: (input) => {
      stream.write(input);
    },
    resize: (cols, rows) => {
      stream.setWindow(rows, cols, 640, 960);
    },
    close: () => {
      stream.close();
      client.end();
      client.destroy();
    },
  });

  stream
    .on('data', (chunk: Buffer) => {
      emitSshShellEvent(session, { type: 'stdout', content: redactSensitiveText(chunk.toString('utf8')) });
    })
    .on('close', (code: number | null, signal: string | null) => {
      emitSshShellEvent(session, { type: 'close', code, signal });
      finalizeSshShellSession(session);
      client.end();
    })
    .on('error', (error: Error) => {
      emitSshShellEvent(session, {
        type: 'error',
        message: `SSH shell stream failed: ${redactSensitiveText(error.message)}`,
      });
      session.close('error');
    });

  stream.stderr.on('data', (chunk: Buffer) => {
    emitSshShellEvent(session, { type: 'stderr', content: redactSensitiveText(chunk.toString('utf8')) });
  });

  return session;
}

function registerSshShellSession(input: {
  id: string;
  mode: SshVerifyMode;
  connectedAt: string;
  write: (input: string) => void;
  resize: (cols: number, rows: number) => void;
  close: (reason?: string) => void;
}) {
  let session: ActiveSshShellSession;
  const refreshIdleTimer = () => {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      session.close('idle-timeout');
    }, sshShellIdleTimeoutMs);
  };

  session = {
    id: input.id,
    mode: input.mode,
    connectedAt: input.connectedAt,
    history: [],
    listeners: new Set(),
    write: input.write,
    resize: input.resize,
    close: (reason = 'closed') => {
      if (session.closed) {
        return;
      }
      emitSshShellEvent(session, { type: 'close', signal: reason });
      input.close(reason);
      finalizeSshShellSession(session);
    },
    touch: refreshIdleTimer,
    idleTimer: setTimeout(() => undefined, sshShellIdleTimeoutMs),
    closed: false,
  };

  refreshIdleTimer();
  activeSshShellSessions.set(session.id, session);
  return session;
}

function emitSshShellEvent(session: ActiveSshShellSession, event: SshShellStreamEvent) {
  const safeEvent = event.content
    ? { ...event, content: redactSensitiveText(event.content) }
    : event;
  session.history.push(safeEvent);
  session.history.splice(0, Math.max(0, session.history.length - sshShellHistoryLimit));
  session.listeners.forEach((listener) => listener(safeEvent));
}

function finalizeSshShellSession(session: ActiveSshShellSession) {
  if (session.closed) {
    return;
  }
  session.closed = true;
  clearTimeout(session.idleTimer);
  session.listeners.clear();
  activeSshShellSessions.delete(session.id);
}

function getActiveShellSession(sessionId: string) {
  const session = activeSshShellSessions.get(sessionId);
  if (!session || session.closed) {
    throw new HttpError(404, 'SSH shell session not found', 'SSH_SHELL_NOT_FOUND');
  }
  return session;
}

function clampShellDimension(value: unknown, min: number, max: number, fallback: number) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, number));
}

function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialSecret, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${authTag.toString('base64')}.${encrypted.toString('base64')}`;
}

function decryptSecret(value: string) {
  const [ivText, authTagText, encryptedText] = value.split('.');
  if (!ivText || !authTagText || !encryptedText) {
    throw new HttpError(500, 'Stored SSH credential is invalid', 'SSH_CREDENTIAL_INVALID');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', credentialSecret, Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8');
}

function hashFingerprint(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function parseMetricsOutput(output: string) {
  const values = Object.fromEntries(
    output
      .split('\n')
      .map((line) => line.trim().split('='))
      .filter((parts) => parts.length === 2)
      .map(([key, value]) => [key, Number(value)]),
  );

  return {
    cpu: clampMetric(values.cpu),
    memory: clampMetric(values.mem),
    disk: clampMetric(values.disk),
  };
}

function clampMetric(value: unknown) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}
