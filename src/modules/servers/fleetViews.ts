import type { ServerFilters } from '../../shared/serverFilters';

export interface FleetView {
  id: string;
  name: string;
  filters: ServerFilters;
  createdAt: string;
}

export const fleetViewsStorageKey = 'colipas.serverFleetViews.v1';
export const fleetViewsLimit = 8;

const validStatuses = new Set<string>(['all', 'running', 'stopped', 'warning', 'provisioning', 'unconnected']);
const validHealthFilters = new Set<string>(['resourcePressure', 'sshMissing', 'sshSimulated']);

export function readFleetViews(): FleetView[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(fleetViewsStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.map(sanitizeFleetView).filter((view): view is FleetView => Boolean(view))
      : [];
  } catch {
    return [];
  }
}

export function writeFleetViews(views: FleetView[]) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(fleetViewsStorageKey, JSON.stringify(views.map(sanitizeFleetView).filter(Boolean)));
  } catch {
    // A full or restricted browser storage area must not block inventory filtering.
  }
}

export function captureFleetViewFilters(filters: ServerFilters): ServerFilters {
  const regionScope = normalizeRegionScope(filters.regionScope);
  const health = validHealthFilters.has(filters.health ?? '') ? filters.health : undefined;
  const status = validStatuses.has(filters.status) ? filters.status : 'all';
  const provider = normalizeValue(filters.provider, 80) || 'all';
  const region = regionScope.length > 0 ? 'all' : normalizeValue(filters.region, 80) || 'all';

  return {
    query: normalizeValue(filters.query, 120),
    provider,
    status,
    region,
    ...(regionScope.length > 0 ? { regionScope } : {}),
    ...(health ? { health } : {}),
  };
}

export function sameFleetViewFilters(left: ServerFilters, right: ServerFilters) {
  return JSON.stringify(captureFleetViewFilters(left)) === JSON.stringify(captureFleetViewFilters(right));
}

export function countFleetViewFilters(filters: ServerFilters) {
  const normalized = captureFleetViewFilters(filters);
  return [
    normalized.query.length > 0,
    normalized.provider !== 'all',
    normalized.status !== 'all',
    normalized.region !== 'all' || (normalized.regionScope?.length ?? 0) > 0,
    Boolean(normalized.health),
  ].filter(Boolean).length;
}

export function normalizeFleetViewName(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 36);
}

export function createFleetView(name: string, filters: ServerFilters): FleetView | null {
  const normalizedName = normalizeFleetViewName(name);
  if (!normalizedName) {
    return null;
  }

  return {
    id: createFleetViewId(),
    name: normalizedName,
    filters: captureFleetViewFilters(filters),
    createdAt: new Date().toISOString(),
  };
}

function sanitizeFleetView(value: unknown): FleetView | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<FleetView>;
  const id = typeof candidate.id === 'string' && /^[a-z0-9_-]{8,80}$/i.test(candidate.id) ? candidate.id : '';
  const name = normalizeFleetViewName(typeof candidate.name === 'string' ? candidate.name : '');
  if (!id || !name || !candidate.filters || typeof candidate.filters !== 'object') {
    return null;
  }

  return {
    id,
    name,
    filters: captureFleetViewFilters(candidate.filters as ServerFilters),
    createdAt: typeof candidate.createdAt === 'string' && candidate.createdAt.length <= 40 ? candidate.createdAt : new Date(0).toISOString(),
  };
}

function normalizeRegionScope(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => normalizeValue(item, 80))
    .filter(Boolean)))
    .slice(0, 12);
}

function normalizeValue(value: unknown, limit: number) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function createFleetViewId() {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : Math.random().toString(36).slice(2, 12);
  return `view-${Date.now().toString(36)}-${random}`;
}
