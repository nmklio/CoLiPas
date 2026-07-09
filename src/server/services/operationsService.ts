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
import { getServerById, runServerCommand, runServerDiagnostic } from './inventoryService.js';
import { executeServerAction } from './serverActions.js';
import { resolveServerLifecycleStatus } from '../../shared/serverFilters.js';
import { getSshCommandConfirmationReason } from '../../shared/sshCommandRisk.js';
import { resolveMaintenanceWindowCoverage } from './maintenanceWindowService.js';

const operationOutputLimit = 200;
const operationPreflightTargetLimit = 120;
const operationExecutionConcurrency = readBoundedIntegerEnv('COLIPAS_OPERATION_CONCURRENCY', 6, 1, 16);

const operationTaskSchema = z
  .object({
    type: z.enum(['assetSync', 'healthCheck', 'sshCommand', 'powerOn', 'shutdown', 'reboot']),
    targetMode: z.enum(['allServers', 'allConnected', 'selected']).default('allConnected'),
    serverIds: z.array(z.string().min(1)).max(100).optional().default([]),
    command: z.string().trim().max(2000).optional().default(''),
    reason: z.string().trim().max(300).optional().default('operator requested operation task'),
    confirmed: z.boolean().optional().default(false),
    correlationId: z.string().trim().regex(/^ops-trace-[a-f0-9-]{36}$/).optional(),
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
  const correlationId = parsed.correlationId || buildOperationCorrelationId();
  const maintenanceCoverage = resolveMaintenanceWindowCoverage(parsed, targets);

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
        correlationId,
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
      correlationId,
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
        correlationId,
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
        correlationId,
      });
      throw new HttpError(409, 'Selected servers must be SSH-connected for this operation', 'OPERATIONS_TARGETS_UNCONNECTED');
    }
  }

  const confirmationReason = requiredConfirmationReason(parsed);
  if (confirmationReason && !parsed.confirmed) {
    recordAudit({
      action: 'OPERATIONS_TASK',
      actor: 'operator',
      target: parsed.targetMode === 'selected' ? parsed.serverIds.join(',') : parsed.targetMode,
      status: 'blocked',
      detail: `Blocked ${parsed.type}: missing operator confirmation for ${confirmationReason}`,
      correlationId,
    });
    throw new HttpError(409, `Operator confirmation is required before ${confirmationReason}`, 'OPERATIONS_CONFIRMATION_REQUIRED');
  }

  const summary: OperationTaskResponse['summary'] = {
    total: targets.length,
    success: 0,
    failed: 0,
    skipped: 0,
  };
  const targetResults = await executeOperationTargets(taskId, parsed, targets);
  const outputs: OperationTaskTargetResult[] = [];

  for (const output of targetResults) {
    if (output.status === 'success') {
      summary.success += 1;
    } else if (output.status === 'failed') {
      summary.failed += 1;
    } else {
      summary.skipped += 1;
    }

    if (outputs.length < operationOutputLimit) {
      outputs.push(output);
    }
  }

  const omittedOutputs = Math.max(summary.total - outputs.length, 0);
  const status = resolveTaskStatus(summary);
  const finishedAt = new Date().toISOString();
  const message = buildTaskMessage(parsed.type, summary);

  recordAudit({
    action: 'OPERATIONS_TASK',
    actor: 'operator',
    target: parsed.targetMode === 'selected' ? parsed.serverIds.join(',') : parsed.targetMode,
    status: status === 'failed' ? 'failed' : 'success',
    detail: `${parsed.type} ${status}: ${summary.success} success, ${summary.failed} failed, ${summary.skipped} skipped; ${formatMaintenanceAuditDetail(maintenanceCoverage)}`,
    correlationId,
  });

  return {
    id: taskId,
    correlationId,
    type: parsed.type,
    targetMode: parsed.targetMode,
    status,
    startedAt,
    finishedAt,
    summary,
    outputs,
    outputsTruncated: omittedOutputs > 0 || undefined,
    outputLimit: omittedOutputs > 0 ? operationOutputLimit : undefined,
    omittedOutputs: omittedOutputs > 0 ? omittedOutputs : undefined,
    message,
  };
}

export function preflightOperationTask(input: unknown): OperationTaskPreflightResponse {
  const parsed = operationTaskSchema.parse(input) satisfies OperationTaskRequest;
  const correlationId = parsed.correlationId || buildOperationCorrelationId();
  const targets = resolveTargets(parsed);
  const selectedIds = new Set(parsed.serverIds);
  const targetById = parsed.targetMode === 'selected'
    ? new Map(targets.map((server) => [server.id, server]))
    : new Map<string, ServerNode>();
  const foundIds = parsed.targetMode === 'selected' ? new Set(targetById.keys()) : new Set<string>();
  const missingTargets = parsed.targetMode === 'selected'
    ? parsed.serverIds.filter((serverId) => !foundIds.has(serverId))
    : [];
  const confirmationReason = requiredConfirmationReason(parsed);
  const requiresConfirmation = Boolean(confirmationReason);
  const requiresSsh = parsed.type !== 'assetSync';
  const maintenanceCoverage = resolveMaintenanceWindowCoverage(parsed, targets);
  const maintenanceCoveredServerIds = new Set(maintenanceCoverage.coveredServerIds);
  let disconnectedTargetCount = 0;
  let runnableTargetCount = 0;
  const existingPreflightTargets: OperationTaskPreflightResponse['targets'] = [];

  for (const server of targets) {
    const status = resolveServerLifecycleStatus(server);
    const disconnected = requiresSsh && status === 'unconnected';
    const runnable = !disconnected;

    if (disconnected) {
      disconnectedTargetCount += 1;
    }

    if (runnable) {
      runnableTargetCount += 1;
    }

    if (
      existingPreflightTargets.length < operationPreflightTargetLimit
      && (parsed.targetMode !== 'selected' || selectedIds.has(server.id))
    ) {
      existingPreflightTargets.push({
        id: server.id,
        name: server.name,
        provider: server.provider,
        region: server.region,
        status,
        sshConnected: Boolean(server.ssh?.connected),
        runnable,
        issues: buildTargetPreflightIssues(parsed, server, requiresConfirmation, maintenanceCoverage.required, maintenanceCoveredServerIds.has(server.id)),
      });
    }
  }

  const issues: OperationTaskPreflightResponse['issues'] = [];

  if (missingTargets.length > 0) {
    issues.push({
      code: 'OPERATIONS_TARGETS_NOT_FOUND',
      severity: 'block',
      message: 'Selected servers do not exist',
      count: missingTargets.length,
    });
  }

  if (requiresSsh && targets.length === 0) {
    issues.push({
      code: 'OPERATIONS_NO_TARGETS',
      severity: 'block',
      message: 'No eligible SSH-connected servers for this operation',
      count: 0,
    });
  }

  if (requiresSsh && disconnectedTargetCount > 0) {
    issues.push({
      code: 'OPERATIONS_TARGETS_UNCONNECTED',
      severity: 'block',
      message: parsed.targetMode === 'selected'
        ? 'Selected servers must be SSH-connected for this operation'
        : 'All server targets must be SSH-connected for this operation',
      count: disconnectedTargetCount,
    });
  }

  if (requiresConfirmation && !parsed.confirmed) {
    issues.push({
      code: 'OPERATIONS_CONFIRMATION_REQUIRED',
      severity: 'warn',
      message: `Operator confirmation is required before ${confirmationReason}`,
      count: runnableTargetCount,
    });
  }

  if (maintenanceCoverage.required && maintenanceCoverage.uncoveredServerIds.length > 0) {
    issues.push({
      code: 'OPERATIONS_MAINTENANCE_WINDOW_MISSING',
      severity: 'warn',
      message: buildMaintenanceWindowWarning(maintenanceCoverage),
      count: maintenanceCoverage.uncoveredServerIds.length,
    });
  }

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
  const totalPreflightTargets = targets.length + missingTargets.length;
  const omittedPreflightTargets = Math.max(totalPreflightTargets - preflightTargets.length, 0);

  const response: OperationTaskPreflightResponse = {
    ok: !issues.some((issue) => issue.severity === 'block'),
    correlationId,
    type: parsed.type,
    targetMode: parsed.targetMode,
    requiresSsh: parsed.type !== 'assetSync',
    requiresConfirmation,
    plan: buildPreflightPlan(parsed, {
      totalTargets: totalPreflightTargets,
      runnableTargets: runnableTargetCount,
      missingTargets: missingTargets.length,
      disconnectedTargets: disconnectedTargetCount,
      blocked: issues.filter((issue) => issue.severity === 'block').length,
      warnings: issues.filter((issue) => issue.severity === 'warn').length,
    }),
    summary: {
      totalTargets: totalPreflightTargets,
      runnableTargets: runnableTargetCount,
      missingTargets: missingTargets.length,
      disconnectedTargets: disconnectedTargetCount,
      blocked: issues.filter((issue) => issue.severity === 'block').length,
    },
    issues,
    targets: preflightTargets,
    targetsTruncated: omittedPreflightTargets > 0 || undefined,
    targetLimit: omittedPreflightTargets > 0 ? operationPreflightTargetLimit : undefined,
    omittedTargets: omittedPreflightTargets > 0 ? omittedPreflightTargets : undefined,
    generatedAt: new Date().toISOString(),
    maintenance: {
      required: maintenanceCoverage.required,
      status: maintenanceCoverage.status,
      activeWindowIds: maintenanceCoverage.activeWindowIds,
      coveredTargets: maintenanceCoverage.coveredServerIds.length,
      uncoveredTargets: maintenanceCoverage.uncoveredServerIds.length,
    },
  };

  recordAudit({
    action: 'OPERATIONS_PREFLIGHT',
    actor: 'operator',
    target: parsed.targetMode === 'selected' ? summarizeAuditTargets(parsed.serverIds) : parsed.targetMode,
    status: response.ok ? 'success' : 'blocked',
    detail: buildPreflightAuditDetail(response),
    correlationId,
  });

  return response;
}

async function executeOperationTargets(taskId: string, task: ParsedOperationTask, targets: ServerNode[]) {
  if (targets.length === 0) {
    return [];
  }

  const results: OperationTaskTargetResult[] = new Array(targets.length);
  let nextTargetIndex = 0;
  const workerCount = Math.min(operationExecutionConcurrency, targets.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextTargetIndex < targets.length) {
      const index = nextTargetIndex;
      nextTargetIndex += 1;
      results[index] = await executeTarget(taskId, task, targets[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

function buildOperationCorrelationId() {
  return `ops-trace-${crypto.randomUUID()}`;
}

function buildPreflightAuditDetail(response: OperationTaskPreflightResponse) {
  const parts = [
    `Plan: ${response.plan.title}`,
    response.plan.targetSummary,
    response.plan.riskSummary,
    response.plan.impact,
  ];

  if (response.plan.commandPreview) {
    parts.push(`Command: ${response.plan.commandPreview}`);
  }

  parts.push(formatMaintenanceAuditDetail(response.maintenance));

  return parts.join(' | ').slice(0, 900);
}

function summarizeAuditTargets(serverIds: string[]) {
  if (serverIds.length <= 4) {
    return serverIds.join(',');
  }

  return `${serverIds.slice(0, 4).join(',')} +${serverIds.length - 4} more`;
}

function buildPreflightPlan(
  task: ParsedOperationTask,
  summary: OperationTaskPreflightResponse['summary'] & { warnings: number },
): OperationTaskPreflightResponse['plan'] {
  const taskName = formatOperationTaskType(task.type);
  const targetMode = formatTargetMode(task.targetMode);
  const riskParts = [
    summary.blocked > 0 ? `${summary.blocked} blocking issue${summary.blocked > 1 ? 's' : ''}` : '',
    summary.warnings > 0 ? `${summary.warnings} warning${summary.warnings > 1 ? 's' : ''}` : '',
  ].filter(Boolean);
  const commandPreview = task.type === 'sshCommand' ? sanitizeCommandPreview(task.command) : undefined;

  return {
    title: `${taskName} on ${targetMode}`,
    targetSummary: `${summary.runnableTargets}/${summary.totalTargets} targets runnable`,
    impact: buildPreflightImpact(task, summary),
    commandPreview,
    riskSummary: riskParts.length > 0 ? riskParts.join(', ') : 'No blocking issues or warnings',
  };
}

function buildPreflightImpact(
  task: ParsedOperationTask,
  summary: OperationTaskPreflightResponse['summary'],
) {
  if (summary.blocked > 0) {
    return 'Execution is blocked until target issues are fixed';
  }

  if (task.type === 'shutdown') {
    return `${summary.runnableTargets} server${summary.runnableTargets === 1 ? '' : 's'} will be powered off after confirmation`;
  }

  if (task.type === 'reboot') {
    return `${summary.runnableTargets} server${summary.runnableTargets === 1 ? '' : 's'} will be rebooted after confirmation`;
  }

  if (task.type === 'powerOn') {
    return `${summary.runnableTargets} server${summary.runnableTargets === 1 ? '' : 's'} will receive a power-on command`;
  }

  if (task.type === 'sshCommand') {
    const confirmationReason = requiredConfirmationReason(task);
    const confirmationSuffix = confirmationReason ? ' after operator confirmation' : '';
    return `${summary.runnableTargets} server${summary.runnableTargets === 1 ? '' : 's'} will run the prepared SSH command${confirmationSuffix}`;
  }

  if (task.type === 'assetSync') {
    return `${summary.totalTargets} server${summary.totalTargets === 1 ? '' : 's'} will be included in asset synchronization`;
  }

  return `${summary.runnableTargets} server${summary.runnableTargets === 1 ? '' : 's'} will run a health check`;
}

function formatOperationTaskType(type: OperationTaskType) {
  return {
    assetSync: 'Asset sync',
    healthCheck: 'Health check',
    sshCommand: 'SSH command',
    powerOn: 'Power on',
    shutdown: 'Shutdown',
    reboot: 'Reboot',
  }[type];
}

function formatTargetMode(targetMode: OperationTaskTargetMode) {
  return {
    allServers: 'all servers',
    allConnected: 'all SSH-connected servers',
    selected: 'selected servers',
  }[targetMode];
}

function sanitizeCommandPreview(command: string) {
  return command
    .replace(/([?&](?:access_token|api_key|apikey|auth|authorization|bearer|client_secret|key|password|secret|signature|token)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/\b((?:authorization|x-api-key|api-key)\s*:\s*)[^\s"']+/gi, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[redacted-api-key]')
    .slice(0, 180);
}

function requiredConfirmationReason(task: Pick<ParsedOperationTask, 'type' | 'command'>) {
  if (task.type === 'shutdown' || task.type === 'reboot') {
    return task.type;
  }

  if (task.type !== 'sshCommand') {
    return '';
  }

  return getSshCommandConfirmationReason(task.command);
}

function buildTargetPreflightIssues(
  task: ParsedOperationTask,
  server: ServerNode,
  requiresConfirmation: boolean,
  maintenanceWindowRequired: boolean,
  maintenanceWindowCovered: boolean,
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
      message: `Operator confirmation is required before ${requiredConfirmationReason(task) || task.type}`,
    });
  }

  if (maintenanceWindowRequired && !maintenanceWindowCovered && targetIssues.every((issue) => issue.severity !== 'block')) {
    targetIssues.push({
      code: 'OPERATIONS_MAINTENANCE_WINDOW_MISSING',
      severity: 'warn',
      message: 'No active maintenance window covers this high-impact operation',
    });
  }

  return targetIssues;
}

function buildMaintenanceWindowWarning(coverage: {
  coveredServerIds: string[];
  uncoveredServerIds: string[];
}) {
  if (coverage.coveredServerIds.length > 0) {
    return `Active maintenance coverage is partial: ${coverage.uncoveredServerIds.length} target(s) are outside a maintenance window`;
  }
  return `No active maintenance window covers ${coverage.uncoveredServerIds.length} high-impact target(s)`;
}

function formatMaintenanceAuditDetail(coverage: {
  required: boolean;
  status: 'notRequired' | 'covered' | 'partial' | 'missing';
  activeWindowIds: string[];
  coveredServerIds?: string[];
  uncoveredServerIds?: string[];
  coveredTargets?: number;
  uncoveredTargets?: number;
}) {
  if (!coverage.required) {
    return 'maintenance window not required';
  }

  const covered = coverage.coveredServerIds?.length ?? coverage.coveredTargets ?? 0;
  const uncovered = coverage.uncoveredServerIds?.length ?? coverage.uncoveredTargets ?? 0;
  return `maintenance ${coverage.status}: ${covered} covered, ${uncovered} uncovered, ${coverage.activeWindowIds.length} active window(s)`;
}

function resolveTargets(task: ParsedOperationTask) {
  if (task.targetMode === 'selected') {
    const selected = new Set(task.serverIds);
    const selectedServers: ServerNode[] = [];
    for (const serverId of selected) {
      const server = getServerById(serverId);
      if (server) {
        selectedServers.push(server);
      }
    }
    return selectedServers;
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

function readBoundedIntegerEnv(name: string, fallback: number, min: number, max: number) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}
