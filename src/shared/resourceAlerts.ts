import type {
  ResourceAlertEvaluation,
  ResourceAlertMetric,
  ResourceAlertPolicy,
  ResourceAlertPolicyUpdate,
  ResourceAlertSignal,
  ServerNode,
} from '../types.js';

export const resourceAlertThresholdMinimum = 50;
export const resourceAlertThresholdMaximum = 95;
export const resourceAlertReminderOptions = [15, 30, 60, 180, 360, 720, 1440] as const;
export const resourceAlertSignalLimit = 24;

export const defaultResourceAlertPolicy: ResourceAlertPolicy = {
  enabled: true,
  cpuThreshold: 85,
  memoryThreshold: 85,
  diskThreshold: 80,
  reminderMinutes: 60,
  updatedAt: null,
};

const metricOrder: ResourceAlertMetric[] = ['cpu', 'memory', 'disk'];

export function toResourceAlertPolicyUpdate(policy: ResourceAlertPolicy): ResourceAlertPolicyUpdate {
  return {
    enabled: policy.enabled,
    cpuThreshold: policy.cpuThreshold,
    memoryThreshold: policy.memoryThreshold,
    diskThreshold: policy.diskThreshold,
    reminderMinutes: policy.reminderMinutes,
  };
}

export function buildResourceAlertEvaluation(
  servers: ServerNode[],
  policy: ResourceAlertPolicy,
  signalLimit = resourceAlertSignalLimit,
): ResourceAlertEvaluation {
  if (!policy.enabled) {
    return emptyResourceAlertEvaluation();
  }

  const affectedServerIds = new Set<string>();
  const signals: ResourceAlertSignal[] = [];
  const boundedLimit = normalizeResourceAlertSignalLimit(signalLimit);
  let activeAlerts = 0;
  let criticalAlerts = 0;
  let evaluatedServers = 0;

  for (const server of servers) {
    if (!server.ssh?.connected || server.status === 'stopped' || server.status === 'unconnected') {
      continue;
    }

    evaluatedServers += 1;
    for (const metric of metricOrder) {
      const value = normalizeMetricValue(server[metric]);
      const threshold = readMetricThreshold(policy, metric);
      if (value < threshold) {
        continue;
      }

      const severity = value >= Math.min(95, threshold + 10) ? 'critical' : 'warning';
      activeAlerts += 1;
      criticalAlerts += severity === 'critical' ? 1 : 0;
      affectedServerIds.add(server.id);
      insertBoundedResourceAlertSignal(signals, {
        id: hashResourceAlertId(`${server.id}:${metric}:${threshold}`),
        serverId: server.id,
        serverName: server.name,
        metric,
        value,
        threshold,
        overage: value - threshold,
        severity,
      }, boundedLimit);
    }
  }

  return {
    summary: {
      activeAlerts,
      affectedServers: affectedServerIds.size,
      criticalAlerts,
      evaluatedServers,
      truncated: activeAlerts > signals.length,
    },
    signals,
  };
}

function emptyResourceAlertEvaluation(): ResourceAlertEvaluation {
  return {
    summary: {
      activeAlerts: 0,
      affectedServers: 0,
      criticalAlerts: 0,
      evaluatedServers: 0,
      truncated: false,
    },
    signals: [],
  };
}

function readMetricThreshold(policy: ResourceAlertPolicy, metric: ResourceAlertMetric) {
  if (metric === 'cpu') {
    return policy.cpuThreshold;
  }
  if (metric === 'memory') {
    return policy.memoryThreshold;
  }
  return policy.diskThreshold;
}

function normalizeMetricValue(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function compareResourceAlertSignals(left: ResourceAlertSignal, right: ResourceAlertSignal) {
  if (left.severity !== right.severity) {
    return left.severity === 'critical' ? -1 : 1;
  }
  if (left.overage !== right.overage) {
    return right.overage - left.overage;
  }
  if (left.value !== right.value) {
    return right.value - left.value;
  }
  const serverOrder = left.serverName.localeCompare(right.serverName);
  if (serverOrder !== 0) {
    return serverOrder;
  }
  return metricOrder.indexOf(left.metric) - metricOrder.indexOf(right.metric);
}

function normalizeResourceAlertSignalLimit(value: number) {
  if (!Number.isFinite(value)) {
    return resourceAlertSignalLimit;
  }
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function insertBoundedResourceAlertSignal(
  signals: ResourceAlertSignal[],
  signal: ResourceAlertSignal,
  limit: number,
) {
  let low = 0;
  let high = signals.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareResourceAlertSignals(signal, signals[middle]) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  signals.splice(low, 0, signal);
  if (signals.length > limit) {
    signals.pop();
  }
}

function hashResourceAlertId(value: string) {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + ((index + 1) * 19)), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(36)}${(right >>> 0).toString(36)}`.slice(0, 20);
}
