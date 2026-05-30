import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  CheckCircle2,
  Cpu,
  HardDrive,
  LayoutDashboard,
  LogOut,
  MessageSquareText,
  Menu,
  PlugZap,
  RefreshCw,
  Server,
  ShieldCheck,
  TerminalSquare,
  UserCog,
  X,
} from 'lucide-react';
import { getLocale, languageOptions, useI18n } from '../i18n';
import { AIConsole } from '../modules/ai/AIConsole';
import { LoginPage } from './LoginPage';
import { CustomApiLab } from '../modules/custom-api/CustomApiLab';
import { OperationsCenter } from '../modules/operations/OperationsCenter';
import { MonitoringOverview } from '../modules/overview/MonitoringOverview';
import { SecurityPanel } from '../modules/security/SecurityPanel';
import { ServerInventory } from '../modules/servers/ServerInventory';
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
  OverviewResponse,
  changeAccountPassword,
  fetchAuthSession,
  fetchOverview,
  login,
  logout,
  updateAccountProfile,
} from '../services/apiClient';
import type { ServerNode } from '../types';

type SectionId = 'overview' | 'servers' | 'operations' | 'ai' | 'api' | 'security';

const sections: Array<{ id: SectionId; labelKey: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', labelKey: 'nav.overview', icon: LayoutDashboard },
  { id: 'servers', labelKey: 'nav.servers', icon: Server },
  { id: 'operations', labelKey: 'nav.operations', icon: TerminalSquare },
  { id: 'ai', labelKey: 'nav.ai', icon: Bot },
  { id: 'api', labelKey: 'nav.api', icon: PlugZap },
  { id: 'security', labelKey: 'nav.security', icon: ShieldCheck },
];

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
const avatarMaxBytes = 2 * 1024 * 1024;
const settingsMessageTtlMs = 2800;

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
  const [profileDraft, setProfileDraft] = useState<AccountProfile>(fallbackProfile);
  const [passwordDraft, setPasswordDraft] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const avatarUploadRef = useRef<HTMLInputElement | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>(initialHashRouteRef.current.section);
  const [securityTraceFocusId, setSecurityTraceFocusId] = useState(initialHashRouteRef.current.traceId);
  const [filters, setFilters] = useState<ServerFilters>(defaultFilters);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [aiCollapsed, setAiCollapsed] = useState(true);
  const [aiSeedQuestion, setAiSeedQuestion] = useState('');
  const [overview, setOverview] = useState<OverviewResponse>(fallbackOverview);
  const [dataSource, setDataSource] = useState<'api' | 'fallback'>('fallback');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const appMountedRef = useRef(true);
  const sessionAuthenticatedRef = useRef(false);
  const overviewRefreshInFlightRef = useRef(false);
  const settingsMessageTimerRef = useRef<number | null>(null);

  async function refreshOverview() {
    if ((!session?.authenticated && !sessionAuthenticatedRef.current) || overviewRefreshInFlightRef.current) {
      return;
    }
    overviewRefreshInFlightRef.current = true;
    try {
      const { data, source } = await fetchOverview();
      if (!appMountedRef.current || !sessionAuthenticatedRef.current) {
        return;
      }
      setOverview(data);
      setDataSource(source);
      setLastRefreshedAt(new Date());
    } catch (error) {
      if (appMountedRef.current && error instanceof AuthRequiredError) {
        setSession(null);
        setAiCollapsed(true);
      }
    } finally {
      overviewRefreshInFlightRef.current = false;
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
  }, []);

  useEffect(() => {
    sessionAuthenticatedRef.current = Boolean(session?.authenticated);
  }, [session?.authenticated]);

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
  const accountDisplayLabel = profile.displayName || sessionIdentity || 'CoLiPas';
  const sessionTooltip = session?.expiresAt
    ? `${accountDisplayLabel} - ${t('login.expiresAt', { time: new Date(session.expiresAt).toLocaleString(timeLocale) })}`
    : accountDisplayLabel;
  const activeSectionConfig = sections.find((section) => section.id === activeSection) ?? sections[0];
  const ActiveSectionIcon = activeSectionConfig.icon;

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
    setDataSource('fallback');
    setLastRefreshedAt(null);
    setAiCollapsed(true);
  }

  function navigateToSection(section: SectionId) {
    setActiveSection(section);
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

  function openSettings() {
    setProfileDraft(profile);
    setPasswordDraft({ currentPassword: '', newPassword: '', confirmPassword: '' });
    setSettingsError('');
    setSettingsSuccess('');
    setSettingsOpen(true);
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

    try {
      const dataUrl = await readFileAsDataUrl(file);
      setProfileDraft((current) => ({ ...current, avatarImage: dataUrl }));
      setSettingsError('');
      setSettingsSuccess(t('account.avatarImageReady'));
    } catch {
      setSettingsError(t('account.avatarImageReadFailed'));
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
    <div className="shell" data-build="20260509-i18n-map">
      <aside className={sidebarOpen ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          <AvatarMark profile={profile} />
          <div>
            <strong>{profile.displayName}</strong>
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
              onClick={refreshOverview}
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
          </div>
        </header>

        <main>
          {activeSection === 'overview' && (
            <MonitoringOverview
              servers={overview.servers}
              events={overview.operationEvents}
              onlineCount={onlineCount}
              avgCpu={avgCpu}
              onRegionServersOpen={openServersForRegion}
            />
          )}

          {activeSection === 'servers' && (
            <ServerInventory
              filters={filters}
              onFiltersChange={setFilters}
              onServerConnected={refreshOverview}
              onAuditTraceOpen={openSecurityTrace}
              allServers={overview.servers}
              servers={filteredServers}
            />
          )}

          {activeSection === 'operations' && (
            <OperationsCenter
              events={overview.operationEvents}
              servers={overview.servers}
              onTaskFinished={refreshOverview}
              onAuditTraceOpen={openSecurityTrace}
            />
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

          {activeSection === 'api' && <CustomApiLab />}

          {activeSection === 'security' && (
            <SecurityPanel
              events={overview.operationEvents}
              onNavigate={(section) => {
                navigateToSection(section);
              }}
              onRemediated={refreshOverview}
              focusTraceId={securityTraceFocusId}
              onTraceFocused={() => setSecurityTraceFocusId('')}
              onTraceFilterChange={handleSecurityTraceFilterChange}
            />
          )}
        </main>

        <AIConsole
          servers={overview.servers}
          events={overview.operationEvents}
          collapsed={aiCollapsed}
          seedQuestion={aiSeedQuestion}
          onCollapse={() => setAiCollapsed(true)}
          onExpand={() => setAiCollapsed(false)}
          onSeedQuestionConsumed={() => setAiSeedQuestion('')}
          onTaskFinished={refreshOverview}
        />

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

function AvatarMark({ profile, className = '' }: { profile: AccountProfile; className?: string }) {
  const usesDefaultIcon = !profile.avatarImage;
  const classes = ['brand-mark', usesDefaultIcon ? 'app-brand-mark' : '', className].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      {profile.avatarImage ? <img src={profile.avatarImage} alt="" aria-hidden="true" /> : <BrandIcon />}
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
