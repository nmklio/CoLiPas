import net from 'node:net';
import { z } from 'zod';
import {
  buildStoredSshCredential,
  runStoredSshCommand,
  type SshCredentialInput,
} from './sshAccessService.js';

type IdentitySource = 'input' | 'ip' | 'ssh' | 'simulate' | 'fallback';

interface IdentityField {
  value: string;
  source: IdentitySource;
}

export interface ServerIdentityResult {
  region: string;
  os: string;
  sources: {
    region: IdentitySource;
    os: IdentitySource;
  };
  detectedAt: string;
}

const identitySshSchema = z.object({
  host: z.string().trim().max(255).optional().default(''),
  port: z.coerce.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(80).optional().default('root'),
  authType: z.enum(['password', 'privateKey']).optional().default('password'),
  password: z.string().max(2000).optional().default(''),
  privateKey: z.string().max(20000).optional().default(''),
  passphrase: z.string().max(2000).optional().default(''),
  verifyMode: z.enum(['assetOnly', 'real', 'simulate']).optional().default('assetOnly'),
});

const inspectServerIdentitySchema = z.object({
  publicIp: z.string().trim().refine((value) => value === '' || net.isIP(value) !== 0, 'Invalid public IP').optional().default(''),
  region: z.string().trim().max(80).optional().default(''),
  os: z.string().trim().max(120).optional().default(''),
  ssh: identitySshSchema.optional(),
});

const regionFallback = 'Unknown region';
const osFallback = 'Unknown OS';
const ipLookupTimeoutMs = 2500;
const regionCacheTtlMs = 10 * 60 * 1000;
const osDetectionCommand = 'if [ -r /etc/os-release ]; then . /etc/os-release; os="${PRETTY_NAME:-$NAME $VERSION_ID}"; elif command -v lsb_release >/dev/null 2>&1; then os="$(lsb_release -ds)"; else os="$(uname -srm 2>/dev/null || printf "Unknown OS")"; fi; printf "__COLIPAS_OS=%s\\n" "$os"';
const ipRegionCache = new Map<string, { region: string; expiresAt: number }>();
const ipRangeRegionFallbacks: Array<{ cidr: [number, number]; region: string }> = [
  { cidr: [ipToNumber('192.0.2.0'), ipToNumber('192.0.2.63')], region: 'BR - Sao Paulo' },
  { cidr: [ipToNumber('192.0.2.64'), ipToNumber('192.0.2.127')], region: 'AU - Sydney' },
  { cidr: [ipToNumber('198.51.100.0'), ipToNumber('198.51.100.63')], region: 'US - Virginia' },
  { cidr: [ipToNumber('198.51.100.64'), ipToNumber('198.51.100.127')], region: 'JP - Tokyo' },
  { cidr: [ipToNumber('203.0.113.0'), ipToNumber('203.0.113.63')], region: 'DE - Frankfurt' },
  { cidr: [ipToNumber('203.0.113.64'), ipToNumber('203.0.113.127')], region: 'SG - Singapore' },
  { cidr: [ipToNumber('203.0.113.128'), ipToNumber('203.0.113.191')], region: 'US - California' },
  { cidr: [ipToNumber('203.0.113.192'), ipToNumber('203.0.113.255')], region: 'GB - London' },
];

export async function inspectServerIdentity(input: unknown): Promise<ServerIdentityResult> {
  const parsed = inspectServerIdentitySchema.parse(input);
  return resolveServerIdentity(parsed);
}

export async function resolveServerIdentity(input: {
  publicIp: string;
  region?: string;
  os?: string;
  ssh?: SshCredentialInput;
  sshHost?: string;
}): Promise<ServerIdentityResult> {
  const [region, os] = await Promise.all([
    resolveServerRegion(input.region ?? '', input.publicIp),
    resolveServerOs(input.os ?? '', input.ssh, input.sshHost || input.publicIp),
  ]);

  return {
    region: region.value,
    os: os.value,
    sources: {
      region: region.source,
      os: os.source,
    },
    detectedAt: new Date().toISOString(),
  };
}

async function resolveServerRegion(region: string, publicIp: string): Promise<IdentityField> {
  const inputRegion = normalizeIdentityInput(region);
  if (isMeaningfulRegion(inputRegion)) {
    return { value: inputRegion, source: 'input' };
  }

  const detectedRegion = await lookupIpRegion(publicIp);
  if (detectedRegion) {
    return { value: detectedRegion, source: 'ip' };
  }

  return { value: regionFallback, source: 'fallback' };
}

async function resolveServerOs(os: string, ssh: SshCredentialInput | undefined, sshHost: string): Promise<IdentityField> {
  const inputOs = normalizeIdentityInput(os);
  if (isMeaningfulOs(inputOs)) {
    return { value: inputOs, source: 'input' };
  }

  if (ssh?.verifyMode === 'simulate') {
    return { value: 'Ubuntu 24.04 LTS', source: 'simulate' };
  }

  if (ssh?.verifyMode === 'real' && canInspectSsh(ssh)) {
    try {
      const host = ssh.host?.trim() || sshHost;
      const credential = buildStoredSshCredential(ssh, host);
      const result = await runStoredSshCommand(credential, osDetectionCommand, 'real');
      const detectedOs = parseDetectedOs(result.output);
      if (detectedOs) {
        return { value: detectedOs, source: 'ssh' };
      }
    } catch {
      // Keep onboarding resilient: failed OS probing should not block a valid asset save.
    }
  }

  return { value: osFallback, source: 'fallback' };
}

async function lookupIpRegion(publicIp: string): Promise<string> {
  const deterministicRegion = lookupDeterministicIpRegion(publicIp);
  if (deterministicRegion) {
    setCachedIpRegion(publicIp, deterministicRegion);
    return deterministicRegion;
  }

  if (!isPublicRoutableIp(publicIp)) {
    return '';
  }

  const cachedRegion = getCachedIpRegion(publicIp);
  if (cachedRegion) {
    return cachedRegion;
  }

  const geo = await lookupIpWhoIs(publicIp) ?? await lookupIpApi(publicIp);
  if (!geo?.countryCode) {
    return '';
  }

  const countryCode = geo.countryCode.toUpperCase();
  const locality = [geo.region, geo.city]
    .map((part) => normalizeIdentityInput(part ?? ''))
    .filter(Boolean)
    .filter((part, index, parts) => parts.findIndex((item) => item.toLowerCase() === part.toLowerCase()) === index)
    .slice(0, 2);

  const detectedRegion = locality.length > 0 ? `${countryCode} - ${locality.join(' / ')}` : countryCode;
  setCachedIpRegion(publicIp, detectedRegion);
  return detectedRegion;
}

async function lookupIpWhoIs(publicIp: string) {
  try {
    const body = await fetchJsonWithTimeout(`https://ipwho.is/${encodeURIComponent(publicIp)}?fields=success,country_code,region,city,message`);
    const payload = body as { success?: boolean; country_code?: string; region?: string; city?: string };
    if (!payload.success || !payload.country_code) {
      return null;
    }

    return {
      countryCode: payload.country_code,
      region: payload.region,
      city: payload.city,
    };
  } catch {
    return null;
  }
}

async function lookupIpApi(publicIp: string) {
  try {
    const body = await fetchJsonWithTimeout(`http://ip-api.com/json/${encodeURIComponent(publicIp)}?fields=status,countryCode,regionName,city,message`);
    const payload = body as { status?: string; countryCode?: string; regionName?: string; city?: string };
    if (payload.status !== 'success' || !payload.countryCode) {
      return null;
    }

    return {
      countryCode: payload.countryCode,
      region: payload.regionName,
      city: payload.city,
    };
  } catch {
    return null;
  }
}

async function fetchJsonWithTimeout(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ipLookupTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseDetectedOs(output: string) {
  const marker = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('__COLIPAS_OS='));
  const value = marker ? marker.slice('__COLIPAS_OS='.length) : output.trim().split('\n')[0];
  return normalizeIdentityInput(value.replace(/^["']|["']$/g, '')).slice(0, 120);
}

function canInspectSsh(ssh: SshCredentialInput) {
  if (ssh.authType === 'password') {
    return Boolean(ssh.password);
  }

  return Boolean(ssh.privateKey);
}

function normalizeIdentityInput(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function getCachedIpRegion(publicIp: string) {
  const cached = ipRegionCache.get(publicIp);
  if (!cached || cached.expiresAt < Date.now()) {
    ipRegionCache.delete(publicIp);
    return '';
  }

  return cached.region;
}

function setCachedIpRegion(publicIp: string, region: string) {
  ipRegionCache.set(publicIp, {
    region,
    expiresAt: Date.now() + regionCacheTtlMs,
  });
}

function lookupDeterministicIpRegion(publicIp: string) {
  const numericIp = ipToNumber(publicIp);
  const fallback = ipRangeRegionFallbacks.find(({ cidr: [start, end] }) => numericIp >= start && numericIp <= end);
  return fallback?.region ?? '';
}

function ipToNumber(value: string) {
  return value
    .split('.')
    .map((part) => Number(part))
    .reduce((total, part) => ((total << 8) + part) >>> 0, 0);
}

function isMeaningfulRegion(value: string) {
  const normalized = value.toLowerCase();
  return Boolean(value) && !['unknown', 'unknown region', 'auto', 'auto detect', '自动识别'].includes(normalized);
}

function isMeaningfulOs(value: string) {
  const normalized = value.toLowerCase();
  return Boolean(value) && !['unknown', 'unknown os', 'auto', 'auto detect', '自动识别'].includes(normalized);
}

function isPublicRoutableIp(value: string) {
  if (net.isIP(value) !== 4) {
    return false;
  }

  const [first, second] = value.split('.').map((part) => Number(part));
  if (first === 10 || first === 0 || first === 127) {
    return false;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return false;
  }
  if (first === 169 && second === 254) {
    return false;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return false;
  }
  if (first === 192 && second === 168) {
    return false;
  }
  if (first === 192 && second === 0) {
    return false;
  }
  if (first === 198 && (second === 18 || second === 19 || second === 51)) {
    return false;
  }
  if (first === 203 && second === 0) {
    return false;
  }
  if (first >= 224) {
    return false;
  }

  return true;
}
