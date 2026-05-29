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

    CREATE INDEX IF NOT EXISTS idx_audit_entries_created_at ON audit_entries(created_at DESC);
  `);

  return database;
}
