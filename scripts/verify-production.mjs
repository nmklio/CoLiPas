import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const port = process.env.PORT ?? '18080';
const baseUrl = `http://127.0.0.1:${port}`;
const verifyDataDir = path.resolve(process.cwd(), '.tmp-verify-data');
removeVerifyDataDir();

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
    });
  });
}

async function waitForHealth(timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
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
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
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

const server = spawn(process.execPath, ['build/server/index.js'], {
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
    COLIPAS_DATA_DIR: verifyDataDir,
  },
  shell: false,
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  await waitForHealth();
  await run(process.execPath, ['scripts/smoke.mjs'], {
    env: {
      ...process.env,
      SMOKE_BASE_URL: baseUrl,
      SMOKE_RELEASE_VERIFY_TOKEN: 'verify-production-release-token-12345',
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
} finally {
  await stopServer(server);
  removeVerifyDataDir();
}

async function assertLoginAccepted(password, label) {
  const response = await postLogin(password);
  if (!response.ok) {
    throw new Error(`${label}: expected login success, got HTTP ${response.status}`);
  }
  console.log(`ok ${label}`);
}

async function assertLoginRejected(password, label) {
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
