import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { RuntimeConfig } from '../config.js';
import { HttpError } from '../httpErrors.js';
import { readAppSetting, writeAppSetting } from './database.js';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(32),
  avatarText: z.string().trim().min(1).max(4).regex(/^[\p{L}\p{N}]+$/u, '头像只能包含字母或数字'),
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
}

interface SessionRecord {
  id: string;
  username: string;
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, SessionRecord>();
const fallbackProfile: ConsoleProfile = {
  displayName: 'CoLiPas',
  avatarText: 'CP',
};

export function getSessionCookieName() {
  return cookieName;
}

export function login(input: unknown, response: Response, config: RuntimeConfig) {
  const parsed = loginSchema.parse(input);
  const account = getStoredAccount(config);
  if (!safeEqual(parsed.username, account.username) || !verifyPassword(parsed.password, account.password)) {
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
  setSessionCookie(response, session, config);

  return buildSessionPayload(session, now);
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
  return readJsonSetting<ConsoleProfile>(profileSettingId) ?? fallbackProfile;
}

export function updateConsoleProfile(input: unknown) {
  const parsed = profileSchema.parse(input);
  const profile: ConsoleProfile = {
    displayName: parsed.displayName,
    avatarText: parsed.avatarText.toUpperCase(),
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
    secure: config.nodeEnv === 'production' && process.env.COLIPAS_SECURE_COOKIES === '1',
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
