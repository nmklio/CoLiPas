import crypto from 'node:crypto';
import { z } from 'zod';
import { servers } from '../../data/mockData.js';
import type {
  OperationTaskRequest,
  OperationTaskPreflightResponse,
  OperationTaskResponse,
  OperationTaskTargetMode,
  OperationTaskTargetResult,
  OperationTaskType,
  ServerNode,
} from '../../types.js';
import { HttpError } from '../httpErrors.js';
import { recordAudit } from './auditService.js';
import { runServerCommand, runServerDiagnostic } from './inventoryService.js';
import { executeServerAction } from './serverActions.js';
import { resolveServerLifecycleStatus } from '../../shared/serverFilters.js';

const operationTaskSchema = z
  .object({
    type: z.enum(['assetSync', 'healthCheck', 'sshCommand', 'powerOn', 'shutdown', 'reboot']),
    targetMode: z.enum(['allServers', 'allConnected', 'selected']).default('allConnected'),
    serverIds: z.array(z.string().min(1)).max(100).optional().default([]),
    command: z.string().trim().max(2000).optional().default(''),
    reason: z.string().trim().max(300).optional().default('operator requested operation task'),
    confirmed: z.boolean().optional().default(false),
  })
  .superRefine((value, context) => {
    if (value.type === 'sshCommand' && !value.command) {
      context.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'SSH command is required',
      });
    }

    if (value.targetMode === 'selected' && value.serverIds.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['serverIds'],
        message: 'Select at least one server',
      });
    }
  });

type ParsedOperationTask = z.infer<typeof operationTaskSchema>;

export async function createOperationTask(input: unknown): Promise<OperationTaskResponse> {
  const parsed = operationTaskSchema.parse(input) satisfies OperationTaskRequest;
  const startedAt = new Date().toISOString();
  const targets = resolveTargets(parsed);
  const taskId = `ops-${crypto.randomUUID()}`;

  if (parsed.targetMode === 'selected') {
    const foundIds = new Set(targets.map((server) => server.id));
    const missingIds = parsed.serverIds.filter((serverId) => !foundIds.has(serverId));
    if (missingIds.length > 0) {
      recordAudit({
        action: 'OPERATIONS_TASK',
        actor: 'operator',
        target: missingIds.join(','),
        status: 'blocked',
        detail: `Blocked ${parsed.type}: selected servers do not exist`,
      });
      throw new HttpError(404, 'Selected servers do not exist', 'OPERATIONS_TARGETS_NOT_FOUND');
    }
  }

  if (targets.length === 0 && parsed.type !== 'assetSync') {
    recordAudit({
      action: 'OPERATIONS_TASK',
      actor: 'operator',
      target: parsed.targetMode,
      status: 'blocked',
      detail: `Blocked ${parsed.type}: no eligible SSH-connected servers`,
    });
    throw new HttpError(409, 'No eligible SSH-connected servers for this operation', 'OPERATIONS_NO_TARGETS');
  }

  if (parsed.type !== 'assetSync' && parsed.targetMode === 'allServers') {
    const disconnectedTargets = targets.filter((server) => resolveServerLifecycleStatus(server) === 'unconnected');
    if (disconnectedTargets.length > 0) {
      recordAudit({
        action: 'OPERATIONS_TASK',
        actor: 'operator',
        target: disconnectedTargets.map((server) => server.id).join(','),
        status: 'blocked',
        detail: `Blocked ${parsed.type}: allServers includes servers that are not SSH-connected`,
      });
      throw new HttpError(409, 'All server targets must be SSH-connected for this operation', 'OPERATIONS_TARGETS_UNCONNECTED');
    }
  }

  if (parsed.type !== 'assetSync' && parsed.targetMode === 'selected') {
    const disconnectedTargets = targets.filter((server) => resolveServerLifecycleStatus(server) === 'unconnected');
    if (disconnectedTargets.length > 0) {
      recordAudit({
        action: 'OPERATIONS_TASK',
        actor: 'operator',
        target: disconnectedTargets.map((server) => server.id).join(','),
        status: 'blocked',
        detail: `Blocked ${parsed.type}: selected servers are not SSH-connected`,
      });
      throw new HttpError(409, 'Selected servers must be SSH-connected for this operation', 'OPERATIONS_TARGETS_UNCONNECTED');
    }
  }

  if ((parsed.type === 'shutdown' || parsed.type === 'reboot') && !parsed.confirmed) {
    recordAudit({
      action: 'OPERATIONS_TASK',
      actor: 'operator',
      target: parsed.targetMode === 'selected' ? parsed.serverIds.join(',') : parsed.targetMode,
      status: 'blocked',
      detail: `Blocked ${parsed.type}: missing operator confirmation`,
    });
    throw new HttpError(409, `Operator confirmation is required before ${parsed.type}`, 'OPERATIONS_CONFIRMATION_REQUIRED');
  }

  const outputs: OperationTaskTargetResult[] = [];
  for (const server of targets) {
    outputs.push(await executeTarget(taskId, parsed, server));
  }

  const summary = {
    total: outputs.length,
    success: outputs.filter((output) => output.status === 'success').length,
    failed: outputs.filter((output) => output.status === 'failed').length,
    skipped: outputs.filter((output) => output.status === 'skipped').length,
  };
  const status = resolveTaskStatus(summary);
  const finishedAt = new Date().toISOString();
  const message = buildTaskMessage(parsed.type, summary);

  recordAudit({
    action: 'OPERATIONS_TASK',
    actor: 'operator',
    target: parsed.targetMode === 'selected' ? parsed.serverIds.join(',') : parsed.targetMode,
    status: status === 'failed' ? 'failed' : 'success',
    detail: `${parsed.type} ${status}: ${summary.success} success, ${summary.failed} failed, ${summary.skipped} skipped`,
  });

  return {
    id: taskId,
    type: parsed.type,
    targetMode: parsed.targetMode,
    status,
    startedAt,
    finishedAt,
    summary,
    outputs,
    message,
  };
}

export function preflightOperationTask(input: unknown): OperationTaskPreflightResponse {
  const parsed = operationTaskSchema.parse(input) satisfies OperationTaskRequest;
  const targets = resolveTargets(parsed);
  const selectedIds = new Set(parsed.serverIds);
  const targetById = new Map(targets.map((server) => [server.id, server]));
  const foundIds = new Set(targetById.keys());
  const missingTargets = parsed.targetMode === 'selected'
    ? parsed.serverIds.filter((serverId) => !foundIds.has(serverId))
    : [];
  const disconnectedTargets = parsed.type === 'assetSync'
    ? []
    : targets.filter((server) => resolveServerLifecycleStatus(server) === 'unconnected');
  const runnableTargets = parsed.type === 'assetSync'
    ? targets
    : targets.filter((server) => resolveServerLifecycleStatus(server) !== 'unconnected');
  const requiresConfirmation = parsed.type === 'shutdown' || parsed.type === 'reboot';
  const issues: OperationTaskPreflightResponse['issues'] = [];

  if (missingTargets.length > 0) {
    issues.push({
      code: 'OPERATIONS_TARGETS_NOT_FOUND',
      severity: 'block',
      message: 'Selected servers do not exist',
      count: missingTargets.length,
    });
  }

  if (parsed.type !== 'assetSync' && targets.length === 0) {
    issues.push({
      code: 'OPERATIONS_NO_TARGETS',
      severity: 'block',
      message: 'No eligible SSH-connected servers for this operation',
      count: 0,
    });
  }

  if (parsed.type !== 'assetSync' && disconnectedTargets.length > 0) {
    issues.push({
      code: 'OPERATIONS_TARGETS_UNCONNECTED',
      severity: 'block',
      message: parsed.targetMode === 'selected'
        ? 'Selected servers must be SSH-connected for this operation'
        : 'All server targets must be SSH-connected for this operation',
      count: disconnectedTargets.length,
    });
  }

  if (requiresConfirmation && !parsed.confirmed) {
    issues.push({
      code: 'OPERATIONS_CONFIRMATION_REQUIRED',
      severity: 'warn',
      message: `Operator confirmation is required before ${parsed.type}`,
      count: runnableTargets.length,
    });
  }

  const existingPreflightTargets: OperationTaskPreflightResponse['targets'] = targets.map((server) => ({
    id: server.id,
    name: server.name,
    provider: server.provider,
    region: server.region,
    status: resolveServerLifecycleStatus(server),
    sshConnected: Boolean(server.ssh?.connected),
    runnable: parsed.type === 'assetSync' || resolveServerLifecycleStatus(server) !== 'unconnected',
    issues: buildTargetPreflightIssues(parsed, server, requiresConfirmation),
  }))
    .filter((target) => parsed.targetMode !== 'selected' || selectedIds.has(target.id));
  const missingPreflightTargets: OperationTaskPreflightResponse['targets'] = missingTargets.map((serverId) => ({
    id: serverId,
    name: serverId,
    provider: 'Unknown',
    region: 'Unknown',
    status: 'missing',
    sshConnected: false,
    runnable: false,
    issues: [{
      code: 'OPERATIONS_TARGETS_NOT_FOUND',
      severity: 'block',
      message: 'Selected server does not exist',
    }],
  }));
  const preflightTargets: OperationTaskPreflightResponse['targets'] = [
    ...existingPreflightTargets,
    ...missingPreflightTargets,
  ];

  return {
    ok: !issues.some((issue) => issue.severity === 'block'),
    type: parsed.type,
    targetMode: parsed.targetMode,
    requiresSsh: parsed.type !== 'assetSync',
    requiresConfirmation,
    summary: {
      totalTargets: targets.length + missingTargets.length,
      runnableTargets: runnableTargets.length,
      missingTargets: missingTargets.length,
      disconnectedTargets: disconnectedTargets.length,
      blocked: issues.filter((issue) => issue.severity === 'block').length,
    },
    issues,
    targets: preflightTargets,
    generatedAt: new Date().toISOString(),
  };
}

function buildTargetPreflightIssues(
  task: ParsedOperationTask,
  server: ServerNode,
  requiresConfirmation: boolean,
): OperationTaskPreflightResponse['targets'][number]['issues'] {
  const targetIssues: OperationTaskPreflightResponse['targets'][number]['issues'] = [];

  if (task.type !== 'assetSync' && resolveServerLifecycleStatus(server) === 'unconnected') {
    targetIssues.push({
      code: 'OPERATIONS_TARGETS_UNCONNECTED',
      severity: 'block',
      message: 'SSH access is not connected',
    });
  }

  if (requiresConfirmation && !task.confirmed && targetIssues.every((issue) => issue.severity !== 'block')) {
    targetIssues.push({
      code: 'OPERATIONS_CONFIRMATION_REQUIRED',
      severity: 'warn',
      message: `Operator confirmation is required before ${task.type}`,
    });
  }

  return targetIssues;
}

function resolveTargets(task: ParsedOperationTask) {
  if (task.targetMode === 'selected') {
    const selected = new Set(task.serverIds);
    return servers.filter((server) => selected.has(server.id));
  }

  if (task.targetMode === 'allServers') {
    return servers;
  }

  return servers.filter((server) => resolveServerLifecycleStatus(server) !== 'unconnected');
}

async function executeTarget(taskId: string, task: ParsedOperationTask, server: ServerNode): Promise<OperationTaskTargetResult> {
  const startedAt = new Date().toISOString();

  if (task.type !== 'assetSync' && resolveServerLifecycleStatus(server) === 'unconnected') {
    return {
      serverId: server.id,
      serverName: server.name,
      status: 'skipped',
      output: '',
      error: 'SSH access is not connected',
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  try {
    const result = await runOperation(task, server);
    return {
      serverId: server.id,
      serverName: server.name,
      status: 'success',
      output: result.output,
      command: result.command,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      serverId: server.id,
      serverName: server.name,
      status: 'failed',
      output: '',
      error: error instanceof Error ? error.message : `${taskId} target execution failed`,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

async function runOperation(task: ParsedOperationTask, server: ServerNode) {
  if (task.type === 'assetSync') {
    return {
      output: [
        `server=${server.name}`,
        `provider=${server.provider}`,
        `region=${server.region}`,
        `status=${server.status}`,
        `publicIp=${server.publicIp}`,
        `ssh=${server.ssh?.connected ? `${server.ssh.username}@${server.ssh.host}:${server.ssh.port}` : 'unconnected'}`,
        `resource=cpu:${server.cpu}% memory:${server.memory}% disk:${server.disk}%`,
      ].join('\n'),
    };
  }

  if (task.type === 'healthCheck') {
    const result = await runServerDiagnostic(server.id);
    return {
      command: result.command,
      output: result.output,
    };
  }

  if (task.type === 'sshCommand') {
    const result = await runServerCommand({ serverId: server.id, command: task.command });
    return {
      command: result.command,
      output: result.output,
    };
  }

  const result = await executeServerAction({
    serverId: server.id,
    action: task.type,
    reason: task.reason || `operation task ${task.type}`,
    confirmed: task.confirmed,
  });
  const actionResult = result as { command?: string; output?: string };
  return {
    command: actionResult.command,
    output: actionResult.output || `${task.type} accepted`,
  };
}

function resolveTaskStatus(summary: OperationTaskResponse['summary']) {
  if (summary.total === 0) {
    return 'completed';
  }

  if (summary.success === summary.total) {
    return 'completed';
  }

  if (summary.success > 0) {
    return 'partial';
  }

  return 'failed';
}

function buildTaskMessage(type: OperationTaskType, summary: OperationTaskResponse['summary']) {
  return `${type} finished: ${summary.success}/${summary.total} succeeded, ${summary.failed} failed, ${summary.skipped} skipped`;
}
