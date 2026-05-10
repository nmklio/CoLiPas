import type { ApiMethod, CustomApiConfig, PreparedApiRequest } from '../types.js';

const blockedHeaderNames = new Set([
  'connection',
  'content-length',
  'cookie',
  'expect',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

export function parseHeaders(headersText: string) {
  if (headersText.trim().length === 0) {
    return {};
  }

  return headersText.split('\n').reduce<Record<string, string>>((headers, line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return headers;
    }

    const separator = trimmed.indexOf(':');
    if (separator === -1) {
      throw new Error(`Header line ${index + 1} is missing ':'`);
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!key || !value) {
      throw new Error(`Header line ${index + 1} is incomplete`);
    }

    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key)) {
      throw new Error(`Header line ${index + 1} has an invalid header name`);
    }

    if (blockedHeaderNames.has(key.toLowerCase())) {
      throw new Error(`Header "${key}" is not allowed through the custom API proxy`);
    }

    headers[key] = value;
    return headers;
  }, {});
}

export function prepareApiRequest(config: CustomApiConfig): PreparedApiRequest {
  const url = new URL(config.url);
  const headers = parseHeaders(config.headersText);

  if (config.authToken?.trim()) {
    headers.Authorization = `Bearer ${config.authToken.trim()}`;
  }

  if (config.bodyText.trim() && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  return {
    method: config.method as ApiMethod,
    url: url.toString(),
    headers,
    body: config.method === 'GET' ? undefined : config.bodyText.trim() ? config.bodyText.trim() : undefined,
  };
}

export function toCurl(request: PreparedApiRequest) {
  const headerParts = Object.entries(request.headers).map(([key, value]) => `-H "${key}: ${value}"`);
  const bodyPart = request.body ? `--data '${request.body.replaceAll("'", "'\\''")}'` : '';
  return ['curl', '-X', request.method, `"${request.url}"`, ...headerParts, bodyPart].filter(Boolean).join(' ');
}
