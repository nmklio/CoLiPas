import type { ConfigSummaryResponse, OverviewResponse } from '../services/apiClient';

export type TabSyncRole = 'solo' | 'primary' | 'standby';

export interface TabSyncStats {
  overviewSnapshotsBroadcast: number;
  configSnapshotsBroadcast: number;
  overviewSnapshotsReceived: number;
  configSnapshotsReceived: number;
  avoidedOverviewPolls: number;
  lastBroadcastAt: string | null;
  lastSnapshotAt: string | null;
}

export const tabSyncChannelName = 'colipas.tab-sync.v1';
export const tabSyncLeaderStorageKey = 'colipas.tab-sync.leader.v1';
export const tabSyncLeaderLeaseMs = 7_500;
export const tabSyncHeartbeatMs = 2_000;
export const tabSyncStandbyCheckMs = 2_000;

interface TabSyncLeaderRecord {
  tabId: string;
  expiresAt: number;
  updatedAt: number;
}

interface OverviewSnapshotMessage {
  type: 'overview-snapshot';
  tabId: string;
  sentAt: number;
  refreshedAt: string;
  data: OverviewResponse;
  source: 'api' | 'fallback';
}

interface ConfigSnapshotMessage {
  type: 'config-snapshot';
  tabId: string;
  sentAt: number;
  refreshedAt: string;
  data: ConfigSummaryResponse;
}

interface LeaderReleaseMessage {
  type: 'leader-release';
  tabId: string;
  sentAt: number;
}

type TabSyncMessage = OverviewSnapshotMessage | ConfigSnapshotMessage | LeaderReleaseMessage;

const initialTabSyncStats: TabSyncStats = {
  overviewSnapshotsBroadcast: 0,
  configSnapshotsBroadcast: 0,
  overviewSnapshotsReceived: 0,
  configSnapshotsReceived: 0,
  avoidedOverviewPolls: 0,
  lastBroadcastAt: null,
  lastSnapshotAt: null,
};

function createTabId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function hasLocalStorage() {
  try {
    if (typeof window === 'undefined') {
      return false;
    }
    const key = `${tabSyncLeaderStorageKey}.probe`;
    window.localStorage.setItem(key, '1');
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function parseLeaderRecord(value: string | null): TabSyncLeaderRecord | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<TabSyncLeaderRecord>;
    const expiresAt = parsed.expiresAt;
    const updatedAt = parsed.updatedAt;
    if (
      typeof parsed.tabId === 'string'
      && typeof expiresAt === 'number'
      && Number.isFinite(expiresAt)
      && typeof updatedAt === 'number'
      && Number.isFinite(updatedAt)
    ) {
      return {
        tabId: parsed.tabId,
        expiresAt,
        updatedAt,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function supportsBroadcastChannel() {
  return typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function';
}

export class TabSyncCoordinator {
  readonly tabId = createTabId();

  private readonly storageAvailable = hasLocalStorage();

  private readonly channel: BroadcastChannel | null = supportsBroadcastChannel()
    ? new BroadcastChannel(tabSyncChannelName)
    : null;

  private environmentActive = false;

  private role: TabSyncRole = this.channel && this.storageAvailable ? 'standby' : 'solo';

  private heartbeatTimer: number | null = null;

  private disposed = false;

  private readonly roleSubscribers = new Set<(role: TabSyncRole) => void>();

  private stats: TabSyncStats = { ...initialTabSyncStats };

  private readonly statsSubscribers = new Set<(stats: TabSyncStats) => void>();

  private readonly overviewSubscribers = new Set<(snapshot: {
    data: OverviewResponse;
    refreshedAt: string;
    source: 'api' | 'fallback';
  }) => void>();

  private readonly configSubscribers = new Set<(snapshot: {
    data: ConfigSummaryResponse;
    refreshedAt: string;
  }) => void>();

  constructor() {
    if (this.channel) {
      this.channel.addEventListener('message', this.handleChannelMessage);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.handleStorageEvent);
      window.addEventListener('beforeunload', this.releaseLeadership);
      this.heartbeatTimer = window.setInterval(() => {
        this.evaluateRole();
      }, tabSyncHeartbeatMs);
    }
  }

  subscribeRole(callback: (role: TabSyncRole) => void) {
    this.roleSubscribers.add(callback);
    callback(this.role);
    return () => {
      this.roleSubscribers.delete(callback);
    };
  }

  subscribeStats(callback: (stats: TabSyncStats) => void) {
    this.statsSubscribers.add(callback);
    callback(this.getStats());
    return () => {
      this.statsSubscribers.delete(callback);
    };
  }

  subscribeOverview(callback: (snapshot: {
    data: OverviewResponse;
    refreshedAt: string;
    source: 'api' | 'fallback';
  }) => void) {
    this.overviewSubscribers.add(callback);
    return () => {
      this.overviewSubscribers.delete(callback);
    };
  }

  subscribeConfig(callback: (snapshot: {
    data: ConfigSummaryResponse;
    refreshedAt: string;
  }) => void) {
    this.configSubscribers.add(callback);
    return () => {
      this.configSubscribers.delete(callback);
    };
  }

  setEnvironmentActive(active: boolean) {
    if (this.environmentActive === active) {
      this.evaluateRole();
      return;
    }
    this.environmentActive = active;
    if (!active) {
      this.releaseLeadership();
      this.setRole(this.channel && this.storageAvailable ? 'standby' : 'solo');
      return;
    }
    this.evaluateRole();
  }

  getRole() {
    return this.role;
  }

  getStats(): TabSyncStats {
    return { ...this.stats };
  }

  shouldRunSharedRefresh() {
    return this.role !== 'standby';
  }

  broadcastOverview(snapshot: {
    data: OverviewResponse;
    refreshedAt: string;
    source: 'api' | 'fallback';
  }) {
    if (this.role !== 'standby') {
      this.updateStats({
        overviewSnapshotsBroadcast: this.stats.overviewSnapshotsBroadcast + 1,
        lastBroadcastAt: snapshot.refreshedAt,
      });
    }
    this.postMessage({
      type: 'overview-snapshot',
      tabId: this.tabId,
      sentAt: Date.now(),
      refreshedAt: snapshot.refreshedAt,
      data: snapshot.data,
      source: snapshot.source,
    });
  }

  broadcastConfig(snapshot: {
    data: ConfigSummaryResponse;
    refreshedAt: string;
  }) {
    if (this.role !== 'standby') {
      this.updateStats({
        configSnapshotsBroadcast: this.stats.configSnapshotsBroadcast + 1,
        lastBroadcastAt: snapshot.refreshedAt,
      });
    }
    this.postMessage({
      type: 'config-snapshot',
      tabId: this.tabId,
      sentAt: Date.now(),
      refreshedAt: snapshot.refreshedAt,
      data: snapshot.data,
    });
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.releaseLeadership();
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.handleStorageEvent);
      window.removeEventListener('beforeunload', this.releaseLeadership);
    }
    if (this.channel) {
      this.channel.removeEventListener('message', this.handleChannelMessage);
      this.channel.close();
    }
    this.roleSubscribers.clear();
    this.statsSubscribers.clear();
    this.overviewSubscribers.clear();
    this.configSubscribers.clear();
  }

  private evaluateRole = () => {
    if (this.disposed) {
      return;
    }
    if (!this.channel || !this.storageAvailable || typeof window === 'undefined') {
      this.setRole('solo');
      return;
    }
    if (!this.environmentActive) {
      this.releaseLeadership();
      this.setRole('standby');
      return;
    }

    const now = Date.now();
    const record = parseLeaderRecord(window.localStorage.getItem(tabSyncLeaderStorageKey));
    if (!record || record.expiresAt <= now || record.tabId === this.tabId) {
      const nextRecord: TabSyncLeaderRecord = {
        tabId: this.tabId,
        expiresAt: now + tabSyncLeaderLeaseMs,
        updatedAt: now,
      };
      try {
        window.localStorage.setItem(tabSyncLeaderStorageKey, JSON.stringify(nextRecord));
        this.setRole('primary');
      } catch {
        this.setRole('solo');
      }
      return;
    }

    this.setRole('standby');
  };

  private releaseLeadership = () => {
    if (!this.storageAvailable || typeof window === 'undefined') {
      return;
    }
    const record = parseLeaderRecord(window.localStorage.getItem(tabSyncLeaderStorageKey));
    if (record?.tabId === this.tabId) {
      try {
        window.localStorage.removeItem(tabSyncLeaderStorageKey);
      } catch {
        // If storage fails, the lease naturally expires.
      }
      this.postMessage({ type: 'leader-release', tabId: this.tabId, sentAt: Date.now() });
    }
    if (this.role === 'primary') {
      this.setRole(this.channel ? 'standby' : 'solo');
    }
  };

  private handleStorageEvent = (event: StorageEvent) => {
    if (event.key === tabSyncLeaderStorageKey) {
      this.evaluateRole();
    }
  };

  private handleChannelMessage = (event: MessageEvent<TabSyncMessage>) => {
    const message = event.data;
    if (!message || message.tabId === this.tabId) {
      return;
    }
    if (message.type === 'leader-release') {
      this.evaluateRole();
      return;
    }
    if (message.type === 'overview-snapshot') {
      this.updateStats({
        overviewSnapshotsReceived: this.stats.overviewSnapshotsReceived + 1,
        avoidedOverviewPolls: this.stats.avoidedOverviewPolls + 1,
        lastSnapshotAt: message.refreshedAt,
      });
      for (const subscriber of this.overviewSubscribers) {
        subscriber({
          data: message.data,
          refreshedAt: message.refreshedAt,
          source: message.source,
        });
      }
      return;
    }
    if (message.type === 'config-snapshot') {
      this.updateStats({
        configSnapshotsReceived: this.stats.configSnapshotsReceived + 1,
        lastSnapshotAt: message.refreshedAt,
      });
      for (const subscriber of this.configSubscribers) {
        subscriber({
          data: message.data,
          refreshedAt: message.refreshedAt,
        });
      }
    }
  };

  private updateStats(nextStats: Partial<TabSyncStats>) {
    this.stats = {
      ...this.stats,
      ...nextStats,
    };
    for (const subscriber of this.statsSubscribers) {
      subscriber(this.getStats());
    }
  }

  private postMessage(message: TabSyncMessage) {
    try {
      this.channel?.postMessage(message);
    } catch {
      // Cross-tab sync is an optimization; local refresh remains authoritative.
    }
  }

  private setRole(nextRole: TabSyncRole) {
    if (this.role === nextRole) {
      return;
    }
    this.role = nextRole;
    for (const subscriber of this.roleSubscribers) {
      subscriber(nextRole);
    }
  }
}

export function createTabSyncCoordinator() {
  return new TabSyncCoordinator();
}
