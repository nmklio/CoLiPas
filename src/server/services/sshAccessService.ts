import crypto from 'node:crypto';
import ssh2, { Client, type ClientChannel } from 'ssh2';
import { z } from 'zod';
import type { SshAuthType, SshVerifyMode } from '../../types.js';
import { defaultRuntimeSecrets } from '../config.js';
import { HttpError } from '../httpErrors.js';
import { redactSensitiveText } from './sensitiveRedaction.js';

const credentialSecret = crypto
  .createHash('sha256')
  .update(process.env.CREDENTIAL_ENCRYPTION_KEY || defaultRuntimeSecrets.credentialEncryptionKey)
  .digest();
const sshReadyTimeoutMs = 5000;
const sshShellReadyTimeoutMs = 10000;
const sshShellIdleTimeoutMs = 20 * 60 * 1000;
const sshShellHistoryLimit = 120;
const sshShellEvidenceLimit = 80;
const sshShellEvidenceRetentionMs = 30 * 60 * 1000;
const sshShellEvidencePruneIntervalMs = 60 * 1000;
const sshShellEvidenceMaxChars = 6000;
const simulatedShellPrompt = 'simulated$ ';
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

export interface SshShellEvidenceSummary {
  serverId: string;
  serverName: string;
  mode: SshVerifyMode;
  active: boolean;
  updatedAt: string;
  transcript: string;
}

export interface SshShellSessionStats {
  activeCount: number;
  byMode: Record<SshVerifyMode, number>;
  oldestConnectedAt: string | null;
  newestConnectedAt: string | null;
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
  serverId: string;
  serverName: string;
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

interface SshShellEvidenceRecord {
  serverId: string;
  serverName: string;
  mode: SshVerifyMode;
  updatedAt: string;
  events: Array<{
    type: SshShellStreamEvent['type'];
    content?: string;
    message?: string;
    at: string;
  }>;
}

const recentSshShellEvidenceByServer = new Map<string, SshShellEvidenceRecord>();
let lastSshShellEvidencePruneAt = 0;

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
  server: { id: string; name: string },
  mode: SshVerifyMode,
  options: { cols?: number; rows?: number } = {},
): Promise<SshShellSessionResult> {
  return mode === 'simulate'
    ? openSimulatedSshShell(server, mode)
    : openRealSshShell(credential, server, mode, options);
}

export function subscribeSshShellSession(
  sessionId: string,
  listener: SshShellListener,
  options: { replayHistory?: boolean } = {},
) {
  const session = activeSshShellSessions.get(sessionId);
  if (!session || session.closed) {
    throw new HttpError(404, 'SSH shell session not found', 'SSH_SHELL_NOT_FOUND');
  }

  session.listeners.add(listener);
  session.touch();
  if (options.replayHistory !== false) {
    session.history.forEach(listener);
  }

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

export function getSshShellSessionStats(): SshShellSessionStats {
  const stats: SshShellSessionStats = {
    activeCount: 0,
    byMode: {
      assetOnly: 0,
      real: 0,
      simulate: 0,
    },
    oldestConnectedAt: null,
    newestConnectedAt: null,
  };

  for (const session of activeSshShellSessions.values()) {
    if (session.closed) {
      continue;
    }

    stats.activeCount += 1;
    stats.byMode[session.mode] += 1;

    if (!stats.oldestConnectedAt || session.connectedAt < stats.oldestConnectedAt) {
      stats.oldestConnectedAt = session.connectedAt;
    }

    if (!stats.newestConnectedAt || session.connectedAt > stats.newestConnectedAt) {
      stats.newestConnectedAt = session.connectedAt;
    }
  }

  return stats;
}

export function getRecentSshShellEvidence(serverIds?: string[]): SshShellEvidenceSummary[] {
  pruneRecentSshShellEvidence();
  const allowedServerIds = serverIds?.length ? new Set(serverIds) : null;
  const activeServerIds = new Set(Array.from(activeSshShellSessions.values()).filter((session) => !session.closed).map((session) => session.serverId));

  return Array.from(recentSshShellEvidenceByServer.values())
    .filter((record) => !allowedServerIds || allowedServerIds.has(record.serverId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8)
    .map((record) => ({
      serverId: record.serverId,
      serverName: record.serverName,
      mode: record.mode,
      active: activeServerIds.has(record.serverId),
      updatedAt: record.updatedAt,
      transcript: summarizeShellEvidence(record),
    }))
    .filter((summary) => summary.transcript.trim());
}

export async function collectSshMetrics(credential: StoredSshCredential, mode: SshVerifyMode) {
  const command = [
    'cpu1=$(awk \'/^cpu / {total=0; for (i=2; i<=NF; i++) total+=$i; idle=$5+$6; print total ":" idle}\' /proc/stat)',
    'sleep 0.5',
    'cpu2=$(awk \'/^cpu / {total=0; for (i=2; i<=NF; i++) total+=$i; idle=$5+$6; print total ":" idle}\' /proc/stat)',
    'cpu=$(awk -F: -v a="$cpu1" -v b="$cpu2" \'BEGIN {split(a,x,":"); split(b,y,":"); dt=y[1]-x[1]; di=y[2]-x[2]; if (dt>0) { usage=100-(di*100/dt); if (usage<0) usage=0; if (usage>100) usage=100; printf "%.1f", usage } else print 0}\')',
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
      reject(new HttpError(408, 'SSH connection timed out. Check port 22, firewall, security group, and credentials, or use asset-only mode first.', 'SSH_TIMEOUT'));
    }, sshReadyTimeoutMs);

    client
      .on('ready', () => {
        clearTimeout(timer);
        client.end();
        resolve();
      })
      .on('error', (error) => {
        clearTimeout(timer);
        reject(new HttpError(422, `SSH connection failed: ${redactSensitiveText(error.message)}`, 'SSH_CONNECT_FAILED'));
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
      reject(new HttpError(408, 'SSH diagnostic timed out. Check SSH connectivity.', 'SSH_DIAGNOSTIC_TIMEOUT'));
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

function openSimulatedSshShell(server: { id: string; name: string }, mode: SshVerifyMode): SshShellSessionResult {
  const connectedAt = new Date().toISOString();
  const sessionId = crypto.randomUUID();
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let interrupted = false;
  let inputBuffer = '';
  const shell = registerSshShellSession({
    id: sessionId,
    serverId: server.id,
    serverName: server.name,
    mode,
    connectedAt,
    write: (input) => {
      if (input.includes('\u0003')) {
        interrupted = true;
        inputBuffer = '';
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        emitSshShellEvent(shell, { type: 'stdout', content: `^C\r\n${simulatedShellPrompt}` });
        return;
      }

      for (const char of input) {
        if (char === '\u007f') {
          inputBuffer = inputBuffer.slice(0, -1);
          emitSshShellEvent(shell, { type: 'stdout', content: '\b \b' });
          continue;
        }

        if (char === '\r' || char === '\n') {
          const command = inputBuffer.trim();
          inputBuffer = '';
          runSimulatedShellCommand(shell, command, {
            setPendingTimer: (timer) => {
              pendingTimer = timer;
            },
            setInterrupted: (nextInterrupted) => {
              interrupted = nextInterrupted;
            },
            getInterrupted: () => interrupted,
          });
          continue;
        }

        if (char >= ' ' && char !== '\u001b') {
          inputBuffer += char;
        }
      }
    },
    resize: () => undefined,
    close: () => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    },
  });

  queueMicrotask(() => {
    emitSshShellEvent(shell, { type: 'start', connectedAt });
    emitSshShellEvent(shell, { type: 'stdout', content: `CoLiPas云服务器管理面板 simulated SSH shell\r\n${simulatedShellPrompt}` });
  });

  return {
    sessionId,
    mode,
    connectedAt,
  };
}

function runSimulatedShellCommand(
  shell: ActiveSshShellSession,
  command: string,
  state: {
    setPendingTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
    setInterrupted: (interrupted: boolean) => void;
    getInterrupted: () => boolean;
  },
) {
  emitSshShellEvent(shell, { type: 'stdout', content: '\r\n' });
  if (!command) {
    emitSshShellEvent(shell, { type: 'stdout', content: simulatedShellPrompt });
    return;
  }
  if (command === 'clear') {
    emitSshShellEvent(shell, { type: 'stdout', content: `\x1b[2J\x1b[H${simulatedShellPrompt}` });
    return;
  }
  if (command === 'colipas-long-output') {
    emitSshShellEvent(shell, { type: 'stdout', content: `${simulatedShellPrompt}${command}\r\n` });
    for (let index = 1; index <= 80; index += 1) {
      emitSshShellEvent(shell, { type: 'stdout', content: `long-output-${String(index).padStart(2, '0')}\r\n` });
    }
    emitSshShellEvent(shell, { type: 'stdout', content: simulatedShellPrompt });
    return;
  }
  if (command === 'colipas-burst-output') {
    emitSshShellEvent(shell, { type: 'stdout', content: `${simulatedShellPrompt}${command}\r\n` });
    for (let index = 1; index <= 1200; index += 1) {
      emitSshShellEvent(shell, { type: 'stdout', content: `burst-output-${String(index).padStart(4, '0')} ${'x'.repeat(120)}\r\n` });
    }
    emitSshShellEvent(shell, { type: 'stdout', content: simulatedShellPrompt });
    return;
  }
  if (command.includes('colipas-ssh-self-test-start')) {
    emitSshShellEvent(shell, { type: 'stdout', content: `${simulatedShellPrompt}${command}\r\ncolipas-ssh-self-test-start\r\n` });
    for (let index = 1; index <= 40; index += 1) {
      emitSshShellEvent(shell, { type: 'stdout', content: `colipas-ssh-self-test-${String(index).padStart(2, '0')}\r\n` });
    }
    emitSshShellEvent(shell, { type: 'stdout', content: `colipas-ssh-self-test-end\r\n${simulatedShellPrompt}` });
    return;
  }
  if (command === 'colipas-hang') {
    state.setInterrupted(false);
    emitSshShellEvent(shell, { type: 'stdout', content: `${simulatedShellPrompt}${command}\r\nhanging until interrupt\r\n` });
    const timer = setTimeout(() => {
      state.setPendingTimer(null);
      if (!state.getInterrupted() && !shell.closed) {
        emitSshShellEvent(shell, { type: 'stdout', content: `still-running\r\n${simulatedShellPrompt}` });
      }
    }, 5000);
    state.setPendingTimer(timer);
    return;
  }
  emitSshShellEvent(shell, {
    type: 'stdout',
    content: redactSensitiveText(`${simulatedShellPrompt}${command}\r\ncommand simulated.\r\n${simulatedShellPrompt}`),
  });
}

function openRealSshShell(
  credential: StoredSshCredential,
  server: { id: string; name: string },
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
          registeredSession = registerRealShellSession(sessionId, server, mode, connectedAt, client, stream);
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
  server: { id: string; name: string },
  mode: SshVerifyMode,
  connectedAt: string,
  client: Client,
  stream: ClientChannel,
) {
  let session: ActiveSshShellSession;
  session = registerSshShellSession({
    id: sessionId,
    serverId: server.id,
    serverName: server.name,
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
      emitSshShellEvent(session, { type: 'stdout', content: chunk.toString('utf8') });
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
    emitSshShellEvent(session, { type: 'stderr', content: chunk.toString('utf8') });
  });

  return session;
}

function registerSshShellSession(input: {
  id: string;
  serverId: string;
  serverName: string;
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
    serverId: input.serverId,
    serverName: input.serverName,
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
  const safeEvent = {
    ...event,
    content: event.content ? redactSensitiveText(event.content) : event.content,
    message: event.message ? redactSensitiveText(event.message) : event.message,
  };
  session.history.push(safeEvent);
  if (session.history.length > sshShellHistoryLimit) {
    session.history.splice(0, session.history.length - sshShellHistoryLimit);
  }
  recordSshShellEvidence(session, safeEvent);
  session.listeners.forEach((listener) => listener(safeEvent));
}

function recordSshShellEvidence(session: ActiveSshShellSession, event: SshShellStreamEvent) {
  const text = event.content ?? event.message ?? '';
  if (!text.trim() && event.type !== 'close') {
    return;
  }

  maybePruneRecentSshShellEvidence();
  const existing = recentSshShellEvidenceByServer.get(session.serverId);
  const record: SshShellEvidenceRecord = existing ?? {
    serverId: session.serverId,
    serverName: session.serverName,
    mode: session.mode,
    updatedAt: session.connectedAt,
    events: [],
  };

  record.serverName = session.serverName;
  record.mode = session.mode;
  record.updatedAt = new Date().toISOString();
  record.events.push({
    type: event.type,
    content: event.content,
    message: event.message,
    at: record.updatedAt,
  });
  if (record.events.length > sshShellEvidenceLimit) {
    record.events.splice(0, record.events.length - sshShellEvidenceLimit);
  }
  recentSshShellEvidenceByServer.set(session.serverId, record);
}

function maybePruneRecentSshShellEvidence() {
  const now = Date.now();
  if (now - lastSshShellEvidencePruneAt < sshShellEvidencePruneIntervalMs) {
    return;
  }
  lastSshShellEvidencePruneAt = now;
  pruneRecentSshShellEvidence(now);
}

function pruneRecentSshShellEvidence(now = Date.now()) {
  const cutoff = now - sshShellEvidenceRetentionMs;
  for (const [serverId, record] of recentSshShellEvidenceByServer) {
    if (new Date(record.updatedAt).getTime() < cutoff) {
      recentSshShellEvidenceByServer.delete(serverId);
    }
  }
}

function summarizeShellEvidence(record: SshShellEvidenceRecord) {
  const lines = record.events
    .map((event) => {
      const text = (event.content ?? event.message ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n');
      return text
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.trim())
        .map((line) => `${event.type}: ${line}`)
        .join('\n');
    })
    .filter(Boolean);
  return lines.join('\n').slice(-sshShellEvidenceMaxChars);
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

  const hasCpuSample = typeof values.cpu === 'number' && Number.isFinite(values.cpu);

  return {
    cpu: normalizeLiveCpuMetric(values.cpu, hasCpuSample),
    memory: clampMetric(values.mem),
    disk: clampMetric(values.disk),
  };
}

function normalizeLiveCpuMetric(value: unknown, hasCpuSample: boolean) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const clamped = Math.max(0, Math.min(100, number));
  if (hasCpuSample && clamped < 1) {
    return 1;
  }
  return Math.round(clamped);
}

function clampMetric(value: unknown) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}
