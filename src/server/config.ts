import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  CORS_ORIGIN: z.string().optional(),
  CUSTOM_API_ALLOWED_HOSTS: z.string().default('httpbin.org,api.example.com'),
  CUSTOM_API_TIMEOUT_MS: z.coerce.number().int().positive().max(30000).default(8000),
  AI_API_KEY: z.string().optional().default(''),
  AI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  AI_MODEL: z.string().min(1).default('gpt-4.1-mini'),
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  ADMIN_PASSWORD: z.string().min(8).default('admin123456'),
  SESSION_SECRET: z.string().min(16).default('colipas-local-session-secret'),
  SESSION_TTL_HOURS: z.coerce.number().positive().max(168).default(12),
  SESSION_MAX_ACTIVE: z.coerce.number().int().min(2).max(64).default(12),
  RELEASE_VERIFY_TOKEN: z.string().default('').refine((value) => value === '' || value.length >= 24, {
    message: 'RELEASE_VERIFY_TOKEN must be empty or at least 24 characters',
  }),
  RELEASE_TARGET_NAME: z.string().default(''),
  RELEASE_CHANNEL: z.string().default(''),
  RELEASE_DEPLOYMENT_MODE: z.string().default(''),
  RELEASE_PUBLIC_URL: z.string().default(''),
  RELEASE_GIT_COMMIT: z.string().default(''),
  RELEASE_ARTIFACT_ID: z.string().default(''),
  RELEASE_DEPLOYED_AT: z.string().default(''),
  RELEASE_SYNC_TARGETS: z.string().default(''),
  COLIPAS_TEST_ALLOW_RELEASE_SYNC_LOOPBACK: z.enum(['0', '1']).default('0'),
  COLIPAS_SECURE_COOKIES: z.enum(['0', '1']).optional(),
});

export const defaultRuntimeSecrets = {
  adminPassword: 'admin123456',
  sessionSecret: 'colipas-local-session-secret',
  credentialEncryptionKey: 'colipas-local-development-secret',
} as const;

export type RuntimeConfig = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const defaultCorsOrigin = parsed.NODE_ENV === 'production'
    ? `http://127.0.0.1:${parsed.PORT},http://localhost:${parsed.PORT}`
    : 'http://127.0.0.1:5173,http://localhost:5173';
  const corsOrigin = parsed.CORS_ORIGIN ?? defaultCorsOrigin;

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    corsOrigins: corsOrigin.split(',').map((origin) => origin.trim()).filter(Boolean),
    customApiAllowedHosts: parsed.CUSTOM_API_ALLOWED_HOSTS.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
    customApiTimeoutMs: parsed.CUSTOM_API_TIMEOUT_MS,
    ai: {
      apiKey: parsed.AI_API_KEY,
      baseUrl: parsed.AI_BASE_URL,
      model: parsed.AI_MODEL,
    },
    auth: {
      adminUsername: parsed.ADMIN_USERNAME,
      adminPassword: parsed.ADMIN_PASSWORD,
      sessionSecret: parsed.SESSION_SECRET,
      sessionTtlMs: parsed.SESSION_TTL_HOURS * 60 * 60 * 1000,
      maxActiveSessions: parsed.SESSION_MAX_ACTIVE,
      secureCookies: parsed.NODE_ENV === 'production' && (
        parsed.COLIPAS_SECURE_COOKIES === '1'
        || parsed.RELEASE_PUBLIC_URL.toLowerCase().startsWith('https://')
      ),
    },
    security: {
      adminPasswordDefault: parsed.ADMIN_PASSWORD === defaultRuntimeSecrets.adminPassword,
      sessionSecretDefault: parsed.SESSION_SECRET === defaultRuntimeSecrets.sessionSecret,
      credentialEncryptionKeyConfigured: Boolean(env.CREDENTIAL_ENCRYPTION_KEY),
      credentialEncryptionKeyDefault: (env.CREDENTIAL_ENCRYPTION_KEY || defaultRuntimeSecrets.credentialEncryptionKey) === defaultRuntimeSecrets.credentialEncryptionKey,
    },
    releaseVerification: {
      token: parsed.RELEASE_VERIFY_TOKEN,
      tokenConfigured: parsed.RELEASE_VERIFY_TOKEN.length >= 24,
    },
    release: {
      targetName: parsed.RELEASE_TARGET_NAME,
      channel: parsed.RELEASE_CHANNEL,
      deploymentMode: parsed.RELEASE_DEPLOYMENT_MODE,
      publicUrl: parsed.RELEASE_PUBLIC_URL,
      gitCommit: parsed.RELEASE_GIT_COMMIT,
      artifactId: parsed.RELEASE_ARTIFACT_ID,
      deployedAt: parsed.RELEASE_DEPLOYED_AT,
      syncTargets: parseReleaseSyncTargets(
        parsed.RELEASE_SYNC_TARGETS,
        parsed.RELEASE_PUBLIC_URL,
        parsed.RELEASE_TARGET_NAME,
        parsed.COLIPAS_TEST_ALLOW_RELEASE_SYNC_LOOPBACK === '1',
      ),
    },
  };
}

function parseReleaseSyncTargets(rawValue: string, fallbackUrl: string, fallbackName: string, allowLoopback: boolean) {
  const rawTargets = rawValue
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const targetSpecs = rawTargets.length > 0
    ? rawTargets
    : fallbackUrl
      ? [`${fallbackName || 'current'}=${fallbackUrl}`]
      : [];

  return targetSpecs
    .map((spec, index) => {
      const separatorIndex = spec.indexOf('=');
      const rawName = separatorIndex > 0 ? spec.slice(0, separatorIndex).trim() : `target-${index + 1}`;
      const rawUrl = separatorIndex > 0 ? spec.slice(separatorIndex + 1).trim() : spec;
      const parsedUrl = parsePublicHttpUrl(rawUrl, allowLoopback);
      if (!parsedUrl) {
        return null;
      }

      return {
        name: sanitizeReleaseTargetName(rawName || `target-${index + 1}`),
        baseUrl: parsedUrl,
      };
    })
    .filter((target): target is { name: string; baseUrl: string } => Boolean(target));
}

function parsePublicHttpUrl(rawUrl: string, allowLoopback: boolean) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    if (!allowLoopback && isPrivateHostname(url.hostname)) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized.endsWith('.local')
    || normalized === '0.0.0.0'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized.startsWith('10.')
    || normalized.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized);
}

function sanitizeReleaseTargetName(value: string) {
  return value.replace(/[^\p{L}\p{N}_. -]/gu, '').trim().slice(0, 48) || 'target';
}
