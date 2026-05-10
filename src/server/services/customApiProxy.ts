import dns from 'node:dns/promises';
import net from 'node:net';
import { z } from 'zod';
import { prepareApiRequest } from '../../shared/apiRequest.js';
import { ApiMethod, CustomApiConfig } from '../../types.js';
import { RuntimeConfig } from '../config.js';
import { HttpError } from '../httpErrors.js';

const apiMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const customApiTestSchema = z.object({
  name: z.string().min(1).max(80),
  method: apiMethodSchema,
  url: z.string().url(),
  headersText: z.string().max(4000).default(''),
  bodyText: z.string().max(20000).default(''),
  authToken: z.string().max(4000).optional(),
});

export interface ProxiedApiResult {
  ok: boolean;
  status: number;
  durationMs: number;
  headers: Record<string, string>;
  bodyText: string;
}

export async function executeCustomApiProxy(input: unknown, config: RuntimeConfig): Promise<ProxiedApiResult> {
  const parsed = customApiTestSchema.parse(input);
  const apiConfig: CustomApiConfig = {
    ...parsed,
    method: parsed.method as ApiMethod,
  };
  let prepared: ReturnType<typeof prepareApiRequest>;
  try {
    prepared = prepareApiRequest(apiConfig);
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : 'Invalid custom API request',
      'INVALID_CUSTOM_API_REQUEST',
    );
  }
  await assertSafeOutboundUrl(prepared.url, config.customApiAllowedHosts);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.customApiTimeoutMs);
  const startedAt = performance.now();

  try {
    const response = await fetch(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      body: prepared.body,
      redirect: 'manual',
      signal: controller.signal,
    });
    const bodyText = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      headers: headersToObject(response.headers),
      bodyText: bodyText.slice(0, 10000),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(504, 'Custom API call timed out', 'CUSTOM_API_TIMEOUT');
    }

    throw new HttpError(
      502,
      error instanceof Error ? `Custom API upstream call failed: ${error.message}` : 'Custom API upstream call failed',
      'CUSTOM_API_UPSTREAM_ERROR',
    );
  } finally {
    clearTimeout(timeout);
  }
}

function headersToObject(headers: Headers) {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export async function assertSafeOutboundUrl(urlText: string, allowedHosts: string[]) {
  const url = new URL(urlText);

  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new HttpError(400, 'Only HTTP and HTTPS URLs are supported', 'UNSUPPORTED_PROTOCOL');
  }

  const hostname = url.hostname.toLowerCase();
  if (!allowedHosts.includes(hostname)) {
    throw new HttpError(403, `Host ${hostname} is not in the custom API allowlist`, 'HOST_NOT_ALLOWED');
  }

  if (isLiteralPrivateAddress(hostname) && !isExplicitlyAllowedLoopback(hostname, allowedHosts)) {
    throw new HttpError(403, 'Private or localhost addresses are blocked for custom API calls', 'PRIVATE_ADDRESS_BLOCKED');
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new HttpError(502, `Custom API host could not be resolved: ${hostname}`, 'CUSTOM_API_DNS_FAILED');
  }

  if (records.some((record) => isLiteralPrivateAddress(record.address) && !isExplicitlyAllowedLoopback(hostname, allowedHosts))) {
    throw new HttpError(403, 'Resolved host points to a private or localhost address', 'PRIVATE_ADDRESS_BLOCKED');
  }
}

function isLiteralPrivateAddress(hostname: string) {
  if (hostname === 'localhost') {
    return true;
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 0) {
    return false;
  }

  if (ipVersion === 6) {
    return (
      hostname === '::1' ||
      hostname === '::' ||
      hostname.startsWith('fc') ||
      hostname.startsWith('fd') ||
      hostname.startsWith('fe80:')
    );
  }

  const parts = hostname.split('.').map((part) => Number(part));
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isExplicitlyAllowedLoopback(hostname: string, allowedHosts: string[]) {
  return process.env.COLIPAS_TEST_ALLOW_LOOPBACK_API === '1'
    && (hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost')
    && allowedHosts.includes(hostname);
}
