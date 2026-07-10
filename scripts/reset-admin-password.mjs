import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const accountSettingId = 'admin-account';
const minPasswordLength = 10;

const args = parseArgs(process.argv.slice(2));
const username = String(args.username || process.env.ADMIN_USERNAME || 'admin').trim();
const password = String(args.password || process.env.COLIPAS_RESET_PASSWORD || process.env.ADMIN_PASSWORD || '');
const databasePath = resolveDatabasePath(args.db);

if (!username) {
  fail('Admin username cannot be empty.');
}

if (!isStrongPassword(password)) {
  fail(`New password must be at least ${minPasswordLength} characters and include both letters and numbers.`);
}

if (!fs.existsSync(databasePath)) {
  fail(`Database not found: ${databasePath}`);
}

const db = new DatabaseSync(databasePath);
try {
  db.exec('PRAGMA busy_timeout = 5000;');
  ensureAppSettingsTable(db);
  ensureAuthSessionsTable(db);
  const account = {
    username,
    password: hashPassword(password),
    passwordChangedAt: new Date().toISOString(),
    resetBy: 'scripts/reset-admin-password.mjs',
  };
  db.prepare(`
    INSERT INTO app_settings (id, payload, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(accountSettingId, JSON.stringify(account), account.passwordChangedAt);
  const revokedSessions = Number(
    db.prepare('DELETE FROM auth_sessions WHERE username = ?').run(username).changes,
  );
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  console.log(`ok reset CoLiPas cloud server management panel admin password for ${username} in ${databasePath}`);
  console.log(`ok revoked ${revokedSessions} persisted login session(s); the new password is effective immediately`);
} finally {
  db.close();
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      continue;
    }

    const [rawKey, inlineValue] = value.slice(2).split('=', 2);
    const key = rawKey.trim();
    result[key] = inlineValue ?? values[index + 1] ?? '';
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  return result;
}

function resolveDatabasePath(cliPath) {
  if (typeof cliPath === 'string' && cliPath.trim()) {
    return path.resolve(process.cwd(), cliPath.trim());
  }

  const configuredDatabasePath = process.env.COLIPAS_DB_PATH?.trim();
  if (configuredDatabasePath) {
    return path.resolve(process.cwd(), configuredDatabasePath);
  }

  const dataDir = process.env.COLIPAS_DATA_DIR || '.data';
  return path.resolve(process.cwd(), dataDir, 'colipas.sqlite');
}

function ensureAppSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function ensureAuthSessionsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      device_label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
}

function hashPassword(value) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = crypto.scryptSync(value, salt, 32).toString('base64url');
  return {
    algorithm: 'scrypt',
    salt,
    key,
  };
}

function isStrongPassword(value) {
  return value.length >= minPasswordLength && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

function fail(message) {
  console.error(`error ${message}`);
  process.exit(1);
}
