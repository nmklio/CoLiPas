import type { BulkImportServerPayload } from '../../services/apiClient';
import type { ServerNode } from '../../types';

export const serverBulkImportLimit = 500;
export const serverBulkImportMaxBytes = 2 * 1024 * 1024;

export type ServerBulkImportFormat = 'csv' | 'json' | 'unknown';
export type ServerBulkImportGlobalIssue =
  | 'empty'
  | 'too-large'
  | 'invalid-json'
  | 'invalid-shape'
  | 'missing-columns'
  | 'sensitive-columns'
  | 'too-many-rows';
export type ServerBulkImportRowIssue =
  | 'name'
  | 'provider'
  | 'public-ip'
  | 'private-ip'
  | 'region'
  | 'os'
  | 'tags'
  | 'duplicate-name'
  | 'duplicate-public-ip';

export interface ServerBulkImportRow extends BulkImportServerPayload {
  rowNumber: number;
  issues: ServerBulkImportRowIssue[];
}

export interface ServerBulkImportPreview {
  format: ServerBulkImportFormat;
  rows: ServerBulkImportRow[];
  importable: BulkImportServerPayload[];
  globalIssues: ServerBulkImportGlobalIssue[];
  summary: {
    total: number;
    valid: number;
    invalid: number;
    duplicates: number;
  };
}

export interface ServerBulkImportReportLabels {
  ready: string;
  formatIssues: (issues: ServerBulkImportRowIssue[]) => string;
}

const fieldAliases: Record<keyof BulkImportServerPayload, string[]> = {
  name: ['name', 'servername', 'server', 'assetname', '名称', '服务器名称', '資産名', 'サーバー名'],
  provider: ['provider', 'vendor', 'cloudprovider', '厂商', '云厂商', 'プロバイダー'],
  region: ['region', 'location', '地域', '地区', 'リージョン'],
  publicIp: ['publicip', 'publicaddress', 'ip', '公网ip', '公開ip'],
  privateIp: ['privateip', 'privateaddress', '内网ip', 'プライベートip'],
  os: ['os', 'operatingsystem', 'system', '系统', '操作系统'],
  tags: ['tags', 'tag', 'labels', '标签', 'タグ'],
};
const requiredFields: Array<keyof BulkImportServerPayload> = ['name', 'provider', 'publicIp'];
const sensitiveKeyPattern = /(?:password|passwd|passphrase|private.?key|api.?key|token|secret|credential|ssh.?key)/i;
const sshCredentialKeyPattern = /^(?:ssh|sshhost|sshport|sshuser|sshusername|sshauth|sshauthtype|username|loginuser|authtype)$/i;

export function buildServerBulkImportPreview(source: string, existingServers: ServerNode[]): ServerBulkImportPreview {
  const trimmed = source.trim();
  if (!trimmed) {
    return emptyPreview('unknown', ['empty']);
  }
  if (new TextEncoder().encode(source).byteLength > serverBulkImportMaxBytes) {
    return emptyPreview('unknown', ['too-large']);
  }

  const format: ServerBulkImportFormat = trimmed.startsWith('[') || trimmed.startsWith('{') ? 'json' : 'csv';
  const parsed = format === 'json' ? parseJsonRows(trimmed) : parseCsvRows(trimmed);
  if (parsed.globalIssues.length > 0) {
    return emptyPreview(format, parsed.globalIssues);
  }
  if (parsed.items.length > serverBulkImportLimit) {
    return emptyPreview(format, ['too-many-rows']);
  }

  const existingNames = new Set(existingServers.map((server) => normalizeIdentity(server.name)));
  const existingPublicIps = new Set(existingServers.map((server) => server.publicIp.trim()).filter(Boolean));
  const batchNames = new Set<string>();
  const batchPublicIps = new Set<string>();
  const rows = parsed.items.map((item, index) => {
    const normalized = normalizeDraft(item, index + 1);
    const normalizedName = normalizeIdentity(normalized.name);
    const duplicateName = Boolean(normalizedName) && (existingNames.has(normalizedName) || batchNames.has(normalizedName));
    const duplicatePublicIp = Boolean(normalized.publicIp) && (existingPublicIps.has(normalized.publicIp) || batchPublicIps.has(normalized.publicIp));
    const issues = validateDraft(normalized);
    if (duplicateName) {
      issues.push('duplicate-name');
    } else if (normalizedName) {
      batchNames.add(normalizedName);
    }
    if (duplicatePublicIp) {
      issues.push('duplicate-public-ip');
    } else if (normalized.publicIp) {
      batchPublicIps.add(normalized.publicIp);
    }
    return {
      ...normalized,
      issues: Array.from(new Set(issues)),
    };
  });
  const duplicateIssueSet = new Set<ServerBulkImportRowIssue>(['duplicate-name', 'duplicate-public-ip']);
  const duplicates = rows.filter((row) => row.issues.some((issue) => duplicateIssueSet.has(issue))).length;
  const validRows = rows.filter((row) => row.issues.length === 0);

  return {
    format,
    rows,
    importable: validRows.map(stripPreviewFields),
    globalIssues: [],
    summary: {
      total: rows.length,
      valid: validRows.length,
      invalid: rows.length - validRows.length - duplicates,
      duplicates,
    },
  };
}

export function buildServerBulkImportTemplate() {
  return [
    'name,provider,publicIp,privateIp,region,os,tags',
    'prod-api-01,Example Cloud,203.0.113.10,10.0.0.10,US - California,Ubuntu 24.04,prod|api',
    'prod-db-01,Example Cloud,203.0.113.11,10.0.0.11,US - California,Debian 13,prod|database',
  ].join('\n');
}

export function buildServerBulkImportValidationReport(
  preview: ServerBulkImportPreview,
  labels: ServerBulkImportReportLabels,
) {
  const rows = preview.rows.map((row) => [
    row.rowNumber,
    row.name,
    row.provider,
    row.publicIp,
    row.privateIp,
    row.region,
    row.os,
    row.tags.join('|'),
    row.issues.length === 0 ? labels.ready : labels.formatIssues(row.issues),
  ]);
  return `\uFEFF${[
    ['row', 'name', 'provider', 'publicIp', 'privateIp', 'region', 'os', 'tags', 'status'],
    ...rows,
  ].map((row) => row.map(escapeSpreadsheetCsvCell).join(',')).join('\r\n')}`;
}

function parseJsonRows(source: string) {
  try {
    const parsed = JSON.parse(source) as unknown;
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
        ? (parsed as { items: unknown[] }).items
        : null;
    if (!items) {
      return { items: [], globalIssues: ['invalid-shape'] as ServerBulkImportGlobalIssue[] };
    }
    if (items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
      return { items: [], globalIssues: ['invalid-shape'] as ServerBulkImportGlobalIssue[] };
    }
    const sensitive = items.some((item) => Object.keys(item as Record<string, unknown>).some(isSensitiveFieldName));
    if (sensitive) {
      return { items: [], globalIssues: ['sensitive-columns'] as ServerBulkImportGlobalIssue[] };
    }
    return {
      items: items.map((item) => mapObjectFields(item as Record<string, unknown>)),
      globalIssues: [] as ServerBulkImportGlobalIssue[],
    };
  } catch {
    return { items: [], globalIssues: ['invalid-json'] as ServerBulkImportGlobalIssue[] };
  }
}

function parseCsvRows(source: string) {
  const matrix = parseCsv(source);
  if (matrix.length < 2) {
    return { items: [], globalIssues: ['invalid-shape'] as ServerBulkImportGlobalIssue[] };
  }
  const headers = matrix[0].map(normalizeHeader);
  if (headers.some(isSensitiveFieldName)) {
    return { items: [], globalIssues: ['sensitive-columns'] as ServerBulkImportGlobalIssue[] };
  }
  const headerIndexes = buildHeaderIndexes(headers);
  if (requiredFields.some((field) => headerIndexes[field] === undefined)) {
    return { items: [], globalIssues: ['missing-columns'] as ServerBulkImportGlobalIssue[] };
  }
  const items = matrix
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim()))
    .map((row) => mapCsvRow(row, headerIndexes));
  return { items, globalIssues: [] as ServerBulkImportGlobalIssue[] };
}

function parseCsv(source: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === ',' && !quoted) {
      row.push(value);
      value = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') {
        index += 1;
      }
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      continue;
    }
    value += char;
  }
  if (quoted) {
    return [];
  }
  row.push(value);
  if (row.some((cell) => cell.length > 0) || rows.length === 0) {
    rows.push(row);
  }
  if (rows[0]?.[0]) {
    rows[0][0] = rows[0][0].replace(/^\uFEFF/, '');
  }
  return rows;
}

function buildHeaderIndexes(headers: string[]) {
  const result: Partial<Record<keyof BulkImportServerPayload, number>> = {};
  for (const field of Object.keys(fieldAliases) as Array<keyof BulkImportServerPayload>) {
    const index = headers.findIndex((header) => fieldAliases[field].some((alias) => normalizeHeader(alias) === header));
    if (index >= 0) {
      result[field] = index;
    }
  }
  return result;
}

function mapCsvRow(row: string[], indexes: Partial<Record<keyof BulkImportServerPayload, number>>) {
  const read = (field: keyof BulkImportServerPayload) => {
    const index = indexes[field];
    return index === undefined ? '' : row[index] ?? '';
  };
  return {
    name: read('name'),
    provider: read('provider'),
    region: read('region'),
    publicIp: read('publicIp'),
    privateIp: read('privateIp'),
    os: read('os'),
    tags: read('tags'),
  };
}

function mapObjectFields(item: Record<string, unknown>) {
  const normalizedEntries = new Map(Object.entries(item).map(([key, value]) => [normalizeHeader(key), value]));
  const read = (field: keyof BulkImportServerPayload) => {
    for (const alias of fieldAliases[field]) {
      const value = normalizedEntries.get(normalizeHeader(alias));
      if (value !== undefined) {
        return value;
      }
    }
    return '';
  };
  return {
    name: read('name'),
    provider: read('provider'),
    region: read('region'),
    publicIp: read('publicIp'),
    privateIp: read('privateIp'),
    os: read('os'),
    tags: read('tags'),
  };
}

function normalizeDraft(item: Record<string, unknown>, rowNumber: number): Omit<ServerBulkImportRow, 'issues'> {
  return {
    rowNumber,
    name: normalizeText(item.name),
    provider: normalizeText(item.provider),
    publicIp: normalizeText(item.publicIp),
    privateIp: normalizeText(item.privateIp),
    region: normalizeText(item.region),
    os: normalizeText(item.os),
    tags: normalizeTags(item.tags),
  };
}

function validateDraft(item: Omit<ServerBulkImportRow, 'issues'>) {
  const issues: ServerBulkImportRowIssue[] = [];
  if (item.name.length < 2 || item.name.length > 80) {
    issues.push('name');
  }
  if (!item.provider || item.provider.length > 80) {
    issues.push('provider');
  }
  if (!isValidIp(item.publicIp)) {
    issues.push('public-ip');
  }
  if (item.privateIp && !isValidIp(item.privateIp)) {
    issues.push('private-ip');
  }
  if (item.region.length > 80) {
    issues.push('region');
  }
  if (item.os.length > 120) {
    issues.push('os');
  }
  if (item.tags.length > 8 || item.tags.some((tag) => tag.length < 1 || tag.length > 24)) {
    issues.push('tags');
  }
  return issues;
}

function normalizeTags(value: unknown) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[|;,]/) : [];
  return Array.from(new Set(source.map((tag) => normalizeText(tag)).filter(Boolean)));
}

function normalizeText(value: unknown) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim().replace(/\s+/g, ' ')
    : '';
}

function normalizeHeader(value: string) {
  return value.trim().toLocaleLowerCase('en-US').replace(/[\s_-]+/g, '');
}

function isSensitiveFieldName(value: string) {
  const normalized = normalizeHeader(value);
  return sensitiveKeyPattern.test(value) || sensitiveKeyPattern.test(normalized) || sshCredentialKeyPattern.test(normalized);
}

function normalizeIdentity(value: string) {
  return value.trim().toLocaleLowerCase('en-US');
}

function escapeSpreadsheetCsvCell(value: string | number) {
  let normalized = String(value).replace(/\r\n?/g, '\n');
  if (/^[=+\-@]/.test(normalized)) {
    normalized = `'${normalized}`;
  }
  return /[",\n]/.test(normalized)
    ? `"${normalized.replaceAll('"', '""')}"`
    : normalized;
}

function isValidIp(value: string) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255 && String(Number(part)) === part);
  }
  if (value.includes(':') && /^[0-9a-f:]+$/i.test(value)) {
    try {
      const parsed = new URL(`http://[${value}]/`);
      return Boolean(parsed.hostname);
    } catch {
      return false;
    }
  }
  return false;
}

function stripPreviewFields(row: ServerBulkImportRow): BulkImportServerPayload {
  return {
    name: row.name,
    provider: row.provider,
    region: row.region,
    publicIp: row.publicIp,
    privateIp: row.privateIp,
    os: row.os,
    tags: row.tags,
  };
}

function emptyPreview(format: ServerBulkImportFormat, globalIssues: ServerBulkImportGlobalIssue[]): ServerBulkImportPreview {
  return {
    format,
    rows: [],
    importable: [],
    globalIssues,
    summary: {
      total: 0,
      valid: 0,
      invalid: 0,
      duplicates: 0,
    },
  };
}
