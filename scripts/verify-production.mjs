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
    },
  });
  await run(process.execPath, ['scripts/browser-e2e.mjs'], {
    env: {
      ...process.env,
      E2E_BASE_URL: baseUrl,
      E2E_ADMIN_PASSWORD: 'NextPassword123',
    },
  });
  await run(process.execPath, ['scripts/concurrency-check.mjs'], {
    env: {
      ...process.env,
      SMOKE_BASE_URL: baseUrl,
      SMOKE_ADMIN_PASSWORD: 'NextPassword123',
    },
  });
} finally {
  await stopServer(server);
  removeVerifyDataDir();
}
