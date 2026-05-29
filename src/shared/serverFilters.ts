import type { CloudProvider, ServerNode, ServerStatus } from '../types.js';

export const baseCloudProviders = ['AWS', 'Azure', 'GCP', 'Aliyun', 'Tencent Cloud'] as const;
export const customProviderFilterValue = 'Custom';
const baseCloudProviderKeys = new Set(baseCloudProviders.map((provider) => normalizeFilterValue(provider)));
export type ServerLifecycleStatus = Extract<ServerStatus, 'running' | 'stopped' | 'unconnected'>;

export interface ServerFilters {
  query: string;
  provider: string | 'all';
  status: ServerStatus | 'all';
  region: string | 'all';
  regionScope?: string[];
}

const serverSearchTextCache = new WeakMap<ServerNode, { signature: string; searchText: string }>();

export function isBaseCloudProvider(provider: string) {
  return baseCloudProviderKeys.has(normalizeFilterValue(provider));
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
  const providerFilter = filters.provider;
  const hasProviderFilter = providerFilter !== 'all';
  const wantsCustomProvider = providerFilter === customProviderFilterValue;
  const hasStatusFilter = filters.status !== 'all';
  const hasScopedRegionFilter = scopedRegions.size > 0;
  const hasSelectedRegionFilter = !hasScopedRegionFilter && filters.region !== 'all';

  return (server: ServerNode) => {
    if (
      query.length > 0 &&
      !getServerSearchText(server).includes(query)
    ) {
      return false;
    }

    if (hasProviderFilter) {
      if (wantsCustomProvider) {
        if (!isCustomCloudProvider(server.provider)) {
          return false;
        }
      } else if (server.provider !== providerFilter) {
        return false;
      }
    }

    if (hasStatusFilter && resolveServerLifecycleStatus(server) !== filters.status) {
      return false;
    }

    if (hasScopedRegionFilter || hasSelectedRegionFilter) {
      const serverRegion = normalizeFilterValue(server.region);
      if (hasScopedRegionFilter ? !scopedRegions.has(serverRegion) : serverRegion !== selectedRegion) {
        return false;
      }
    }

    return true;
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

function getServerSearchText(server: ServerNode) {
  const signature = [
    server.name,
    server.id,
    server.region,
    server.publicIp,
    server.privateIp,
    server.os,
    server.tags.join('\u001f'),
  ].join('\u001e');
  const cached = serverSearchTextCache.get(server);
  if (cached?.signature === signature) {
    return cached.searchText;
  }

  const searchText = signature.replaceAll('\u001e', ' ').replaceAll('\u001f', ' ').toLowerCase();
  serverSearchTextCache.set(server, { signature, searchText });
  return searchText;
}
