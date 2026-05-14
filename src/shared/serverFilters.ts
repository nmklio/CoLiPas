import type { CloudProvider, ServerNode, ServerStatus } from '../types.js';

export const baseCloudProviders = ['AWS', 'Azure', 'GCP', 'Aliyun', 'Tencent Cloud'] as const;
export const customProviderFilterValue = 'Custom';
export type ServerLifecycleStatus = Extract<ServerStatus, 'running' | 'stopped' | 'unconnected'>;

export interface ServerFilters {
  query: string;
  provider: string | 'all';
  status: ServerStatus | 'all';
  region: string | 'all';
  regionScope?: string[];
}

export function isBaseCloudProvider(provider: string) {
  return baseCloudProviders.some((baseProvider) => baseProvider.toLowerCase() === provider.trim().toLowerCase());
}

export function isCustomCloudProvider(provider: string) {
  return provider.trim().length > 0 && !isBaseCloudProvider(provider);
}

export function filterServers(servers: ServerNode[], filters: ServerFilters) {
  const matcher = buildServerFilterMatcher(filters);
  return servers.filter(matcher);
}

export function matchesServerFilters(server: ServerNode, filters: ServerFilters) {
  return buildServerFilterMatcher(filters)(server);
}

export function buildServerFilterMatcher(filters: ServerFilters) {
  const query = filters.query.trim().toLowerCase();
  const scopedRegions = new Set((filters.regionScope ?? []).map(normalizeFilterValue).filter(Boolean));
  const selectedRegion = normalizeFilterValue(filters.region);

  return (server: ServerNode) => {
    const serverRegion = normalizeFilterValue(server.region);
    const matchesQuery =
      query.length === 0 ||
      [server.name, server.id, server.region, server.publicIp, server.privateIp, server.os, ...server.tags]
        .join(' ')
        .toLowerCase()
        .includes(query);
    const matchesProvider =
      filters.provider === 'all' ||
      (filters.provider === customProviderFilterValue
        ? isCustomCloudProvider(server.provider)
        : server.provider === filters.provider);
    const lifecycleStatus = resolveServerLifecycleStatus(server);
    const matchesStatus = filters.status === 'all' || lifecycleStatus === filters.status;
    const matchesRegion = scopedRegions.size > 0
      ? scopedRegions.has(serverRegion)
      : filters.region === 'all' || serverRegion === selectedRegion;

    return matchesQuery && matchesProvider && matchesStatus && matchesRegion;
  };
}

export function resolveServerLifecycleStatus(server: ServerNode): ServerLifecycleStatus {
  if (!server.ssh?.connected) {
    return 'unconnected';
  }

  if (server.status === 'stopped') {
    return 'stopped';
  }

  return 'running';
}

function normalizeFilterValue(value: string) {
  return value.trim().toLowerCase();
}
