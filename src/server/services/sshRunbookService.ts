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
