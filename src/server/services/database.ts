import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = process.env.COLIPAS_DATA_DIR || '.data';
const configuredDatabasePath = process.env.COLIPAS_DB_PATH?.trim();
const databasePath = path.resolve(process.cwd(), configuredDatabasePath || path.join(dataDir, 'colipas.sqlite'));
const walPath = `${databasePath}-wal`;
const maxWalBytes = 1024 * 1024;
const checkpointCheckWriteInterval = 32;
const checkpointCheckTimeIntervalMs = 1000;

let database: DatabaseSync | null = null;
type PreparedStatement = ReturnType<DatabaseSync['prepare']>;
const statementCache = new Map<string, PreparedStatement>();
let writesSinceCheckpointCheck = 0;
let lastCheckpointCheckAt = 0;

export interface StoredJsonRow {
  id: string;
  payload: string;
  updated_at?: string;
  created_at?: string;
}

export interface StoredAuthSessionRow {
  token_hash: string;
  username: string;
  device_label: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

export function getDatabasePath() {
  ensureDatabase();
  return databasePath;
}

export function loadJsonRows(table: 'servers' | 'credentials' | 'audit_entries') {
  const orderBy = table === 'audit_entries' ? 'created_at DESC' : 'id ASC';
  return prepareStatement(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() as unknown as StoredJsonRow[];
}

export function readAppSetting(id: string) {
  const row = prepareStatement('SELECT * FROM app_settings WHERE id = ?').get(id) as StoredJsonRow | undefined;
  return row ?? null;
}

export function writeAppSetting(id: string, payload: unknown) {
  const now = new Date().toISOString();
  prepareStatement(`
    INSERT INTO app_settings (id, payload, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(id, JSON.stringify(payload), now);
  checkpointDatabaseIfNeeded();
}

export function deleteAppSetting(id: string) {
  prepareStatement('DELETE FROM app_settings WHERE id = ?').run(id);
  checkpointDatabaseIfNeeded();
}

export function readAuthSessionRow(tokenHash: string) {
  const row = prepareStatement('SELECT * FROM auth_sessions WHERE token_hash = ?').get(tokenHash) as StoredAuthSessionRow | undefined;
  return row ?? null;
}

export function loadAuthSessionRows(username: string) {
  return prepareStatement(`
    SELECT * FROM auth_sessions
    WHERE username = ?
    ORDER BY created_at ASC, token_hash ASC
  `).all(username) as unknown as StoredAuthSessionRow[];
}

export function insertAuthSessionRow(session: StoredAuthSessionRow) {
  prepareStatement(`
    INSERT INTO auth_sessions (
      token_hash,
      username,
      device_label,
      created_at,
      last_seen_at,
      expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    session.token_hash,
    session.username,
    session.device_label,
    session.created_at,
    session.last_seen_at,
    session.expires_at,
  );
  checkpointDatabaseIfNeeded();
}

export function updateAuthSessionLastSeen(tokenHash: string, lastSeenAt: number) {
  const result = prepareStatement(`
    UPDATE auth_sessions
    SET last_seen_at = ?
    WHERE token_hash = ? AND last_seen_at < ?
  `).run(lastSeenAt, tokenHash, lastSeenAt);
  if (Number(result.changes) > 0) {
    checkpointDatabaseIfNeeded();
  }
}

export function deleteAuthSessionRow(tokenHash: string) {
  const result = prepareStatement('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
  if (Number(result.changes) > 0) {
    checkpointDatabaseIfNeeded();
  }
  return Number(result.changes);
}

export function deleteExpiredAuthSessionRows(now: number) {
  const result = prepareStatement('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
  if (Number(result.changes) > 0) {
    checkpointDatabaseIfNeeded();
  }
  return Number(result.changes);
}

export function deleteOtherAuthSessionRows(username: string, currentTokenHash: string) {
  const result = prepareStatement(`
    DELETE FROM auth_sessions
    WHERE username = ? AND token_hash <> ?
  `).run(username, currentTokenHash);
  if (Number(result.changes) > 0) {
    checkpointDatabaseIfNeeded();
  }
  return Number(result.changes);
}

export function retireOldestAuthSessionRows(username: string, slotsToKeep: number) {
  const countRow = prepareStatement(`
    SELECT COUNT(*) AS count
    FROM auth_sessions
    WHERE username = ?
  `).get(username) as { count: number };
  const retireCount = Math.max(0, Number(countRow.count) - Math.max(0, slotsToKeep));
  if (retireCount === 0) {
    return 0;
  }

  const result = prepareStatement(`
    DELETE FROM auth_sessions
    WHERE token_hash IN (
      SELECT token_hash
      FROM auth_sessions
      WHERE username = ?
      ORDER BY created_at ASC, token_hash ASC
      LIMIT ?
    )
  `).run(username, retireCount);
  if (Number(result.changes) > 0) {
    checkpointDatabaseIfNeeded();
  }
  return Number(result.changes);
}

export function replaceServerRows(items: Array<{ id: string }>) {
  const db = ensureDatabase();
  const now = new Date().toISOString();
  const insert = prepareStatement('INSERT INTO servers (id, payload, updated_at) VALUES (?, ?, ?)');

  db.exec('BEGIN IMMEDIATE');
  try {
    prepareStatement('DELETE FROM servers').run();
    for (const item of items) {
      insert.run(item.id, JSON.stringify(item), now);
    }
    db.exec('COMMIT');
    checkpointDatabaseIfNeeded();
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function upsertServerRow(item: { id: string }) {
  upsertJsonRow('servers', item.id, item);
}

export function upsertServerRows(items: Array<{ id: string }>) {
  if (items.length === 0) {
    return;
  }

  const db = ensureDatabase();
  const now = new Date().toISOString();
  const insert = prepareStatement(`
    INSERT INTO servers (id, payload, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of items) {
      insert.run(item.id, JSON.stringify(item), now);
    }
    db.exec('COMMIT');
    checkpointDatabaseIfNeeded();
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function deleteServerRow(id: string) {
  prepareStatement('DELETE FROM servers WHERE id = ?').run(id);
  checkpointDatabaseIfNeeded();
}

export function replaceCredentialRows(items: Record<string, unknown>) {
  const db = ensureDatabase();
  const now = new Date().toISOString();
  const insert = prepareStatement('INSERT INTO credentials (id, payload, updated_at) VALUES (?, ?, ?)');

  db.exec('BEGIN IMMEDIATE');
  try {
    prepareStatement('DELETE FROM credentials').run();
    for (const [id, credential] of Object.entries(items)) {
      insert.run(id, JSON.stringify(credential), now);
    }
    db.exec('COMMIT');
    checkpointDatabaseIfNeeded();
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function upsertCredentialRow(id: string, credential: unknown) {
  upsertJsonRow('credentials', id, credential);
}

export function deleteCredentialRow(id: string) {
  prepareStatement('DELETE FROM credentials WHERE id = ?').run(id);
  checkpointDatabaseIfNeeded();
}

export function replaceAuditRows(items: Array<{ id: string; createdAt: string }>) {
  const db = ensureDatabase();
  const insert = prepareStatement('INSERT INTO audit_entries (id, payload, created_at) VALUES (?, ?, ?)');

  db.exec('BEGIN IMMEDIATE');
  try {
    prepareStatement('DELETE FROM audit_entries').run();
    for (const item of items.slice(0, 200)) {
      insert.run(item.id, JSON.stringify(item), item.createdAt);
    }
    db.exec('COMMIT');
    checkpointDatabaseIfNeeded();
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function insertAuditRow(item: { id: string; createdAt: string }) {
  prepareStatement(`
    INSERT OR REPLACE INTO audit_entries (id, payload, created_at)
    VALUES (?, ?, ?)
  `).run(item.id, JSON.stringify(item), item.createdAt);
  prepareStatement(`
    DELETE FROM audit_entries
    WHERE id NOT IN (
      SELECT id FROM audit_entries
      ORDER BY created_at DESC
      LIMIT 200
    )
  `).run();
  checkpointDatabaseIfNeeded();
}

export function isTableEmpty(table: 'servers' | 'credentials' | 'audit_entries') {
  const row = prepareStatement(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count === 0;
}

export function checkpointDatabase() {
  ensureDatabase().exec('PRAGMA wal_checkpoint(TRUNCATE);');
}

function checkpointDatabaseIfNeeded() {
  writesSinceCheckpointCheck += 1;
  const now = Date.now();
  if (
    writesSinceCheckpointCheck < checkpointCheckWriteInterval
    && now - lastCheckpointCheckAt < checkpointCheckTimeIntervalMs
  ) {
    return;
  }

  writesSinceCheckpointCheck = 0;
  lastCheckpointCheckAt = now;

  try {
    if (fs.existsSync(walPath) && fs.statSync(walPath).size > maxWalBytes) {
      checkpointDatabase();
    }
  } catch {
    // Keep writes successful if checkpointing is temporarily blocked by another reader.
  }
}

function upsertJsonRow(table: 'servers' | 'credentials', id: string, payload: unknown) {
  const now = new Date().toISOString();
  prepareStatement(`
    INSERT INTO ${table} (id, payload, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(id, JSON.stringify(payload), now);
  checkpointDatabaseIfNeeded();
}

function prepareStatement(sql: string) {
  let statement = statementCache.get(sql);
  if (!statement) {
    statement = ensureDatabase().prepare(sql);
    statementCache.set(sql, statement);
  }
  return statement;
}

function ensureDatabase() {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA wal_autocheckpoint = 200;
    PRAGMA journal_size_limit = 1048576;

    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_entries (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      device_label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_entries_created_at ON audit_entries(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_username_created_at ON auth_sessions(username, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);
  `);

  return database;
}
