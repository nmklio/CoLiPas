import { FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Terminal as XTerm, IDisposable } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { ChevronUp, Copy, Cpu, Database, Edit3, Eraser, FileKey2, Globe2, KeyRound, Plus, Power, PowerOff, RotateCcw, Search, Server, ShieldCheck, Terminal, Trash2, X } from 'lucide-react';
import { Language, useI18n } from '../../i18n';
import {
  closeServerShell,
  connectServerShellSocket,
  connectServer,
  type ConnectServerPayload,
  deleteServer,
  executeServerAction,
  fetchServerShellStatus,
  inspectServerIdentity,
  openServerShell,
  resizeServerShell,
  streamServerShell,
  writeServerShell,
  type ServerIdentityResponse,
  type ServerShellSocketMetrics,
  type ServerShellStreamEvent,
  type ServerShellSocketReady,
  updateServer,
} from '../../services/apiClient';
import { CloudProvider, ServerNode, ServerStatus, SshAuthType, SshVerifyMode } from '../../types';
import { formatRegionName, percentClass, statusLabel } from '../../utils/format';
import { ServerFilters } from './serverFilters';
import { baseCloudProviders, customProviderFilterValue, resolveServerLifecycleStatus } from '../../shared/serverFilters';

interface ServerInventoryProps {
  allServers: ServerNode[];
  servers: ServerNode[];
  filters: ServerFilters;
  onFiltersChange: (filters: ServerFilters) => void;
  onServerConnected: () => Promise<void> | void;
  onAuditTraceOpen?: (correlationId: string) => void;
}

const statuses: Array<Extract<ServerStatus, 'running' | 'stopped' | 'unconnected'> | 'all'> = ['all', 'running', 'stopped', 'unconnected'];
const baseProviders = [...baseCloudProviders];
const customProvider = customProviderFilterValue;
const customProviderOption = '__custom__';
const actionMessageAutoDismissMs = 4500;
const actionTraceMessageAutoDismissMs = 10000;
const terminalWriteBaseChunkSize = 32 * 1024;
const terminalWriteLargeChunkSize = 96 * 1024;
const terminalWriteLargeBacklogThreshold = 64 * 1024;
const terminalWriteImmediateThreshold = 256;
const terminalCompatibleInputFlushMs = 4;
const terminalRuntimePrefetchDelayMs = 250;
const terminalNetworkUiRefreshMs = 900;
const terminalSelfTestCommand = `printf 'colipas-ssh-self-test-start\\n'; i=1; while [ "$i" -le 40 ]; do printf 'colipas-ssh-self-test-%02d\\n' "$i"; i=$((i+1)); done; printf 'colipas-ssh-self-test-end\\n'`;
const terminalSelfTestTimeoutMs = 15000;
const terminalSelfTestLinePattern = /colipas-ssh-self-test-\d{2}/g;

const actionCommands: Record<'powerOn' | 'shutdown' | 'reboot', string> = {
  powerOn: 'printf "server reachable via SSH\\n"; uptime',
  shutdown: 'nohup sh -c "shutdown -h now" >/dev/null 2>&1 & echo "shutdown scheduled"',
  reboot: 'nohup sh -c "reboot" >/dev/null 2>&1 & echo "reboot scheduled"',
};
const serverRenderBatchSize = 120;
const serverRenderBatchStep = 120;

interface LoginProbe {
  uname?: string;
  host?: string;
  user?: string;
  pwd?: string;
  date?: string;
}

interface TerminalNetworkStats {
  bytesReceived: number;
  throughputBytesPerSecond: number;
  rttMs: number | null;
}

interface TerminalSelfTestState {
  status: 'running' | 'complete' | 'timeout' | 'failed';
  lines: number;
  durationMs: number;
  linesPerSecond: number;
  networkLabel: string;
  message?: string;
}

interface TerminalSelfTestTracker {
  sessionId: string;
  startedAt: number;
  lineCount: number;
  timeoutId: number | null;
}

const initialForm: ConnectServerPayload = {
  name: '',
  provider: customProvider,
  region: '',
  publicIp: '',
  privateIp: '',
  os: '',
  tags: [],
  ssh: {
    host: '',
    port: 22,
    username: 'root',
    authType: 'password',
    password: '',
    privateKey: '',
    passphrase: '',
    verifyMode: 'assetOnly',
  },
};

export function ServerInventory({ allServers, servers, filters, onFiltersChange, onServerConnected, onAuditTraceOpen }: ServerInventoryProps) {
  const { language, t } = useI18n();
  const regions = useMemo(() => buildSortedRegions(allServers), [allServers]);
  const scopedRegions = useMemo(() => normalizeScopedRegions(filters.regionScope), [filters.regionScope]);
  const providerFilters = useMemo(() => buildProviderOptions(allServers.map((server) => server.provider)), [allServers]);
  const providerDisplayName = (provider: string) => formatProviderName(provider, t);
  const providerFilterName = (provider: string) => formatProviderFilterName(provider, t);
  const regionDisplayName = (region: string) => formatRegionName(region, language);
  const [actionMessage, setActionMessage] = useState('');
  const [lastActionTraceId, setLastActionTraceId] = useState('');
  const [form, setForm] = useState<ConnectServerPayload>(initialForm);
  const [tagsText, setTagsText] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [detectingIdentity, setDetectingIdentity] = useState(false);
  const [identityMessage, setIdentityMessage] = useState('');
  const [providerMode, setProviderMode] = useState<string>(customProviderOption);
  const [customProviderName, setCustomProviderName] = useState(customProvider);
  const [editingServerId, setEditingServerId] = useState('');
  const [sshPanelServerId, setSshPanelServerId] = useState('');
  const [sshConsoleOpen, setSshConsoleOpen] = useState(false);
  const sshConsoleReplayHistoryRef = useRef(true);
  const [sshRunning, setSshRunning] = useState(false);
  const [sshInterrupting, setSshInterrupting] = useState(false);
  const [terminalShellId, setTerminalShellId] = useState<string | null>(null);
  const [activeShellCount, setActiveShellCount] = useState(0);
  const [terminalNetworkStats, setTerminalNetworkStats] = useState<TerminalNetworkStats | null>(null);
  const [terminalSelfTest, setTerminalSelfTest] = useState<TerminalSelfTestState | null>(null);
  const [loginProbe, setLoginProbe] = useState<LoginProbe | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formDismissed, setFormDismissed] = useState(false);
  const [visibleServerLimit, setVisibleServerLimit] = useState(serverRenderBatchSize);
  const terminalContainerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalRuntimeRef = useRef<Promise<{
    TerminalCtor: typeof import('@xterm/xterm').Terminal;
    FitAddonCtor: typeof import('@xterm/addon-fit').FitAddon;
  }> | null>(null);
  const terminalDataSubscriptionRef = useRef<IDisposable | null>(null);
  const terminalResizeObserverRef = useRef<ResizeObserver | null>(null);
  const terminalResizeTimerRef = useRef<number | null>(null);
  const terminalShellIdRef = useRef<string | null>(null);
  const terminalShellServerIdRef = useRef<string | null>(null);
  const terminalShellStreamRef = useRef<EventSource | null>(null);
  const terminalShellSocketRef = useRef<ReturnType<typeof connectServerShellSocket> | null>(null);
  const terminalShellTransportRef = useRef<'websocket' | 'compatible' | null>(null);
  const terminalWriteBufferRef = useRef('');
  const terminalWriteRafRef = useRef<number | null>(null);
  const terminalInputBufferRef = useRef('');
  const terminalInputTimerRef = useRef<number | null>(null);
  const terminalInputChainRef = useRef<Promise<void>>(Promise.resolve());
  const terminalInputInFlightRef = useRef(false);
  const terminalInputFlushAgainRef = useRef(false);
  const terminalNetworkRenderedRef = useRef<TerminalNetworkStats | null>(null);
  const terminalNetworkRenderedAtRef = useRef(0);
  const terminalSelfTestRef = useRef<TerminalSelfTestTracker | null>(null);
  const terminalCssInjectedRef = useRef(false);
  const actionMessageTimerRef = useRef<number | null>(null);
  const sshConsoleOpenRef = useRef(false);
  const sshPanelServerIdRef = useRef('');
  const terminalLifecycleSeqRef = useRef(0);
  const formRef = useRef(form);
  const privateKeyFileRef = useRef<HTMLInputElement | null>(null);
  const identityRequestSeqRef = useRef(0);
  const identityInFlightRef = useRef<{ key: string; promise: Promise<ServerIdentityResponse> } | null>(null);
  const identityCacheRef = useRef<Map<string, ServerIdentityResponse>>(new Map());
  const lastAppliedIdentityRef = useRef<{ region: string; os: string } | null>(null);
  const visibleConnectedServerCount = useMemo(() => countConnectedServers(servers), [servers]);
  const visibleServerRows = useMemo(() => servers.slice(0, visibleServerLimit), [servers, visibleServerLimit]);
  const hiddenServerCount = Math.max(servers.length - visibleServerRows.length, 0);
  const allServersById = useMemo(() => buildServerById(allServers), [allServers]);
  const activeSshServer = useMemo(() => allServersById.get(sshPanelServerId) ?? null, [allServersById, sshPanelServerId]);
  const terminalNetworkLabel = terminalNetworkStats
    ? `${formatTerminalRtt(terminalNetworkStats.rttMs)} / ${formatBytesPerSecond(terminalNetworkStats.throughputBytesPerSecond)}`
    : '';
  const terminalSelfTestRunning = terminalSelfTest?.status === 'running';
  const terminalSelfTestLabel = terminalSelfTest ? formatTerminalSelfTestLabel(terminalSelfTest, language) : '';
  const visibleSummary = useMemo(() => {
    let maxLoadServer: ServerNode | undefined;
    let maxLoad = -1;
    let loadTotal = 0;
    const providers = new Set<string>();
    const serverRegions = new Set<string>();

    for (const server of servers) {
      providers.add(server.provider);
      serverRegions.add(server.region);

      const load = maxServerLoad(server);
      loadTotal += load;
      if (load > maxLoad) {
        maxLoad = load;
        maxLoadServer = server;
      }
    }

    return {
      maxLoadServer,
      providerCount: providers.size,
      regionCount: serverRegions.size,
      avgLoad: servers.length > 0 ? Math.round(loadTotal / servers.length) : 0,
    };
  }, [servers]);
  const visibleMaxLoadServer = visibleSummary.maxLoadServer;
  const visibleProviderCount = visibleSummary.providerCount;
  const visibleRegionCount = visibleSummary.regionCount;
  const visibleAvgLoad = visibleSummary.avgLoad;
  const regionScopeKey = scopedRegions.join('|');

  useEffect(() => () => {
    closeActiveShellSession(false);
    disposeXterm();
  }, []);
  const formVisible = formOpen || Boolean(editingServerId) || (allServers.length === 0 && !formDismissed);

  useEffect(() => {
    if (visibleConnectedServerCount === 0 || terminalRuntimeRef.current) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void loadTerminalRuntime();
    }, terminalRuntimePrefetchDelayMs);
    return () => window.clearTimeout(timer);
  }, [visibleConnectedServerCount]);

  useEffect(() => {
    setVisibleServerLimit(serverRenderBatchSize);
  }, [filters.provider, filters.query, filters.region, filters.status, regionScopeKey, servers.length]);

  useEffect(() => {
    formRef.current = form;
  }, [form]);

  useEffect(() => {
    sshConsoleOpenRef.current = sshConsoleOpen;
  }, [sshConsoleOpen]);

  useEffect(() => {
    sshPanelServerIdRef.current = sshPanelServerId;
  }, [sshPanelServerId]);

  useEffect(() => {
    if (!sshConsoleOpen || !activeSshServer?.ssh?.connected) {
      return;
    }

    startTerminalLogin(activeSshServer).catch(() => undefined);
  }, [sshConsoleOpen, activeSshServer?.id]);

  useEffect(() => {
    refreshShellStatus();

    if (!sshConsoleOpen && !terminalShellId) {
      return undefined;
    }

    const timer = window.setInterval(refreshShellStatus, 5000);
    return () => window.clearInterval(timer);
  }, [sshConsoleOpen, terminalShellId]);

  useEffect(() => () => clearActionMessageTimer(), []);

  async function runAction(server: ServerNode, action: 'powerOn' | 'shutdown' | 'reboot') {
    const confirmed = confirmServerAction(server, action, language);
    if (!confirmed) {
      return;
    }

    clearActionMessage();
    try {
      const result = await executeServerAction(server.id, action, `operator requested ${action}`, true);
      showActionMessage(t('servers.actionDone', { name: result.serverName, action: actionLabel(action) }), { traceId: result.correlationId });
      if (sshConsoleOpen && activeSshServer?.id === server.id) {
        appendTerminalOutput(actionCommands[action], result.output || `${actionLabel(action)} executed`);
      }
    } catch (error) {
      showActionMessage(error instanceof Error ? error.message : 'action failed');
    }
  }

  async function handleDelete(server: ServerNode) {
    const confirmed = window.confirm(t('servers.deleteConfirm', { name: server.name }));
    if (!confirmed) {
      return;
    }

    clearActionMessage();
    try {
      await deleteServer(server.id);
      if (sshPanelServerId === server.id) {
        closeActiveShellSession();
        disposeXterm();
        setSshPanelServerId('');
        setSshConsoleOpen(false);
        setLoginProbe(null);
      }
      showActionMessage(t('servers.deleted', { name: server.name }));
      await onServerConnected();
    } catch (error) {
      showActionMessage(error instanceof Error ? error.message : 'delete failed');
    }
  }

  async function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConnecting(true);
    clearActionMessage();
    try {
      const basePayload = {
        ...form,
        provider: resolveProvider(),
        ssh: {
          ...form.ssh,
          host: form.ssh.host?.trim() || form.publicIp,
          password: form.ssh.authType === 'password' ? form.ssh.password : '',
          privateKey: form.ssh.authType === 'privateKey' ? form.ssh.privateKey : '',
          passphrase: form.ssh.authType === 'privateKey' ? form.ssh.passphrase : '',
        },
        tags: tagsText
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      };
      const payload = await completeServerIdentity(basePayload);
      if (editingServerId) {
        await updateServer(editingServerId, payload);
      } else {
        await connectServer(payload);
      }
      const successMessage = editingServerId
        ? t('servers.updated')
        : form.ssh.verifyMode === 'assetOnly'
          ? t('servers.registered')
          : t('servers.connected');
      resetForm();
      showActionMessage(successMessage);
      await onServerConnected();
    } catch (error) {
      showActionMessage(error instanceof Error ? error.message : 'connect failed');
    } finally {
      setConnecting(false);
    }
  }

  return (
    <section className="module-section" aria-labelledby="servers-title">
      <div className="section-header">
        <div>
          <p>{t('servers.eyebrow')}</p>
          <h2 id="servers-title">{t('servers.title')}</h2>
        </div>
        <div className="section-actions">
          <div className="segmented" role="group" aria-label={t('servers.statusFilter')}>
            {statuses.map((status) => (
              <button
                key={status}
                type="button"
                className={filters.status === status ? 'active' : ''}
                onClick={() => onFiltersChange({ ...filters, status })}
              >
                {status === 'all' ? t('common.all') : statusLabel(status, language)}
              </button>
            ))}
          </div>
          <button type="button" className="tool-button primary" onClick={() => {
            setFormDismissed(false);
            setFormOpen((value) => !value);
          }}>
            {formOpen ? <ChevronUp size={16} /> : <Plus size={16} />}
            {editingServerId ? t('servers.formTitleEdit') : t('servers.formTitleAdd')}
          </button>
        </div>
      </div>

      <div className="server-summary-grid">
        <article>
          <span><Server size={16} /> {t('servers.summaryTotal')}</span>
          <strong>{allServers.length}</strong>
          <small>{t('servers.summaryFiltered', { count: servers.length })}</small>
        </article>
        <article>
          <span><ShieldCheck size={16} /> SSH</span>
          <strong>{visibleConnectedServerCount}</strong>
          <small>{t('servers.summarySshReady')}</small>
        </article>
        <article>
          <span><Cpu size={16} /> {t('servers.summaryLoad')}</span>
          <strong>{visibleAvgLoad}%</strong>
          <small>{visibleMaxLoadServer ? visibleMaxLoadServer.name : t('common.none')}</small>
        </article>
        <article>
          <span><Globe2 size={16} /> {t('servers.summaryScope')}</span>
          <strong>{visibleRegionCount}</strong>
          <small>{visibleProviderCount > 0 ? t('servers.summaryProviders', { count: visibleProviderCount }) : t('common.none')}</small>
        </article>
      </div>

      <div className="filters-row server-filter-row">
        <label>
          <Search size={15} />
          {t('app.searchAria')}
          <input
            value={filters.query}
            onChange={(event) => onFiltersChange({ ...filters, query: event.target.value, regionScope: undefined })}
            placeholder={t('app.searchPlaceholder')}
          />
        </label>
        <label>
          {t('common.provider')}
          <select
            value={filters.provider}
            onChange={(event) => onFiltersChange({ ...filters, provider: event.target.value as CloudProvider | 'all', regionScope: undefined })}
          >
            <option value="all">{t('servers.allProviders')}</option>
            {providerFilters.map((provider) => (
              <option key={provider} value={provider}>
                {providerFilterName(provider)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('common.region')}
          <select value={filters.region} onChange={(event) => onFiltersChange({ ...filters, region: event.target.value, regionScope: undefined })}>
            <option value="all">{t('servers.allRegions')}</option>
            {regions.map((region) => (
              <option key={region} value={region}>
                {regionDisplayName(region)}
              </option>
            ))}
          </select>
        </label>
        {scopedRegions.length > 0 && (
          <div className="region-scope-chip">
            <Globe2 size={15} />
            <span>{t('servers.mapRegionScope', { count: scopedRegions.length })}</span>
            <strong>{scopedRegions.slice(0, 3).map(regionDisplayName).join(' / ')}{scopedRegions.length > 3 ? ` +${scopedRegions.length - 3}` : ''}</strong>
            <button type="button" onClick={() => onFiltersChange({ ...filters, regionScope: undefined })}>
              {t('servers.clearRegionScope')}
            </button>
          </div>
        )}
      </div>

      {formVisible && (
      <form className="connect-form open" onSubmit={handleConnect}>
        <div className="connect-form-title">
          <div>
            {editingServerId ? <Edit3 size={18} /> : <KeyRound size={18} />}
            <strong>{editingServerId ? t('servers.formTitleEdit') : t('servers.formTitleAdd')}</strong>
          </div>
          <button type="button" className="icon-button" aria-label={t('common.cancel')} onClick={() => {
            resetForm();
            setFormDismissed(true);
            setFormOpen(false);
          }}>
            <X size={16} />
          </button>
        </div>
        <label>
          {t('servers.name')}
          <input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="prod-api-01" />
        </label>
        <label>
          {t('common.provider')}
          <select value={providerMode} onChange={(event) => updateProviderMode(event.target.value)}>
            {baseProviders.map((provider) => (
              <option key={provider} value={provider}>{provider}</option>
            ))}
            <option value={customProviderOption}>{t('servers.providerCustom')}</option>
          </select>
        </label>
        {providerMode === customProviderOption && (
          <label>
            {t('servers.customProviderName')}
            <input
              required
              value={customProviderName}
              onChange={(event) => setCustomProviderName(event.target.value)}
              placeholder={t('servers.customProviderPlaceholder')}
            />
          </label>
        )}
        <label>
          {t('common.region')}
          <input value={form.region} onChange={(event) => updateIdentityField('region', event.target.value)} placeholder={t('servers.regionPlaceholder')} />
        </label>
        <label>
          {t('servers.publicIp')}
          <input
            required
            value={form.publicIp}
            onChange={(event) => updateIdentityField('publicIp', event.target.value)}
            onBlur={() => detectServerIdentity().catch(() => undefined)}
            placeholder="203.0.113.10"
          />
        </label>
        <label>
          {t('servers.privateIp')}
          <input value={form.privateIp} onChange={(event) => setForm({ ...form, privateIp: event.target.value })} placeholder="10.0.0.10" />
        </label>
        <label>
          {t('servers.os')}
          <input value={form.os} onChange={(event) => updateIdentityField('os', event.target.value)} placeholder={t('servers.osPlaceholder')} />
        </label>
        <label>
          {t('servers.tags')}
          <input value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="prod, api" />
        </label>
        <label>
          {t('servers.accessMode')}
          <select value={form.ssh.verifyMode} onChange={(event) => setSshField('verifyMode', event.target.value as SshVerifyMode)}>
            <option value="assetOnly">{t('servers.assetOnly')}</option>
            <option value="real">{t('servers.realSsh')}</option>
            <option value="simulate">{t('servers.simulateSsh')}</option>
          </select>
        </label>
        {form.ssh.verifyMode !== 'assetOnly' && (
          <>
            <label>
              {t('servers.sshHost')}
              <input
                value={form.ssh.host}
                onChange={(event) => setSshField('host', event.target.value)}
                onBlur={() => detectServerIdentity().catch(() => undefined)}
                placeholder={t('servers.sshHostPlaceholder')}
              />
            </label>
            <label>
              {t('servers.sshPort')}
              <input
                required
                min={1}
                max={65535}
                type="number"
                value={form.ssh.port}
                onChange={(event) => setSshField('port', Number(event.target.value))}
                placeholder="22"
              />
            </label>
            <label>
              {t('servers.sshUser')}
              <input
                required
                autoComplete="username"
                value={form.ssh.username}
                onChange={(event) => setSshField('username', event.target.value)}
                placeholder="root"
              />
            </label>
            <label>
              {t('servers.authType')}
              <select value={form.ssh.authType} onChange={(event) => setSshField('authType', event.target.value as SshAuthType)}>
                <option value="password">{t('servers.passwordAuth')}</option>
                <option value="privateKey">{t('servers.keyAuth')}</option>
              </select>
            </label>
            {form.ssh.authType === 'password' ? (
              <label>
                {t('servers.sshPassword')}
                <input
                  required
                  type="password"
                  autoComplete="current-password"
                  value={form.ssh.password}
                  onChange={(event) => setSshField('password', event.target.value)}
                  placeholder={t('servers.passwordPlaceholder')}
                />
              </label>
            ) : (
              <>
                <label className="connect-form-wide">
                  <span className="connect-form-label-row">
                    {t('servers.privateKey')}
                    <button type="button" className="inline-import-button" onClick={() => privateKeyFileRef.current?.click()}>
                      <FileKey2 size={14} />
                      {t('servers.importPrivateKey')}
                    </button>
                  </span>
                  <input
                    ref={privateKeyFileRef}
                    className="visually-hidden"
                    type="file"
                    accept=".pem,.key,.txt,.ppk"
                    onChange={(event) => importPrivateKeyFile(event.currentTarget.files?.[0])}
                    aria-label={t('servers.importPrivateKey')}
                  />
                  <textarea
                    required
                    spellCheck={false}
                    value={form.ssh.privateKey}
                    onChange={(event) => setSshField('privateKey', event.target.value)}
                    placeholder={t('servers.privateKeyPlaceholder')}
                  />
                </label>
                <label>
                  {t('servers.privateKeyPassphrase')}
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={form.ssh.passphrase}
                    onChange={(event) => setSshField('passphrase', event.target.value)}
                    placeholder={t('servers.optional')}
                  />
                </label>
              </>
            )}
          </>
        )}
        <button type="submit" className="tool-button primary" disabled={connecting}>
          <Plus size={16} />
          {connecting ? t('common.processing') : editingServerId ? t('servers.saveEdit') : form.ssh.verifyMode === 'assetOnly' ? t('servers.registerAsset') : t('servers.verifyAndConnect')}
        </button>
        <button type="button" className="tool-button" onClick={() => detectServerIdentity(true).catch(() => undefined)} disabled={connecting || detectingIdentity || !form.publicIp}>
          <Globe2 size={16} />
          {detectingIdentity ? t('servers.detectingIdentity') : t('servers.detectIdentity')}
        </button>
        {editingServerId && (
          <button type="button" className="tool-button" onClick={resetForm} disabled={connecting}>
            <X size={16} />
            {t('servers.cancelEdit')}
          </button>
        )}
        <p className="connect-form-note">
          {identityMessage || (editingServerId ? t('servers.editNote') : t('servers.addNote'))}
        </p>
      </form>
      )}

      {actionMessage && (
        <div className="validation-box action-trace-box action-message">
          <span>{actionMessage}</span>
          {lastActionTraceId && (
            <button type="button" className="inline-trace-button" onClick={() => onAuditTraceOpen?.(lastActionTraceId)}>
              <Search size={14} />
              {t('common.viewTrace')}
            </button>
          )}
        </div>
      )}

      {servers.length === 0 ? (
        <div className="empty-state">
          <Database size={26} />
          <h3>{t('servers.emptyTitle')}</h3>
          <p>{t('servers.emptyDesc')}</p>
        </div>
      ) : (
        <>
          <div className="server-workspace-list">
            <div className="server-workspace-head">
              <div>
                <strong>{t('servers.tableServer')}</strong>
                <span>{visibleConnectedServerCount > 0 ? t('servers.connectableCount', { count: visibleConnectedServerCount }) : t('servers.noConnectable')}</span>
              </div>
              <div>{t('servers.tableProvider')}</div>
              <div>{t('servers.tableResource')}</div>
              <div>{t('servers.tableSsh')}</div>
              <div>{t('servers.tableActions')}</div>
            </div>
            {visibleServerRows.map((server) => {
              const sshAccess = server.ssh;
              const connected = Boolean(sshAccess?.connected);
              const canOpenTerminal = connected;
              const lifecycleStatus = resolveServerLifecycleStatus(server);
              return (
              <article key={server.id} className={`server-workspace-row ${lifecycleStatus}`}>
                <div className="server-row-main">
                  <span className="server-row-icon">
                    <Server size={18} />
                  </span>
                  <div>
                    <div className="server-row-title">
                      <strong>{server.name}</strong>
                      <span className={`status-pill ${lifecycleStatus}`}>{serverStatusText(server, language)}</span>
                    </div>
                    <span className="muted">{server.id} / {server.os}</span>
                    <div className="server-row-network">
                      <span>{server.publicIp}</span>
                      <small>{server.privateIp}</small>
                    </div>
                    <div className="tag-list">
                      {server.tags.map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="server-row-provider">
                  <strong>{providerDisplayName(server.provider)}</strong>
                  <span>{regionDisplayName(server.region)}</span>
                </div>
                <div className="server-row-metrics">
                  <ResourceMeter label="CPU" value={server.cpu} />
                  <ResourceMeter label="MEM" value={server.memory} />
                  <ResourceMeter label="DISK" value={server.disk} />
                </div>
                <div className="server-row-ssh">
                  {connected ? (
                    <>
                      <span className="status-pill running">
                        {sshAccess?.verifyMode === 'simulate' ? t('servers.simulatedVerified') : t('servers.verified')}
                      </span>
                      <strong>{sshAccess?.username}@{sshAccess?.host}:{sshAccess?.port}</strong>
                      <small>{sshAccess?.authType === 'password' ? t('servers.passwordAuth') : t('servers.keyAuth')}</small>
                    </>
                  ) : (
                    <>
                      <span className="status-pill stopped">{t('servers.unconnected')}</span>
                      <small>{t('servers.verifyFirst')}</small>
                    </>
                  )}
                </div>
                <div className="server-mobile-ops" data-mobile-server-ops="true">
                  <div className="server-mobile-status-strip" aria-label={`${server.name} ${t('servers.tableResource')}`}>
                    <span>
                      <small>{t('common.region')}</small>
                      <strong>{regionDisplayName(server.region)}</strong>
                    </span>
                    <span>
                      <small>CPU</small>
                      <strong>{server.cpu}%</strong>
                    </span>
                    <span>
                      <small>SSH</small>
                      <strong>{connected ? (sshAccess?.authType === 'password' ? t('servers.passwordAuth') : t('servers.keyAuth')) : t('servers.unconnected')}</strong>
                    </span>
                  </div>
                  <div className="server-mobile-action-strip" aria-label={`${server.name} ${t('common.actions')}`}>
                    <button type="button" className="server-mobile-primary-action" disabled={!canOpenTerminal} onClick={() => openSshConsole(server)}>
                      <Terminal size={15} />
                      {t('servers.ssh')}
                    </button>
                    <button type="button" onClick={() => startEdit(server)}>
                      <Edit3 size={15} />
                      {t('common.edit')}
                    </button>
                    <button type="button" disabled={!connected} onClick={() => runAction(server, 'reboot')}>
                      <RotateCcw size={15} />
                      {t('servers.reboot')}
                    </button>
                  </div>
                </div>
                <div className="icon-actions server-row-actions compact" aria-label={`${server.name} ${t('common.actions')}`}>
                  <ActionButton label={t('servers.powerOn')} disabled={!connected} onClick={() => runAction(server, 'powerOn')} icon={<Power size={15} />} />
                  <ActionButton label={t('servers.shutdown')} disabled={!connected} onClick={() => runAction(server, 'shutdown')} icon={<PowerOff size={15} />} />
                  <ActionButton label={t('servers.reboot')} disabled={!connected} onClick={() => runAction(server, 'reboot')} icon={<RotateCcw size={15} />} />
                  <ActionButton label={t('common.edit')} onClick={() => startEdit(server)} icon={<Edit3 size={15} />} />
                  <ActionButton label={t('servers.ssh')} disabled={!canOpenTerminal} onClick={() => openSshConsole(server)} icon={<Terminal size={15} />} />
                  <ActionButton label={t('common.delete')} onClick={() => handleDelete(server)} icon={<Trash2 size={15} />} />
                </div>
              </article>
              );
            })}
            {hiddenServerCount > 0 && (
              <div className="server-render-window" aria-live="polite">
                <span>
                  {t('servers.renderWindow', {
                    shown: visibleServerRows.length,
                    total: servers.length,
                  })}
                </span>
                <button
                  type="button"
                  className="tool-button"
                  onClick={() => setVisibleServerLimit((current) => Math.min(servers.length, current + serverRenderBatchStep))}
                >
                  <Plus size={16} />
                  {t('servers.loadMore', { count: Math.min(serverRenderBatchStep, hiddenServerCount) })}
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {sshConsoleOpen && activeSshServer?.ssh?.connected && (
        <div className="ssh-console-backdrop" role="dialog" aria-modal="true" aria-labelledby="ssh-console-title" onClick={closeSshConsole}>
          <div className="ssh-console" onClick={(event) => event.stopPropagation()}>
            <div className="ssh-console-header">
              <div>
                <span className="status-pill running">
                  {activeSshServer.ssh.verifyMode === 'simulate' ? t('servers.simulatedVerified') : t('servers.verified')}
                </span>
                <h3 id="ssh-console-title"><Terminal size={18} /> {activeSshServer.name}</h3>
                <p>{t('servers.sshDesc')}</p>
              </div>
              <button type="button" className="icon-button" aria-label={t('common.cancel')} onClick={closeSshConsole}>
                <X size={17} />
              </button>
            </div>
            <div className="ssh-console-body">
              <aside className="ssh-console-meta">
                <div>
                  <span>{t('servers.tableProvider')}</span>
                  <strong>{providerDisplayName(activeSshServer.provider)}</strong>
                  <small>{regionDisplayName(activeSshServer.region)}</small>
                </div>
                <div>
                  <span>{t('servers.tableNetwork')}</span>
                  <strong>{activeSshServer.publicIp}</strong>
                  <small>{activeSshServer.privateIp}</small>
                </div>
                <div>
                  <span>{t('servers.tableSsh')}</span>
                  <strong>{activeSshServer.ssh.username}@{activeSshServer.ssh.host}:{activeSshServer.ssh.port}</strong>
                  <small>{activeSshServer.ssh.authType === 'password' ? t('servers.passwordAuth') : t('servers.keyAuth')}</small>
                </div>
                <div className="ssh-console-actions">
                  <button type="button" onClick={() => runAction(activeSshServer, 'powerOn')}>
                    <Power size={15} /> {t('servers.powerOn')}
                  </button>
                  <button type="button" onClick={() => runAction(activeSshServer, 'shutdown')}>
                    <PowerOff size={15} /> {t('servers.shutdown')}
                  </button>
                  <button type="button" onClick={() => runAction(activeSshServer, 'reboot')}>
                    <RotateCcw size={15} /> {t('servers.reboot')}
                  </button>
                </div>
              </aside>
              <div className="ssh-terminal-shell" onClick={() => xtermRef.current?.focus()}>
                <div className="ssh-terminal-titlebar">
                  <div className="ssh-terminal-target">
                    <span>{activeSshServer.ssh.username}@{loginProbe?.host ?? activeSshServer.ssh.host}</span>
                    <small>{activeSshServer.os}</small>
                  </div>
                  <div className="ssh-terminal-controls">
                    <div className="ssh-terminal-tools" aria-label={t('servers.terminalTools')}>
                      <button type="button" aria-label={t('servers.copyTerminalOutput')} title={t('servers.copyTerminalOutput')} onClick={copyTerminalOutput}>
                        <Copy size={14} />
                      </button>
                      <button type="button" aria-label={t('servers.clearTerminalOutput')} title={t('servers.clearTerminalOutput')} onClick={clearTerminalOutput}>
                        <Eraser size={14} />
                      </button>
                      <button type="button" aria-label={t('servers.runTerminalSelfTest')} title={t('servers.runTerminalSelfTest')} onClick={runTerminalSelfTest} disabled={!terminalShellId || sshInterrupting || terminalSelfTestRunning}>
                        <Cpu size={14} />
                      </button>
                      <button type="button" aria-label={t('servers.sendCtrlC')} title={t('servers.sendCtrlC')} onClick={interruptTerminalCommand} disabled={!terminalShellId || sshInterrupting}>
                        <span className="ssh-terminal-shortcut-glyph" aria-hidden="true">^C</span>
                      </button>
                    </div>
                    <span className="ssh-terminal-session-count" title={t('servers.activeShellSessions', { count: activeShellCount })}>
                      {t('servers.activeShellSessionsShort', { count: activeShellCount })}
                    </span>
                    {terminalShellId && terminalNetworkLabel && (
                      <span className="ssh-terminal-network" title={t('servers.terminalNetworkStats')}>
                        {terminalNetworkLabel}
                      </span>
                    )}
                    {terminalSelfTest && (
                      <span className={`ssh-terminal-self-test ${terminalSelfTest.status}`} title={terminalSelfTestLabel}>
                        {terminalSelfTest.status === 'running'
                          ? t('servers.sshSelfTestRunning')
                          : t('servers.sshSelfTestBadge', { lines: terminalSelfTest.lines, duration: Math.round(terminalSelfTest.durationMs) })}
                      </span>
                    )}
                    <div className="ssh-terminal-state">
                      <span className={terminalShellId ? 'live' : sshRunning ? 'pending' : ''} aria-hidden="true" />
                      <small>{sshInterrupting ? t('servers.sshInterrupting') : terminalShellId ? t('servers.sshConnected') : sshRunning ? t('servers.runningSsh') : t('servers.sshConnect')}</small>
                      {(sshRunning || terminalShellId) && (
                        <button type="button" onClick={closeSshConsole}>
                          {terminalShellId ? t('servers.disconnectSsh') : t('common.cancel')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                <div ref={terminalContainerRef} className="ssh-terminal-screen" aria-label="Interactive SSH terminal" />
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );

  function setSshField<T extends keyof ConnectServerPayload['ssh']>(key: T, value: ConnectServerPayload['ssh'][T]) {
    const lastAppliedIdentity = isIdentityTargetSshField(key) ? lastAppliedIdentityRef.current : null;
    if (isIdentityTargetSshField(key)) {
      clearIdentityDetectionState({ clearAutoFields: Boolean(lastAppliedIdentity) });
    }

    setForm((current) => ({
      ...clearAutoIdentityFields(current, lastAppliedIdentity),
      ssh: {
        ...current.ssh,
        [key]: value,
      },
    }));
  }

  async function importPrivateKeyFile(file: File | undefined) {
    if (!file) {
      return;
    }

    if (file.size > 64 * 1024) {
      showActionMessage(t('servers.privateKeyFileTooLarge'));
      if (privateKeyFileRef.current) {
        privateKeyFileRef.current.value = '';
      }
      return;
    }

    try {
      const text = await file.text();
      setSshField('privateKey', text.trim());
      showActionMessage(t('servers.privateKeyImported', { name: file.name }));
    } catch {
      showActionMessage(t('servers.privateKeyImportFailed'));
    } finally {
      if (privateKeyFileRef.current) {
        privateKeyFileRef.current.value = '';
      }
    }
  }

  function updateProviderMode(value: string) {
    setProviderMode(value);
    if (value !== customProviderOption) {
      setForm((current) => ({ ...current, provider: value }));
    }
  }

  function resolveProvider() {
    return providerMode === customProviderOption ? customProviderName.trim() : providerMode;
  }

  function updateIdentityField<T extends keyof ConnectServerPayload>(key: T, value: ConnectServerPayload[T]) {
    const lastAppliedIdentity = key === 'publicIp' ? lastAppliedIdentityRef.current : null;
    if (isIdentityTargetFormField(key)) {
      clearIdentityDetectionState({ clearAutoFields: key === 'publicIp' });
    }

    setForm((current) => ({
      ...(key === 'publicIp' ? clearAutoIdentityFields(current, lastAppliedIdentity) : current),
      [key]: value,
    }));
  }

  async function detectServerIdentity(force = false) {
    const publicIp = form.publicIp.trim();
    if (!publicIp) {
      return null;
    }

    if (!force && !isAutoIdentityCandidate(publicIp)) {
      return null;
    }

    if (!force && form.region.trim() && form.os.trim()) {
      return null;
    }

    const sshHost = form.ssh.host?.trim() || publicIp;
    const payload = {
      publicIp,
      region: force ? '' : form.region,
      os: force ? '' : form.os,
      ssh: {
        ...form.ssh,
        host: sshHost,
      },
    };
    const identityKey = buildIdentityRequestKey(payload);
    const cachedResult = force ? undefined : identityCacheRef.current.get(identityKey);
    if (cachedResult) {
      applyDetectedIdentity(cachedResult, force, publicIp, sshHost);
      return cachedResult;
    }

    if (!force && identityInFlightRef.current?.key === identityKey) {
      return identityInFlightRef.current.promise;
    }

    const requestSeq = identityRequestSeqRef.current + 1;
    identityRequestSeqRef.current = requestSeq;
    setDetectingIdentity(true);
    setIdentityMessage(t('servers.detectingIdentity'));
    const requestPromise = inspectServerIdentity(payload);
    identityInFlightRef.current = { key: identityKey, promise: requestPromise };
    try {
      const result = await requestPromise;
      identityCacheRef.current.set(identityKey, result);
      if (identityRequestSeqRef.current === requestSeq) {
        applyDetectedIdentity(result, force, publicIp, sshHost);
      }
      return result;
    } catch (error) {
      if (identityRequestSeqRef.current === requestSeq && isCurrentIdentityTarget(publicIp, sshHost)) {
        setIdentityMessage(error instanceof Error ? `${t('servers.identityFailed')}: ${error.message}` : t('servers.identityFailed'));
      }
      return null;
    } finally {
      if (identityInFlightRef.current?.key === identityKey) {
        identityInFlightRef.current = null;
      }
      if (identityRequestSeqRef.current === requestSeq) {
        setDetectingIdentity(false);
      }
    }
  }

  async function completeServerIdentity(payload: ConnectServerPayload) {
    if (payload.region.trim() && payload.os.trim()) {
      return payload;
    }

    const identityKey = buildIdentityRequestKey(payload);
    const cachedResult = identityCacheRef.current.get(identityKey);
    const result = cachedResult ?? await inspectServerIdentity(payload);
    if (!cachedResult) {
      identityCacheRef.current.set(identityKey, result);
    }
    lastAppliedIdentityRef.current = { region: result.region, os: result.os };
    setIdentityMessage(t('servers.identityDetected', { region: regionDisplayName(result.region), os: result.os }));
    return {
      ...payload,
      region: payload.region.trim() || result.region,
      os: payload.os.trim() || result.os,
    };
  }

  function applyDetectedIdentity(result: ServerIdentityResponse, force: boolean, publicIp: string, sshHost: string) {
    if (!isCurrentIdentityTarget(publicIp, sshHost)) {
      return;
    }

    setForm((current) => ({
      ...current,
      region: shouldUseDetectedIdentity(current.region, force) ? result.region : current.region,
      os: shouldUseDetectedIdentity(current.os, force) ? result.os : current.os,
    }));
    lastAppliedIdentityRef.current = { region: result.region, os: result.os };
    setIdentityMessage(t('servers.identityDetected', { region: regionDisplayName(result.region), os: result.os }));
  }

  function isCurrentIdentityTarget(publicIp: string, sshHost: string) {
    const current = formRef.current;
    const currentPublicIp = current.publicIp.trim();
    const currentSshHost = current.ssh.host?.trim() || currentPublicIp;
    return currentPublicIp === publicIp && currentSshHost === sshHost;
  }

  function startEdit(server: ServerNode) {
    invalidateIdentityDetection();
    const isBaseProvider = isBaseProviderName(server.provider);
    setEditingServerId(server.id);
    setProviderMode(isBaseProvider ? server.provider : customProviderOption);
    setCustomProviderName(isBaseProvider ? customProvider : server.provider);
    setTagsText(server.tags.join(', '));
    clearActionMessage();
    setFormDismissed(false);
    setFormOpen(true);
    setForm({
      name: server.name,
      provider: server.provider,
      region: server.region,
      publicIp: server.publicIp,
      privateIp: server.privateIp === '-' ? '' : server.privateIp,
      os: server.os,
      tags: server.tags,
      ssh: {
        host: server.ssh?.host ?? server.publicIp,
        port: server.ssh?.port ?? 22,
        username: server.ssh?.username ?? 'root',
        authType: server.ssh?.authType ?? 'password',
        password: '',
        privateKey: '',
        passphrase: '',
        verifyMode: 'assetOnly',
      },
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openSshConsole(server: ServerNode) {
    if (!server.ssh?.connected) {
      showActionMessage(t('servers.selectVerifiedFirst'));
      return;
    }

    terminalLifecycleSeqRef.current += 1;
    void loadTerminalRuntime();
    if (terminalShellServerIdRef.current && terminalShellServerIdRef.current !== server.id) {
      closeActiveShellSession();
      disposeXterm();
    }
    sshPanelServerIdRef.current = server.id;
    sshConsoleOpenRef.current = true;
    setSshPanelServerId(server.id);
    setLoginProbe(null);
    clearTerminalNetworkStats();
    sshConsoleReplayHistoryRef.current = !terminalShellIdRef.current || terminalShellServerIdRef.current !== server.id;
    setSshConsoleOpen(true);
    refreshShellStatus();
  }

  function closeSshConsole() {
    const serverName = activeSshServer?.name;
    terminalLifecycleSeqRef.current += 1;
    sshConsoleOpenRef.current = false;
    sshPanelServerIdRef.current = '';
    closeActiveShellSession();
    disposeXterm();
    setSshConsoleOpen(false);
    setSshPanelServerId('');
    setLoginProbe(null);
    clearTerminalNetworkStats();
    setSshRunning(false);
    setSshInterrupting(false);
    if (serverName) {
      showActionMessage(t('servers.sshDisconnectedMessage', { name: serverName }));
    }
    window.setTimeout(refreshShellStatus, 200);
  }

  async function startTerminalLogin(server: ServerNode) {
    const lifecycleSeq = terminalLifecycleSeqRef.current;
    if (terminalShellIdRef.current && terminalShellServerIdRef.current === server.id) {
      await attachExistingTerminal(server);
      return;
    }

    const terminal = await ensureXterm();
    if (!isCurrentTerminalLifecycle(server.id, lifecycleSeq)) {
      return;
    }
    setSshRunning(true);
    clearTerminalNetworkStats();
    closeActiveShellSession();
    terminalShellServerIdRef.current = server.id;
    terminal.reset();
    terminal.writeln(`Connecting to ${server.ssh?.username}@${server.ssh?.host}:${server.ssh?.port}...`);
    terminal.scrollToBottom();

    try {
      await openTerminalTransport(server, terminal, lifecycleSeq);
      if (!isCurrentTerminalLifecycle(server.id, lifecycleSeq)) {
        return;
      }

      const mergedProbe = {
        host: server.ssh?.host || server.publicIp,
        user: server.ssh?.username || 'root',
        pwd: '~',
        date: new Date().toString(),
        uname: `${server.os} ${server.publicIp}`,
      };

      setLoginProbe(mergedProbe);
      showActionMessage(t('servers.sshConnectedMessage', { name: server.name }));
      scheduleTerminalFit(true);
      window.setTimeout(() => terminal.focus(), 30);
    } catch (error) {
      if (!isCurrentTerminalLifecycle(server.id, lifecycleSeq)) {
        return;
      }
      closeActiveShellSession();
      refreshShellStatus();
      clearTerminalNetworkStats();
      setLoginProbe({
        host: server.ssh?.host || server.publicIp,
        user: server.ssh?.username || 'root',
        pwd: '~',
      });
      terminal.reset();
      terminal.writeln(error instanceof Error ? error.message : 'SSH login failed');
      showActionMessage(error instanceof Error ? error.message : 'SSH login failed');
    } finally {
      if (terminalLifecycleSeqRef.current === lifecycleSeq) {
        setSshRunning(false);
      }
    }
  }

  async function attachExistingTerminal(server: ServerNode) {
    const terminal = await ensureXterm();
    const sessionId = terminalShellIdRef.current;
    if (!sessionId) {
      return;
    }

    if (!terminalShellStreamRef.current && !terminalShellSocketRef.current) {
      const stream = streamServerShell(
        sessionId,
        (event) => handleTerminalStreamEvent(server.id, terminal, event),
        (error) => {
          if (terminalShellIdRef.current && sshConsoleOpenRef.current) {
            flushTerminalWriteBuffer(terminal, { drainAll: true });
            terminal.writeln(`\r\n${error.message}`);
            terminal.scrollToBottom();
          }
        },
        { replayHistory: sshConsoleReplayHistoryRef.current },
      );
      terminalShellStreamRef.current = stream;
    }

    attachTerminalInput(sessionId);
    setLoginProbe({
      host: server.ssh?.host || server.publicIp,
      user: server.ssh?.username || 'root',
      pwd: '~',
      date: new Date().toString(),
      uname: `${server.os} ${server.publicIp}`,
    });
    scheduleTerminalFit(true);
    terminal.scrollToBottom();
    window.setTimeout(() => terminal.focus(), 30);
  }

  async function openTerminalTransport(server: ServerNode, terminal: XTerm, lifecycleSeq: number) {
    try {
      await openWebSocketTerminalTransport(server, terminal, lifecycleSeq);
    } catch (socketError) {
      if (!isCurrentTerminalLifecycle(server.id, lifecycleSeq)) {
        return;
      }
      terminal.writeln('\r\nWebSocket terminal unavailable, falling back to compatible stream mode...');
      terminal.scrollToBottom();
      await openCompatibleTerminalTransport(server, terminal, lifecycleSeq);
      if (socketError instanceof Error) {
        console.info(`SSH WebSocket fallback: ${socketError.message}`);
      }
    }
  }

  function openWebSocketTerminalTransport(server: ServerNode, terminal: XTerm, lifecycleSeq: number) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let ready = false;
      const socket = connectServerShellSocket(
        server.id,
        getTerminalDimensions(),
        (event) => handleTerminalStreamEvent(server.id, terminal, event),
        (event) => {
          if (!isCurrentTerminalLifecycle(server.id, lifecycleSeq)) {
            closeServerShell(event.sessionId).catch(() => undefined);
            socket.close();
            return;
          }
          ready = true;
          terminalShellIdRef.current = event.sessionId;
          setTerminalShellId(event.sessionId);
          terminalShellServerIdRef.current = server.id;
          attachTerminalInput(event.sessionId);
          refreshShellStatus();
          if (!settled) {
            settled = true;
            window.clearTimeout(timeout);
            resolve();
          }
        },
        (error) => {
          if (!ready && !settled) {
            settled = true;
            window.clearTimeout(timeout);
            terminalShellSocketRef.current = null;
            terminalShellTransportRef.current = null;
            socket.close();
            reject(error);
            return;
          }
          if (terminalShellIdRef.current && sshConsoleOpenRef.current) {
            flushTerminalWriteBuffer(terminal, { drainAll: true });
            terminal.writeln(`\r\n${error.message}`);
            terminal.scrollToBottom();
          }
        },
        (metrics) => updateTerminalNetworkStats(metrics),
      );
      terminalShellSocketRef.current = socket;
      terminalShellTransportRef.current = 'websocket';
      const timeout = window.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        terminalShellSocketRef.current = null;
        terminalShellTransportRef.current = null;
        socket.close();
        reject(new Error('SSH WebSocket connection timed out'));
      }, 5000);
    });
  }

  async function openCompatibleTerminalTransport(server: ServerNode, terminal: XTerm, lifecycleSeq: number) {
    const shell = await openServerShell(server.id, getTerminalDimensions());
    if (!isCurrentTerminalLifecycle(server.id, lifecycleSeq)) {
      closeServerShell(shell.sessionId).catch(() => undefined);
      return;
    }
    terminalShellIdRef.current = shell.sessionId;
    setTerminalShellId(shell.sessionId);
    terminalShellServerIdRef.current = server.id;
    terminalShellTransportRef.current = 'compatible';
    refreshShellStatus();
    attachTerminalInput(shell.sessionId);
    const stream = streamServerShell(
      shell.sessionId,
      (event) => handleTerminalStreamEvent(server.id, terminal, event),
      (error) => {
        if (terminalShellIdRef.current && sshConsoleOpenRef.current) {
          flushTerminalWriteBuffer(terminal, { drainAll: true });
          terminal.writeln(`\r\n${error.message}`);
          terminal.scrollToBottom();
        }
      },
      { replayHistory: sshConsoleReplayHistoryRef.current },
    );
    terminalShellStreamRef.current = stream;
    renderTerminalNetworkStats({
      bytesReceived: 0,
      throughputBytesPerSecond: 0,
      rttMs: null,
    });
  }

  function handleTerminalStreamEvent(serverId: string, terminal: XTerm, event: ServerShellStreamEvent) {
    if (sshPanelServerIdRef.current !== serverId) {
      return;
    }
    if ((event.type === 'stdout' || event.type === 'stderr') && event.content) {
      queueTerminalWrite(terminal, event.content);
      captureTerminalSelfTestOutput(terminal, event.content);
      return;
    }
    if (event.type === 'close') {
      flushTerminalWriteBuffer(terminal, { drainAll: true });
      terminal.writeln('\r\nConnection closed.');
      terminal.scrollToBottom();
      terminalShellIdRef.current = null;
      setTerminalShellId(null);
      terminalShellServerIdRef.current = null;
      terminalDataSubscriptionRef.current?.dispose();
      terminalDataSubscriptionRef.current = null;
      terminalShellStreamRef.current?.close();
      terminalShellStreamRef.current = null;
      terminalShellSocketRef.current = null;
      terminalShellTransportRef.current = null;
      clearTerminalNetworkStats();
      refreshShellStatus();
    }
    if (event.type === 'error' && sshConsoleOpenRef.current) {
      flushTerminalWriteBuffer(terminal, { drainAll: true });
      terminal.writeln(`\r\n${event.message ?? 'SSH shell stream failed'}`);
      terminal.scrollToBottom();
    }
  }

  function updateTerminalNetworkStats(metrics: ServerShellSocketMetrics) {
    const nextStats = {
      bytesReceived: metrics.bytesReceived,
      throughputBytesPerSecond: metrics.throughputBytesPerSecond,
      rttMs: metrics.rttMs,
    };
    const now = performance.now();
    const renderedStats = terminalNetworkRenderedRef.current;
    if (!shouldRenderTerminalNetworkStats(renderedStats, nextStats, now, terminalNetworkRenderedAtRef.current)) {
      return;
    }
    renderTerminalNetworkStats(nextStats, now);
  }

  function renderTerminalNetworkStats(stats: TerminalNetworkStats, renderedAt = performance.now()) {
    terminalNetworkRenderedRef.current = stats;
    terminalNetworkRenderedAtRef.current = renderedAt;
    setTerminalNetworkStats(stats);
  }

  function clearTerminalNetworkStats() {
    terminalNetworkRenderedRef.current = null;
    terminalNetworkRenderedAtRef.current = 0;
    setTerminalNetworkStats(null);
  }

  function beginTerminalSelfTest(sessionId: string) {
    clearTerminalSelfTestTimer();
    const networkLabel = terminalNetworkLabel || formatTerminalRtt(terminalNetworkRenderedRef.current?.rttMs ?? null);
    const tracker: TerminalSelfTestTracker = {
      sessionId,
      startedAt: performance.now(),
      lineCount: 0,
      timeoutId: null,
    };
    tracker.timeoutId = window.setTimeout(() => {
      finishTerminalSelfTest('timeout');
    }, terminalSelfTestTimeoutMs);
    terminalSelfTestRef.current = tracker;
    setTerminalSelfTest({
      status: 'running',
      lines: 0,
      durationMs: 0,
      linesPerSecond: 0,
      networkLabel,
    });
  }

  function captureTerminalSelfTestOutput(terminal: XTerm, content: string) {
    const tracker = terminalSelfTestRef.current;
    if (!tracker) {
      return;
    }

    const lineMatches = content.match(terminalSelfTestLinePattern);
    if (lineMatches) {
      tracker.lineCount += lineMatches.length;
      const elapsedMs = Math.max(0, performance.now() - tracker.startedAt);
      setTerminalSelfTest((current) => current?.status === 'running'
        ? {
            ...current,
            lines: tracker.lineCount,
            durationMs: elapsedMs,
            linesPerSecond: calculateSelfTestRate(tracker.lineCount, elapsedMs),
          }
        : current);
    }

    if (content.includes('colipas-ssh-self-test-end')) {
      finishTerminalSelfTest('complete', terminal);
    }
  }

  function finishTerminalSelfTest(status: TerminalSelfTestState['status'], terminal?: XTerm, message?: string) {
    const tracker = terminalSelfTestRef.current;
    if (!tracker) {
      if (status === 'failed' && message) {
        setTerminalSelfTest({
          status,
          lines: 0,
          durationMs: 0,
          linesPerSecond: 0,
          networkLabel: terminalNetworkLabel || formatTerminalRtt(terminalNetworkRenderedRef.current?.rttMs ?? null),
          message,
        });
      }
      return;
    }

    const durationMs = Math.max(0, performance.now() - tracker.startedAt);
    clearTerminalSelfTestTimer();
    terminalSelfTestRef.current = null;

    const nextState: TerminalSelfTestState = {
      status,
      lines: tracker.lineCount,
      durationMs,
      linesPerSecond: calculateSelfTestRate(tracker.lineCount, durationMs),
      networkLabel: terminalNetworkLabel || formatTerminalRtt(terminalNetworkRenderedRef.current?.rttMs ?? null),
      message,
    };
    setTerminalSelfTest(nextState);

    const summary = formatTerminalSelfTestLabel(nextState, language);
    if (terminal) {
      flushTerminalWriteBuffer(terminal, { drainAll: true });
      terminal.writeln(`\r\n${t('servers.sshSelfTestTerminalLine', { summary })}`);
      terminal.scrollToBottom();
    }

    if (status === 'complete') {
      showActionMessage(t('servers.sshSelfTestFinished', { summary }));
      return;
    }
    if (status === 'timeout') {
      showActionMessage(t('servers.sshSelfTestTimeout', { lines: tracker.lineCount }), { autoDismissMs: 7000 });
      return;
    }
    if (status === 'failed') {
      showActionMessage(message || 'SSH self-test failed');
    }
  }

  function clearTerminalSelfTestTimer() {
    const timeoutId = terminalSelfTestRef.current?.timeoutId;
    if (timeoutId !== null && timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }

  function resetTerminalSelfTest() {
    clearTerminalSelfTestTimer();
    terminalSelfTestRef.current = null;
    setTerminalSelfTest(null);
  }

  async function ensureXterm() {
    if (xtermRef.current) {
      mountXterm(xtermRef.current);
      return xtermRef.current;
    }

    const { TerminalCtor, FitAddonCtor } = await loadTerminalRuntime();
    const terminal = new TerminalCtor({
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"Cascadia Code", Consolas, "SFMono-Regular", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 6000,
      disableStdin: false,
      allowProposedApi: false,
      theme: {
        background: '#070b0d',
        foreground: '#e8f1e8',
        cursor: '#ffffff',
        selectionBackground: '#275c44',
        black: '#0b1113',
        red: '#ff8b8b',
        green: '#7cff91',
        yellow: '#f9d66d',
        blue: '#7ab7ff',
        magenta: '#d8a8ff',
        cyan: '#81e6d9',
        white: '#f8fafc',
        brightBlack: '#64748b',
        brightRed: '#ffb4b4',
        brightGreen: '#a7ffb4',
        brightYellow: '#ffe8a3',
        brightBlue: '#add2ff',
        brightMagenta: '#eccbff',
        brightCyan: '#b2f5ea',
        brightWhite: '#ffffff',
      },
    });
    const fitAddon = new FitAddonCtor();
    terminal.loadAddon(fitAddon);
    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    if (terminalContainerRef.current) {
      mountXterm(terminal);
    }

    return terminal;
  }

  function mountXterm(terminal: XTerm) {
    if (!terminalContainerRef.current) {
      return;
    }

    if (terminal.element && terminal.element.parentElement !== terminalContainerRef.current) {
      terminalContainerRef.current.appendChild(terminal.element);
    } else if (!terminal.element) {
      terminal.open(terminalContainerRef.current);
    }

    terminalResizeObserverRef.current?.disconnect();
    const resizeObserver = new ResizeObserver(() => scheduleTerminalFit(true));
    resizeObserver.observe(terminalContainerRef.current);
    terminalResizeObserverRef.current = resizeObserver;
    scheduleTerminalFit(false);
    terminal.focus();
  }

  function loadTerminalRuntime() {
    if (!terminalRuntimeRef.current) {
      terminalRuntimeRef.current = Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/xterm/css/xterm.css?inline'),
      ]).then(([terminalModule, fitModule, xtermCss]) => {
        injectTerminalCss(xtermCss.default);
        return {
          TerminalCtor: terminalModule.Terminal,
          FitAddonCtor: fitModule.FitAddon,
        };
      });
    }
    return terminalRuntimeRef.current;
  }

  function injectTerminalCss(cssText: string) {
    if (terminalCssInjectedRef.current || document.getElementById('colipas-xterm-css')) {
      terminalCssInjectedRef.current = true;
      return;
    }
    const style = document.createElement('style');
    style.id = 'colipas-xterm-css';
    style.textContent = cssText;
    document.head.appendChild(style);
    terminalCssInjectedRef.current = true;
  }

  function attachTerminalInput(sessionId: string) {
    terminalDataSubscriptionRef.current?.dispose();
    terminalDataSubscriptionRef.current = xtermRef.current?.onData((data) => {
      queueTerminalInput(sessionId, data);
    }) ?? null;
  }

  function queueTerminalInput(sessionId: string, data: string) {
    if (terminalShellTransportRef.current === 'websocket' && terminalShellSocketRef.current) {
      terminalShellSocketRef.current.sendInput(data);
      return;
    }

    terminalInputBufferRef.current += data;
    if (data.includes('\r') || data.includes('\n') || data.includes('\u0003')) {
      flushTerminalInput(sessionId);
      return;
    }

    if (terminalInputTimerRef.current !== null) {
      return;
    }

    terminalInputTimerRef.current = window.setTimeout(() => {
      terminalInputTimerRef.current = null;
      flushTerminalInput(sessionId);
    }, terminalCompatibleInputFlushMs);
  }

  function flushTerminalInput(sessionId = terminalShellIdRef.current): Promise<void> {
    if (terminalInputTimerRef.current !== null) {
      window.clearTimeout(terminalInputTimerRef.current);
      terminalInputTimerRef.current = null;
    }

    if (terminalInputInFlightRef.current) {
      terminalInputFlushAgainRef.current = true;
      return terminalInputChainRef.current;
    }

    const input = terminalInputBufferRef.current;
    terminalInputBufferRef.current = '';
    if (!input || !sessionId) {
      return terminalInputChainRef.current;
    }

    terminalInputInFlightRef.current = true;
    terminalInputChainRef.current = sendTerminalInput(sessionId, input)
      .catch((error) => {
        xtermRef.current?.writeln(`\r\n${error instanceof Error ? error.message : 'SSH input failed'}`);
      })
      .finally(() => {
        terminalInputInFlightRef.current = false;
        if (terminalInputFlushAgainRef.current || terminalInputBufferRef.current) {
          terminalInputFlushAgainRef.current = false;
          void flushTerminalInput(sessionId);
        }
      });
    return terminalInputChainRef.current;
  }

  function sendTerminalInput(sessionId: string, input: string) {
    if (terminalShellTransportRef.current === 'websocket' && terminalShellSocketRef.current) {
      terminalShellSocketRef.current.sendInput(input);
      return Promise.resolve();
    }
    return writeServerShell(sessionId, input);
  }

  function clearTerminalInputBuffer() {
    if (terminalInputTimerRef.current !== null) {
      window.clearTimeout(terminalInputTimerRef.current);
      terminalInputTimerRef.current = null;
    }
    terminalInputBufferRef.current = '';
    terminalInputInFlightRef.current = false;
    terminalInputFlushAgainRef.current = false;
    terminalInputChainRef.current = Promise.resolve();
  }

  function scheduleTerminalFit(pushResize: boolean) {
    if (terminalResizeTimerRef.current !== null) {
      window.clearTimeout(terminalResizeTimerRef.current);
    }
    terminalResizeTimerRef.current = window.setTimeout(() => {
      terminalResizeTimerRef.current = null;
      if (!sshConsoleOpenRef.current) {
        return;
      }
      fitTerminal(pushResize);
    }, 20);
  }

  function fitTerminal(pushResize: boolean) {
    const terminal = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon || !terminalContainerRef.current || !sshConsoleOpenRef.current) {
      return;
    }

    try {
      fitAddon.fit();
    } catch {
      return;
    }

    if (pushResize && terminalShellIdRef.current) {
      pushTerminalResize(terminalShellIdRef.current, getTerminalDimensions());
    }
  }

  function pushTerminalResize(sessionId: string, dimensions: { cols: number; rows: number }) {
    if (terminalShellTransportRef.current === 'websocket' && terminalShellSocketRef.current) {
      terminalShellSocketRef.current.resize(dimensions);
      return;
    }
    resizeServerShell(sessionId, dimensions).catch(() => undefined);
  }

  function appendTerminalOutput(command: string, output: string) {
    const terminal = xtermRef.current;
    terminal?.writeln(`\r\n${command}\r\n${output}`);
    terminal?.scrollToBottom();
  }

  async function copyTerminalOutput() {
    const terminal = xtermRef.current;
    if (!terminal) {
      return;
    }

    const selectedText = terminal.getSelection();
    const text = selectedText.trim() ? selectedText : getVisibleTerminalText(terminal);
    if (!text.trim()) {
      showActionMessage(t('servers.terminalCopyEmpty'));
      terminal.focus();
      return;
    }

    try {
      await writeClipboardText(text);
      showActionMessage(t('servers.terminalCopied'));
    } catch {
      showActionMessage(t('servers.terminalCopyFailed'));
    } finally {
      terminal.focus();
    }
  }

  function clearTerminalOutput() {
    const terminal = xtermRef.current;
    if (!terminal) {
      return;
    }

    terminal.clear();
    showActionMessage(t('servers.terminalCleared'));
    terminal.focus();
  }

  function runTerminalSelfTest() {
    const sessionId = terminalShellId;
    if (!sessionId) {
      showActionMessage(t('servers.sshSelfTestUnavailable'));
      return;
    }

    beginTerminalSelfTest(sessionId);
    flushTerminalInput(sessionId)
      .then(() => sendTerminalInput(sessionId, `${terminalSelfTestCommand}\r`))
      .then(() => {
        showActionMessage(t('servers.sshSelfTestStarted'));
        xtermRef.current?.focus();
      })
      .catch((error) => {
        finishTerminalSelfTest('failed', undefined, error instanceof Error ? error.message : 'SSH self-test failed');
      });
  }

  function interruptTerminalCommand() {
    const sessionId = terminalShellId;
    if (!sessionId) {
      showActionMessage(t('servers.sshInterruptUnavailable'));
      return;
    }

    setSshInterrupting(true);
    flushTerminalInput(sessionId)
      .then(() => sendTerminalInput(sessionId, '\u0003'))
      .then(() => {
        showActionMessage(t('servers.sshInterruptSent'));
        refreshShellStatus();
        xtermRef.current?.focus();
      })
      .catch((error) => {
        showActionMessage(error instanceof Error ? error.message : 'SSH interrupt failed');
      })
      .finally(() => {
        setSshInterrupting(false);
      });
  }

  function getVisibleTerminalText(terminal: XTerm) {
    const buffer = terminal.buffer.active;
    const start = Math.max(0, buffer.viewportY);
    const end = Math.min(buffer.length, start + terminal.rows);
    const lines: string[] = [];
    for (let index = start; index < end; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
    }
    return lines.join('\n').replace(/\s+$/u, '');
  }

  async function writeClipboardText(text: string) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-10000px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (!copied) {
      throw new Error('clipboard copy failed');
    }
  }

  function closeActiveShellSession(syncState = true) {
    const sessionId = terminalShellIdRef.current;
    const transport = terminalShellTransportRef.current;
    terminalShellIdRef.current = null;
    clearTerminalWriteBuffer();
    clearTerminalInputBuffer();
    resetTerminalSelfTest();
    if (syncState) {
      setTerminalShellId(null);
      clearTerminalNetworkStats();
    }
    terminalShellServerIdRef.current = null;
    terminalDataSubscriptionRef.current?.dispose();
    terminalDataSubscriptionRef.current = null;
    terminalShellStreamRef.current?.close();
    terminalShellStreamRef.current = null;
    terminalShellSocketRef.current?.close();
    terminalShellSocketRef.current = null;
    terminalShellTransportRef.current = null;
    if (sessionId) {
      if (transport === 'websocket') {
        window.setTimeout(refreshShellStatus, 200);
      } else {
        closeServerShell(sessionId)
          .catch(() => undefined)
          .finally(() => refreshShellStatus());
      }
    }
  }

  function showActionMessage(message: string, options: { traceId?: string; autoDismissMs?: number | null } = {}) {
    clearActionMessageTimer();
    setActionMessage(message);
    setLastActionTraceId(options.traceId ?? '');

    const autoDismissMs = options.autoDismissMs ?? (options.traceId ? actionTraceMessageAutoDismissMs : actionMessageAutoDismissMs);
    if (message && autoDismissMs !== null && autoDismissMs > 0) {
      actionMessageTimerRef.current = window.setTimeout(() => {
        setActionMessage('');
        setLastActionTraceId('');
        actionMessageTimerRef.current = null;
      }, autoDismissMs);
    }
  }

  function clearActionMessage() {
    clearActionMessageTimer();
    setActionMessage('');
    setLastActionTraceId('');
  }

  function clearActionMessageTimer() {
    if (actionMessageTimerRef.current !== null) {
      window.clearTimeout(actionMessageTimerRef.current);
      actionMessageTimerRef.current = null;
    }
  }

  function refreshShellStatus() {
    fetchServerShellStatus()
      .then((status) => {
        setActiveShellCount(status.activeCount);
      })
      .catch(() => undefined);
  }

  function isCurrentTerminalLifecycle(serverId: string, lifecycleSeq: number) {
    return sshConsoleOpenRef.current && sshPanelServerIdRef.current === serverId && terminalLifecycleSeqRef.current === lifecycleSeq;
  }

  function getTerminalDimensions() {
    const terminal = xtermRef.current;
    if (terminal) {
      return {
        cols: Math.max(20, Math.min(240, terminal.cols || 100)),
        rows: Math.max(8, Math.min(80, terminal.rows || 30)),
      };
    }

    const width = terminalContainerRef.current?.clientWidth ?? 960;
    const height = terminalContainerRef.current?.clientHeight ?? 520;
    return {
      cols: Math.max(80, Math.min(180, Math.floor(width / 8))),
      rows: Math.max(24, Math.min(60, Math.floor(height / 18))),
    };
  }

  function queueTerminalWrite(terminal: XTerm, content: string) {
    terminalWriteBufferRef.current += content;
    if (terminalWriteBufferRef.current.length <= terminalWriteImmediateThreshold) {
      flushTerminalWriteBuffer(terminal);
      return;
    }
    scheduleTerminalWriteFlush(terminal);
  }

  function scheduleTerminalWriteFlush(terminal: XTerm) {
    if (terminalWriteRafRef.current !== null) {
      return;
    }

    terminalWriteRafRef.current = window.requestAnimationFrame(() => {
      terminalWriteRafRef.current = null;
      flushTerminalWriteBuffer(terminal);
    });
  }

  function flushTerminalWriteBuffer(terminal = xtermRef.current, options: { drainAll?: boolean } = {}) {
    if (terminalWriteRafRef.current !== null) {
      window.cancelAnimationFrame(terminalWriteRafRef.current);
      terminalWriteRafRef.current = null;
    }

    const content = terminalWriteBufferRef.current;
    if (!content || !terminal) {
      terminalWriteBufferRef.current = '';
      return;
    }

    const chunkSize = getTerminalWriteChunkSize(content.length);
    const chunk = !options.drainAll && content.length > chunkSize ? content.slice(0, chunkSize) : content;
    terminalWriteBufferRef.current = content.slice(chunk.length);
    terminal.write(chunk, () => {
      terminal.scrollToBottom();
      if (terminalWriteBufferRef.current) {
        scheduleTerminalWriteFlush(terminal);
      }
    });
  }

  function getTerminalWriteChunkSize(backlogLength: number) {
    return backlogLength >= terminalWriteLargeBacklogThreshold ? terminalWriteLargeChunkSize : terminalWriteBaseChunkSize;
  }

  function clearTerminalWriteBuffer() {
    if (terminalWriteRafRef.current !== null) {
      window.cancelAnimationFrame(terminalWriteRafRef.current);
      terminalWriteRafRef.current = null;
    }
    terminalWriteBufferRef.current = '';
  }

  function disposeXterm() {
    clearTerminalWriteBuffer();
    clearTerminalInputBuffer();
    resetTerminalSelfTest();
    if (terminalResizeTimerRef.current !== null) {
      window.clearTimeout(terminalResizeTimerRef.current);
      terminalResizeTimerRef.current = null;
    }
    terminalResizeObserverRef.current?.disconnect();
    terminalResizeObserverRef.current = null;
    terminalDataSubscriptionRef.current?.dispose();
    terminalDataSubscriptionRef.current = null;
    fitAddonRef.current?.dispose();
    fitAddonRef.current = null;
    xtermRef.current?.dispose();
    xtermRef.current = null;
  }

  function resetForm() {
    invalidateIdentityDetection();
    setForm(initialForm);
    setTagsText('');
    setIdentityMessage('');
    setDetectingIdentity(false);
    setProviderMode(customProviderOption);
    setCustomProviderName(customProvider);
    setEditingServerId('');
    setFormDismissed(true);
    setFormOpen(false);
    lastAppliedIdentityRef.current = null;
  }

  function invalidateIdentityDetection() {
    identityRequestSeqRef.current += 1;
    identityInFlightRef.current = null;
  }

  function clearIdentityDetectionState(options: { clearAutoFields?: boolean } = {}) {
    invalidateIdentityDetection();
    setDetectingIdentity(false);
    setIdentityMessage('');
    if (options.clearAutoFields) {
      lastAppliedIdentityRef.current = null;
    }
  }

  function clearAutoIdentityFields(current: ConnectServerPayload, lastApplied = lastAppliedIdentityRef.current) {
    if (!lastApplied) {
      return current;
    }

    return {
      ...current,
      region: current.region === lastApplied.region ? '' : current.region,
      os: current.os === lastApplied.os ? '' : current.os,
    };
  }
}

function isIdentityTargetFormField(key: keyof ConnectServerPayload) {
  return key === 'publicIp' || key === 'region' || key === 'os';
}

function isIdentityTargetSshField(key: keyof ConnectServerPayload['ssh']) {
  return key === 'host' || key === 'port' || key === 'username' || key === 'authType' || key === 'verifyMode';
}

function buildSortedRegions(servers: ServerNode[]) {
  const regions = new Set<string>();
  for (const server of servers) {
    if (server.region) {
      regions.add(server.region);
    }
  }
  return Array.from(regions).sort();
}

function normalizeScopedRegions(regions: string[] | undefined) {
  if (!regions?.length) {
    return [];
  }
  const normalized = new Map<string, string>();
  for (const region of regions) {
    const trimmed = region.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (!normalized.has(key)) {
      normalized.set(key, trimmed);
    }
  }
  return Array.from(normalized.values());
}

function countConnectedServers(servers: ServerNode[]) {
  let count = 0;
  for (const server of servers) {
    if (server.ssh?.connected) {
      count += 1;
    }
  }
  return count;
}

function buildServerById(servers: ServerNode[]) {
  const serverById = new Map<string, ServerNode>();
  for (const server of servers) {
    serverById.set(server.id, server);
  }
  return serverById;
}

function buildProviderOptions(dynamicProviders: string[]) {
  const normalized = new Map<string, string>();
  [...baseProviders, customProvider].forEach((provider) => {
    const trimmed = provider.trim();
    if (!trimmed) {
      return;
    }
    const key = trimmed.toLowerCase() === 'custom' ? customProvider.toLowerCase() : trimmed.toLowerCase();
    if (!normalized.has(key)) {
      normalized.set(key, trimmed.toLowerCase() === 'custom' ? customProvider : trimmed);
    }
  });
  const hasCustomProvider = dynamicProviders.some((provider) => !isBaseProviderName(provider));
  return Array.from(normalized.values()).filter((provider) => provider !== customProvider || hasCustomProvider);
}

function isBaseProviderName(provider: string) {
  return baseProviders.some((baseProvider) => baseProvider.toLowerCase() === provider.trim().toLowerCase());
}

function shouldUseDetectedIdentity(value: string, force: boolean) {
  return force || !value.trim();
}

function isAutoIdentityCandidate(publicIp: string) {
  return isLikelyIpv4Address(publicIp);
}

function isLikelyIpv4Address(value: string) {
  const parts = value.trim().split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }

    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function buildIdentityRequestKey(payload: Pick<ConnectServerPayload, 'publicIp' | 'region' | 'os' | 'ssh'>) {
  const ssh = payload.ssh;
  return [
    payload.publicIp.trim().toLowerCase(),
    payload.region.trim().toLowerCase(),
    payload.os.trim().toLowerCase(),
    ssh.host?.trim().toLowerCase() ?? '',
    String(ssh.port),
    ssh.username.trim().toLowerCase(),
    ssh.authType,
    ssh.verifyMode,
    ssh.authType === 'password' ? `password:${Boolean(ssh.password)}` : `key:${Boolean(ssh.privateKey)}:${Boolean(ssh.passphrase)}`,
  ].join('|');
}

function formatProviderName(provider: string, t: (key: string, vars?: Record<string, string | number>) => string) {
  return provider.trim().toLowerCase() === customProvider.toLowerCase() ? t('servers.providerCustomDisplay') : provider;
}

function formatProviderFilterName(provider: string, t: (key: string, vars?: Record<string, string | number>) => string) {
  return provider.trim().toLowerCase() === customProvider.toLowerCase() ? t('servers.providerCustomFilter') : provider;
}

function formatTerminalRtt(rttMs: number | null) {
  return rttMs === null ? 'RTT --' : `RTT ${rttMs}ms`;
}

function formatBytesPerSecond(bytesPerSecond: number) {
  if (bytesPerSecond >= 1024 * 1024) {
    return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  }
  return `${Math.max(0, Math.round(bytesPerSecond / 1024))} KB/s`;
}

function actionLabel(action: 'powerOn' | 'shutdown' | 'reboot') {
  return {
    powerOn: 'power on',
    shutdown: 'shutdown',
    reboot: 'reboot',
  }[action];
}

function confirmServerAction(server: ServerNode, action: 'powerOn' | 'shutdown' | 'reboot', language: Language) {
  const actionText = actionLabelByLanguage(action, language);
  if (action === 'powerOn') {
    return window.confirm(confirmText(language, `${server.name}`, actionText, false));
  }

  return window.confirm(confirmText(language, `${server.name} (${server.publicIp})`, actionText, true));
}

function actionLabelByLanguage(action: 'powerOn' | 'shutdown' | 'reboot', language: Language) {
  const labels: Record<Language, Record<'powerOn' | 'shutdown' | 'reboot', string>> = {
    zh: {
      powerOn: '开机检测',
      shutdown: '关机',
      reboot: '重启',
    },
    en: {
      powerOn: 'power-on check',
      shutdown: 'shutdown',
      reboot: 'reboot',
    },
    ja: {
      powerOn: '起動確認',
      shutdown: '停止',
      reboot: '再起動',
    },
  };
  return labels[language][action];
}

function confirmText(language: Language, target: string, action: string, dangerous: boolean) {
  if (language === 'en') {
    return dangerous
      ? `This will run a real ${action} command on ${target}. Continue?`
      : `Run ${action} on ${target}?`;
  }

  if (language === 'ja') {
    return dangerous
      ? `${target} に実際の ${action} コマンドを実行します。続行しますか？`
      : `${target} に ${action} を実行しますか？`;
  }

  return dangerous
    ? `将对 ${target} 执行真实${action}命令，是否继续？`
    : `对 ${target} 执行${action}？`;
}

function serverStatusText(server: ServerNode, language: Language) {
  return statusLabel(resolveServerLifecycleStatus(server), language);
}

function maxServerLoad(server: ServerNode) {
  return Math.max(server.cpu, server.memory, server.disk);
}

function shouldRenderTerminalNetworkStats(
  renderedStats: TerminalNetworkStats | null,
  nextStats: TerminalNetworkStats,
  now: number,
  renderedAt: number,
) {
  if (!renderedStats) {
    return true;
  }

  if (terminalNetworkDisplayKey(renderedStats) === terminalNetworkDisplayKey(nextStats)) {
    return false;
  }

  return now - renderedAt >= terminalNetworkUiRefreshMs;
}

function terminalNetworkDisplayKey(stats: TerminalNetworkStats) {
  return `${formatTerminalRtt(stats.rttMs)}|${formatBytesPerSecond(stats.throughputBytesPerSecond)}`;
}

function calculateSelfTestRate(lines: number, durationMs: number) {
  if (lines <= 0 || durationMs <= 0) {
    return 0;
  }
  return lines / (durationMs / 1000);
}

function formatSelfTestRate(linesPerSecond: number, language: Language) {
  const unit = language === 'en' ? 'lines/s' : '行/秒';
  if (!Number.isFinite(linesPerSecond) || linesPerSecond <= 0) {
    return `0 ${unit}`;
  }
  return linesPerSecond >= 100
    ? `${Math.round(linesPerSecond)} ${unit}`
    : `${linesPerSecond.toFixed(1)} ${unit}`;
}

function formatTerminalSelfTestLabel(state: TerminalSelfTestState, language: Language) {
  if (state.status === 'running') {
    const runningLabel = language === 'en' ? 'running' : language === 'ja' ? '測定中' : '测速中';
    const lineUnit = language === 'en' ? 'lines' : '行';
    return `${runningLabel} · ${state.lines} ${lineUnit}`;
  }
  if (state.status === 'failed') {
    const failedLabel = language === 'en' ? 'failed' : language === 'ja' ? '失敗' : '失败';
    return `${failedLabel} · ${state.message ?? 'send failed'}`;
  }

  const lineUnit = language === 'en' ? 'lines' : '行';
  const base = `${state.lines} ${lineUnit} / ${Math.round(state.durationMs)}ms / ${formatSelfTestRate(state.linesPerSecond, language)}`;
  const network = state.networkLabel ? ` / ${state.networkLabel}` : '';
  const timeoutLabel = language === 'en' ? 'timeout' : language === 'ja' ? 'タイムアウト' : '超时';
  return state.status === 'timeout' ? `${timeoutLabel} · ${base}${network}` : `${base}${network}`;
}

function ActionButton({ label, icon, disabled, onClick }: { label: string; icon: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ResourceMeter({ label, value }: { label: string; value: number }) {
  return (
    <div className="resource-meter">
      <span>{label}</span>
      <div className="meter-track" aria-hidden="true">
        <i className={percentClass(value)} style={{ width: `${value}%` }} />
      </div>
      <b>{value}%</b>
    </div>
  );
}
