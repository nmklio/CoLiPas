import type { OperationEvent, ServerNode } from '../types.js';
import { hasFreshServerTelemetry } from './serverTelemetry.js';

const promptServerSampleLimit = 24;
const promptHighLoadLimit = 12;
const promptOpenEventLimit = 12;
const promptGroupLimit = 12;

interface CountGroup {
  key: string;
  count: number;
}

interface ServerRiskEntry {
  server: ServerNode;
  load: number;
}

export function buildOpsPrompt(servers: ServerNode[], events: OperationEvent[]) {
  const summary = summarizeServersForPrompt(servers);
  const serverLines = summary.sampleServers.length
    ? summary.sampleServers.map((server) => [
      `- ${server.name}`,
      `provider=${server.provider}`,
      `region=${server.region || 'unknown'}`,
      `status=${server.status}`,
      `publicIp=${server.publicIp || 'none'}`,
      `os=${server.os || 'unknown'}`,
      `telemetry=${server.telemetry?.status ?? 'unavailable'}`,
      `cpu=${formatPromptMetric(server, 'cpu')}`,
      `memory=${formatPromptMetric(server, 'memory')}`,
      `disk=${formatPromptMetric(server, 'disk')}`,
      `ssh=${server.ssh?.connected ? `${server.ssh.verifyMode}/${server.ssh.username}@${server.ssh.host}:${server.ssh.port}` : 'not connected'}`,
      `tags=${server.tags.join(',') || 'none'}`,
    ].join(' | ')).join('\n')
    : 'No servers are currently registered.';

  const hotServers = summary.highLoadServers
    .map(({ server, load }) => `- ${server.name}: load ${load}%, CPU ${server.cpu}%, memory ${server.memory}%, disk ${server.disk}%, status ${server.status}`)
    .join('\n');

  const openEventItems = events.filter((event) => event.status === 'open');
  const openEvents = openEventItems
    .slice(0, promptOpenEventLimit)
    .map((event) => `- ${event.time} [${event.severity}] ${event.title} (${event.source})`)
    .join('\n');
  const omittedOpenEvents = Math.max(0, openEventItems.length - promptOpenEventLimit);

  return [
    'Current CoLiPas Cloud Server Management Panel operations context. Use this context only when it is relevant to the user question.',
    'Do not invent servers, credentials, commands that were executed, or cloud-provider data.',
    'Large inventories are summarized to keep the UI, API request, and model prompt responsive.',
    '',
    `Fleet summary: total=${summary.total}, sshConnected=${summary.sshConnected}, running=${summary.running}, stopped=${summary.stopped}, warning=${summary.warning}, unconnected=${summary.unconnected}, freshTelemetry=${summary.freshTelemetry}, telemetrySkipped=${summary.total - summary.freshTelemetry}, avgCpu=${formatPromptAverage(summary.avgCpu)}, avgMemory=${formatPromptAverage(summary.avgMemory)}, avgDisk=${formatPromptAverage(summary.avgDisk)}.`,
    `Providers: ${formatCountGroups(summary.providers)}`,
    `Regions: ${formatCountGroups(summary.regions)}`,
    '',
    `Server inventory:\n${serverLines}${summary.omittedServers > 0 ? `\n- ... ${summary.omittedServers} additional server(s) omitted from prompt; use filtered inventory or selected scope for exact rows.` : ''}`,
    '',
    `High-load servers:\n${hotServers || '- None above the configured thresholds.'}`,
    '',
    `Open operation/security events:\n${openEvents || '- None.'}${omittedOpenEvents > 0 ? `\n- ... ${omittedOpenEvents} additional open event(s) omitted from prompt.` : ''}`,
  ].join('\n');
}

function summarizeServersForPrompt(servers: ServerNode[]) {
  let running = 0;
  let stopped = 0;
  let warning = 0;
  let unconnected = 0;
  let sshConnected = 0;
  let cpuTotal = 0;
  let memoryTotal = 0;
  let diskTotal = 0;
  let freshTelemetry = 0;
  const providerCounts = new Map<string, number>();
  const regionCounts = new Map<string, number>();
  const sampleServers: ServerNode[] = [];
  const highLoadServers: ServerRiskEntry[] = [];

  for (const server of servers) {
    if (sampleServers.length < promptServerSampleLimit) {
      sampleServers.push(server);
    }

    const isSshConnected = Boolean(server.ssh?.connected);
    if (isSshConnected) {
      sshConnected += 1;
    }
    if (server.status === 'running') {
      running += 1;
    } else if (server.status === 'stopped') {
      stopped += 1;
    } else if (server.status === 'warning') {
      warning += 1;
    } else if (server.status === 'unconnected') {
      unconnected += 1;
    }
    if (!isSshConnected && server.status !== 'unconnected') {
      unconnected += 1;
    }

    if (hasFreshServerTelemetry(server)) {
      cpuTotal += server.cpu;
      memoryTotal += server.memory;
      diskTotal += server.disk;
      freshTelemetry += 1;
    }
    incrementCount(providerCounts, server.provider || 'unknown');
    incrementCount(regionCounts, server.region || 'unknown');

    const load = hasFreshServerTelemetry(server) ? Math.max(server.cpu, server.memory, server.disk) : 0;
    if (hasFreshServerTelemetry(server) && load > 75) {
      insertTopServer(highLoadServers, { server, load }, promptHighLoadLimit);
    }
  }

  return {
    total: servers.length,
    running,
    stopped,
    warning,
    unconnected,
    sshConnected,
    freshTelemetry,
    avgCpu: average(cpuTotal, freshTelemetry),
    avgMemory: average(memoryTotal, freshTelemetry),
    avgDisk: average(diskTotal, freshTelemetry),
    providers: topCountGroups(providerCounts, promptGroupLimit),
    regions: topCountGroups(regionCounts, promptGroupLimit),
    sampleServers,
    omittedServers: Math.max(0, servers.length - sampleServers.length),
    highLoadServers,
  };
}

function incrementCount(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function insertTopServer(items: ServerRiskEntry[], entry: ServerRiskEntry, limit: number) {
  const insertAt = items.findIndex((item) => entry.load > item.load);
  if (insertAt >= 0) {
    items.splice(insertAt, 0, entry);
  } else if (items.length < limit) {
    items.push(entry);
  }

  if (items.length > limit) {
    items.length = limit;
  }
}

function topCountGroups(counts: Map<string, number>, limit: number): CountGroup[] {
  const top: CountGroup[] = [];
  for (const [key, count] of counts) {
    const entry = { key, count };
    const insertAt = top.findIndex((item) => count > item.count);
    if (insertAt >= 0) {
      top.splice(insertAt, 0, entry);
    } else if (top.length < limit) {
      top.push(entry);
    }

    if (top.length > limit) {
      top.length = limit;
    }
  }
  return top;
}

function formatCountGroups(groups: CountGroup[]) {
  return groups.length ? groups.map((group) => `${group.key}=${group.count}`).join(', ') : 'none';
}

function average(total: number, count: number) {
  return count > 0 ? Math.round(total / count) : null;
}

function formatPromptMetric(server: ServerNode, metric: 'cpu' | 'memory' | 'disk') {
  return hasFreshServerTelemetry(server) ? `${server[metric]}%` : 'unavailable';
}

function formatPromptAverage(value: number | null) {
  return value === null ? 'unavailable' : `${value}%`;
}
