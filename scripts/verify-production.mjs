import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const port = process.env.PORT ?? '18080';
const baseUrl = `http://127.0.0.1:${port}`;
const verifyDataDir = path.resolve(process.cwd(), '.tmp-verify-data');
const logTailLimit = 6000;
const verificationSteps = [];
const serverLog = { stdout: '', stderr: '' };
let currentStep = 'initializing';
let keepVerifyDataOnFailure = false;
let server;

resetVerifyDataDir();
configureNodeReports();

function run(command, args, options = {}) {
  const label = args[0] ?? command;
  return new Promise((resolve, reject) => {
    assertServerAlive();
    const step = {
      label,
      command: path.basename(command),
      args: args.map((arg) => path.basename(String(arg))),
      startedAt: new Date().toISOString(),
      status: 'running',
    };
    verificationSteps.push(step);
    currentStep = label;
    const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options });
    let settled = false;

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      step.status = 'failed';
      step.error = error.message;
      step.finishedAt = new Date().toISOString();
      reject(new Error(`${label} failed to start: ${error.message}`));
    });

    child.on('exit', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      step.status = code === 0 ? 'passed' : 'failed';
      step.exitCode = code;
      step.signal = signal;
      step.finishedAt = new Date().toISOString();
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} failed with ${formatExit(code, signal)}`));
    });
  });
}

async function waitForHealth(timeoutMs = 15000) {
  currentStep = 'wait for local health';
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    assertServerAlive();
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 3000);
  });
}

function removeVerifyDataDir() {
  fs.rmSync(verifyDataDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 250,
  });
}

function resetVerifyDataDir() {
  removeVerifyDataDir();
  fs.mkdirSync(verifyDataDir, { recursive: true });
}

function configureNodeReports() {
  if (!process.report) {
    return;
  }

  process.report.directory = verifyDataDir;
  process.report.filename = `verify-production-node-report-${process.pid}.json`;
  process.report.reportOnFatalError = true;
  process.report.reportOnSignal = true;
  process.report.reportOnUncaughtException = true;
}

function startServer() {
  const child = spawn(process.execPath, ['build/server/index.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: port,
      CORS_ORIGIN: baseUrl,
      CUSTOM_API_ALLOWED_HOSTS: 'api.example.com,127.0.0.1',
      COLIPAS_TEST_ALLOW_LOOPBACK_API: '1',
      AI_API_KEY: '',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin123456',
      SESSION_SECRET: 'verify-production-session-secret',
      RELEASE_VERIFY_TOKEN: 'verify-production-release-token-12345',
      RELEASE_TARGET_NAME: 'verify-local',
      RELEASE_CHANNEL: 'grey',
      RELEASE_DEPLOYMENT_MODE: 'node',
      RELEASE_PUBLIC_URL: baseUrl,
      RELEASE_GIT_COMMIT: 'abcdef1234567890',
      RELEASE_ARTIFACT_ID: 'verify-production',
      RELEASE_DEPLOYED_AT: '2026-01-01T00:00:00.000Z',
      RELEASE_SYNC_TARGETS: `primary-grey=${baseUrl},secondary-grey=${baseUrl}`,
      COLIPAS_TEST_ALLOW_RELEASE_SYNC_LOOPBACK: '1',
      COLIPAS_DATA_DIR: verifyDataDir,
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  mirrorServerStream(child.stdout, process.stdout, 'stdout');
  mirrorServerStream(child.stderr, process.stderr, 'stderr');
  child.on('error', (error) => {
    serverLog.stderr = appendTail(serverLog.stderr, `${error.message}\n`);
  });
  return child;
}

function mirrorServerStream(stream, target, key) {
  stream.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    serverLog[key] = appendTail(serverLog[key], text);
    target.write(chunk);
  });
}

function appendTail(current, next) {
  const combined = `${current}${next}`;
  return combined.length > logTailLimit ? combined.slice(-logTailLimit) : combined;
}

function assertServerAlive() {
  if (!server || (server.exitCode === null && server.signalCode === null)) {
    return;
  }

  throw new Error(`Application server exited early during ${currentStep}: ${formatExit(server.exitCode, server.signalCode)}`);
}

function formatExit(code, signal) {
  const parts = [];
  if (code !== null && code !== undefined) {
    parts.push(`exit code ${code}`);
  }
  if (signal) {
    parts.push(`signal ${signal}`);
  }
  return parts.join(', ') || 'no exit code or signal';
}

function writeFailureDiagnostics(error) {
  const diagnostic = {
    script: 'verify-production',
    failedAt: new Date().toISOString(),
    currentStep,
    baseUrl,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    error: error instanceof Error ? error.message : String(error),
    server: server
      ? {
          pid: server.pid,
          exitCode: server.exitCode,
          signalCode: server.signalCode,
          killed: server.killed,
        }
      : null,
    steps: verificationSteps,
    serverLog,
    diagnosticsDir: verifyDataDir,
  };

  console.error(`verify-production diagnostic:\n${JSON.stringify(diagnostic, null, 2)}`);
}

try {
  server = startServer();
  await waitForHealth();
  await run(process.execPath, ['scripts/smoke.mjs'], {
    env: {
      ...process.env,
      SMOKE_BASE_URL: baseUrl,
      SMOKE_RELEASE_VERIFY_TOKEN: 'verify-production-release-token-12345',
      COLIPAS_DATA_DIR: verifyDataDir,
    },
  });
  await run(process.execPath, ['scripts/browser-e2e.mjs'], {
    env: {
      ...process.env,
      E2E_BASE_URL: baseUrl,
      E2E_ADMIN_PASSWORD: 'NextPassword123',
    },
  });
  await run(process.execPath, ['scripts/public-pages-check.mjs'], {
    env: {
      ...process.env,
      PUBLIC_PAGES_BASE_URL: baseUrl,
      PUBLIC_PAGES_MODE: 'admin',
    },
  });
  await run(process.execPath, ['scripts/performance-check.mjs'], {
    env: {
      ...process.env,
      PERF_BASE_URL: baseUrl,
      PERF_ADMIN_PASSWORD: 'NextPassword123',
    },
  });
  await run(process.execPath, ['scripts/concurrency-check.mjs'], {
    env: {
      ...process.env,
      SMOKE_BASE_URL: baseUrl,
      SMOKE_ADMIN_PASSWORD: 'NextPassword123',
    },
  });
  await run(process.execPath, ['scripts/reset-admin-password.mjs'], {
    env: {
      ...process.env,
      COLIPAS_DATA_DIR: verifyDataDir,
      COLIPAS_RESET_PASSWORD: 'RecoveredPassword123',
    },
  });
  await assertLoginRejected('NextPassword123', 'old admin password was rejected after reset');
  await assertLoginAccepted('RecoveredPassword123', 'reset admin password accepted by login API');
} catch (error) {
  keepVerifyDataOnFailure = true;
  writeFailureDiagnostics(error);
  process.exitCode = 1;
} finally {
  await stopServer(server);
  if (keepVerifyDataOnFailure) {
    console.error(`verify-production kept diagnostics at ${verifyDataDir}`);
  } else {
    removeVerifyDataDir();
  }
}

async function assertLoginAccepted(password, label) {
  assertServerAlive();
  const response = await postLogin(password);
  if (!response.ok) {
    throw new Error(`${label}: expected login success, got HTTP ${response.status}`);
  }
  console.log(`ok ${label}`);
}

async function assertLoginRejected(password, label) {
  assertServerAlive();
  const response = await postLogin(password);
  if (response.status !== 401) {
    throw new Error(`${label}: expected HTTP 401, got HTTP ${response.status}`);
  }
  console.log(`ok ${label}`);
}

async function postLogin(password) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
}
