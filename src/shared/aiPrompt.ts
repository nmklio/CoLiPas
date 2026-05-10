import type { OperationEvent, ServerNode } from '../types.js';

export function buildOpsPrompt(servers: ServerNode[], events: OperationEvent[]) {
  const serverLines = servers.length
    ? servers.map((server) => [
      `- ${server.name}`,
      `provider=${server.provider}`,
      `region=${server.region || 'unknown'}`,
      `status=${server.status}`,
      `publicIp=${server.publicIp || 'none'}`,
      `os=${server.os || 'unknown'}`,
      `cpu=${server.cpu}%`,
      `memory=${server.memory}%`,
      `disk=${server.disk}%`,
      `ssh=${server.ssh?.connected ? `${server.ssh.verifyMode}/${server.ssh.username}@${server.ssh.host}:${server.ssh.port}` : 'not connected'}`,
      `tags=${server.tags.join(',') || 'none'}`,
    ].join(' | ')).join('\n')
    : 'No servers are currently registered.';

  const hotServers = servers
    .filter((server) => server.cpu > 75 || server.memory > 80 || server.disk > 85)
    .sort((a, b) => Math.max(b.cpu, b.memory, b.disk) - Math.max(a.cpu, a.memory, a.disk))
    .map((server) => `- ${server.name}: CPU ${server.cpu}%, memory ${server.memory}%, disk ${server.disk}%, status ${server.status}`)
    .join('\n');

  const openEvents = events
    .filter((event) => event.status === 'open')
    .map((event) => `- ${event.time} [${event.severity}] ${event.title} (${event.source})`)
    .join('\n');

  return [
    'Current CoLiPas operations context. Use this context only when it is relevant to the user question.',
    'Do not invent servers, credentials, commands that were executed, or cloud-provider data.',
    '',
    `Server inventory:\n${serverLines}`,
    '',
    `High-load servers:\n${hotServers || '- None above the configured thresholds.'}`,
    '',
    `Open operation/security events:\n${openEvents || '- None.'}`,
  ].join('\n');
}
