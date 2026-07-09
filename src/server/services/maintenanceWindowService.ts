import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  MaintenanceWindow,
  MaintenanceWindowPhase,
  MaintenanceWindowScope,
  OperationTaskType,
  ServerNode,
} from '../../types.js';
import { getSshCommandConfirmationReason } from '../../shared/sshCommandRisk.js';
import { HttpError } from '../httpErrors.js';
import { redactSensitiveText } from './sensitiveRedaction.js';
import { readAppSetting, writeAppSetting } from './database.js';

const settingId = 'operations-maintenance-windows.v1';
const maxMaintenanceWindows = 12;
const maxSelectedTargets = 100;
const minimumWindowDurationMs = 5 * 60_000;
const maximumWindowDurationMs = 7 * 24 * 60 * 60_000;

const maintenanceWindowPayloadSchema = z.object({
  title: z.string().trim().min(1).max(64),
  note: z.string().trim().max(240).optional().default(''),
  scope: z.enum(['all', 'allConnected', 'selected']),
  serverIds: z.array(z.string().trim().min(1).max(120)).max(maxSelectedTargets).optional().default([]),
  startsAt: z.string().trim().min(1).max(80),
  endsAt: z.string().trim().min(1).max(80),
});

const storedMaintenanceWindowSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(64),
  note: z.string().trim().max(240),
  scope: z.enum(['all', 'allConnected', 'selected']),
  serverIds: z.array(z.string().trim().min(1).max(120)).max(maxSelectedTargets),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

const storedMaintenanceWindowCollectionSchema = z.object({
  version: z.literal(1),
  windows: z.array(storedMaintenanceWindowSchema).max(maxMaintenanceWindows),
});

type StoredMaintenanceWindow = z.infer<typeof storedMaintenanceWindowSchema>;

export interface MaintenanceWindowCoverage {
  required: boolean;
  status: 'notRequired' | 'covered' | 'partial' | 'missing';
  activeWindowIds: string[];
  coveredServerIds: string[];
  uncoveredServerIds: string[];
}

export function listMaintenanceWindows(referenceTime = new Date()): MaintenanceWindow[] {
  return readMaintenanceWindows()
    .map((window) => toPublicMaintenanceWindow(window, referenceTime))
    .sort((left, right) => {
      const phaseOrder = maintenancePhaseOrder(left.phase) - maintenancePhaseOrder(right.phase);
      if (phaseOrder !== 0) {
        return phaseOrder;
      }
      return left.startsAt.localeCompare(right.startsAt);
    });
}

export function createMaintenanceWindow(input: unknown, servers: ServerNode[], referenceTime = new Date()) {
  const parsed = maintenanceWindowPayloadSchema.parse(input);
  const title = normalizeHumanText(parsed.title, 64);
  const note = normalizeHumanText(parsed.note, 240);
  rejectSensitiveText(title, 'title');
  rejectSensitiveText(note, 'note');
  const startsAt = parseMaintenanceTimestamp(parsed.startsAt, 'Maintenance window start time is invalid');
  const endsAt = parseMaintenanceTimestamp(parsed.endsAt, 'Maintenance window end time is invalid');
  const durationMs = endsAt.getTime() - startsAt.getTime();

  if (durationMs < minimumWindowDurationMs || durationMs > maximumWindowDurationMs) {
    throw new HttpError(400, 'Maintenance window must be between 5 minutes and 7 days', 'MAINTENANCE_WINDOW_DURATION_INVALID');
  }

  if (endsAt.getTime() <= referenceTime.getTime()) {
    throw new HttpError(400, 'Maintenance window end time must be in the future', 'MAINTENANCE_WINDOW_ENDED');
  }

  const scope = parsed.scope satisfies MaintenanceWindowScope;
  const serverIds = normalizeServerIds(parsed.serverIds);
  if (scope === 'selected' && serverIds.length === 0) {
    throw new HttpError(400, 'Select at least one server for a scoped maintenance window', 'MAINTENANCE_WINDOW_TARGETS_REQUIRED');
  }
  if (scope !== 'selected' && serverIds.length > 0) {
    throw new HttpError(400, 'Only selected maintenance windows may include server targets', 'MAINTENANCE_WINDOW_SCOPE_INVALID');
  }

  const existingServerIds = new Set(servers.map((server) => server.id));
  const missingServerIds = serverIds.filter((serverId) => !existingServerIds.has(serverId));
  if (missingServerIds.length > 0) {
    throw new HttpError(404, 'Selected maintenance window servers do not exist', 'MAINTENANCE_WINDOW_TARGETS_NOT_FOUND');
  }

  const windows = readMaintenanceWindows();
  if (windows.length >= maxMaintenanceWindows) {
    throw new HttpError(400, `Maintenance window limit reached (${maxMaintenanceWindows})`, 'MAINTENANCE_WINDOW_LIMIT_REACHED');
  }

  const now = referenceTime.toISOString();
  const window: StoredMaintenanceWindow = {
    id: randomUUID(),
    title,
    note,
    scope,
    serverIds,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    createdAt: now,
    updatedAt: now,
  };

  writeMaintenanceWindows([window, ...windows]);
  return {
    window: toPublicMaintenanceWindow(window, referenceTime),
    windows: listMaintenanceWindows(referenceTime),
  };
}

export function deleteMaintenanceWindow(windowId: string, referenceTime = new Date()) {
  const windows = readMaintenanceWindows();
  const next = windows.filter((window) => window.id !== windowId);
  if (next.length === windows.length) {
    throw new HttpError(404, 'Maintenance window was not found', 'MAINTENANCE_WINDOW_NOT_FOUND');
  }
  writeMaintenanceWindows(next);
  return {
    ok: true,
    id: windowId,
    windows: listMaintenanceWindows(referenceTime),
  };
}

export function resolveMaintenanceWindowCoverage(
  task: Pick<{ type: OperationTaskType; command: string }, 'type' | 'command'>,
  targets: ServerNode[],
  referenceTime = new Date(),
): MaintenanceWindowCoverage {
  const required = requiresMaintenanceWindow(task);
  if (!required) {
    return {
      required: false,
      status: 'notRequired',
      activeWindowIds: [],
      coveredServerIds: [],
      uncoveredServerIds: [],
    };
  }

  const activeWindows = listMaintenanceWindows(referenceTime).filter((window) => window.phase === 'active');
  const coveredServerIds: string[] = [];
  const uncoveredServerIds: string[] = [];
  const activeWindowIds = new Set<string>();

  for (const target of targets) {
    const matchingWindow = activeWindows.find((window) => maintenanceWindowMatchesServer(window, target.id));
    if (matchingWindow) {
      coveredServerIds.push(target.id);
      activeWindowIds.add(matchingWindow.id);
    } else {
      uncoveredServerIds.push(target.id);
    }
  }

  return {
    required: true,
    status: targets.length === 0 || uncoveredServerIds.length === 0
      ? 'covered'
      : coveredServerIds.length > 0
        ? 'partial'
        : 'missing',
    activeWindowIds: [...activeWindowIds],
    coveredServerIds,
    uncoveredServerIds,
  };
}

export function requiresMaintenanceWindow(task: Pick<{ type: OperationTaskType; command: string }, 'type' | 'command'>) {
  return task.type === 'shutdown'
    || task.type === 'reboot'
    || (task.type === 'sshCommand' && Boolean(getSshCommandConfirmationReason(task.command)));
}

function readMaintenanceWindows(): StoredMaintenanceWindow[] {
  const row = readAppSetting(settingId);
  if (!row) {
    return [];
  }

  try {
    return storedMaintenanceWindowCollectionSchema.parse(JSON.parse(row.payload)).windows;
  } catch {
    return [];
  }
}

function writeMaintenanceWindows(windows: StoredMaintenanceWindow[]) {
  writeAppSetting(settingId, {
    version: 1,
    windows: windows.slice(0, maxMaintenanceWindows),
  });
}

function toPublicMaintenanceWindow(window: StoredMaintenanceWindow, referenceTime: Date): MaintenanceWindow {
  return {
    ...window,
    serverIds: [...window.serverIds],
    phase: resolveMaintenancePhase(window, referenceTime),
  };
}

function resolveMaintenancePhase(window: Pick<StoredMaintenanceWindow, 'startsAt' | 'endsAt'>, referenceTime: Date): MaintenanceWindowPhase {
  if (new Date(window.endsAt).getTime() <= referenceTime.getTime()) {
    return 'ended';
  }
  if (new Date(window.startsAt).getTime() <= referenceTime.getTime()) {
    return 'active';
  }
  return 'upcoming';
}

function maintenancePhaseOrder(phase: MaintenanceWindowPhase) {
  return phase === 'active' ? 0 : phase === 'upcoming' ? 1 : 2;
}

function maintenanceWindowMatchesServer(window: MaintenanceWindow, serverId: string) {
  return window.scope === 'all'
    || window.scope === 'allConnected'
    || window.serverIds.includes(serverId);
}

function parseMaintenanceTimestamp(value: string, message: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, message, 'MAINTENANCE_WINDOW_TIME_INVALID');
  }
  return parsed;
}

function normalizeServerIds(values: string[]) {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return [...unique].slice(0, maxSelectedTargets);
}

function normalizeHumanText(value: string, maxLength: number) {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function rejectSensitiveText(value: string, field: string) {
  if (redactSensitiveText(value) !== value) {
    throw new HttpError(400, `Maintenance window ${field} appears to contain sensitive material`, 'MAINTENANCE_WINDOW_SENSITIVE');
  }
}
