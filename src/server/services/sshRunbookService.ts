import { randomUUID } from 'node:crypto';
import { HttpError } from '../httpErrors.js';
import type { SshRunbookCommand } from '../../types.js';
import { readAppSetting, writeAppSetting } from './database.js';
import { redactSensitiveText } from './sensitiveRedaction.js';

const settingId = 'ssh_runbook_commands.v1';
const maxCommands = 20;
const maxTitleLength = 48;
const maxCommandLength = 360;

export interface SshRunbookCommandPayload {
  title?: unknown;
  command?: unknown;
}

export interface SshRunbookReorderPayload {
  commandIds?: unknown;
}

export interface SshRunbookImportPayload {
  commands?: unknown;
}

export interface SshRunbookImportResult {
  commands: SshRunbookCommand[];
  imported: SshRunbookCommand[];
  skipped: string[];
}

export function listSshRunbookCommands() {
  return readRunbookCommands();
}

export function createSshRunbookCommand(payload: SshRunbookCommandPayload) {
  const input = normalizePayload(payload);
  const commands = readRunbookCommands();
  if (commands.length >= maxCommands) {
    throw new HttpError(400, `SSH runbook command limit reached (${maxCommands})`, 'SSH_RUNBOOK_LIMIT_REACHED');
  }
  ensureUniqueTitle(commands, input.title);
  const now = new Date().toISOString();
  const command: SshRunbookCommand = {
    id: randomUUID(),
    title: input.title,
    command: input.command,
    createdAt: now,
    updatedAt: now,
  };
  writeRunbookCommands([command, ...commands]);
  return command;
}

export function updateSshRunbookCommand(commandId: string, payload: SshRunbookCommandPayload) {
  const input = normalizePayload(payload);
  const commands = readRunbookCommands();
  const index = commands.findIndex((item) => item.id === commandId);
  if (index === -1) {
    throw new HttpError(404, 'SSH runbook command was not found', 'SSH_RUNBOOK_COMMAND_NOT_FOUND');
  }
  ensureUniqueTitle(commands.filter((item) => item.id !== commandId), input.title);
  const updated: SshRunbookCommand = {
    ...commands[index],
    title: input.title,
    command: input.command,
    updatedAt: new Date().toISOString(),
  };
  const next = commands.slice();
  next[index] = updated;
  writeRunbookCommands(next);
  return updated;
}

export function deleteSshRunbookCommand(commandId: string) {
  const commands = readRunbookCommands();
  const next = commands.filter((item) => item.id !== commandId);
  if (next.length === commands.length) {
    throw new HttpError(404, 'SSH runbook command was not found', 'SSH_RUNBOOK_COMMAND_NOT_FOUND');
  }
  writeRunbookCommands(next);
  return { ok: true, id: commandId };
}

export function importSshRunbookCommands(payload: SshRunbookImportPayload): SshRunbookImportResult {
  const inputCommands = normalizeImportCommands(payload?.commands);
  const commands = readRunbookCommands();
  const usedTitles = new Set(commands.map((item) => item.title.toLowerCase()));
  const batchTitles = new Set<string>();
  const skipped: string[] = [];
  const candidates: Array<{ title: string; command: string }> = [];

  for (const input of inputCommands) {
    const titleKey = input.title.toLowerCase();
    if (usedTitles.has(titleKey) || batchTitles.has(titleKey)) {
      skipped.push(input.title);
      continue;
    }
    batchTitles.add(titleKey);
    candidates.push(input);
  }

  const available = maxCommands - commands.length;
  if (available <= 0 && candidates.length > 0) {
    throw new HttpError(400, `SSH runbook command limit reached (${maxCommands})`, 'SSH_RUNBOOK_LIMIT_REACHED');
  }

  const selected = candidates.slice(0, Math.max(available, 0));
  skipped.push(...candidates.slice(selected.length).map((item) => item.title));
  const now = new Date().toISOString();
  const imported = selected.map((input): SshRunbookCommand => ({
    id: randomUUID(),
    title: input.title,
    command: input.command,
    createdAt: now,
    updatedAt: now,
  }));
  const next = [...imported, ...commands].slice(0, maxCommands);
  if (imported.length > 0) {
    writeRunbookCommands(next);
  }
  return { commands: next, imported, skipped };
}

export function reorderSshRunbookCommands(payload: SshRunbookReorderPayload) {
  const requestedIds = normalizeCommandIds(payload?.commandIds);
  const commands = readRunbookCommands();
  const byId = new Map(commands.map((item) => [item.id, item]));
  const reordered: SshRunbookCommand[] = [];

  for (const commandId of requestedIds) {
    const command = byId.get(commandId);
    if (!command) {
      throw new HttpError(404, 'SSH runbook command was not found', 'SSH_RUNBOOK_COMMAND_NOT_FOUND');
    }
    reordered.push(command);
  }

  const requested = new Set(requestedIds);
  const next = [
    ...reordered,
    ...commands.filter((item) => !requested.has(item.id)),
  ].slice(0, maxCommands);
  writeRunbookCommands(next);
  return next;
}

function normalizePayload(payload: SshRunbookCommandPayload) {
  const title = typeof payload?.title === 'string' ? payload.title.trim().replace(/\s+/g, ' ') : '';
  const command = typeof payload?.command === 'string' ? payload.command.trim() : '';
  if (!title || title.length > maxTitleLength) {
    throw new HttpError(400, `Title must be 1-${maxTitleLength} characters`, 'SSH_RUNBOOK_TITLE_INVALID');
  }
  if (!command || command.length > maxCommandLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(command)) {
    throw new HttpError(400, `Command must be 1-${maxCommandLength} printable characters`, 'SSH_RUNBOOK_COMMAND_INVALID');
  }
  if (redactSensitiveText(`${title}\n${command}`) !== `${title}\n${command}`) {
    throw new HttpError(400, 'Command appears to contain sensitive material', 'SSH_RUNBOOK_COMMAND_SENSITIVE');
  }
  return { title, command };
}

function normalizeCommandIds(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxCommands) {
    throw new HttpError(400, `Command order must include 1-${maxCommands} command ids`, 'SSH_RUNBOOK_ORDER_INVALID');
  }
  const commandIds = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  if (commandIds.length !== value.length || new Set(commandIds).size !== commandIds.length) {
    throw new HttpError(400, 'Command order must contain unique command ids', 'SSH_RUNBOOK_ORDER_INVALID');
  }
  return commandIds;
}

function normalizeImportCommands(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new HttpError(400, 'Runbook import must include 1-8 commands', 'SSH_RUNBOOK_IMPORT_INVALID');
  }
  return value.map((item) => normalizePayload(item as SshRunbookCommandPayload));
}

function ensureUniqueTitle(commands: SshRunbookCommand[], title: string) {
  if (commands.some((item) => item.title.toLowerCase() === title.toLowerCase())) {
    throw new HttpError(409, 'A runbook command with this title already exists', 'SSH_RUNBOOK_TITLE_EXISTS');
  }
}

function readRunbookCommands(): SshRunbookCommand[] {
  const row = readAppSetting(settingId);
  if (!row) {
    return [];
  }
  try {
    const parsed = JSON.parse(row.payload);
    if (!Array.isArray(parsed?.commands)) {
      return [];
    }
    return parsed.commands.filter(isSshRunbookCommand).slice(0, maxCommands);
  } catch {
    return [];
  }
}

function writeRunbookCommands(commands: SshRunbookCommand[]) {
  writeAppSetting(settingId, {
    version: 1,
    commands: commands.slice(0, maxCommands),
  });
}

function isSshRunbookCommand(value: unknown): value is SshRunbookCommand {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as SshRunbookCommand;
  return typeof item.id === 'string'
    && typeof item.title === 'string'
    && typeof item.command === 'string'
    && typeof item.createdAt === 'string'
    && typeof item.updatedAt === 'string'
    && item.title.length > 0
    && item.command.length > 0;
}
