import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { RuntimeConfig } from '../config.js';
import { HttpError } from '../httpErrors.js';
import {
  deleteAuthSessionRow,
  deleteExpiredAuthSessionRows,
  deleteOtherAuthSessionRows,
  insertAuthSessionRow,
  loadAuthSessionRows,
  readAppSetting,
  readAuthSessionRow,
  retireOldestAuthSessionRows,
  updateAuthSessionLastSeen,
  writeAppSetting,
  type StoredAuthSessionRow,
} from './database.js';

const avatarMaxBytes = 2 * 1024 * 1024;
const avatarMaxDimension = 4096;
const avatarMaxDataUrlLength = Math.ceil(avatarMaxBytes * 4 / 3) + 64;
const defaultAvatarText = 'CP';
const defaultDisplayName = 'CoLiPas';
const legacyDefaultDisplayName = 'CoLiPas云服务器管理面板';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(32),
  avatarText: z.string().trim().min(1).max(4).regex(/^[\p{L}\p{N}]+$/u, '头像只能包含字母或数字').optional().default(defaultAvatarText),
  avatarImage: z.string().trim().max(avatarMaxDataUrlLength).optional().default('').refine(
    (value) => value === '' || isSafeAvatarDataUrl(value),
    '头像图片仅支持 2MB 内的 PNG、JPEG、WebP 或 GIF',
  ),
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200)
    .regex(/[A-Za-z]/, '新密码需要包含字母')
    .regex(/[0-9]/, '新密码需要包含数字'),
});

const cookieName = 'colipas_session';
const accountSettingId = 'admin-account';
const profileSettingId = 'console-profile';
const loginFailureWindowMs = 10 * 60 * 1000;
const maxLoginFailuresPerWindow = 8;
const sessionLastSeenWriteIntervalMs = 30_000;

interface StoredPassword {
  algorithm: 'scrypt';
  salt: string;
  key: string;
}

interface StoredAccountSetting {
  username: string;
  password: StoredPassword;
  passwordChangedAt: string;
}

export interface ConsoleProfile {
  displayName: string;
  avatarText: string;
  avatarImage?: string;
}

interface SessionRecord {
  tokenHash: string;
  username: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  deviceLabel: string;
}

interface SessionContext {
  tokenHash: string;
  session: SessionRecord;
}

interface LoginFailureRecord {
  count: number;
  firstFailedAt: number;
  lockedUntil: number;
}

const loginFailures = new Map<string, LoginFailureRecord>();
const sessionManagementIdSchema = z.string().regex(/^[a-f0-9]{24}$/);
const fallbackProfile: ConsoleProfile = {
  displayName: defaultDisplayName,
  avatarText: defaultAvatarText,
  avatarImage: '',
};

export function getSessionCookieName() {
  return cookieName;
}

export function login(input: unknown, request: Request, response: Response, config: RuntimeConfig) {
  const parsed = loginSchema.parse(input);
  const limiterKey = buildLoginLimiterKey(parsed.username, request);
  assertLoginAllowed(limiterKey);

  const account = getStoredAccount(config);
  if (!safeEqual(parsed.username, account.username) || !verifyPassword(parsed.password, account.password)) {
    const retryAfterSeconds = recordLoginFailure(limiterKey);
    if (retryAfterSeconds > 0) {
      throw new HttpError(429, 'Too many failed login attempts. Please retry later.', 'AUTH_RATE_LIMITED');
    }
    throw new HttpError(401, '用户名或密码错误', 'AUTH_INVALID_CREDENTIALS');
  }

  const now = Date.now();
  pruneExpiredSessions(now);
  retireOldestSessions(parsed.username, config.auth.maxActiveSessions - 1);
  const sessionId = crypto.randomBytes(32).toString('hex');
  const session: SessionRecord = {
    tokenHash: hashSessionId(sessionId),
    username: parsed.username,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + config.auth.sessionTtlMs,
    deviceLabel: describeSessionDevice(request),
  };

  insertAuthSessionRow(toStoredAuthSession(session));
  clearLoginFailures(limiterKey);
  setSessionCookie(response, sessionId, config);

  return buildSessionPayload(session, now);
}

export function getLoginThrottleStatus(input: unknown, request: Request) {
  const username = input && typeof input === 'object' && 'username' in input && typeof (input as { username?: unknown }).username === 'string'
    ? (input as { username: string }).username
    : 'anonymous';
  const record = getActiveLoginFailureRecord(buildLoginLimiterKey(username, request));
  const retryAfterSeconds = record?.lockedUntil && record.lockedUntil > Date.now()
    ? Math.ceil((record.lockedUntil - Date.now()) / 1000)
    : 0;

  return {
    throttled: retryAfterSeconds > 0,
    retryAfterSeconds,
  };
}

export function logout(request: Request, response: Response, config: RuntimeConfig) {
  const token = readCookie(request, cookieName);
  const sessionId = token ? verifyToken(token, config.auth.sessionSecret) : null;
  if (sessionId) {
    deleteAuthSessionRow(hashSessionId(sessionId));
  }
  clearSessionCookie(response);
  return { authenticated: false };
}

export function getCurrentSession(request: Request, config: RuntimeConfig) {
  const context = resolveSessionContext(request, config);
  return context ? buildSessionPayload(context.session) : null;
}

export function getConsoleProfile() {
  const stored = readJsonSetting<ConsoleProfile>(profileSettingId);
  if (!stored) {
    return fallbackProfile;
  }
  if (isDefaultLikeProfile(stored)) {
    return fallbackProfile;
  }
  return {
    displayName: stored.displayName || fallbackProfile.displayName,
    avatarText: (stored.avatarText || fallbackProfile.avatarText).toUpperCase(),
    avatarImage: stored.avatarImage && isSafeAvatarDataUrl(stored.avatarImage) ? stored.avatarImage : '',
  };
}

export function updateConsoleProfile(input: unknown) {
  const parsed = profileSchema.parse(input);
  const profile: ConsoleProfile = {
    displayName: parsed.displayName,
    avatarText: parsed.avatarText.toUpperCase(),
    avatarImage: parsed.avatarImage,
  };
  writeAppSetting(profileSettingId, profile);
  return profile;
}

function isDefaultLikeProfile(profile: Partial<ConsoleProfile>) {
  const displayName = profile.displayName?.trim();
  const avatarText = profile.avatarText?.trim().toUpperCase() || fallbackProfile.avatarText;
  return (
    !profile.avatarImage
    && avatarText === fallbackProfile.avatarText
    && (displayName === defaultDisplayName || displayName === legacyDefaultDisplayName)
  );
}

export function changeAdminPassword(input: unknown, request: Request, config: RuntimeConfig) {
  const sessionContext = requireSessionContext(request, config);
  const parsed = passwordChangeSchema.parse(input);
  const account = getStoredAccount(config);

  if (!verifyPassword(parsed.currentPassword, account.password)) {
    throw new HttpError(403, '当前密码错误', 'AUTH_INVALID_CURRENT_PASSWORD');
  }

  if (verifyPassword(parsed.newPassword, account.password)) {
    throw new HttpError(400, '新密码不能与当前密码相同', 'AUTH_PASSWORD_REUSED');
  }

  const nextAccount: StoredAccountSetting = {
    username: account.username,
    password: hashPassword(parsed.newPassword),
    passwordChangedAt: new Date().toISOString(),
  };
  writeAppSetting(accountSettingId, nextAccount);
  clearOtherSessions(sessionContext.session.username, sessionContext.tokenHash);
  return {
    ok: true,
    changedAt: nextAccount.passwordChangedAt,
  };
}

export function requireSession(request: Request, config: RuntimeConfig) {
  const context = requireSessionContext(request, config);
  return buildSessionPayload(context.session);
}

export function buildAccountPayload(request: Request, config: RuntimeConfig) {
  const session = requireSession(request, config);
  return {
    session,
    profile: getConsoleProfile(),
  };
}

export function listAccountSessions(request: Request, config: RuntimeConfig) {
  const context = requireSessionContext(request, config);
  return buildAccountSessionsPayload(context, config.auth.maxActiveSessions);
}

export function revokeAccountSession(sessionManagementId: unknown, request: Request, config: RuntimeConfig) {
  const context = requireSessionContext(request, config);
  const parsedId = sessionManagementIdSchema.parse(sessionManagementId);
  pruneExpiredSessions();
  const target = loadSessionRecords(context.session.username)
    .find((session) => buildSessionManagementId(session.tokenHash) === parsedId);

  if (!target) {
    throw new HttpError(404, 'Session not found or already expired', 'AUTH_SESSION_NOT_FOUND');
  }
  if (target.tokenHash === context.tokenHash) {
    throw new HttpError(400, 'Sign out to close the current session', 'AUTH_SESSION_CURRENT');
  }

  deleteAuthSessionRow(target.tokenHash);
  return {
    ok: true as const,
    revoked: 1,
    sessions: buildAccountSessionsPayload(context, config.auth.maxActiveSessions),
  };
}

export function revokeOtherAccountSessions(request: Request, config: RuntimeConfig) {
  const context = requireSessionContext(request, config);
  pruneExpiredSessions();
  const revoked = deleteOtherAuthSessionRows(context.session.username, context.tokenHash);
  return {
    ok: true as const,
    revoked,
    sessions: buildAccountSessionsPayload(context, config.auth.maxActiveSessions),
  };
}

function setSessionCookie(response: Response, sessionId: string, config: RuntimeConfig) {
  const token = signToken(sessionId, config.auth.sessionSecret);
  response.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.auth.secureCookies,
    path: '/',
    maxAge: config.auth.sessionTtlMs,
  });
}

function clearSessionCookie(response: Response) {
  response.clearCookie(cookieName, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  });
}

function buildSessionPayload(session: SessionRecord, now = Date.now()) {
  return {
    authenticated: true,
    user: {
      username: session.username,
      role: '管理员',
    },
    profile: getConsoleProfile(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    ttlSeconds: Math.max(0, Math.round((session.expiresAt - now) / 1000)),
  };
}

function resolveSessionContext(request: Request, config: RuntimeConfig): SessionContext | null {
  const token = readCookie(request, cookieName);
  const sessionId = token ? verifyToken(token, config.auth.sessionSecret) : null;
  if (!sessionId) {
    return null;
  }

  const tokenHash = hashSessionId(sessionId);
  const session = fromStoredAuthSession(readAuthSessionRow(tokenHash));
  const now = Date.now();
  const account = getStoredAccount(config);
  if (!session || session.expiresAt <= now || session.username !== account.username) {
    deleteAuthSessionRow(tokenHash);
    return null;
  }

  if (now - session.lastSeenAt >= sessionLastSeenWriteIntervalMs) {
    updateAuthSessionLastSeen(tokenHash, now);
    session.lastSeenAt = now;
  }
  return { tokenHash, session };
}

function requireSessionContext(request: Request, config: RuntimeConfig) {
  const context = resolveSessionContext(request, config);
  if (!context) {
    throw new HttpError(401, '登录已失效，请重新登录', 'AUTH_REQUIRED');
  }
  return context;
}

function getStoredAccount(config: RuntimeConfig): StoredAccountSetting {
  const stored = readJsonSetting<StoredAccountSetting>(accountSettingId);
  if (isStoredAccount(stored) && stored.username === config.auth.adminUsername) {
    return stored;
  }

  const seeded: StoredAccountSetting = {
    username: config.auth.adminUsername,
    password: hashPassword(config.auth.adminPassword),
    passwordChangedAt: '',
  };
  writeAppSetting(accountSettingId, seeded);
  return seeded;
}

function clearOtherSessions(username: string, currentTokenHash: string) {
  deleteOtherAuthSessionRows(username, currentTokenHash);
}

function buildAccountSessionsPayload(context: SessionContext, maxActiveSessions: number) {
  pruneExpiredSessions();
  const currentSession = fromStoredAuthSession(readAuthSessionRow(context.tokenHash));
  if (!currentSession || currentSession.username !== context.session.username) {
    throw new HttpError(401, '登录已失效，请重新登录', 'AUTH_REQUIRED');
  }
  const items = loadSessionRecords(currentSession.username)
    .sort((left, right) => {
      if (left.tokenHash === context.tokenHash) {
        return -1;
      }
      if (right.tokenHash === context.tokenHash) {
        return 1;
      }
      return right.lastSeenAt - left.lastSeenAt;
    })
    .map((session) => ({
      id: buildSessionManagementId(session.tokenHash),
      current: session.tokenHash === context.tokenHash,
      deviceLabel: session.deviceLabel,
      createdAt: new Date(session.createdAt).toISOString(),
      lastSeenAt: new Date(session.lastSeenAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
    }));

  return {
    items,
    summary: {
      active: items.length,
      otherSessions: items.filter((item) => !item.current).length,
      maxActive: maxActiveSessions,
      available: Math.max(0, maxActiveSessions - items.length),
      atCapacity: items.length >= maxActiveSessions,
      persistent: true,
    },
  };
}

function retireOldestSessions(username: string, slotsToKeep: number) {
  retireOldestAuthSessionRows(username, slotsToKeep);
}

function pruneExpiredSessions(now = Date.now()) {
  deleteExpiredAuthSessionRows(now);
}

function buildSessionManagementId(tokenHash: string) {
  return crypto.createHash('sha256').update(`colipas-session-management:${tokenHash}`).digest('hex').slice(0, 24);
}

function hashSessionId(sessionId: string) {
  return crypto.createHash('sha256').update(`colipas-auth-session:${sessionId}`).digest('hex');
}

function loadSessionRecords(username: string) {
  return loadAuthSessionRows(username)
    .map((row) => fromStoredAuthSession(row))
    .filter((session): session is SessionRecord => Boolean(session));
}

function toStoredAuthSession(session: SessionRecord): StoredAuthSessionRow {
  return {
    token_hash: session.tokenHash,
    username: session.username,
    device_label: session.deviceLabel,
    created_at: session.createdAt,
    last_seen_at: session.lastSeenAt,
    expires_at: session.expiresAt,
  };
}

function fromStoredAuthSession(row: StoredAuthSessionRow | null): SessionRecord | null {
  if (
    !row
    || !/^[a-f0-9]{64}$/.test(row.token_hash)
    || !row.username
    || !row.device_label
    || !Number.isFinite(row.created_at)
    || !Number.isFinite(row.last_seen_at)
    || !Number.isFinite(row.expires_at)
  ) {
    return null;
  }
  return {
    tokenHash: row.token_hash,
    username: row.username,
    deviceLabel: row.device_label,
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    expiresAt: Number(row.expires_at),
  };
}

function describeSessionDevice(request: Request) {
  const rawUserAgent = Array.isArray(request.headers['user-agent'])
    ? request.headers['user-agent'][0]
    : request.headers['user-agent'] || '';
  const browser = /\bEdg\//i.test(rawUserAgent)
    ? 'Edge'
    : /\bFirefox\//i.test(rawUserAgent)
      ? 'Firefox'
      : /\b(?:Chrome|CriOS)\//i.test(rawUserAgent)
        ? 'Chrome'
        : /\bSafari\//i.test(rawUserAgent)
          ? 'Safari'
          : /\b(?:curl|Wget)\//i.test(rawUserAgent)
            ? 'API client'
            : 'Browser';
  const platform = /\bAndroid\b/i.test(rawUserAgent)
    ? 'Android'
    : /\b(?:iPhone|iPad|iPod)\b/i.test(rawUserAgent)
      ? 'iOS'
      : /\bWindows\b/i.test(rawUserAgent)
        ? 'Windows'
        : /\bMacintosh\b|\bMac OS X\b/i.test(rawUserAgent)
          ? 'macOS'
          : /\bLinux\b/i.test(rawUserAgent)
            ? 'Linux'
            : 'Device';
  return `${browser} · ${platform}`;
}

function buildLoginLimiterKey(username: string, request: Request) {
  return `${username.trim().toLowerCase()}:${resolveClientAddress(request)}`;
}

function resolveClientAddress(request: Request) {
  const forwardedFor = request.headers['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const firstForwarded = forwardedValue?.split(',')[0]?.trim();
  const socketAddress = request.socket.remoteAddress || '';
  if (firstForwarded && (process.env.TRUST_PROXY_LOGIN_LIMIT === '1' || isLoopbackAddress(socketAddress))) {
    return firstForwarded;
  }

  return request.ip || socketAddress || 'unknown';
}

function assertLoginAllowed(key: string) {
  const record = getActiveLoginFailureRecord(key);
  if (record?.lockedUntil && record.lockedUntil > Date.now()) {
    throw new HttpError(429, 'Too many failed login attempts. Please retry later.', 'AUTH_RATE_LIMITED');
  }
}

function recordLoginFailure(key: string) {
  const now = Date.now();
  const current = getActiveLoginFailureRecord(key);
  const next: LoginFailureRecord = current
    ? {
        count: current.count + 1,
        firstFailedAt: current.firstFailedAt,
        lockedUntil: current.lockedUntil,
      }
    : {
        count: 1,
        firstFailedAt: now,
        lockedUntil: 0,
      };

  if (next.count >= maxLoginFailuresPerWindow) {
    next.lockedUntil = now + loginFailureWindowMs;
  }
  loginFailures.set(key, next);
  return next.lockedUntil > now ? Math.ceil((next.lockedUntil - now) / 1000) : 0;
}

function clearLoginFailures(key: string) {
  loginFailures.delete(key);
}

function getActiveLoginFailureRecord(key: string) {
  const record = loginFailures.get(key);
  if (!record) {
    return null;
  }

  const now = Date.now();
  if (now - record.firstFailedAt > loginFailureWindowMs && record.lockedUntil <= now) {
    loginFailures.delete(key);
    return null;
  }

  return record;
}

function isLoopbackAddress(value: string) {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function readJsonSetting<T>(id: string) {
  const row = readAppSetting(id);
  if (!row) {
    return null;
  }

  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

function isStoredAccount(value: unknown): value is StoredAccountSetting {
  return Boolean(
    value
      && typeof value === 'object'
      && 'username' in value
      && 'password' in value
      && typeof (value as StoredAccountSetting).username === 'string'
      && isStoredPassword((value as StoredAccountSetting).password),
  );
}

function isStoredPassword(value: unknown): value is StoredPassword {
  return Boolean(
    value
      && typeof value === 'object'
      && (value as StoredPassword).algorithm === 'scrypt'
      && typeof (value as StoredPassword).salt === 'string'
      && typeof (value as StoredPassword).key === 'string',
  );
}

function hashPassword(password: string): StoredPassword {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = crypto.scryptSync(password, salt, 32).toString('base64url');
  return {
    algorithm: 'scrypt',
    salt,
    key,
  };
}

function verifyPassword(password: string, stored: StoredPassword) {
  if (stored.algorithm !== 'scrypt') {
    return false;
  }
  const derived = crypto.scryptSync(password, stored.salt, 32).toString('base64url');
  return safeEqual(derived, stored.key);
}

function isSafeAvatarDataUrl(value: string) {
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) {
    return false;
  }

  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > avatarMaxBytes) {
    return false;
  }

  const format = match[1].toLowerCase();
  if (format === 'png') {
    return isValidPngAvatar(bytes);
  }
  if (format === 'jpeg') {
    return bytes.length >= 32
      && bytes[0] === 0xff
      && bytes[1] === 0xd8
      && bytes[2] === 0xff
      && bytes.lastIndexOf(Buffer.from([0xff, 0xd9])) >= 2;
  }
  if (format === 'webp') {
    return bytes.length >= 20
      && bytes.toString('ascii', 0, 4) === 'RIFF'
      && bytes.toString('ascii', 8, 12) === 'WEBP'
      && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16));
  }

  const gifHeader = bytes.toString('ascii', 0, 6);
  return bytes.length >= 14
    && (gifHeader === 'GIF87a' || gifHeader === 'GIF89a')
    && bytes.readUInt16LE(6) > 0
    && bytes.readUInt16LE(6) <= avatarMaxDimension
    && bytes.readUInt16LE(8) > 0
    && bytes.readUInt16LE(8) <= avatarMaxDimension
    && bytes.lastIndexOf(0x3b) >= 13;
}

function isValidPngAvatar(bytes: Buffer) {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 45 || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    return false;
  }

  let offset = pngSignature.length;
  let hasHeader = false;
  while (offset + 12 <= bytes.length) {
    const chunkLength = bytes.readUInt32BE(offset);
    const chunkType = bytes.toString('ascii', offset + 4, offset + 8);
    const nextOffset = offset + 12 + chunkLength;
    if (nextOffset > bytes.length) {
      return false;
    }
    if (!hasHeader) {
      if (chunkType !== 'IHDR' || chunkLength !== 13) {
        return false;
      }
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (width === 0 || height === 0 || width > avatarMaxDimension || height > avatarMaxDimension) {
        return false;
      }
      hasHeader = true;
    }
    if (chunkType === 'IEND') {
      return hasHeader && chunkLength === 0;
    }
    offset = nextOffset;
  }

  return false;
}

function signToken(sessionId: string, secret: string) {
  const signature = crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
  return `${sessionId}.${signature}`;
}

function verifyToken(token: string, secret: string) {
  const [sessionId, signature] = token.split('.');
  if (!sessionId || !signature) {
    return null;
  }

  const expected = crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
  return safeEqual(signature, expected) ? sessionId : null;
}

function readCookie(request: Request, name: string) {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return '';
  }

  const cookies = cookieHeader.split(';').map((part) => part.trim());
  const found = cookies.find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : '';
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
