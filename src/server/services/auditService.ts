import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { operationEvents } from '../../data/mockData.js';
import { insertAuditRow, isTableEmpty, loadJsonRows, replaceAuditRows } from './database.js';

export type AuditAction =
  | 'HEALTH_CHECK'
  | 'AUTH_LOGIN'
  | 'AUTH_LOGOUT'
  | 'AUTH_PASSWORD_CHANGE'
  | 'PROFILE_UPDATE'
  | 'AI_ANALYZE'
  | 'AI_PROVIDER_SAVE'
  | 'AI_TEST'
  | 'CUSTOM_API_TEST'
  | 'SERVER_CONNECT'
  | 'SERVER_UPDATE'
  | 'SERVER_DELETE'
  | 'SERVER_IDENTITY_INSPECT'
  | 'SERVER_SSH_VERIFY'
  | 'SERVER_SSH_DIAGNOSTIC'
  | 'SERVER_SSH_COMMAND'
  | 'SSH_RUNBOOK_CREATE'
  | 'SSH_RUNBOOK_IMPORT'
  | 'SSH_RUNBOOK_UPDATE'
  | 'SSH_RUNBOOK_REORDER'
  | 'SSH_RUNBOOK_DELETE'
  | 'SSH_SUPPORT_TICKET_COPY'
  | 'SERVER_ACTION'
  | 'OPERATIONS_PREFLIGHT'
  | 'OPERATIONS_TASK'
  | 'SECURITY_REMEDIATION'
  | 'CLOUD_SYNC';

export interface AuditEntry {
  id: string;
  action: AuditAction;
  actor: string;
  target: string;
  status: 'success' | 'blocked' | 'failed';
  detail: string;
  createdAt: string;
  correlationId?: string;
}

const dataDir = process.env.COLIPAS_DATA_DIR || '.data';
const auditPath = path.resolve(process.cwd(), dataDir, 'audit.json');

const auditEntries: AuditEntry[] = [
  {
    id: 'audit-1001',
    action: 'CLOUD_SYNC',
    actor: 'system',
    target: 'all-cloud-accounts',
    status: 'success',
    detail: 'Mock asset sync completed',
    createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
  },
];

const remediationSchema = z.object({
  type: z.enum(['acknowledgeCheck', 'acknowledgeAuditFailures', 'closeOpenEvents', 'reviewRuntime']),
  target: z.string().trim().min(1).max(120),
  note: z.string().trim().max(400).optional().default(''),
});

export function recordAudit(entry: Omit<AuditEntry, 'id' | 'createdAt'>) {
  const auditEntry: AuditEntry = {
    ...entry,
    id: `audit-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
  auditEntries.unshift(auditEntry);
  auditEntries.splice(200);
  persistAuditEntries();
  return auditEntry;
}

export function listAuditEntries() {
  return auditEntries;
}

export function remediateSecurityRisk(input: unknown, actor: string) {
  const parsed = remediationSchema.parse(input);
  const openEvents = operationEvents.filter((event) => event.status === 'open');
  let detail = '';

  if (parsed.type === 'closeOpenEvents') {
    for (const event of openEvents) {
      event.status = 'closed';
    }
    detail = `Closed ${openEvents.length} open security event(s)${parsed.note ? `: ${parsed.note}` : ''}`;
  } else if (parsed.type === 'acknowledgeAuditFailures') {
    const unresolved = auditEntries.filter((entry) => entry.action !== 'SECURITY_REMEDIATION' && (entry.status === 'blocked' || entry.status === 'failed')).length;
    detail = `Reviewed ${unresolved} blocked/failed audit item(s)${parsed.note ? `: ${parsed.note}` : ''}`;
  } else if (parsed.type === 'reviewRuntime') {
    detail = `Runtime security posture reviewed${parsed.note ? `: ${parsed.note}` : ''}`;
  } else {
    detail = `Security check reviewed${parsed.note ? `: ${parsed.note}` : ''}`;
  }

  const audit = recordAudit({
    action: 'SECURITY_REMEDIATION',
    actor,
    target: parsed.target,
    status: 'success',
    detail,
  });

  return {
    ok: true,
    type: parsed.type,
    target: parsed.target,
    affected: parsed.type === 'closeOpenEvents' ? openEvents.length : 1,
    audit,
  };
}

loadPersistedAuditEntries();

function loadPersistedAuditEntries() {
  try {
    if (isTableEmpty('audit_entries') && fs.existsSync(auditPath)) {
      const raw = JSON.parse(fs.readFileSync(auditPath, 'utf8')) as { items?: AuditEntry[] };
      if (Array.isArray(raw.items)) {
        replaceAuditRows(raw.items);
      }
    }

    const rows = loadJsonRows('audit_entries');
    auditEntries.splice(0, auditEntries.length, ...rows.map((row) => JSON.parse(row.payload) as AuditEntry).slice(0, 200));
  } catch {
    // Keep the in-memory seed if the local audit store is unreadable.
  }
}

function persistAuditEntries() {
  const [latestEntry] = auditEntries;
  if (latestEntry) {
    insertAuditRow(latestEntry);
  }
}
