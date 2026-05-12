import crypto from 'node:crypto';
import { z } from 'zod';
import { defaultRuntimeSecrets, type RuntimeConfig } from '../config.js';
import { HttpError } from '../httpErrors.js';
import { deleteAppSetting, readAppSetting, writeAppSetting } from './database.js';
import type { AIProviderConfig } from '../../types.js';

const aiProviderSettingId = 'ai-provider-settings';
const credentialSecret = crypto
  .createHash('sha256')
  .update(process.env.CREDENTIAL_ENCRYPTION_KEY || defaultRuntimeSecrets.credentialEncryptionKey)
  .digest();

const aiProviderSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  baseUrl: z.string().trim().optional(),
  model: z.string().trim().min(1).max(80).optional(),
  temperature: z.coerce.number().min(0).max(2).optional(),
  apiKey: z.string().trim().optional(),
  clearStoredKey: z.boolean().optional(),
});

export interface StoredAiProviderRecord {
  name: string;
  baseUrl: string;
  model: string;
  temperature: number;
  encryptedApiKey?: string;
  updatedAt: string;
}

export interface AiProviderStatus {
  name: string;
  baseUrl: string;
  model: string;
  temperature: number;
  configured: boolean;
  hasStoredApiKey: boolean;
  managedBy: 'database' | 'environment' | 'none';
  updatedAt: string | null;
}

export interface AiProviderSettingsResponse {
  provider: AIProviderConfig;
  configured: boolean;
  hasStoredApiKey: boolean;
  managedBy: AiProviderStatus['managedBy'];
  updatedAt: string | null;
}

export type AiProviderInput = Partial<AIProviderConfig> | (Partial<AIProviderConfig> & { provider?: Partial<AIProviderConfig> }) | undefined;

export function getAiProviderStatus(config: RuntimeConfig): AiProviderStatus {
  const stored = readStoredAiProviderRecord();
  const storedApiKey = decryptStoredApiKey(stored?.encryptedApiKey);
  const hasStoredApiKey = Boolean(storedApiKey);
  const configured = hasStoredApiKey || Boolean(config.ai.apiKey);

  return {
    name: stored?.name || 'OpenAI Compatible',
    baseUrl: stored?.baseUrl || config.ai.baseUrl,
    model: stored?.model || config.ai.model,
    temperature: typeof stored?.temperature === 'number' ? stored.temperature : 0.2,
    configured,
    hasStoredApiKey,
    managedBy: hasStoredApiKey ? 'database' : config.ai.apiKey ? 'environment' : 'none',
    updatedAt: stored?.updatedAt ?? null,
  };
}

export function loadAiProviderSettings(config: RuntimeConfig): AiProviderSettingsResponse {
  const status = getAiProviderStatus(config);
  return {
    provider: {
      name: status.name,
      baseUrl: status.baseUrl,
      model: status.model,
      apiKey: '',
      temperature: status.temperature,
    },
    configured: status.configured,
    hasStoredApiKey: status.hasStoredApiKey,
    managedBy: status.managedBy,
    updatedAt: status.updatedAt,
  };
}

export function saveAiProviderSettings(input: unknown, config: RuntimeConfig): AiProviderSettingsResponse {
  const parsed = aiProviderSchema.parse(input);
  const current = readStoredAiProviderRecord();
  const nextName = normalizeName(parsed.name, current?.name ?? 'OpenAI Compatible');
  const nextBaseUrl = normalizeBaseUrl(parsed.baseUrl ?? current?.baseUrl ?? config.ai.baseUrl);
  const nextModel = normalizeModel(parsed.model, current?.model ?? config.ai.model);
  const nextTemperature = typeof parsed.temperature === 'number' && Number.isFinite(parsed.temperature)
    ? parsed.temperature
    : current?.temperature ?? 0.2;
  const nextApiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
  if (parsed.clearStoredKey === true) {
    deleteAppSetting(aiProviderSettingId);
    return loadAiProviderSettings(config);
  }
  const nextRecord: StoredAiProviderRecord = {
    name: nextName,
    baseUrl: nextBaseUrl,
    model: nextModel,
    temperature: nextTemperature,
    updatedAt: new Date().toISOString(),
  };

  if (nextApiKey) {
    nextRecord.encryptedApiKey = encryptSecret(nextApiKey);
  } else if (current?.encryptedApiKey) {
    nextRecord.encryptedApiKey = current.encryptedApiKey;
  }

  writeAppSetting(aiProviderSettingId, nextRecord);
  return loadAiProviderSettings(config);
}

export function resolveAiProvider(input: AiProviderInput, config: RuntimeConfig): AIProviderConfig {
  const providerInput = input && 'provider' in input && input.provider ? input.provider : input;
  const stored = readStoredAiProviderRecord();
  const storedApiKey = decryptStoredApiKey(stored?.encryptedApiKey);
  const inputApiKey = typeof providerInput?.apiKey === 'string' ? providerInput.apiKey.trim() : '';
  const provider: AIProviderConfig = {
    name: normalizeName(providerInput?.name, stored?.name ?? 'OpenAI Compatible'),
    baseUrl: normalizeBaseUrl(providerInput?.baseUrl ?? stored?.baseUrl ?? config.ai.baseUrl),
    model: normalizeModel(providerInput?.model, stored?.model ?? config.ai.model),
    apiKey: inputApiKey && inputApiKey !== '__use_server_env__'
      ? inputApiKey
      : storedApiKey || config.ai.apiKey,
    temperature: typeof providerInput?.temperature === 'number'
      ? providerInput.temperature
      : typeof stored?.temperature === 'number'
        ? stored.temperature
        : 0.2,
  };

  return provider;
}

function readStoredAiProviderRecord(): StoredAiProviderRecord | null {
  const row = readAppSetting(aiProviderSettingId);
  if (!row) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.payload) as Partial<StoredAiProviderRecord>;
    return {
      name: normalizeName(parsed.name, 'OpenAI Compatible'),
      baseUrl: normalizeBaseUrl(parsed.baseUrl ?? ''),
      model: normalizeModel(parsed.model, 'gpt-4.1-mini'),
      temperature: typeof parsed.temperature === 'number' && Number.isFinite(parsed.temperature) ? parsed.temperature : 0.2,
      encryptedApiKey: typeof parsed.encryptedApiKey === 'string' && parsed.encryptedApiKey.trim() ? parsed.encryptedApiKey : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function decryptStoredApiKey(encryptedApiKey?: string) {
  if (!encryptedApiKey) {
    return '';
  }

  try {
    const [ivText, authTagText, encryptedText] = encryptedApiKey.split('.');
    if (!ivText || !authTagText || !encryptedText) {
      return '';
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', credentialSecret, Buffer.from(ivText, 'base64'));
    decipher.setAuthTag(Buffer.from(authTagText, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialSecret, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${authTag.toString('base64')}.${encrypted.toString('base64')}`;
}

function normalizeName(value: string | undefined, fallback: string) {
  const name = value?.trim();
  return name && name.length >= 2 ? name : fallback;
}

function normalizeModel(value: string | undefined, fallback: string) {
  const model = value?.trim();
  return model || fallback;
}

function normalizeBaseUrl(value: string) {
  const baseUrl = value.trim();
  if (!baseUrl) {
    return 'https://api.openai.com/v1';
  }

  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('invalid protocol');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new HttpError(400, 'AI Base URL must not include username, password, query parameters, or fragments', 'INVALID_AI_BASE_URL');
    }
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, 'AI Base URL is not a valid HTTP/HTTPS URL', 'INVALID_AI_BASE_URL');
  }
}
