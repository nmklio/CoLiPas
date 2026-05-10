import { z } from 'zod';
import { HttpError } from '../httpErrors.js';
import { recordAudit } from './auditService.js';
import { getConnectedServerCredential, setServerRuntimeStatus } from './inventoryService.js';
import { runStoredSshCommand } from './sshAccessService.js';

const actionSchema = z.object({
  serverId: z.string().min(1),
  action: z.enum(['powerOn', 'shutdown', 'reboot']),
  reason: z.string().min(4).max(300),
  dryRun: z.boolean().optional().default(false),
  confirmed: z.boolean().optional().default(false),
});

const actionCommands: Record<'powerOn' | 'shutdown' | 'reboot', string> = {
  powerOn: 'printf "server reachable via SSH\\n"; uptime',
  shutdown: 'nohup sh -c "shutdown -h now" >/dev/null 2>&1 & echo "shutdown scheduled"',
  reboot: 'nohup sh -c "reboot" >/dev/null 2>&1 & echo "reboot scheduled"',
};

export async function executeServerAction(input: unknown) {
  const parsed = actionSchema.parse(input);
  const isDangerousAction = parsed.action === 'shutdown' || parsed.action === 'reboot';
  if (parsed.dryRun) {
    const { server } = getConnectedServerCredential(parsed.serverId, 'SERVER_ACTION');
    const task = {
      id: `task-${Date.now()}`,
      serverId: server.id,
      serverName: server.name,
      action: parsed.action,
      status: 'dry-run',
      reason: parsed.reason,
    };

    recordAudit({
      action: 'SERVER_ACTION',
      actor: 'operator',
      target: server.id,
      status: 'success',
      detail: `Dry-run ${parsed.action} accepted for ${server.name}`,
    });

    return task;
  }

  const { server, credential } = getConnectedServerCredential(parsed.serverId, 'SERVER_ACTION');
  if (isDangerousAction && !parsed.confirmed) {
    recordAudit({
      action: 'SERVER_ACTION',
      actor: 'operator',
      target: server.id,
      status: 'blocked',
      detail: `Blocked ${parsed.action} for ${server.name}: missing operator confirmation`,
    });
    throw new HttpError(409, `Operator confirmation is required before ${parsed.action}`, 'SERVER_ACTION_CONFIRMATION_REQUIRED');
  }

  const command = actionCommands[parsed.action];
  const commandResult = await runStoredSshCommand(credential, command, server.ssh.verifyMode);
  const nextStatus = parsed.action === 'shutdown' ? 'stopped' : 'running';
  setServerRuntimeStatus(server.id, nextStatus);

  const task = {
    id: `task-${Date.now()}`,
    serverId: server.id,
    serverName: server.name,
    action: parsed.action,
    status: 'executed',
    reason: parsed.reason,
    command,
    output: commandResult.output,
    serverStatus: nextStatus,
  };

  recordAudit({
    action: 'SERVER_ACTION',
    actor: 'operator',
    target: server.id,
    status: 'success',
    detail: `Executed ${parsed.action} for ${server.name}`,
  });

  return task;
}
