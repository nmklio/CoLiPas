export const sshTerminalSupportSnapshotStorageKey = 'colipas.sshTerminalSupportSnapshot.v1';
export const sshTerminalSupportSnapshotHistoryStorageKey = 'colipas.sshTerminalSupportSnapshotHistory.v1';
export const sshTerminalSupportSnapshotEventName = 'colipas:ssh-terminal-support-snapshot';

export type SshTerminalSupportSnapshotTone = 'pending' | 'good' | 'warn' | 'slow';

export interface SshTerminalSupportSnapshotSection {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone: SshTerminalSupportSnapshotTone;
}

export interface SshTerminalSupportSnapshot {
  version: 1;
  source: 'terminal-copy';
  createdAt: string;
  tone: SshTerminalSupportSnapshotTone;
  title: string;
  detail: string;
  sections: SshTerminalSupportSnapshotSection[];
  text: string;
}

const validSnapshotTones = new Set<SshTerminalSupportSnapshotTone>(['pending', 'good', 'warn', 'slow']);
const maxSnapshotSections = 8;
const maxSnapshotHistory = 6;

export function sanitizeSshTerminalSupportSnapshotText(value: string, maxLength = 6000) {
  return String(value || '')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-host]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-api-key]')
    .replace(/\b(?:password|passwd|pwd|passphrase|api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, (match) => {
      const separator = match.includes(':') ? ':' : '=';
      return `${match.split(separator)[0]}${separator} [redacted]`;
    })
    .slice(0, maxLength);
}

export function normalizeSshTerminalSupportSnapshot(value: unknown): SshTerminalSupportSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const snapshot = value as Partial<SshTerminalSupportSnapshot>;
  if (
    snapshot.version !== 1
    || snapshot.source !== 'terminal-copy'
    || typeof snapshot.createdAt !== 'string'
    || Number.isNaN(Date.parse(snapshot.createdAt))
    || !validSnapshotTones.has(snapshot.tone as SshTerminalSupportSnapshotTone)
    || typeof snapshot.title !== 'string'
    || typeof snapshot.detail !== 'string'
    || !Array.isArray(snapshot.sections)
    || typeof snapshot.text !== 'string'
  ) {
    return null;
  }

  const sections = snapshot.sections
    .slice(0, maxSnapshotSections)
    .map((section) => normalizeSshTerminalSupportSnapshotSection(section))
    .filter((section): section is SshTerminalSupportSnapshotSection => Boolean(section));
  if (sections.length === 0) {
    return null;
  }

  return {
    version: 1,
    source: 'terminal-copy',
    createdAt: snapshot.createdAt,
    tone: snapshot.tone as SshTerminalSupportSnapshotTone,
    title: sanitizeSshTerminalSupportSnapshotText(snapshot.title, 120),
    detail: sanitizeSshTerminalSupportSnapshotText(snapshot.detail, 240),
    sections,
    text: sanitizeSshTerminalSupportSnapshotText(snapshot.text, 6000),
  };
}

export function normalizeSshTerminalSupportSnapshotHistory(value: unknown, limit = maxSnapshotHistory): SshTerminalSupportSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const boundedLimit = Math.max(1, Math.min(maxSnapshotHistory, Math.floor(limit)));
  return value
    .map((item) => normalizeSshTerminalSupportSnapshot(item))
    .filter((item): item is SshTerminalSupportSnapshot => Boolean(item))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .filter((item, index, list) => list.findIndex((candidate) => candidate.createdAt === item.createdAt || candidate.text === item.text) === index)
    .slice(0, boundedLimit);
}

export function addSshTerminalSupportSnapshotToHistory(
  snapshot: SshTerminalSupportSnapshot,
  history: unknown,
  limit = maxSnapshotHistory,
) {
  return normalizeSshTerminalSupportSnapshotHistory([snapshot, ...normalizeSshTerminalSupportSnapshotHistory(history, limit)], limit);
}

function normalizeSshTerminalSupportSnapshotSection(value: unknown): SshTerminalSupportSnapshotSection | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const section = value as Partial<SshTerminalSupportSnapshotSection>;
  if (
    typeof section.id !== 'string'
    || typeof section.label !== 'string'
    || typeof section.value !== 'string'
    || typeof section.detail !== 'string'
    || !validSnapshotTones.has(section.tone as SshTerminalSupportSnapshotTone)
  ) {
    return null;
  }

  return {
    id: sanitizeSshTerminalSupportSnapshotText(section.id, 48),
    label: sanitizeSshTerminalSupportSnapshotText(section.label, 80),
    value: sanitizeSshTerminalSupportSnapshotText(section.value, 120),
    detail: sanitizeSshTerminalSupportSnapshotText(section.detail, 240),
    tone: section.tone as SshTerminalSupportSnapshotTone,
  };
}
