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
    },
    security: {
      adminPasswordDefault: parsed.ADMIN_PASSWORD === defaultRuntimeSecrets.adminPassword,
      sessionSecretDefault: parsed.SESSION_SECRET === defaultRuntimeSecrets.sessionSecret,
      credentialEncryptionKeyConfigured: Boolean(env.CREDENTIAL_ENCRYPTION_KEY),
      credentialEncryptionKeyDefault: (env.CREDENTIAL_ENCRYPTION_KEY || defaultRuntimeSecrets.credentialEncryptionKey) === defaultRuntimeSecrets.credentialEncryptionKey,
    },
  };
}
