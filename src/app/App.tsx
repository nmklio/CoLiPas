import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  CheckCircle2,
  ClipboardCheck,
  Command,
  Cpu,
  Gauge,
  HardDrive,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Maximize2,
  MessageSquareText,
  Menu,
  Minimize2,
  MoreHorizontal,
  PlugZap,
  RefreshCw,
  Rocket,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  UserCog,
  X,
} from 'lucide-react';
import { getLocale, languageOptions, useI18n } from '../i18n';
import { LoginPage } from './LoginPage';
import type { OperationsDraft } from '../modules/operations/OperationsCenter';
import type { OverviewPreflightSnapshot } from '../modules/overview/MonitoringOverview';
import type { ServerFleetTriageCardId } from '../modules/servers/ServerInventory';
import { BrandIcon } from './BrandIcon';
import {
  cloudAccounts as fallbackCloudAccounts,
  operationEvents as fallbackOperationEvents,
  servers as fallbackServers,
} from '../data/mockData';
import { ServerFilters, filterServers } from '../modules/servers/serverFilters';
import { resolveServerLifecycleStatus } from '../shared/serverFilters';
import {
  AccountProfile,
  AuthRequiredError,
  AuthSession,
  ConfigSummaryResponse,
  OverviewResponse,
  changeAccountPassword,
  fetchAuthSession,
  fetchConfigSummary,
  fetchOverview,
  login,
  logout,
  updateAccountProfile,
} from '../services/apiClient';
import type { OperationTaskPreflightResponse, ServerNode } from '../types';

type SectionId = 'overview' | 'servers' | 'operations' | 'ai' | 'api' | 'security';

interface ReleaseFixFocusPayload {
  id: string;
  moduleLabel: string;
  title: string;
  value: string;
  action: string;
  source: string;
  anchor: string;
}

interface ReleaseFixFocus extends ReleaseFixFocusPayload {
  targetSection: SectionId;
}

interface LaunchChecklistItem {
  id: 'runtime' | 'assets' | 'ssh' | 'ai' | 'preflight' | 'audit';
  title: string;
  detail: string;
  action: string;
  section: SectionId;
  tone: 'ok' | 'warn' | 'fail';
}

interface LaunchRemediationStep {
  id: string;
  rank: number;
  item: LaunchChecklistItem;
  priority: string;
  reason: string;
}

interface LaunchChecklistSummary {
  tone: 'ok' | 'warn' | 'fail';
  done: number;
  total: number;
  status: string;
  nextAction: string;
  items: LaunchChecklistItem[];
  remediationSteps: LaunchRemediationStep[];
}

type LaunchGuideViewPreference = 'auto' | 'compact' | 'expanded';

const sections: Array<{ id: SectionId; labelKey: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', labelKey: 'nav.overview', icon: LayoutDashboard },
  { id: 'servers', labelKey: 'nav.servers', icon: Server },
  { id: 'operations', labelKey: 'nav.operations', icon: TerminalSquare },
  { id: 'ai', labelKey: 'nav.ai', icon: Bot },
  { id: 'api', labelKey: 'nav.api', icon: PlugZap },
  { id: 'security', labelKey: 'nav.security', icon: ShieldCheck },
];

const LazyMonitoringOverview = lazy(async () => {
  const module = await import('../modules/overview/MonitoringOverview');
  return { default: module.MonitoringOverview };
});
const LazyServerInventory = lazy(async () => {
  const module = await import('../modules/servers/ServerInventory');
  return { default: module.ServerInventory };
});
const LazyOperationsCenter = lazy(async () => {
  const module = await import('../modules/operations/OperationsCenter');
  return { default: module.OperationsCenter };
});
const LazyCustomApiLab = lazy(async () => {
  const module = await import('../modules/custom-api/CustomApiLab');
  return { default: module.CustomApiLab };
});
const LazySecurityPanel = lazy(async () => {
  const module = await import('../modules/security/SecurityPanel');
  return { default: module.SecurityPanel };
});
const LazyAIConsole = lazy(async () => {
  const module = await import('../modules/ai/AIConsole');
  return { default: module.AIConsole };
});

function preloadSectionModule(section: SectionId) {
  if (section === 'overview') {
    void import('../modules/overview/MonitoringOverview');
    return;
  }
  if (section === 'servers') {
    void import('../modules/servers/ServerInventory');
    return;
  }
  if (section === 'operations') {
    void import('../modules/operations/OperationsCenter');
    return;
  }
  if (section === 'api') {
    void import('../modules/custom-api/CustomApiLab');
    return;
  }
  if (section === 'security') {
    void import('../modules/security/SecurityPanel');
    return;
  }
  preloadAiConsole();
}

function preloadAiConsole() {
  void import('../modules/ai/AIConsole');
}

function warmIdleAdminModules(activeSection: SectionId, aiCollapsed: boolean) {
  const warmSections: SectionId[] = activeSection === 'overview'
    ? ['servers', 'operations', 'security']
    : ['overview', 'servers', 'operations'];
  warmSections.forEach(preloadSectionModule);
  if (!aiCollapsed || activeSection === 'ai') {
    preloadAiConsole();
  }
}

function ModuleLoadingFallback({ title, compact = false }: { title: string; compact?: boolean }) {
  const { t } = useI18n();
  return (
    <section className={compact ? 'module-loading-card compact' : 'module-loading-card'} aria-busy="true">
      <div className="module-loading-orb" aria-hidden="true">
        <Sparkles size={20} />
      </div>
      <div>
        <p>{t('app.moduleLoadingOptimize')}</p>
        <h2>{t('app.moduleLoadingTitle', { title })}</h2>
        <span>{t('app.moduleLoadingDetail')}</span>
      </div>
    </section>
  );
}

interface CommandPaletteAction {
  id: string;
  title: string;
  description: string;
  category: string;
  icon: typeof LayoutDashboard;
  keywords: string;
  run: () => void;
}

interface CommandPaletteGroup {
  id: 'continue' | 'recent' | 'all' | 'results';
  title: string;
  actions: CommandPaletteAction[];
}

interface HashRoute {
  section: SectionId;
  traceId: string;
  matched: boolean;
}

const defaultFilters: ServerFilters = {
  query: '',
  provider: 'all',
  status: 'all',
  region: 'all',
};
const overviewTriageCommand = [
  "printf '== CoLiPas health triage ==\\n'",
  'hostname',
  'uptime',
  "printf '\\n== Disk ==\\n'",
  'df -h /',
  "printf '\\n== Memory ==\\n'",
  '(free -m || vm_stat) 2>/dev/null || true',
  "printf '\\n== Top CPU ==\\n'",
  "ps -eo pid,comm,%cpu,%mem --sort=-%cpu 2>/dev/null | head -8 || true",
].join(' && ');
const avatarMaxBytes = 2 * 1024 * 1024;
const avatarMaxDimension = 4096;
const settingsMessageTtlMs = 2800;
const launchGuideStorageKey = 'colipas.launchGuide.dismissed.v1';
const launchGuideViewStorageKey = 'colipas.launchGuide.view.v1';
const performanceModeStorageKey = 'colipas.performanceMode.v1';
const commandPaletteHistoryStorageKey = 'colipas.commandPaletteHistory.v1';
const commandPaletteHistoryLimit = 5;
const commandPaletteHistoryIdPattern = /^(?:section-(?:overview|servers|operations|ai|api|security)|next-remediation|launch-guide|open-ai|refresh-assets|account-settings)$/;

function isSectionId(value: string): value is SectionId {
  return sections.some((section) => section.id === value);
}

function normalizeTraceRouteId(value: string | null | undefined) {
  const traceId = (value ?? '').trim().toLowerCase();
  return /^(ops|srv)-trace-[a-f0-9-]{36}$/.test(traceId) ? traceId : '';
}

function readHashRoute(): HashRoute {
  if (typeof window === 'undefined') {
    return { section: 'overview', traceId: '', matched: false };
  }

  const rawHash = window.location.hash.replace(/^#/, '').trim();
  if (!rawHash) {
    return { section: 'overview', traceId: '', matched: false };
  }

  const queryStart = rawHash.indexOf('?');
  const sectionPart = queryStart >= 0 ? rawHash.slice(0, queryStart) : rawHash;
  const queryPart = queryStart >= 0 ? rawHash.slice(queryStart + 1) : '';
  const matched = isSectionId(sectionPart);
  const section = matched ? sectionPart : 'overview';
  const traceId = section === 'security' ? normalizeTraceRouteId(new URLSearchParams(queryPart).get('trace')) : '';
  return { section, traceId, matched };
}

function readStoredPerformanceMode() {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.localStorage.getItem(performanceModeStorageKey) === '1';
}

function readLaunchGuideViewPreference(): LaunchGuideViewPreference {
  if (typeof window === 'undefined') {
    return 'auto';
  }

  const stored = window.localStorage.getItem(launchGuideViewStorageKey);
  return stored === 'compact' || stored === 'expanded' ? stored : 'auto';
}

function normalizeCommandPaletteHistory(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value.filter((item): item is string => (
    typeof item === 'string' && commandPaletteHistoryIdPattern.test(item)
  )))).slice(0, commandPaletteHistoryLimit);
}

function readCommandPaletteHistory() {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    return normalizeCommandPaletteHistory(JSON.parse(window.localStorage.getItem(commandPaletteHistoryStorageKey) ?? '[]'));
  } catch {
    return [];
  }
}

function writeCommandPaletteHistory(history: string[]) {
  if (typeof window === 'undefined') {
    return;
  }

  const normalizedHistory = normalizeCommandPaletteHistory(history);
  if (normalizedHistory.length === 0) {
    window.localStorage.removeItem(commandPaletteHistoryStorageKey);
    return;
  }
  window.localStorage.setItem(commandPaletteHistoryStorageKey, JSON.stringify(normalizedHistory));
}

function writeHashRoute(section: SectionId, traceId = '') {
  if (typeof window === 'undefined') {
    return;
  }

  const normalizedTraceId = section === 'security' ? normalizeTraceRouteId(traceId) : '';
  const nextHash = normalizedTraceId ? `#${section}?trace=${encodeURIComponent(normalizedTraceId)}` : `#${section}`;
  if (window.location.hash === nextHash) {
    return;
  }

  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
}

const fallbackOverview: OverviewResponse = {
  cloudAccounts: fallbackCloudAccounts,
  servers: fallbackServers,
  operationEvents: fallbackOperationEvents,
  summary: {
    totalServers: fallbackServers.length,
    onlineServers: fallbackServers.filter((server) => resolveServerLifecycleStatus(server) === 'running').length,
    openEvents: fallbackOperationEvents.filter((event) => event.status === 'open').length,
  },
};

const fallbackProfile: AccountProfile = {
  displayName: 'CoLiPas',
  avatarText: 'CP',
  avatarImage: '',
};

export function App() {
  const { language, setLanguage, t } = useI18n();
  const initialHashRouteRef = useRef<HashRoute | null>(null);
  if (!initialHashRouteRef.current) {
    initialHashRouteRef.current = readHashRoute();
  }
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [profile, setProfile] = useState<AccountProfile>(fallbackProfile);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsSuccess, setSettingsSuccess] = useState('');
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState('');
  const [commandPaletteHistory, setCommandPaletteHistory] = useState(readCommandPaletteHistory);
  const [profileDraft, setProfileDraft] = useState<AccountProfile>(fallbackProfile);
  const [passwordDraft, setPasswordDraft] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const avatarUploadRef = useRef<HTMLInputElement | null>(null);
  const commandSearchRef = useRef<HTMLInputElement | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>(initialHashRouteRef.current.section);
  const [releaseFixFocus, setReleaseFixFocus] = useState<ReleaseFixFocus | null>(null);
  const [securityTraceFocusId, setSecurityTraceFocusId] = useState(initialHashRouteRef.current.traceId);
  const [filters, setFilters] = useState<ServerFilters>(defaultFilters);
  const [operationDraft, setOperationDraft] = useState<OperationsDraft | null>(null);
  const [overviewPreflightSnapshot, setOverviewPreflightSnapshot] = useState<OverviewPreflightSnapshot | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileUtilityOpen, setMobileUtilityOpen] = useState(false);
  const [aiCollapsed, setAiCollapsed] = useState(true);
  const [performanceMode, setPerformanceMode] = useState(readStoredPerformanceMode);
  const [aiSeedQuestion, setAiSeedQuestion] = useState('');
  const [overview, setOverview] = useState<OverviewResponse>(fallbackOverview);
  const [configSummary, setConfigSummary] = useState<ConfigSummaryResponse | null>(null);
  const [dataSource, setDataSource] = useState<'api' | 'fallback'>('fallback');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [launchGuideOpen, setLaunchGuideOpen] = useState(() => {
    if (typeof window === 'undefined') {
      return true;
    }
    return window.localStorage.getItem(launchGuideStorageKey) !== 'dismissed';
  });
  const [launchGuideViewPreference, setLaunchGuideViewPreference] = useState<LaunchGuideViewPreference>(readLaunchGuideViewPreference);
  const [launchGuideMessage, setLaunchGuideMessage] = useState('');
  const [launchGuideRefreshing, setLaunchGuideRefreshing] = useState(false);
  const appMountedRef = useRef(true);
  const sessionAuthenticatedRef = useRef(false);
  const overviewRefreshInFlightRef = useRef(false);
  const settingsMessageTimerRef = useRef<number | null>(null);
  const launchGuideMessageTimerRef = useRef<number | null>(null);

  async function refreshOverview() {
    if ((!session?.authenticated && !sessionAuthenticatedRef.current) || overviewRefreshInFlightRef.current) {
      return false;
    }
    overviewRefreshInFlightRef.current = true;
    try {
      const { data, source } = await fetchOverview();
      if (!appMountedRef.current || !sessionAuthenticatedRef.current) {
        return false;
      }
      setOverview(data);
      setDataSource(source);
      setLastRefreshedAt(new Date());
      return true;
    } catch (error) {
      if (appMountedRef.current && error instanceof AuthRequiredError) {
        setSession(null);
        setAiCollapsed(true);
      }
      return false;
    } finally {
      overviewRefreshInFlightRef.current = false;
    }
  }

  async function refreshConfigSummary() {
    if (!session?.authenticated && !sessionAuthenticatedRef.current) {
      return false;
    }
    try {
      const nextConfig = await fetchConfigSummary();
      if (!appMountedRef.current || !sessionAuthenticatedRef.current) {
        return false;
      }
      setConfigSummary(nextConfig);
      return true;
    } catch (error) {
      if (appMountedRef.current && error instanceof AuthRequiredError) {
        setSession(null);
        setAiCollapsed(true);
      }
      return false;
    }
  }

  useEffect(() => {
    let mounted = true;
    fetchAuthSession()
      .then((nextSession) => {
        if (mounted) {
          setSession(nextSession.authenticated ? nextSession : null);
          if (nextSession.profile) {
            setProfile(nextSession.profile);
          }
        }
      })
      .catch(() => {
        if (mounted) {
          setSession(null);
        }
      })
      .finally(() => {
        if (mounted) {
          setAuthLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      appMountedRef.current = false;
    };
  }, []);

  useEffect(() => () => {
    if (settingsMessageTimerRef.current) {
      window.clearTimeout(settingsMessageTimerRef.current);
    }
    if (launchGuideMessageTimerRef.current) {
      window.clearTimeout(launchGuideMessageTimerRef.current);
    }
  }, []);

  useEffect(() => {
    sessionAuthenticatedRef.current = Boolean(session?.authenticated);
  }, [session?.authenticated]);

  useEffect(() => {
    window.localStorage.setItem(performanceModeStorageKey, performanceMode ? '1' : '0');
  }, [performanceMode]);

  useEffect(() => {
    try {
      if (launchGuideViewPreference === 'auto') {
        window.localStorage.removeItem(launchGuideViewStorageKey);
      } else {
        window.localStorage.setItem(launchGuideViewStorageKey, launchGuideViewPreference);
      }
    } catch {
      // The guide remains usable if browser storage is unavailable.
    }
  }, [launchGuideViewPreference]);

  useEffect(() => {
    if (!session?.authenticated) {
      return undefined;
    }

    preloadSectionModule(activeSection);
    if (!performanceMode && activeSection === 'overview') {
      preloadSectionModule('servers');
    }
    if (
      activeSection === 'ai'
      || aiSeedQuestion
      || releaseFixFocus?.targetSection === 'ai'
      || (!performanceMode && !aiCollapsed)
    ) {
      preloadAiConsole();
    }
    if (performanceMode) {
      return undefined;
    }

    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(() => warmIdleAdminModules(activeSection, aiCollapsed), { timeout: 2600 });
      return () => window.cancelIdleCallback(handle);
    }

    const timer = window.setTimeout(() => warmIdleAdminModules(activeSection, aiCollapsed), 1200);
    return () => window.clearTimeout(timer);
  }, [activeSection, aiCollapsed, aiSeedQuestion, performanceMode, releaseFixFocus?.targetSection, session?.authenticated]);

  useEffect(() => {
    function syncRouteFromHash() {
      const route = readHashRoute();
      setActiveSection(route.section);
      setSecurityTraceFocusId(route.traceId);
      setSidebarOpen(false);
    }

    window.addEventListener('hashchange', syncRouteFromHash);
    return () => window.removeEventListener('hashchange', syncRouteFromHash);
  }, []);

  useEffect(() => {
    if (!session?.authenticated) {
      return undefined;
    }

    void refreshOverview();
    void refreshConfigSummary();
    return undefined;
  }, [session?.authenticated]);

  useEffect(() => {
    if (!session?.authenticated) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      refreshOverview().catch(() => undefined);
    }, 15000);

    return () => window.clearInterval(timer);
  }, [session?.authenticated]);

  useEffect(() => {
    if (!settingsError && !settingsSuccess) {
      return undefined;
    }

    if (settingsMessageTimerRef.current) {
      window.clearTimeout(settingsMessageTimerRef.current);
    }

    settingsMessageTimerRef.current = window.setTimeout(() => {
      setSettingsError('');
      setSettingsSuccess('');
      settingsMessageTimerRef.current = null;
    }, settingsMessageTtlMs);

    return () => {
      if (settingsMessageTimerRef.current) {
        window.clearTimeout(settingsMessageTimerRef.current);
        settingsMessageTimerRef.current = null;
      }
    };
  }, [settingsError, settingsSuccess]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
    setMobileUtilityOpen(false);
  }, [activeSection]);

  useEffect(() => {
    if (filters.region === 'all' && !(filters.regionScope?.length)) {
      return;
    }

    const availableRegions = new Set(overview.servers.map((server) => server.region.trim().toLowerCase()).filter(Boolean));
    const scopedRegions = filters.regionScope ?? [];
    const validRegionScope = scopedRegions.filter((region) => availableRegions.has(region.trim().toLowerCase()));
    const selectedRegion = filters.region.trim().toLowerCase();
    const regionIsStale = filters.region !== 'all' && !availableRegions.has(selectedRegion);

    if (regionIsStale || (scopedRegions.length > 0 && validRegionScope.length !== scopedRegions.length)) {
      setFilters((current) => {
        const currentScope = current.regionScope ?? [];
        const nextScope = currentScope.filter((region) => availableRegions.has(region.trim().toLowerCase()));
        const currentRegionIsStale = current.region !== 'all' && !availableRegions.has(current.region.trim().toLowerCase());
        return {
          ...current,
          region: nextScope.length === 1 ? nextScope[0] : currentRegionIsStale ? 'all' : current.region,
          regionScope: nextScope.length > 0 ? nextScope : undefined,
        };
      });
    }
  }, [filters.region, filters.regionScope, overview.servers]);

  const filteredServers = useMemo(
    () => (activeSection === 'servers' ? filterServers(overview.servers, filters) : []),
    [activeSection, filters, overview.servers],
  );
  const overviewStats = useMemo(() => {
    if (
      Number.isInteger(overview.summary.onlineServers)
      && Number.isInteger(overview.summary.openEvents)
      && Number.isInteger(overview.summary.connectedSsh)
      && Number.isInteger(overview.summary.avgCpu)
    ) {
      return {
        onlineCount: overview.summary.onlineServers,
        avgCpu: overview.summary.avgCpu ?? 0,
        connectedCount: overview.summary.connectedSsh ?? 0,
        openEventCount: overview.summary.openEvents,
        busiestServer: overview.summary.busiestServer,
      };
    }

    let online = 0;
    let connected = 0;
    let cpuTotal = 0;
    let busiest: ServerNode | undefined;
    let busiestLoad = -1;

    for (const server of overview.servers) {
      if (resolveServerLifecycleStatus(server) === 'running') {
        online += 1;
      }
      if (server.ssh?.connected) {
        connected += 1;
      }
      cpuTotal += server.cpu;

      const load = Math.max(server.cpu, server.memory, server.disk);
      if (load > busiestLoad) {
        busiest = server;
        busiestLoad = load;
      }
    }

    return {
      onlineCount: online,
      avgCpu: overview.servers.length > 0 ? Math.round(cpuTotal / overview.servers.length) : 0,
      connectedCount: connected,
      openEventCount: overview.operationEvents.reduce((count, event) => count + (event.status === 'open' ? 1 : 0), 0),
      busiestServer: busiest,
    };
  }, [overview.operationEvents, overview.servers, overview.summary]);
  const { onlineCount, avgCpu, connectedCount, openEventCount, busiestServer } = overviewStats;
  const timeLocale = getLocale(language);
  const sessionIdentity = session?.user?.username?.trim() ?? '';
  const sidebarDisplayLabel = profile.displayName || 'CoLiPas';
  const accountDisplayLabel = sessionIdentity || sidebarDisplayLabel;
  const sessionTooltip = session?.expiresAt
    ? `${accountDisplayLabel} - ${t('login.expiresAt', { time: new Date(session.expiresAt).toLocaleString(timeLocale) })}`
    : accountDisplayLabel;
  const activeSectionConfig = sections.find((section) => section.id === activeSection) ?? sections[0];
  const ActiveSectionIcon = activeSectionConfig.icon;
  const commandShortcutLabel = isApplePlatform() ? '⌘K' : 'Ctrl K';
  const launchChecklist = useMemo(() => buildLaunchChecklist({
    config: configSummary,
    dataSource,
    totalServers: overview.servers.length,
    onlineCount,
    connectedCount,
    openEventCount,
    opsPreflightSnapshot: overviewPreflightSnapshot,
    t,
  }), [configSummary, connectedCount, dataSource, onlineCount, openEventCount, overview.servers.length, overviewPreflightSnapshot, t]);
  const launchGuideCompact = launchGuideViewPreference === 'compact'
    || (launchGuideViewPreference === 'auto' && (performanceMode || activeSection !== 'overview'));
  const nextRemediation = launchChecklist.remediationSteps[0]?.item;
  const commandPaletteActions: CommandPaletteAction[] = [
    ...(nextRemediation ? [{
      id: 'next-remediation',
      title: t('app.commandContinueNext'),
      description: nextRemediation.action,
      category: t('app.commandContinue'),
      icon: Rocket,
      keywords: `next priority remediation ${nextRemediation.title} ${nextRemediation.action} ${t('app.commandContinue')}`,
      run: () => openLaunchChecklistItem(nextRemediation),
    }] : []),
    ...sections.map((section) => ({
      id: `section-${section.id}`,
      title: t(section.labelKey),
      description: t('app.commandGoSection'),
      category: t('app.commandNavigation'),
      icon: section.icon,
      keywords: `${section.id} ${t(section.labelKey)} ${t('app.commandNavigation')}`,
      run: () => navigateToSection(section.id),
    })),
    {
      id: 'launch-guide',
      title: t('launchGuide.commandTitle'),
      description: launchChecklist.nextAction,
      category: t('app.commandTools'),
      icon: Rocket,
      keywords: `launch setup checklist readiness deployment ${t('launchGuide.title')} ${t('launchGuide.commandTitle')}`,
      run: openLaunchGuide,
    },
    {
      id: 'open-ai',
      title: t('app.commandOpenAi'),
      description: t('app.aiWorkspaceDesc'),
      category: t('app.commandTools'),
      icon: Bot,
      keywords: `ai chat assistant ${t('app.aiTitle')} ${t('app.commandTools')}`,
      run: () => {
        navigateToSection('ai');
        setAiCollapsed(false);
      },
    },
    {
      id: 'refresh-assets',
      title: t('app.commandRefresh'),
      description: t('app.resourcePending'),
      category: t('app.commandTools'),
      icon: RefreshCw,
      keywords: `refresh sync api assets ${t('app.refresh')} ${t('app.retryApi')}`,
      run: () => {
        void refreshOverview();
      },
    },
    {
      id: 'account-settings',
      title: t('app.commandAccount'),
      description: t('account.title'),
      category: t('app.commandTools'),
      icon: UserCog,
      keywords: `account profile password appearance settings ${t('account.title')}`,
      run: openSettings,
    },
  ];
  const normalizedCommandPaletteQuery = commandPaletteQuery.trim().toLowerCase();
  const filteredCommandPaletteActions = normalizedCommandPaletteQuery
    ? commandPaletteActions.filter((action) => (
      `${action.title} ${action.description} ${action.category} ${action.keywords}`.toLowerCase().includes(normalizedCommandPaletteQuery)
    ))
    : commandPaletteActions;
  const commandPaletteActionById = new Map(commandPaletteActions.map((action) => [action.id, action] as const));
  const recentCommandPaletteActions = commandPaletteHistory
    .map((actionId) => commandPaletteActionById.get(actionId))
    .filter((action): action is CommandPaletteAction => Boolean(action));
  const continueCommandPaletteActions = normalizedCommandPaletteQuery
    ? []
    : commandPaletteActions.filter((action) => action.id === 'next-remediation');
  const contextualCommandPaletteActionIds = new Set(continueCommandPaletteActions.map((action) => action.id));
  const recentCommandPaletteActionIds = new Set(recentCommandPaletteActions.map((action) => action.id));
  const commandPaletteGroups: CommandPaletteGroup[] = normalizedCommandPaletteQuery
    ? [{
      id: 'results',
      title: t('app.commandResults'),
      actions: filteredCommandPaletteActions,
    }]
    : [
      ...(continueCommandPaletteActions.length > 0 ? [{
        id: 'continue' as const,
        title: t('app.commandContinue'),
        actions: continueCommandPaletteActions,
      }] : []),
      ...(recentCommandPaletteActions.length > 0 ? [{
        id: 'recent' as const,
        title: t('app.commandRecent'),
        actions: recentCommandPaletteActions.filter((action) => !contextualCommandPaletteActionIds.has(action.id)),
      }] : []),
      {
        id: 'all' as const,
        title: t('app.commandAllActions'),
        actions: commandPaletteActions.filter((action) => (
          !contextualCommandPaletteActionIds.has(action.id) && !recentCommandPaletteActionIds.has(action.id)
        )),
      },
    ].filter((group) => group.actions.length > 0);
  const visibleCommandPaletteActions = commandPaletteGroups.flatMap((group) => group.actions);
  const activeReleaseFixFocus = releaseFixFocus?.targetSection === activeSection ? releaseFixFocus : null;
  const activeReleaseFixAnchor = activeReleaseFixFocus?.anchor ?? '';
  const shouldRenderAiConsole = !aiCollapsed || Boolean(aiSeedQuestion) || releaseFixFocus?.targetSection === 'ai';

  function scrollReleaseFocusAnchor(anchor = activeReleaseFixAnchor) {
    if (!anchor || typeof document === 'undefined') {
      return;
    }
    const safeAnchor = anchor.replace(/["\\]/g, '');
    const target = document.querySelector(`[data-release-focus-anchor="${safeAnchor}"]`);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.focus({ preventScroll: true });
    }
  }

  useEffect(() => {
    if (!session?.authenticated) {
      return undefined;
    }

    function handleCommandShortcut(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      const modifierPressed = event.ctrlKey || event.metaKey;
      if (modifierPressed && key === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (event.key === 'Escape' && commandPaletteOpen) {
        event.preventDefault();
        closeCommandPalette();
      }
    }

    window.addEventListener('keydown', handleCommandShortcut);
    return () => window.removeEventListener('keydown', handleCommandShortcut);
  }, [session?.authenticated, commandPaletteOpen]);

  useEffect(() => {
    if (!commandPaletteOpen) {
      return undefined;
    }
    const timer = window.setTimeout(() => commandSearchRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [commandPaletteOpen]);

  useEffect(() => {
    if (!activeReleaseFixAnchor) {
      return undefined;
    }
    const timers = [90, 260].map((delay) => window.setTimeout(() => scrollReleaseFocusAnchor(activeReleaseFixAnchor), delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [activeReleaseFixAnchor, activeSection, releaseFixFocus?.id]);

  async function handleLogin(username: string, password: string) {
    setLoginLoading(true);
    setLoginError('');
    try {
      const nextSession = await login(username, password);
      setSession(nextSession.authenticated ? nextSession : null);
      if (nextSession.profile) {
        setProfile(nextSession.profile);
      }
      const route = readHashRoute();
      setActiveSection(route.matched ? route.section : 'overview');
      setSecurityTraceFocusId(route.traceId);
      setReleaseFixFocus(null);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : t('login.failed'));
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleLogout() {
    await logout().catch(() => undefined);
    setSession(null);
    setProfile(fallbackProfile);
    setOverview(fallbackOverview);
    setConfigSummary(null);
    setDataSource('fallback');
    setLastRefreshedAt(null);
    setAiCollapsed(true);
    setReleaseFixFocus(null);
  }

  function navigateToSection(section: SectionId, focus?: ReleaseFixFocusPayload) {
    setActiveSection(section);
    setReleaseFixFocus(focus ? { ...focus, targetSection: section } : null);
    if (focus?.anchor === 'ai-provider') {
      setAiCollapsed(false);
    }
    if (section !== 'security') {
      setSecurityTraceFocusId('');
    }
    writeHashRoute(section);
    setSidebarOpen(false);
  }

  function openServersForRegion(region: string | string[]) {
    const regionScope = (Array.isArray(region) ? region : [region])
      .map((item) => item.trim())
      .filter((item, index, items) => item.length > 0 && items.indexOf(item) === index);
    if (regionScope.length === 0) {
      return;
    }

    setFilters((current) => ({
      ...current,
      query: '',
      status: 'all',
      region: regionScope.length === 1 ? regionScope[0] : 'all',
      regionScope,
    }));
    navigateToSection('servers');
  }

  function openHealthSignal(signal: 'resources' | 'ssh' | 'events') {
    if (signal === 'events') {
      navigateToSection('security');
      return;
    }

    setFilters({
      ...defaultFilters,
      health: signal === 'resources' ? 'resourcePressure' : 'sshMissing',
    });
    navigateToSection('servers');
  }

  function openOverviewOperationsDraft() {
    const connectedServers = overview.servers.filter((server) => resolveServerLifecycleStatus(server) !== 'unconnected');
    const pressureServers = connectedServers
      .filter((server) => Math.max(server.cpu, server.memory, server.disk) >= 70)
      .sort((left, right) => Math.max(right.cpu, right.memory, right.disk) - Math.max(left.cpu, left.memory, left.disk))
      .slice(0, 50);
    const missingSshCount = overview.servers.filter((server) => !server.ssh?.connected).length;
    const openEventCount = overview.operationEvents.filter((event) => event.status === 'open').length;
    const draftType = pressureServers.length > 0 ? 'sshCommand' : connectedServers.length > 0 ? 'healthCheck' : 'assetSync';
    const targetMode = pressureServers.length > 0 ? 'selected' : draftType === 'assetSync' ? 'allServers' : 'allConnected';
    const draftVars = {
      assets: overview.servers.length,
      connected: connectedServers.length,
      pressure: pressureServers.length,
      missingSsh: missingSshCount,
      events: openEventCount,
    };

    setOperationDraft({
      id: `overview-health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: t('overview.opsDraftTitle'),
      description: t('overview.opsDraftDesc', draftVars),
      type: draftType,
      targetMode,
      serverIds: pressureServers.map((server) => server.id),
      command: draftType === 'sshCommand' ? overviewTriageCommand : undefined,
      reason: t('overview.opsDraftReason', draftVars),
    });
    navigateToSection('operations');
  }

  function openServerTriageOperationsDraft(triageId: ServerFleetTriageCardId) {
    const connectedServers = overview.servers.filter((server) => resolveServerLifecycleStatus(server) !== 'unconnected');
    const pressureServers = overview.servers
      .filter((server) => Math.max(server.cpu, server.memory, server.disk) >= 70)
      .sort((left, right) => Math.max(right.cpu, right.memory, right.disk) - Math.max(left.cpu, left.memory, left.disk));
    const connectedPressureServers = pressureServers.filter((server) => resolveServerLifecycleStatus(server) !== 'unconnected');
    const missingSshServers = overview.servers.filter((server) => !server.ssh?.connected);
    const simulatedServers = overview.servers.filter((server) => server.ssh?.verifyMode === 'simulate');
    const stoppedServers = overview.servers.filter((server) => resolveServerLifecycleStatus(server) === 'stopped');
    const triageSource = {
      resourcePressure: {
        servers: connectedPressureServers.length > 0 ? connectedPressureServers : pressureServers,
        type: connectedPressureServers.length > 0 ? 'sshCommand' : 'assetSync',
        command: connectedPressureServers.length > 0 ? overviewTriageCommand : undefined,
      },
      sshMissing: {
        servers: missingSshServers,
        type: 'assetSync',
        command: undefined,
      },
      sshSimulated: {
        servers: simulatedServers,
        type: 'healthCheck',
        command: undefined,
      },
      stopped: {
        servers: stoppedServers,
        type: 'assetSync',
        command: undefined,
      },
    } satisfies Record<ServerFleetTriageCardId, { servers: ServerNode[]; type: OperationsDraft['type']; command?: string }>;
    const source = triageSource[triageId];
    const selectedServers = source.servers.slice(0, 50);
    const targetMode: OperationsDraft['targetMode'] = selectedServers.length > 0 ? 'selected' : source.type === 'assetSync' ? 'allServers' : 'allConnected';
    const draftVars = {
      signal: t(`servers.triage.${triageId}.title`),
      count: source.servers.length,
      selected: selectedServers.length,
      connected: connectedServers.length,
      assets: overview.servers.length,
    };

    setOperationDraft({
      id: `server-triage-${triageId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: t('servers.triageDraftTitle', draftVars),
      description: t('servers.triageDraftDesc', draftVars),
      type: source.type,
      targetMode,
      serverIds: selectedServers.map((server) => server.id),
      command: source.command,
      reason: t('servers.triageDraftReason', draftVars),
    });
    navigateToSection('operations');
  }

  function recordOverviewDraftPreflight(draft: OperationsDraft, preflight: OperationTaskPreflightResponse) {
    const displayedTotalTargets = !preflight.requiresSsh && preflight.summary.totalTargets === 0
      ? overview.servers.length
      : preflight.summary.totalTargets;
    const displayedRunnableTargets = preflight.requiresSsh
      ? preflight.summary.runnableTargets
      : displayedTotalTargets;
    setOverviewPreflightSnapshot({
      id: `${draft.id}-${preflight.correlationId}`,
      title: draft.title,
      status: preflight.ok ? (preflight.requiresConfirmation ? 'warn' : 'ready') : 'blocked',
      runnableTargets: displayedRunnableTargets,
      totalTargets: displayedTotalTargets,
      issueCount: preflight.issues.length,
      generatedAt: preflight.generatedAt,
      correlationId: preflight.correlationId,
    });
  }

  function openAiWithQuestion(question: string) {
    setAiSeedQuestion(question);
    setAiCollapsed(false);
  }

  function openSecurityTrace(correlationId: string) {
    const traceId = normalizeTraceRouteId(correlationId);
    if (!traceId) {
      return;
    }
    setSecurityTraceFocusId(traceId);
    setActiveSection('security');
    writeHashRoute('security', traceId);
    setSidebarOpen(false);
  }

  function handleSecurityTraceFilterChange(correlationId: string) {
    const traceId = normalizeTraceRouteId(correlationId);
    writeHashRoute('security', traceId);
  }

  function openLaunchGuide() {
    setLaunchGuideOpen(true);
    try {
      window.localStorage.removeItem(launchGuideStorageKey);
    } catch {
      // Keep the launch guide usable when storage is unavailable.
    }
  }

  function dismissLaunchGuide() {
    setLaunchGuideOpen(false);
    try {
      window.localStorage.setItem(launchGuideStorageKey, 'dismissed');
    } catch {
      // Dismissal is cosmetic; failing to persist it should not block the console.
    }
  }

  function showLaunchGuideMessage(message: string) {
    setLaunchGuideMessage(message);
    if (launchGuideMessageTimerRef.current) {
      window.clearTimeout(launchGuideMessageTimerRef.current);
    }
    launchGuideMessageTimerRef.current = window.setTimeout(() => {
      setLaunchGuideMessage('');
      launchGuideMessageTimerRef.current = null;
    }, settingsMessageTtlMs);
  }

  async function copyLaunchGuideReport() {
    const report = buildLaunchChecklistReport({
      checklist: launchChecklist,
      generatedAt: new Date(),
      locale: timeLocale,
      t,
    });
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('clipboard unavailable');
      }
      await navigator.clipboard.writeText(report);
      showLaunchGuideMessage(t('launchGuide.reportCopied'));
    } catch {
      showLaunchGuideMessage(t('launchGuide.reportCopyFailed'));
    }
  }

  async function refreshLaunchGuideEvidence() {
    if (launchGuideRefreshing) {
      return;
    }
    setLaunchGuideRefreshing(true);
    try {
      const [overviewUpdated, configUpdated] = await Promise.all([
        refreshOverview(),
        refreshConfigSummary(),
      ]);
      if (!appMountedRef.current || !sessionAuthenticatedRef.current) {
        return;
      }
      showLaunchGuideMessage(
        overviewUpdated || configUpdated
          ? t('launchGuide.rechecked')
          : t('launchGuide.recheckFailed'),
      );
    } finally {
      if (appMountedRef.current) {
        setLaunchGuideRefreshing(false);
      }
    }
  }

  function startTopLaunchFix() {
    const [firstStep] = launchChecklist.remediationSteps;
    if (firstStep) {
      openLaunchChecklistItem(firstStep.item);
    }
  }

  function openLaunchChecklistItem(item: LaunchChecklistItem) {
    if (item.section === 'servers') {
      setFilters(defaultFilters);
    }
    navigateToSection(item.section);
  }

  function openSettings() {
    setProfileDraft(profile);
    setPasswordDraft({ currentPassword: '', newPassword: '', confirmPassword: '' });
    setSettingsError('');
    setSettingsSuccess('');
    setSettingsOpen(true);
  }

  function openCommandPalette() {
    setCommandPaletteQuery('');
    setCommandPaletteOpen(true);
  }

  function closeCommandPalette() {
    setCommandPaletteOpen(false);
    setCommandPaletteQuery('');
  }

  function runCommandPaletteAction(action: CommandPaletteAction) {
    setCommandPaletteHistory((current) => {
      const next = [action.id, ...current.filter((actionId) => actionId !== action.id)].slice(0, commandPaletteHistoryLimit);
      writeCommandPaletteHistory(next);
      return next;
    });
    closeCommandPalette();
    action.run();
  }

  function runFirstCommandPaletteAction() {
    const [firstAction] = visibleCommandPaletteActions;
    if (firstAction) {
      runCommandPaletteAction(firstAction);
    }
  }

  function clearCommandPaletteHistory() {
    setCommandPaletteHistory([]);
    writeCommandPaletteHistory([]);
  }

  async function handleSaveProfile() {
    setSettingsSaving(true);
    setSettingsError('');
    setSettingsSuccess('');
    try {
      const nextProfile = {
        displayName: profileDraft.displayName.trim() || 'CoLiPas',
        avatarText: 'CP',
        avatarImage: profileDraft.avatarImage || '',
      };
      const result = await updateAccountProfile(nextProfile);
      setProfile(result.profile);
      setProfileDraft(result.profile);
      setSession((current) => current ? { ...current, profile: result.profile } : current);
      setSettingsSuccess(t('account.profileSaved'));
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : t('account.saveFailed'));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function handleAvatarUpload(file: File | undefined) {
    if (!file) {
      return;
    }

    const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    if (!allowedTypes.has(file.type)) {
      setSettingsError(t('account.avatarImageInvalid'));
      if (avatarUploadRef.current) {
        avatarUploadRef.current.value = '';
      }
      return;
    }

    if (file.size > avatarMaxBytes) {
      setSettingsError(t('account.avatarImageTooLarge'));
      if (avatarUploadRef.current) {
        avatarUploadRef.current.value = '';
      }
      return;
    }

    let dataUrl = '';
    try {
      dataUrl = await readFileAsDataUrl(file);
    } catch {
      setSettingsError(t('account.avatarImageReadFailed'));
      return;
    }

    try {
      await validateAvatarDataUrl(dataUrl);
      setProfileDraft((current) => ({ ...current, avatarImage: dataUrl }));
      setSettingsError('');
      setSettingsSuccess(t('account.avatarImageReady'));
    } catch {
      setSettingsError(t('account.avatarImageInvalid'));
    } finally {
      if (avatarUploadRef.current) {
        avatarUploadRef.current.value = '';
      }
    }
  }

  async function handleChangePassword() {
    if (passwordDraft.newPassword !== passwordDraft.confirmPassword) {
      setSettingsError(t('account.passwordMismatch'));
      return;
    }

    setSettingsSaving(true);
    setSettingsError('');
    setSettingsSuccess('');
    try {
      await changeAccountPassword(passwordDraft.currentPassword, passwordDraft.newPassword);
      setPasswordDraft({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setSettingsSuccess(t('account.passwordSaved'));
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : t('account.passwordFailed'));
    } finally {
      setSettingsSaving(false);
    }
  }

  if (authLoading) {
    return (
      <div className="auth-loading">
        <div className="brand-mark app-brand-mark">
          <BrandIcon />
        </div>
        <span>{t('login.checkingSession')}</span>
      </div>
    );
  }

  if (!session?.authenticated) {
    return <LoginPage loading={loginLoading} error={loginError} onLogin={handleLogin} />;
  }

  return (
    <div className={performanceMode ? 'shell performance-mode' : 'shell'} data-build="20260509-i18n-map" data-performance-mode={performanceMode ? 'true' : 'false'}>
      <aside className={sidebarOpen ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          <AvatarMark profile={profile} />
          <div>
            <strong>{sidebarDisplayLabel}</strong>
            <span>{t('app.productSubtitle')}</span>
          </div>
        </div>
        <nav className="nav-list" aria-label={t('app.navAria')}>
          {sections.map((section) => {
            const Icon = section.icon;
            return (
              <button
                key={section.id}
                type="button"
                className={activeSection === section.id ? 'nav-item active' : 'nav-item'}
                onMouseEnter={() => {
                  if (!performanceMode) {
                    preloadSectionModule(section.id);
                  }
                }}
                onFocus={() => {
                  if (!performanceMode) {
                    preloadSectionModule(section.id);
                  }
                }}
                onClick={() => navigateToSection(section.id)}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{t(section.labelKey)}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <span>{dataSource === 'api' ? t('app.apiConnected') : t('app.localFallback')}</span>
          <strong>{t('app.apiReady')}</strong>
        </div>
      </aside>

      <div className={aiCollapsed ? 'content ai-collapsed' : 'content'}>
        <header className="topbar">
          <button
            type="button"
            className="icon-button mobile-only"
            aria-label={t('app.openNav')}
            onClick={() => setSidebarOpen((value) => !value)}
          >
            <Menu size={20} />
          </button>
          <div className="topbar-context">
            <div className="topbar-current">
              <span className="topbar-current-icon" aria-hidden="true">
                <ActiveSectionIcon size={18} aria-hidden="true" />
              </span>
              <div>
                <span>{t('app.currentFocus')}</span>
                <strong>{t(activeSectionConfig.labelKey)}</strong>
              </div>
            </div>
            <div className="topbar-metrics" aria-label={t('app.assets')}>
              <span className={dataSource === 'api' ? 'topbar-chip ok' : 'topbar-chip warn'}>
                <PlugZap size={14} aria-hidden="true" />
                <b>{dataSource === 'api' ? 'API' : t('app.localChip')}</b>
                <span>{dataSource === 'api' ? t('status.connected') : t('app.localFallback')}</span>
              </span>
              <span className="topbar-chip">
                <Server size={14} aria-hidden="true" />
                <b>{onlineCount}/{overview.servers.length}</b>
                <span>{t('overview.kpiOnline')}</span>
              </span>
              <span className="topbar-chip">
                <TerminalSquare size={14} aria-hidden="true" />
                <b>{connectedCount}</b>
                <span>SSH</span>
              </span>
              <span className={openEventCount > 0 ? 'topbar-chip warn' : 'topbar-chip ok'}>
                <Activity size={14} aria-hidden="true" />
                <b>{openEventCount}</b>
                <span>{t('app.events')}</span>
              </span>
            </div>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className={`launch-guide-open ${launchChecklist.tone}`}
              data-launch-guide-open="true"
              aria-label={t('launchGuide.open')}
              title={launchChecklist.nextAction}
              onClick={openLaunchGuide}
            >
              <Rocket size={15} aria-hidden="true" />
              <span>{t('launchGuide.open')}</span>
              <b>{launchChecklist.done}/{launchChecklist.total}</b>
            </button>
            <button
              type="button"
              className="command-trigger"
              aria-label={t('app.openCommandPalette')}
              title={t('app.openCommandPalette')}
              onClick={openCommandPalette}
            >
              <Command size={15} aria-hidden="true" />
              <span>{t('app.commandPalette')}</span>
              <kbd>{commandShortcutLabel}</kbd>
            </button>
            <button
              type="button"
              className={performanceMode ? 'performance-mode-toggle active' : 'performance-mode-toggle'}
              data-performance-mode-toggle="true"
              aria-pressed={performanceMode}
              aria-label={performanceMode ? t('app.performanceModeOn') : t('app.performanceModeOff')}
              title={performanceMode ? t('app.performanceModeOnDetail') : t('app.performanceModeOffDetail')}
              onClick={() => setPerformanceMode((value) => !value)}
            >
              <Gauge size={15} aria-hidden="true" />
              <span>{t('app.performanceMode')}</span>
              <b>{performanceMode ? t('app.performanceModeOn') : t('app.performanceModeOff')}</b>
            </button>
            <div className="language-switcher topbar-language-switcher" role="group" aria-label={t('language.label')}>
              <span className="language-switcher-label">{t('language.label')}</span>
              <div className="language-switcher-options">
                {languageOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={language === option.id ? 'language-switcher-option active' : 'language-switcher-option'}
                    aria-pressed={language === option.id}
                    title={option.label}
                    onClick={() => setLanguage(option.id)}
                  >
                    {option.shortLabel}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="icon-button topbar-refresh"
              aria-label={dataSource === 'api' ? t('app.refresh') : t('app.retryApi')}
              title={dataSource === 'api' ? t('app.refresh') : t('app.retryApi')}
              onClick={() => {
                void refreshOverview();
                void refreshConfigSummary();
              }}
            >
              <RefreshCw size={16} />
            </button>
            <span className="refresh-stamp" title={lastRefreshedAt ? lastRefreshedAt.toLocaleString(timeLocale) : t('app.resourcePending')}>
              {lastRefreshedAt ? t('app.resourceAt', { time: lastRefreshedAt.toLocaleTimeString(timeLocale) }) : t('app.resourcePending')}
            </span>
            <button
              type="button"
              className="session-chip account-settings-trigger"
              title={sessionTooltip}
              onClick={openSettings}
            >
              <b>{accountDisplayLabel}</b>
            </button>
            <button type="button" className="icon-button topbar-logout" aria-label={t('login.logout')} title={t('login.logout')} onClick={handleLogout}>
              <LogOut size={16} />
            </button>
            <button
              type="button"
              className="icon-button mobile-utility-trigger"
              data-mobile-utility-trigger="true"
              aria-label={t('app.mobileControls')}
              aria-expanded={mobileUtilityOpen}
              aria-controls="mobile-utility-menu"
              title={t('app.mobileControls')}
              onClick={() => setMobileUtilityOpen((value) => !value)}
            >
              <MoreHorizontal size={19} />
            </button>
          </div>
          {mobileUtilityOpen && (
            <>
              <button
                type="button"
                className="mobile-utility-scrim"
                aria-label={t('app.closeMobileControls')}
                onClick={() => setMobileUtilityOpen(false)}
              />
              <section id="mobile-utility-menu" className="mobile-utility-menu" data-mobile-utility-menu="true" aria-label={t('app.mobileControls')}>
                <div className="mobile-utility-menu-head">
                  <div>
                    <span>{t('app.currentFocus')}</span>
                    <strong>{t('app.mobileControls')}</strong>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t('app.closeMobileControls')}
                    title={t('app.closeMobileControls')}
                    onClick={() => setMobileUtilityOpen(false)}
                  >
                    <X size={17} />
                  </button>
                </div>
                <div className="mobile-utility-menu-grid">
                  <button
                    type="button"
                    className={performanceMode ? 'mobile-utility-action active' : 'mobile-utility-action'}
                    data-mobile-utility-performance="true"
                    aria-pressed={performanceMode}
                    onClick={() => setPerformanceMode((value) => !value)}
                  >
                    <Gauge size={17} aria-hidden="true" />
                    <span>{t('app.performanceMode')}</span>
                    <b>{performanceMode ? t('app.performanceModeOn') : t('app.performanceModeOff')}</b>
                  </button>
                  <button
                    type="button"
                    className="mobile-utility-action"
                    data-mobile-utility-refresh="true"
                    onClick={() => {
                      void refreshOverview();
                      void refreshConfigSummary();
                    }}
                  >
                    <RefreshCw size={17} aria-hidden="true" />
                    <span>{dataSource === 'api' ? t('app.refresh') : t('app.retryApi')}</span>
                    <b>{lastRefreshedAt ? t('app.resourceAt', { time: lastRefreshedAt.toLocaleTimeString(timeLocale) }) : t('app.resourcePending')}</b>
                  </button>
                  <div className="language-switcher mobile-utility-language" role="group" aria-label={t('language.label')}>
                    <span className="language-switcher-label">{t('language.label')}</span>
                    <div className="language-switcher-options">
                      {languageOptions.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className={language === option.id ? 'language-switcher-option active' : 'language-switcher-option'}
                          aria-pressed={language === option.id}
                          title={option.label}
                          onClick={() => setLanguage(option.id)}
                        >
                          {option.shortLabel}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="mobile-utility-action"
                    data-mobile-utility-account="true"
                    onClick={() => {
                      setMobileUtilityOpen(false);
                      openSettings();
                    }}
                  >
                    <UserCog size={17} aria-hidden="true" />
                    <span>{t('app.accountControls')}</span>
                    <b>{accountDisplayLabel}</b>
                  </button>
                  <button
                    type="button"
                    className="mobile-utility-action danger"
                    data-mobile-utility-logout="true"
                    onClick={() => {
                      setMobileUtilityOpen(false);
                      void handleLogout();
                    }}
                  >
                    <LogOut size={17} aria-hidden="true" />
                    <span>{t('login.logout')}</span>
                    <b>{accountDisplayLabel}</b>
                  </button>
                </div>
              </section>
            </>
          )}
        </header>

        <main>
          {launchGuideOpen && (
            <article
              className={`launch-guide ${launchChecklist.tone}${launchGuideCompact ? ' compact' : ''}`}
              data-launch-guide="true"
              data-launch-guide-compact={launchGuideCompact ? 'true' : undefined}
              aria-labelledby="launch-guide-title"
            >
              <div className="launch-guide-radar" aria-hidden="true">
                <Rocket size={22} />
              </div>
              <div className="launch-guide-copy">
                <span className="launch-guide-kicker">
                  <ListChecks size={15} />
                  {launchGuideCompact ? t('launchGuide.compactEyebrow') : t('launchGuide.eyebrow')}
                </span>
                <h2 id="launch-guide-title">{launchGuideCompact ? t('launchGuide.compactTitle') : t('launchGuide.title')}</h2>
                <p>{launchGuideCompact
                  ? t('launchGuide.compactDetail', { count: launchChecklist.remediationSteps.length })
                  : t('launchGuide.desc')}
                </p>
                <div className="launch-guide-progress" aria-label={t('launchGuide.progress', { done: launchChecklist.done, total: launchChecklist.total })}>
                  <span style={{ width: `${Math.round((launchChecklist.done / launchChecklist.total) * 100)}%` }} />
                </div>
              </div>
              <div className="launch-guide-status">
                <span>{t('launchGuide.progress', { done: launchChecklist.done, total: launchChecklist.total })}</span>
                <strong>{launchChecklist.status}</strong>
                {launchGuideCompact && launchChecklist.remediationSteps[0] && (
                  <button
                    type="button"
                    className="launch-guide-compact-next"
                    data-launch-guide-compact-next="true"
                    onClick={startTopLaunchFix}
                  >
                    <span>{t('launchGuide.compactNext')}</span>
                    <b>{launchChecklist.nextAction}</b>
                  </button>
                )}
                <div className="launch-guide-actions">
                  {!launchGuideCompact && launchChecklist.remediationSteps[0] && (
                    <button type="button" className="tool-button" data-launch-guide-start-top-fix="true" onClick={startTopLaunchFix}>
                      <ListChecks size={15} />
                      {t('launchGuide.startTopFix')}
                    </button>
                  )}
                  {!launchGuideCompact && (
                    <button type="button" className="tool-button" data-launch-guide-copy-report="true" onClick={copyLaunchGuideReport}>
                      <ClipboardCheck size={15} />
                      {t('launchGuide.copyReport')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="tool-button"
                    data-launch-guide-recheck="true"
                    onClick={refreshLaunchGuideEvidence}
                    disabled={launchGuideRefreshing}
                  >
                    <RefreshCw size={15} className={launchGuideRefreshing ? 'spin-icon' : undefined} />
                    {launchGuideRefreshing ? t('launchGuide.rechecking') : t('launchGuide.recheck')}
                  </button>
                  <button
                    type="button"
                    className="tool-button"
                    data-launch-guide-view-toggle={launchGuideCompact ? 'expand' : 'compact'}
                    onClick={() => setLaunchGuideViewPreference(launchGuideCompact ? 'expanded' : 'compact')}
                  >
                    {launchGuideCompact ? <Maximize2 size={15} /> : <Minimize2 size={15} />}
                    {launchGuideCompact ? t('launchGuide.compactExpand') : t('launchGuide.compactMode')}
                  </button>
                  <button type="button" className="tool-button" onClick={dismissLaunchGuide}>
                    {t('launchGuide.dismiss')}
                  </button>
                </div>
                {launchGuideMessage && <em className="launch-guide-message">{launchGuideMessage}</em>}
              </div>
              {!launchGuideCompact && (
                <>
                  <div className="launch-guide-grid">
                    {launchChecklist.items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`launch-guide-item ${item.tone}`}
                        data-launch-guide-item={item.id}
                        onClick={() => openLaunchChecklistItem(item)}
                      >
                        <span className="launch-guide-item-state" aria-hidden="true">
                          {item.tone === 'ok' ? <CheckCircle2 size={16} /> : <ShieldCheck size={16} />}
                        </span>
                        <span className="launch-guide-item-copy">
                          <strong>{item.title}</strong>
                          <small>{item.detail}</small>
                        </span>
                        <b>{item.action}</b>
                      </button>
                    ))}
                  </div>
                  <div className="launch-guide-fix-queue" data-launch-guide-fix-queue="true">
                    <div className="launch-guide-fix-queue-head">
                      <span>
                        <ListChecks size={15} />
                        {t('launchGuide.fixQueueEyebrow')}
                      </span>
                      <strong>{t('launchGuide.fixQueueTitle')}</strong>
                      <p>{launchChecklist.remediationSteps.length > 0 ? t('launchGuide.fixQueueDesc') : t('launchGuide.fixQueueEmpty')}</p>
                    </div>
                    {launchChecklist.remediationSteps.length > 0 && (
                      <div className="launch-guide-fix-steps">
                        {launchChecklist.remediationSteps.map((step) => (
                          <button
                            key={step.id}
                            type="button"
                            className={`launch-guide-fix-step ${step.item.tone}`}
                            data-launch-guide-fix-step={step.item.id}
                            onClick={() => openLaunchChecklistItem(step.item)}
                          >
                            <span>{step.priority}</span>
                            <strong>{step.item.title}</strong>
                            <small>{step.reason}</small>
                            <b>{step.item.action}</b>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </article>
          )}

          {activeReleaseFixFocus && (
            <article className="release-fix-focus-banner" data-release-fix-focus="true" aria-live="polite">
              <div className="release-fix-focus-lead">
                <span className="release-fix-focus-kicker">
                  <CheckCircle2 size={15} />
                  {t('app.releaseFixFocusLabel')}
                </span>
                <h3>{activeReleaseFixFocus.title}</h3>
                <p>{t('app.releaseFixFocusSource', { source: activeReleaseFixFocus.source })}</p>
              </div>
              <dl className="release-fix-focus-details">
                <div>
                  <dt>{t('app.releaseFixFocusModule')}</dt>
                  <dd>{activeReleaseFixFocus.moduleLabel}</dd>
                </div>
                <div>
                  <dt>{t('app.releaseFixFocusCurrent')}</dt>
                  <dd>{activeReleaseFixFocus.value}</dd>
                </div>
                <div>
                  <dt>{t('app.releaseFixFocusAction')}</dt>
                  <dd>{activeReleaseFixFocus.action}</dd>
                </div>
              </dl>
              <div className="release-fix-focus-actions">
                <button
                  type="button"
                  className="tool-button release-fix-focus-jump"
                  data-release-fix-anchor-action="true"
                  onClick={() => scrollReleaseFocusAnchor(activeReleaseFixFocus.anchor)}
                >
                  {t('app.releaseFixFocusJump')}
                </button>
                <button
                  type="button"
                  className="icon-button release-fix-focus-close"
                  aria-label={t('app.releaseFixFocusClose')}
                  data-release-fix-focus-close="true"
                  onClick={() => setReleaseFixFocus(null)}
                >
                  <X size={16} />
                </button>
              </div>
            </article>
          )}

          {activeSection === 'overview' && (
            <Suspense fallback={<ModuleLoadingFallback title={t('nav.overview')} />}>
              <LazyMonitoringOverview
                servers={overview.servers}
                events={overview.operationEvents}
                onlineCount={onlineCount}
                avgCpu={avgCpu}
                performanceMode={performanceMode}
                opsPreflightSnapshot={overviewPreflightSnapshot}
                onRegionServersOpen={openServersForRegion}
                onHealthSignalOpen={openHealthSignal}
                onOperationsDraftOpen={openOverviewOperationsDraft}
                onOpsPreflightTraceOpen={openSecurityTrace}
              />
            </Suspense>
          )}

          {activeSection === 'servers' && (
            <Suspense fallback={<ModuleLoadingFallback title={t('nav.servers')} />}>
              <LazyServerInventory
                filters={filters}
                onFiltersChange={setFilters}
                onTriageDraftOpen={openServerTriageOperationsDraft}
                onServerConnected={() => {
                  void refreshOverview();
                }}
                onAuditTraceOpen={openSecurityTrace}
                releaseFocusAnchor={activeReleaseFixAnchor === 'server-ssh' ? activeReleaseFixAnchor : undefined}
                allServers={overview.servers}
                servers={filteredServers}
                performanceMode={performanceMode}
              />
            </Suspense>
          )}

          {activeSection === 'operations' && (
            <Suspense fallback={<ModuleLoadingFallback title={t('nav.operations')} />}>
              <LazyOperationsCenter
                events={overview.operationEvents}
                servers={overview.servers}
                draft={operationDraft}
                onDraftPreflight={recordOverviewDraftPreflight}
                onTaskFinished={() => {
                  void refreshOverview();
                }}
                onAuditTraceOpen={openSecurityTrace}
                releaseFocusAnchor={activeReleaseFixAnchor === 'operations-builder' ? activeReleaseFixAnchor : undefined}
              />
            </Suspense>
          )}

          {activeSection === 'ai' && (
            <section className="module-section ai-main-panel ai-workbench" aria-labelledby="ai-main-title">
              <div className="section-header">
                <div>
                  <p>{t('app.aiEyebrow')}</p>
                  <h2 id="ai-main-title">{t('app.aiTitle')}</h2>
                </div>
                <button type="button" className="tool-button primary" onClick={() => setAiCollapsed(false)}>
                  <Bot size={16} />
                  {t('app.openAi')}
                </button>
              </div>

              <div className="ai-workbench-grid">
                <article className="ai-command-card">
                  <div className="ai-command-title">
                    <div className="provider-logo">
                      <MessageSquareText size={19} />
                    </div>
                    <div>
                      <strong>{t('app.aiWorkspace')}</strong>
                      <span>{t('app.aiWorkspaceDesc')}</span>
                    </div>
                  </div>
                  <div className="ai-metric-strip">
                    <div>
                      <span><Server size={15} /> {t('app.assets')}</span>
                      <strong>{onlineCount}/{overview.servers.length}</strong>
                    </div>
                    <div>
                      <span><Cpu size={15} /> {t('app.avgCpu')}</span>
                      <strong>{avgCpu}%</strong>
                    </div>
                    <div>
                      <span><HardDrive size={15} /> SSH</span>
                      <strong>{connectedCount}</strong>
                    </div>
                    <div>
                      <span><Activity size={15} /> {t('app.events')}</span>
                      <strong>{openEventCount}</strong>
                    </div>
                  </div>
                  <div className="ai-prompt-board">
                    <button type="button" onClick={() => openAiWithQuestion(t('app.aiPromptRiskQuestion'))}>
                      {t('app.aiPromptRisk')}
                    </button>
                    <button type="button" onClick={() => openAiWithQuestion(t('app.aiPromptSshQuestion'))}>
                      {t('app.aiPromptSsh')}
                    </button>
                    <button type="button" onClick={() => openAiWithQuestion(t('app.aiPromptPriorityQuestion'))}>
                      {t('app.aiPromptPriority')}
                    </button>
                  </div>
                </article>

                <div className="ai-insight-stack">
                  <article className="ai-insight-card">
                    <span><PlugZap size={16} /> {t('app.streamApi')}</span>
                    <strong>stream: true</strong>
                    <p>{t('app.streamApiDesc')}</p>
                  </article>
                  <article className="ai-insight-card">
                    <span><ShieldCheck size={16} /> {t('app.currentFocus')}</span>
                    <strong>{busiestServer ? busiestServer.name : t('app.noAssets')}</strong>
                    <p>{busiestServer ? t('app.highestLoad', { load: Math.max(busiestServer.cpu, busiestServer.memory, busiestServer.disk) }) : t('app.focusAfterConnect')}</p>
                  </article>
                </div>
              </div>
            </section>
          )}

          {activeSection === 'api' && (
            <Suspense fallback={<ModuleLoadingFallback title={t('nav.api')} />}>
              <LazyCustomApiLab releaseFocusAnchor={activeReleaseFixAnchor === 'api-request' ? activeReleaseFixAnchor : undefined} />
            </Suspense>
          )}

          {activeSection === 'security' && (
            <Suspense fallback={<ModuleLoadingFallback title={t('nav.security')} />}>
              <LazySecurityPanel
                events={overview.operationEvents}
                opsPreflightSnapshot={overviewPreflightSnapshot}
                onNavigate={(section, focus) => {
                  navigateToSection(section, focus);
                }}
                onRemediated={() => {
                  void refreshOverview();
                }}
                focusTraceId={securityTraceFocusId}
                onTraceFocused={() => setSecurityTraceFocusId('')}
                onTraceFilterChange={handleSecurityTraceFilterChange}
              />
            </Suspense>
          )}
        </main>

        {shouldRenderAiConsole ? (
          <Suspense fallback={<ModuleLoadingFallback title={t('nav.ai')} compact />}>
            <LazyAIConsole
              servers={overview.servers}
              events={overview.operationEvents}
              collapsed={aiCollapsed}
              seedQuestion={aiSeedQuestion}
              onCollapse={() => setAiCollapsed(true)}
              onExpand={() => setAiCollapsed(false)}
              onSeedQuestionConsumed={() => setAiSeedQuestion('')}
              onTaskFinished={() => {
                void refreshOverview();
              }}
              releaseFocusAnchor={releaseFixFocus?.targetSection === 'ai' ? releaseFixFocus.anchor : undefined}
            />
          </Suspense>
        ) : (
          <button type="button" className="ai-launcher" aria-label={t('ai.launch')} title={t('ai.launch')} onClick={() => setAiCollapsed(false)}>
            <Bot size={18} />
            <span>AI</span>
          </button>
        )}

        {commandPaletteOpen && (
          <div
            className="command-palette-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                closeCommandPalette();
              }
            }}
          >
            <section className="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title">
              <header className="command-palette-header">
                <div className="command-palette-search">
                  <Search size={18} aria-hidden="true" />
                  <input
                    ref={commandSearchRef}
                    value={commandPaletteQuery}
                    aria-label={t('app.commandSearchPlaceholder')}
                    placeholder={t('app.commandSearchPlaceholder')}
                    onChange={(event) => setCommandPaletteQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        runFirstCommandPaletteAction();
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        closeCommandPalette();
                      }
                    }}
                  />
                  <kbd>{commandShortcutLabel}</kbd>
                </div>
                <div className="command-palette-heading">
                  <div>
                    <span>{t('app.commandPalette')}</span>
                    <h2 id="command-palette-title">{t('app.openCommandPalette')}</h2>
                  </div>
                  <div className="command-palette-heading-actions">
                    {!normalizedCommandPaletteQuery && recentCommandPaletteActions.length > 0 && (
                      <button
                        type="button"
                        className="command-palette-clear"
                        data-command-palette-clear-history="true"
                        onClick={clearCommandPaletteHistory}
                      >
                        {t('app.commandClearRecent')}
                      </button>
                    )}
                    <button type="button" className="icon-button" aria-label={t('common.cancel')} onClick={closeCommandPalette}>
                      <X size={18} />
                    </button>
                  </div>
                </div>
              </header>

              <div className="command-palette-list" role="listbox" aria-label={t('app.commandPalette')}>
                {commandPaletteGroups.map((group) => (
                  <section
                    key={group.id}
                    className="command-palette-group"
                    data-command-palette-group={group.id}
                    data-command-palette-recent={group.id === 'recent' ? 'true' : undefined}
                    data-command-palette-continue={group.id === 'continue' ? 'true' : undefined}
                    role="group"
                    aria-label={group.title}
                  >
                    <div className="command-palette-group-heading">{group.title}</div>
                    {group.actions.map((action) => {
                      const Icon = action.icon;
                      return (
                        <button
                          key={action.id}
                          type="button"
                          className="command-palette-item"
                          role="option"
                          onClick={() => runCommandPaletteAction(action)}
                        >
                          <span className="command-palette-item-icon" aria-hidden="true">
                            <Icon size={18} />
                          </span>
                          <span>
                            <strong>{action.title}</strong>
                            <small>{action.description}</small>
                          </span>
                          <em>{action.category}</em>
                        </button>
                      );
                    })}
                  </section>
                ))}
                {visibleCommandPaletteActions.length === 0 && (
                  <div className="command-palette-empty" role="status">
                    {t('app.commandEmpty')}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {settingsOpen && (
          <div className="account-modal-backdrop" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSettingsOpen(false);
            }
          }}>
            <section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-settings-title">
              <header className="account-modal-header">
                <div>
                  <span>{accountDisplayLabel}</span>
                  <h2 id="account-settings-title">{t('account.title')}</h2>
                </div>
                <button type="button" className="icon-button" aria-label={t('account.close')} onClick={() => setSettingsOpen(false)}>
                  <X size={18} />
                </button>
              </header>

              <div className="account-settings-grid">
                <article className="account-settings-card">
                  <div className="account-card-title">
                    <AvatarMark profile={profileDraft} className="preview" />
                    <div>
                      <strong>{t('account.profileTitle')}</strong>
                      <span>{t('account.profileDesc')}</span>
                    </div>
                  </div>
                  <label className="login-field">
                    <span>{t('account.displayName')}</span>
                    <input
                      value={profileDraft.displayName}
                      maxLength={32}
                      onChange={(event) => setProfileDraft((current) => ({ ...current, displayName: event.target.value }))}
                      placeholder="CoLiPas"
                    />
                  </label>
                  <div className="avatar-upload-row">
                    <input
                      ref={avatarUploadRef}
                      className="visually-hidden"
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      onChange={(event) => handleAvatarUpload(event.currentTarget.files?.[0])}
                      aria-label={t('account.avatarImage')}
                    />
                    <button type="button" className="tool-button" onClick={() => avatarUploadRef.current?.click()}>
                      <UserCog size={16} />
                      {t('account.avatarImage')}
                    </button>
                    {profileDraft.avatarImage && (
                      <button type="button" className="tool-button" onClick={() => setProfileDraft((current) => ({ ...current, avatarImage: '' }))}>
                        <X size={16} />
                        {t('account.removeAvatarImage')}
                      </button>
                    )}
                  </div>
                  <button type="button" className="login-submit secondary-action" disabled={settingsSaving} onClick={handleSaveProfile}>
                    <UserCog size={17} />
                    {t('account.saveProfile')}
                  </button>
                </article>

                <article className="account-settings-card">
                  <div className="account-card-title">
                    <div className="brand-mark preview secure"><ShieldCheck size={18} /></div>
                    <div>
                      <strong>{t('account.passwordTitle')}</strong>
                      <span>{t('account.passwordDesc')}</span>
                    </div>
                  </div>
                  <label className="login-field">
                    <span>{t('account.currentPassword')}</span>
                    <input
                      value={passwordDraft.currentPassword}
                      type="password"
                      autoComplete="current-password"
                      onChange={(event) => setPasswordDraft((current) => ({ ...current, currentPassword: event.target.value }))}
                    />
                  </label>
                  <label className="login-field">
                    <span>{t('account.newPassword')}</span>
                    <input
                      value={passwordDraft.newPassword}
                      type="password"
                      autoComplete="new-password"
                      onChange={(event) => setPasswordDraft((current) => ({ ...current, newPassword: event.target.value }))}
                    />
                  </label>
                  <label className="login-field">
                    <span>{t('account.confirmPassword')}</span>
                    <input
                      value={passwordDraft.confirmPassword}
                      type="password"
                      autoComplete="new-password"
                      onChange={(event) => setPasswordDraft((current) => ({ ...current, confirmPassword: event.target.value }))}
                    />
                  </label>
                  <button type="button" className="login-submit" disabled={settingsSaving} onClick={handleChangePassword}>
                    <ShieldCheck size={17} />
                    {t('account.changePassword')}
                  </button>
                </article>
              </div>

              {settingsError && <div className="login-error" role="alert">{settingsError}</div>}
              {settingsSuccess && (
                <div className="settings-success" role="status">
                  <CheckCircle2 size={16} />
                  {settingsSuccess}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function isApplePlatform() {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return /mac|iphone|ipad|ipod/i.test(navigator.platform);
}

function buildLaunchChecklist(input: {
  config: ConfigSummaryResponse | null;
  dataSource: 'api' | 'fallback';
  totalServers: number;
  onlineCount: number;
  connectedCount: number;
  openEventCount: number;
  opsPreflightSnapshot: OverviewPreflightSnapshot | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): LaunchChecklistSummary {
  const {
    config,
    dataSource,
    totalServers,
    onlineCount,
    connectedCount,
    openEventCount,
    opsPreflightSnapshot,
    t,
  } = input;
  const defaultSecretCount = config
    ? [
      config.security.adminPasswordDefault,
      config.security.sessionSecretDefault,
      config.security.credentialEncryptionKeyDefault || !config.security.credentialEncryptionKeyConfigured,
    ].filter(Boolean).length
    : 1;
  const aiReady = Boolean(
    config?.ai.configured
    || config?.ai.hasStoredApiKey
    || (config?.ai.managedBy && config.ai.managedBy !== 'none'),
  );
  const preflightTone: LaunchChecklistItem['tone'] = opsPreflightSnapshot
    ? opsPreflightSnapshot.status === 'ready'
      ? 'ok'
      : opsPreflightSnapshot.status === 'warn'
        ? 'warn'
        : 'fail'
    : 'warn';

  const items: LaunchChecklistItem[] = [
    {
      id: 'runtime',
      title: t('launchGuide.runtimeTitle'),
      detail: config
        ? t('launchGuide.runtimeDetail', { count: defaultSecretCount })
        : t('launchGuide.pendingDetail'),
      action: t('launchGuide.openSecurity'),
      section: 'security',
      tone: !config ? 'warn' : defaultSecretCount === 0 ? 'ok' : 'fail',
    },
    {
      id: 'assets',
      title: t('launchGuide.assetsTitle'),
      detail: t('launchGuide.assetsDetail', { online: onlineCount, total: totalServers }),
      action: t('launchGuide.openServers'),
      section: 'servers',
      tone: totalServers > 0 && dataSource === 'api' ? 'ok' : totalServers > 0 ? 'warn' : 'fail',
    },
    {
      id: 'ssh',
      title: t('launchGuide.sshTitle'),
      detail: t('launchGuide.sshDetail', { connected: connectedCount, total: totalServers }),
      action: t('launchGuide.openSsh'),
      section: 'servers',
      tone: connectedCount > 0 ? 'ok' : totalServers > 0 ? 'warn' : 'fail',
    },
    {
      id: 'ai',
      title: t('launchGuide.aiTitle'),
      detail: aiReady ? t('launchGuide.aiReady') : t('launchGuide.aiMissing'),
      action: t('launchGuide.openAi'),
      section: 'ai',
      tone: aiReady ? 'ok' : 'warn',
    },
    {
      id: 'preflight',
      title: t('launchGuide.preflightTitle'),
      detail: opsPreflightSnapshot
        ? t('launchGuide.preflightDetail', {
          runnable: opsPreflightSnapshot.runnableTargets,
          total: opsPreflightSnapshot.totalTargets,
          issues: opsPreflightSnapshot.issueCount,
        })
        : t('launchGuide.preflightMissing'),
      action: t('launchGuide.openOperations'),
      section: 'operations',
      tone: preflightTone,
    },
    {
      id: 'audit',
      title: t('launchGuide.auditTitle'),
      detail: t('launchGuide.auditDetail', { events: openEventCount }),
      action: t('launchGuide.openAudit'),
      section: 'security',
      tone: openEventCount === 0 && defaultSecretCount === 0 ? 'ok' : openEventCount > 0 || defaultSecretCount > 0 ? 'fail' : 'warn',
    },
  ];
  const done = items.filter((item) => item.tone === 'ok').length;
  const firstActionable = items.find((item) => item.tone === 'fail') ?? items.find((item) => item.tone === 'warn') ?? items[0];
  const tone: LaunchChecklistSummary['tone'] = items.some((item) => item.tone === 'fail')
    ? 'fail'
    : items.some((item) => item.tone === 'warn')
      ? 'warn'
      : 'ok';

  return {
    tone,
    done,
    total: items.length,
    status: done === items.length ? t('launchGuide.allDone') : t('launchGuide.needAction'),
    nextAction: firstActionable ? `${firstActionable.title}: ${firstActionable.action}` : t('launchGuide.allDone'),
    items,
    remediationSteps: buildLaunchRemediationQueue(items, t),
  };
}

function buildLaunchRemediationQueue(
  items: LaunchChecklistItem[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): LaunchRemediationStep[] {
  const toneRank: Record<LaunchChecklistItem['tone'], number> = { fail: 0, warn: 1, ok: 2 };
  return [...items]
    .filter((item) => item.tone !== 'ok')
    .sort((left, right) => toneRank[left.tone] - toneRank[right.tone])
    .map((item, index) => ({
      id: `${index + 1}-${item.id}`,
      rank: index + 1,
      item,
      priority: t('launchGuide.fixPriority', { rank: index + 1 }),
      reason: getLaunchRemediationReason(item, t),
    }));
}

function getLaunchRemediationReason(
  item: LaunchChecklistItem,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  switch (item.id) {
    case 'runtime':
      return t('launchGuide.fixReasonRuntime');
    case 'assets':
      return t('launchGuide.fixReasonAssets');
    case 'ssh':
      return t('launchGuide.fixReasonSsh');
    case 'ai':
      return t('launchGuide.fixReasonAi');
    case 'preflight':
      return t('launchGuide.fixReasonPreflight');
    case 'audit':
      return t('launchGuide.fixReasonAudit');
    default:
      return item.detail;
  }
}

function buildLaunchChecklistReport(input: {
  checklist: LaunchChecklistSummary;
  generatedAt: Date;
  locale: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const { checklist, generatedAt, locale, t } = input;
  const toneLabel: Record<LaunchChecklistItem['tone'], string> = {
    ok: t('launchGuide.reportOk'),
    warn: t('launchGuide.reportWarn'),
    fail: t('launchGuide.reportFail'),
  };
  const lines = [
    `# ${t('launchGuide.reportTitle')}`,
    `${t('launchGuide.reportGenerated')}: ${generatedAt.toLocaleString(locale)}`,
    `${t('launchGuide.reportStatus')}: ${checklist.status} (${checklist.done}/${checklist.total})`,
    `${t('launchGuide.reportNextAction')}: ${checklist.nextAction}`,
    '',
    `## ${t('launchGuide.fixQueueTitle')}`,
    ...(checklist.remediationSteps.length > 0
      ? checklist.remediationSteps.map((step) => `- ${step.priority} ${step.item.title}: ${step.reason} -> ${step.item.action}`)
      : [`- ${t('launchGuide.fixQueueEmpty')}`]),
    '',
    `## ${t('launchGuide.reportItemsTitle')}`,
    ...checklist.items.map((item) => `- [${toneLabel[item.tone]}] ${item.title}: ${item.detail} -> ${item.action}`),
    '',
    t('launchGuide.reportSanitizedNote'),
  ];
  return sanitizeLaunchChecklistReport(lines.join('\n'));
}

function sanitizeLaunchChecklistReport(value: string) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-api-key]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b(password|passphrase)=\S+/gi, '$1=[redacted]');
}

function AvatarMark({ profile, className = '' }: { profile: AccountProfile; className?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [profile.avatarImage]);
  const showProfileImage = Boolean(profile.avatarImage && !imageFailed);
  const usesDefaultIcon = !showProfileImage;
  const classes = ['brand-mark', usesDefaultIcon ? 'app-brand-mark' : '', className].filter(Boolean).join(' ');

  return (
    <div className={classes} data-avatar-fallback={imageFailed ? 'true' : undefined}>
      {showProfileImage
        ? <img src={profile.avatarImage} alt="" aria-hidden="true" onError={() => setImageFailed(true)} />
        : <BrandIcon />}
    </div>
  );
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('invalid file result'));
    });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('file read failed')));
    reader.readAsDataURL(file);
  });
}

function validateAvatarDataUrl(dataUrl: string) {
  return new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => {
      if (
        image.naturalWidth > 0
        && image.naturalWidth <= avatarMaxDimension
        && image.naturalHeight > 0
        && image.naturalHeight <= avatarMaxDimension
      ) {
        resolve();
        return;
      }
      reject(new Error('invalid avatar dimensions'));
    }, { once: true });
    image.addEventListener('error', () => reject(new Error('avatar image cannot be decoded')), { once: true });
    image.src = dataUrl;
  });
}
