import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { RuntimeConfig } from '../config.js';
import { HttpError } from '../httpErrors.js';
import { readAppSetting, writeAppSetting } from './database.js';

const avatarMaxBytes = 2 * 1024 * 1024;
const avatarMaxDataUrlLength = Math.ceil(avatarMaxBytes * 4 / 3) + 64;

const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(32),
  avatarText: z.string().trim().min(1).max(4).regex(/^[\p{L}\p{N}]+$/u, '头像只能包含字母或数字'),
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
  id: string;
  username: string;
  createdAt: number;
  expiresAt: number;
}

interface LoginFailureRecord {
  count: number;
  firstFailedAt: number;
  lockedUntil: number;
}

const sessions = new Map<string, SessionRecord>();
const loginFailures = new Map<string, LoginFailureRecord>();
const legacyDefaultDisplayName = 'CoLiPas';
const fallbackProfile: ConsoleProfile = {
  displayName: 'CoLiPas云服务器管理面板',
  avatarText: 'CP',
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
  const session: SessionRecord = {
    id: crypto.randomBytes(32).toString('hex'),
    username: parsed.username,
    createdAt: now,
    expiresAt: now + config.auth.sessionTtlMs,
  };

  sessions.set(session.id, session);
  clearLoginFailures(limiterKey);
  setSessionCookie(response, session, config);

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

export function logout(request: Request, response: Response) {
  const token = readCookie(request, cookieName);
  const sessionId = token ? readSessionId(token) : null;
  if (sessionId) {
    sessions.delete(sessionId);
  }
  clearSessionCookie(response);
  return { authenticated: false };
}

export function getCurrentSession(request: Request, config: RuntimeConfig) {
  const token = readCookie(request, cookieName);
  const sessionId = token ? verifyToken(token, config.auth.sessionSecret) : null;
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);
  const now = Date.now();
  if (!session || session.expiresAt <= now) {
    sessions.delete(sessionId);
    return null;
  }

  return buildSessionPayload(session, now);
}

export function getConsoleProfile() {
  const stored = readJsonSetting<ConsoleProfile>(profileSettingId);
  if (!stored) {
    return fallbackProfile;
  }
  if (stored.displayName === legacyDefaultDisplayName && stored.avatarText === fallbackProfile.avatarText && !stored.avatarImage) {
    return fallbackProfile;
  }
  return stored;
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

export function changeAdminPassword(input: unknown, request: Request, config: RuntimeConfig) {
  const session = requireSession(request, config);
  const sessionId = requireSessionId(request, config);
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
  clearOtherSessions(sessionId);
  return {
    ok: true,
    changedAt: nextAccount.passwordChangedAt,
  };
}

export function requireSession(request: Request, config: RuntimeConfig) {
  const session = getCurrentSession(request, config);
  if (!session) {
    throw new HttpError(401, '登录已失效，请重新登录', 'AUTH_REQUIRED');
  }
  return session;
}

export function buildAccountPayload(request: Request, config: RuntimeConfig) {
  const session = requireSession(request, config);
  return {
    session,
    profile: getConsoleProfile(),
  };
}

function setSessionCookie(response: Response, session: SessionRecord, config: RuntimeConfig) {
  const token = signToken(session.id, config.auth.sessionSecret);
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

function requireSessionId(request: Request, config: RuntimeConfig) {
  const token = readCookie(request, cookieName);
  const sessionId = token ? verifyToken(token, config.auth.sessionSecret) : null;
  if (!sessionId || !sessions.has(sessionId)) {
    throw new HttpError(401, '登录已失效，请重新登录', 'AUTH_REQUIRED');
  }
  return sessionId;
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

function clearOtherSessions(sessionId: string) {
  for (const id of sessions.keys()) {
    if (id !== sessionId) {
      sessions.delete(id);
    }
  }
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

  return Buffer.byteLength(match[2], 'base64') <= avatarMaxBytes;
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

function readSessionId(token: string) {
  return token.split('.')[0] || null;
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
