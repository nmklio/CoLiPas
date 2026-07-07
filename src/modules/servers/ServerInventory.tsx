import { FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Terminal as XTerm, IDisposable } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { ChevronDown, ChevronUp, Copy, Cpu, Database, Edit3, Eraser, FileKey2, FileText, Globe2, KeyRound, Network, Plus, Power, PowerOff, RotateCcw, Search, Server, ShieldCheck, Sparkles, Star, Terminal, Trash2, X } from 'lucide-react';
import { Language, useI18n } from '../../i18n';
import {
  closeServerShell,
  connectServerShellSocket,
  connectServer,
  createSshRunbookCommand,
  type ConnectServerPayload,
  deleteSshRunbookCommand,
  deleteServer,
  executeServerAction,
  fetchServerShellStatus,
  fetchSshRunbookCommands,
  importSshRunbookCommands,
  inspectServerIdentity,
  markSshRunbookCommandUsed,
  openServerShell,
  recordServerShellSelfTest,
  reorderSshRunbookCommands,
  resizeServerShell,
  runServerDiagnostic,
  streamServerShell,
  updateSshRunbookCommand,
  updateSshRunbookCommandPin,
  writeServerShell,
  type ServerDiagnosticResponse,
  type ServerShellSocketCloseEvent,
  type ServerIdentityResponse,
  type ServerShellSocketMetrics,
  type ServerShellStreamEvent,
  type ServerShellSocketReady,
  updateServer,
} from '../../services/apiClient';
import { CloudProvider, ServerNode, ServerStatus, SshAuthType, SshRunbookCommand, SshVerifyMode } from '../../types';
import { formatRegionName, percentClass, statusLabel } from '../../utils/format';
import { ServerFilters } from './serverFilters';
import { baseCloudProviders, customProviderFilterValue, resolveServerLifecycleStatus } from '../../shared/serverFilters';

interface ServerInventoryProps {
  allServers: ServerNode[];
  servers: ServerNode[];
  filters: ServerFilters;
  onFiltersChange: (filters: ServerFilters) => void;
  onTriageDraftOpen?: (triageId: ServerFleetTriageCardId) => void;
  onServerConnected: () => Promise<void> | void;
  onAuditTraceOpen?: (correlationId: string) => void;
  releaseFocusAnchor?: string;
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
const terminalRuntimePrefetchDelayMs = 1500;
const terminalRuntimeIdleTimeoutMs = 4500;
const terminalNetworkUiRefreshMs = 900;
const terminalTelemetryUiRefreshMs = 500;
const terminalWebSocketOpenTimeoutMs = 1400;
const terminalWebSocketReadyTimeoutMs = 14000;
const terminalWebSocketFallbackCacheMs = 2 * 60 * 1000;
const terminalPasteReviewMinBytes = 2048;
const terminalPasteReviewMinLines = 3;
const terminalPasteReviewPreviewLines = 8;
const terminalPasteReviewPreviewChars = 560;
const terminalTextEncoder = new TextEncoder();
const terminalBottleneckHistoryStorageKey = 'colipas.sshBottleneckRadarHistory.v1';
const terminalBottleneckHistoryLimit = 12;
const terminalBottleneckSnapshotDedupeMs = 6000;
const sshDoctorHistoryStorageKey = 'colipas.sshConnectionDoctorHistory.v1';
const sshDoctorHistoryLimit = 12;
const terminalSelfTestCommand = `printf 'colipas-ssh-self-test-start\\n'; i=1; while [ "$i" -le 40 ]; do printf 'colipas-ssh-self-test-%02d\\n' "$i"; i=$((i+1)); done; printf 'colipas-ssh-self-test-end\\n'`;
const terminalSelfTestTimeoutMs = 15000;
const terminalSelfTestLinePattern = /colipas-ssh-self-test-\d{2}/g;
const sshQuickCommands = [
  { id: 'identity', command: 'uname -a && uptime' },
  { id: 'disk', command: 'df -h' },
  { id: 'memory', command: 'free -h' },
  { id: 'network', command: 'ip -br addr' },
  { id: 'processes', command: 'ps -eo pid,ppid,stat,pcpu,pmem,comm --sort=-pcpu | head -12' },
  { id: 'logs', command: 'journalctl -p warning -n 50 --no-pager' },
] as const;
const sshRunbookCategories = ['all', 'system', 'network', 'storage', 'logs', 'other'] as const;
type SshRunbookCategory = (typeof sshRunbookCategories)[number];
const sshRunbookViews = ['manual', 'recent', 'frequent'] as const;
type SshRunbookView = (typeof sshRunbookViews)[number];
const sshRunbookPacks = [
  {
    id: 'system',
    accent: 'cyan',
    commands: [
      { id: 'load', command: 'uname -a && uptime && free -h' },
      { id: 'processes', command: 'ps -eo pid,ppid,stat,pcpu,pmem,comm --sort=-pcpu | head -12' },
      { id: 'services', command: 'systemctl --failed --no-pager' },
    ],
  },
  {
    id: 'docker',
    accent: 'violet',
    commands: [
      { id: 'containers', command: 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"' },
      { id: 'disk', command: 'docker system df' },
      { id: 'logs', command: 'docker ps --format "{{.Names}}" | head -5 | xargs -r -I{} sh -c \'echo === {}; docker logs --tail=40 {}\'' },
    ],
  },
  {
    id: 'network',
    accent: 'blue',
    commands: [
      { id: 'addresses', command: 'ip -br addr && ip route' },
      { id: 'ports', command: 'ss -tulpen' },
      { id: 'dns', command: 'getent hosts github.com || nslookup github.com' },
    ],
  },
  {
    id: 'security',
    accent: 'amber',
    commands: [
      { id: 'auth', command: 'journalctl -u ssh -u sshd -p warning -n 80 --no-pager' },
      { id: 'sessions', command: 'who && last -n 10' },
      { id: 'firewall', command: 'command -v ufw >/dev/null && ufw status || command -v firewall-cmd >/dev/null && firewall-cmd --state || iptables -S | head -40' },
    ],
  },
] as const;

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

interface TerminalNetworkQuality {
  tone: 'pending' | 'good' | 'warn' | 'slow';
  label: string;
  detail: string;
}

interface TerminalQualityInsight {
  tone: TerminalNetworkQuality['tone'];
  title: string;
  detail: string;
  metric: string;
}

interface TerminalTelemetryState {
  inputEvents: number;
  inputBytes: number;
  outputBytes: number;
  outputLines: number;
  latestFirstOutputMs: number | null;
  renderLagMs: number;
  pendingBytes: number;
  peakPendingBytes: number;
  lastInputAt: number | null;
  lastOutputAt: number | null;
  commandSubmittedAt: number | null;
}

interface TerminalTelemetryCard {
  id: 'input' | 'first-output' | 'output' | 'render';
  label: string;
  value: string;
  detail: string;
  tone: 'good' | 'warn' | 'slow' | 'pending';
}

interface TerminalTelemetryInsight {
  tone: TerminalNetworkQuality['tone'];
  title: string;
  detail: string;
  cards: TerminalTelemetryCard[];
}

interface TerminalPasteReview {
  sessionId: string;
  content: string;
  preview: string;
  lineCount: number;
  byteCount: number;
  createdAt: number;
}

interface TerminalBottleneckItem {
  id: 'network' | 'input' | 'output' | 'render';
  label: string;
  value: string;
  detail: string;
  level: number;
  tone: TerminalNetworkQuality['tone'];
}

interface TerminalBottleneckAdvisor {
  tone: TerminalNetworkQuality['tone'];
  title: string;
  detail: string;
  action: string;
  primaryLabel: string;
  items: TerminalBottleneckItem[];
}

interface TerminalLagAction {
  tone: TerminalNetworkQuality['tone'];
  title: string;
  detail: string;
  evidence: string;
  action: 'self-test' | 'clear';
  buttonLabel: string;
}

type SshConnectionDoctorStepId = 'asset' | 'credential' | 'backend' | 'shell' | 'terminal';
const sshConnectionDoctorStepIds: SshConnectionDoctorStepId[] = ['asset', 'credential', 'backend', 'shell', 'terminal'];

interface SshConnectionDoctorStep {
  id: SshConnectionDoctorStepId;
  label: string;
  value: string;
  detail: string;
  tone: TerminalNetworkQuality['tone'];
}

interface SshConnectionDoctorReport {
  serverId: string;
  serverName: string;
  checkedAt: string;
  tone: TerminalNetworkQuality['tone'];
  title: string;
  detail: string;
  summary: string;
  steps: SshConnectionDoctorStep[];
}

interface SshConnectionDoctorHistoryEntry {
  version: 1;
  id: string;
  targetKey: string;
  createdAt: string;
  tone: TerminalNetworkQuality['tone'];
  primary: SshConnectionDoctorStepId;
  stepTones: Record<SshConnectionDoctorStepId, TerminalNetworkQuality['tone']>;
  slowCount: number;
  warnCount: number;
  pendingCount: number;
}

interface SshConnectionDoctorTrendLane {
  id: SshConnectionDoctorStepId;
  label: string;
  value: string;
  detail: string;
  tone: TerminalNetworkQuality['tone'];
}

interface SshConnectionDoctorTrend {
  tone: TerminalNetworkQuality['tone'];
  title: string;
  detail: string;
  lanes: SshConnectionDoctorTrendLane[];
}

interface SshTroubleshootingReportItem {
  id: 'doctor' | 'trend' | 'channel' | 'telemetry' | 'action';
  label: string;
  value: string;
  detail: string;
  tone: TerminalNetworkQuality['tone'];
}

interface SshTroubleshootingReport {
  generatedAt: string;
  tone: TerminalNetworkQuality['tone'];
  title: string;
  detail: string;
  items: SshTroubleshootingReportItem[];
  text: string;
}

type SshChannelCheckStageId = 'browser' | 'websocket' | 'compatible' | 'cleanup';

interface SshChannelCheckStage {
  id: SshChannelCheckStageId;
  label: string;
  value: string;
  detail: string;
  tone: TerminalNetworkQuality['tone'];
  durationMs?: number;
}

interface SshChannelCheckReport {
  serverId: string;
  checkedAt: string;
  tone: TerminalNetworkQuality['tone'];
  title: string;
  detail: string;
  summary: string;
  stages: SshChannelCheckStage[];
}

interface SshChannelFixAction {
  id: SshChannelCheckStageId | 'summary';
  label: string;
  title: string;
  detail: string;
  action: string;
  tone: TerminalNetworkQuality['tone'];
}

interface SshChannelFixPlan {
  tone: TerminalNetworkQuality['tone'];
  title: string;
  detail: string;
  actions: SshChannelFixAction[];
  text: string;
}

type SshRunbookRecommendationReason = 'diagnostic' | 'bottleneck' | 'usage' | 'pinned' | 'ready';

interface SshRunbookRecommendation {
  command: SshRunbookCommand;
  category: Exclude<SshRunbookCategory, 'all'>;
  score: number;
  tone: TerminalNetworkQuality['tone'];
  reason: string;
  detail: string;
}

export type ServerFleetTriageCardId = 'resourcePressure' | 'sshMissing' | 'sshSimulated' | 'stopped';

interface ServerFleetTriageCard {
  id: ServerFleetTriageCardId;
  count: number;
  tone: TerminalNetworkQuality['tone'];
  title: string;
  detail: string;
  actionLabel: string;
}

type TerminalBottleneckSnapshotReason = 'close' | 'remote-close' | 'disconnect';

interface TerminalBottleneckSnapshot {
  version: 1;
  id: string;
  createdAt: string;
  reason: TerminalBottleneckSnapshotReason;
  tone: TerminalNetworkQuality['tone'];
  primary: TerminalBottleneckItem['id'];
  levels: Record<TerminalBottleneckItem['id'], number>;
  metrics: {
    rttMs: number | null;
    throughputBytesPerSecond: number;
    inputEvents: number;
    inputBytes: number;
    outputLines: number;
    outputBytes: number;
    firstOutputMs: number | null;
    renderLagMs: number;
    pendingBytes: number;
    peakPendingBytes: number;
  };
}

interface TerminalSelfTestState {
  status: 'running' | 'complete' | 'timeout' | 'failed';
  lines: number;
  durationMs: number;
  linesPerSecond: number;
  firstResponseMs: number;
  outputSpanMs: number;
  rttMs: number | null;
  throughputBytesPerSecond: number;
  networkLabel: string;
  message?: string;
}

interface TerminalSelfTestTracker {
  sessionId: string;
  startedAt: number;
  lineCount: number;
  firstLineAt: number | null;
  lastLineAt: number | null;
  timeoutId: number | null;
}

const emptyTerminalTelemetry: TerminalTelemetryState = {
  inputEvents: 0,
  inputBytes: 0,
  outputBytes: 0,
  outputLines: 0,
  latestFirstOutputMs: null,
  renderLagMs: 0,
  pendingBytes: 0,
  peakPendingBytes: 0,
  lastInputAt: null,
  lastOutputAt: null,
  commandSubmittedAt: null,
};

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

export function ServerInventory({ allServers, servers, filters, onFiltersChange, onTriageDraftOpen, onServerConnected, onAuditTraceOpen, releaseFocusAnchor }: ServerInventoryProps) {
  const { language, t } = useI18n();
  const regions = useMemo(() => buildSortedRegions(allServers), [allServers]);
  const scopedRegions = useMemo(() => normalizeScopedRegions(filters.regionScope), [filters.regionScope]);
  const providerFilters = useMemo(() => buildProviderOptions(allServers.map((server) => server.provider)), [allServers]);
  const healthScopeLabel = filters.health ? t(`servers.healthScope.${filters.health}`) : '';
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
  const [terminalTelemetry, setTerminalTelemetry] = useState<TerminalTelemetryState>(emptyTerminalTelemetry);
  const [terminalSelfTest, setTerminalSelfTest] = useState<TerminalSelfTestState | null>(null);
  const [terminalTransport, setTerminalTransport] = useState<'websocket' | 'compatible' | null>(null);
  const [terminalPasteReview, setTerminalPasteReview] = useState<TerminalPasteReview | null>(null);
  const [terminalPasteSending, setTerminalPasteSending] = useState(false);
  const [sshRunbookCommands, setSshRunbookCommands] = useState<SshRunbookCommand[]>([]);
  const [sshRunbookForm, setSshRunbookForm] = useState({ title: '', command: '' });
  const [editingSshRunbookId, setEditingSshRunbookId] = useState('');
  const [sshRunbookSearch, setSshRunbookSearch] = useState('');
  const [sshRunbookCategory, setSshRunbookCategory] = useState<SshRunbookCategory>('all');
  const [sshRunbookView, setSshRunbookView] = useState<SshRunbookView>('manual');
  const [sshRunbookLoading, setSshRunbookLoading] = useState(false);
  const [sshRunbookSaving, setSshRunbookSaving] = useState(false);
  const [deletingSshRunbookId, setDeletingSshRunbookId] = useState('');
  const [movingSshRunbookId, setMovingSshRunbookId] = useState('');
  const [importingSshRunbookPackId, setImportingSshRunbookPackId] = useState('');
  const [pinningSshRunbookId, setPinningSshRunbookId] = useState('');
  const [diagnosingServerId, setDiagnosingServerId] = useState('');
  const [sshDoctorReport, setSshDoctorReport] = useState<SshConnectionDoctorReport | null>(null);
  const [sshDoctorHistory, setSshDoctorHistory] = useState<SshConnectionDoctorHistoryEntry[]>(() => readSshDoctorHistory());
  const [sshChannelCheckReport, setSshChannelCheckReport] = useState<SshChannelCheckReport | null>(null);
  const [checkingSshChannelServerId, setCheckingSshChannelServerId] = useState('');
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
  const terminalPasteListenerRef = useRef<{ element: HTMLTextAreaElement; handler: (event: ClipboardEvent) => void } | null>(null);
  const terminalWriteBufferRef = useRef('');
  const terminalWriteRafRef = useRef<number | null>(null);
  const terminalInputBufferRef = useRef('');
  const terminalInputTimerRef = useRef<number | null>(null);
  const terminalInputChainRef = useRef<Promise<void>>(Promise.resolve());
  const terminalInputInFlightRef = useRef(false);
  const terminalInputFlushAgainRef = useRef(false);
  const terminalNetworkRenderedRef = useRef<TerminalNetworkStats | null>(null);
  const terminalNetworkRenderedAtRef = useRef(0);
  const terminalTelemetryRef = useRef<TerminalTelemetryState>(emptyTerminalTelemetry);
  const terminalTelemetryRenderedAtRef = useRef(0);
  const terminalWebSocketFallbackUntilRef = useRef(0);
  const terminalLastBottleneckSnapshotRef = useRef<{ signature: string; savedAt: number } | null>(null);
  const terminalSelfTestRef = useRef<TerminalSelfTestTracker | null>(null);
  const terminalPasteReviewRef = useRef<TerminalPasteReview | null>(null);
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
  const fleetTriageCards = useMemo(() => buildServerFleetTriageCards(allServers, t), [allServers, t]);
  const visibleServerRows = useMemo(() => servers.slice(0, visibleServerLimit), [servers, visibleServerLimit]);
  const hiddenServerCount = Math.max(servers.length - visibleServerRows.length, 0);
  const allServersById = useMemo(() => buildServerById(allServers), [allServers]);
  const activeSshServer = useMemo(() => allServersById.get(sshPanelServerId) ?? null, [allServersById, sshPanelServerId]);
  const sshDoctorServer = useMemo(() => (sshDoctorReport ? allServersById.get(sshDoctorReport.serverId) ?? null : null), [allServersById, sshDoctorReport]);
  const sshDoctorTrend = useMemo(() => (sshDoctorReport ? buildSshDoctorTrend(sshDoctorReport, sshDoctorHistory, t) : null), [sshDoctorReport, sshDoctorHistory, t]);
  const sshDoctorTerminalActive = Boolean(sshDoctorReport && terminalShellId && terminalShellServerIdRef.current === sshDoctorReport.serverId);
  const terminalNetworkLabel = terminalNetworkStats
    ? `${formatTerminalRtt(terminalNetworkStats.rttMs)} / ${formatBytesPerSecond(terminalNetworkStats.throughputBytesPerSecond)}`
    : '';
  const terminalNetworkQuality = terminalNetworkStats ? getTerminalNetworkQuality(terminalNetworkStats, t) : null;
  const terminalQualityInsight = getTerminalQualityInsight(
    terminalNetworkStats,
    terminalSelfTest,
    terminalTransport,
    Boolean(terminalShellId),
    sshRunning,
    t,
  );
  const sshRunbookCategoryCounts = useMemo(() => countSshRunbookCategories(sshRunbookCommands), [sshRunbookCommands]);
  const visibleSshRunbookCommands = useMemo(
    () => filterSshRunbookCommands(sshRunbookCommands, sshRunbookSearch, sshRunbookCategory, sshRunbookView),
    [sshRunbookCommands, sshRunbookSearch, sshRunbookCategory, sshRunbookView],
  );
  const sshRunbookHasFilters = sshRunbookSearch.trim().length > 0 || sshRunbookCategory !== 'all' || sshRunbookView !== 'manual';
  const sshRunbookManualView = sshRunbookView === 'manual';
  const terminalTelemetryInsight = getTerminalTelemetryInsight(terminalTelemetry, terminalNetworkStats, terminalTransport, Boolean(terminalShellId), t);
  const terminalBottleneckAdvisor = getTerminalBottleneckAdvisor(terminalTelemetry, terminalNetworkStats, terminalTransport, Boolean(terminalShellId), t);
  const terminalLagAction = getTerminalLagAction(terminalBottleneckAdvisor, terminalTelemetry, terminalNetworkStats, terminalTransport, Boolean(terminalShellId), t);
  const sshRunbookRecommendations = useMemo(
    () => buildSshRunbookRecommendations(sshRunbookCommands, sshDoctorReport, terminalBottleneckAdvisor, Boolean(terminalShellId), t),
    [sshRunbookCommands, sshDoctorReport, terminalBottleneckAdvisor, terminalShellId, t],
  );
  const sshTroubleshootingReport = useMemo(() => (sshDoctorReport
    ? buildSshTroubleshootingReport({
        report: sshDoctorReport,
        trend: sshDoctorTrend,
        terminalActive: sshDoctorTerminalActive,
        terminalTelemetry: sshDoctorTerminalActive ? terminalTelemetry : emptyTerminalTelemetry,
        terminalNetworkStats: sshDoctorTerminalActive ? terminalNetworkStats : null,
        terminalTransport: sshDoctorTerminalActive ? terminalTransport : null,
        terminalSelfTest: sshDoctorTerminalActive ? terminalSelfTest : null,
        terminalBottleneckAdvisor: sshDoctorTerminalActive ? terminalBottleneckAdvisor : null,
        t,
      })
    : null), [sshDoctorReport, sshDoctorTrend, sshDoctorTerminalActive, terminalTelemetry, terminalNetworkStats, terminalTransport, terminalSelfTest, terminalBottleneckAdvisor, t]);
  const sshChannelFixPlan = useMemo(() => (
    sshChannelCheckReport ? buildSshChannelFixPlan(sshChannelCheckReport, t) : null
  ), [sshChannelCheckReport, t]);
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
  const sshReleaseFocusActive = releaseFocusAnchor === 'server-ssh';

  useEffect(() => () => {
    closeActiveShellSession(false);
    disposeXterm();
  }, []);
  const formVisible = formOpen || Boolean(editingServerId) || (allServers.length === 0 && !formDismissed);

  useEffect(() => {
    let active = true;
    setSshRunbookLoading(true);
    fetchSshRunbookCommands()
      .then((result) => {
        if (active) {
          setSshRunbookCommands(result.commands);
        }
      })
      .catch((error) => {
        if (active) {
          showActionMessage(error instanceof Error ? error.message : t('servers.quickCommandLoadFailed'));
        }
      })
      .finally(() => {
        if (active) {
          setSshRunbookLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [t]);

  useEffect(() => {
    if (releaseFocusAnchor !== 'server-ssh') {
      return;
    }
    setFormDismissed(false);
    setFormOpen(true);
  }, [releaseFocusAnchor]);

  useEffect(() => {
    if (visibleConnectedServerCount === 0 || terminalRuntimeRef.current) {
      return undefined;
    }

    return scheduleTerminalRuntimeWarmup();
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

  async function runSshConnectionDoctor(server: ServerNode) {
    setDiagnosingServerId(server.id);
    clearActionMessage();
    setSshChannelCheckReport(null);

    try {
      const diagnostic = server.ssh?.connected ? await runServerDiagnostic(server.id) : null;
      const report = buildSshConnectionDoctorReport({
        server,
        diagnostic,
        error: null,
        terminalActive: terminalShellServerIdRef.current === server.id && Boolean(terminalShellIdRef.current),
        terminalTransport: terminalShellServerIdRef.current === server.id ? terminalShellTransportRef.current : null,
        terminalNetworkStats: terminalShellServerIdRef.current === server.id ? terminalNetworkRenderedRef.current : null,
        terminalTelemetry: terminalShellServerIdRef.current === server.id ? terminalTelemetryRef.current : emptyTerminalTelemetry,
        t,
      });
      setSshDoctorReport(report);
      setSshDoctorHistory((current) => rememberSshDoctorReport(report, current));
      showActionMessage(t('servers.sshDoctorComplete', { name: report.serverName }));
    } catch (error) {
      const report = buildSshConnectionDoctorReport({
        server,
        diagnostic: null,
        error,
        terminalActive: terminalShellServerIdRef.current === server.id && Boolean(terminalShellIdRef.current),
        terminalTransport: terminalShellServerIdRef.current === server.id ? terminalShellTransportRef.current : null,
        terminalNetworkStats: terminalShellServerIdRef.current === server.id ? terminalNetworkRenderedRef.current : null,
        terminalTelemetry: terminalShellServerIdRef.current === server.id ? terminalTelemetryRef.current : emptyTerminalTelemetry,
        t,
      });
      setSshDoctorReport(report);
      setSshDoctorHistory((current) => rememberSshDoctorReport(report, current));
      showActionMessage(t('servers.sshDoctorIssueFound', { name: report.serverName }), { autoDismissMs: 7000 });
    } finally {
      setDiagnosingServerId('');
    }
  }

  async function runSshChannelSelfCheck(server: ServerNode) {
    if (!server.ssh?.connected) {
      showActionMessage(t('servers.selectVerifiedFirst'));
      return;
    }

    setCheckingSshChannelServerId(server.id);
    clearActionMessage();
    setSshChannelCheckReport(null);

    const stages: SshChannelCheckStage[] = [];
    let beforeActiveCount = 0;
    try {
      const status = await fetchServerShellStatus();
      beforeActiveCount = status.activeCount;
    } catch {
      beforeActiveCount = activeShellCount;
    }

    const browserStage = buildSshChannelBrowserStage(t);
    stages.push(browserStage);

    try {
      stages.push(await probeWebSocketSshChannel(server, getTerminalDimensions, t));
    } catch (error) {
      stages.push(buildSshChannelFailureStage('websocket', error, t));
    }

    try {
      stages.push(await probeCompatibleSshChannel(server, getTerminalDimensions, t));
    } catch (error) {
      stages.push(buildSshChannelFailureStage('compatible', error, t));
    }

    try {
      const status = await fetchServerShellStatus();
      stages.push(buildSshChannelCleanupStage(beforeActiveCount, status.activeCount, t));
      setActiveShellCount(status.activeCount);
    } catch (error) {
      stages.push(buildSshChannelFailureStage('cleanup', error, t));
    }

    const report = buildSshChannelCheckReport(server, stages, t);
    setSshChannelCheckReport(report);
    showActionMessage(
      report.tone === 'slow'
        ? t('servers.sshChannelCheckIssueFound', { name: sanitizeSshDoctorText(server.name) })
        : t('servers.sshChannelCheckComplete', { name: sanitizeSshDoctorText(server.name) }),
      { autoDismissMs: 7000 },
    );
    setCheckingSshChannelServerId('');
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

      {fleetTriageCards.length > 0 && (
        <div className="server-triage-strip" data-server-triage="true" aria-label={t('servers.triageTitle')}>
          <div className="server-triage-heading">
            <span><Sparkles size={14} /> {t('servers.triageEyebrow')}</span>
            <strong>{t('servers.triageTitle')}</strong>
            <small>{t('servers.triageDetail')}</small>
          </div>
          <div className="server-triage-cards">
            {fleetTriageCards.map((card) => {
              const active = isServerFleetTriageActive(card.id, filters);
              return (
                <article
                  key={card.id}
                  className={`server-triage-card ${card.tone}${active ? ' active' : ''}`}
                  data-server-triage-card={card.id}
                >
                  <span>{card.title}</span>
                  <strong>{card.count}</strong>
                  <small>{card.detail}</small>
                  <div className="server-triage-card-actions">
                    <button
                      type="button"
                      data-server-triage-filter={card.id}
                      aria-pressed={active}
                      disabled={card.count === 0}
                      onClick={() => onFiltersChange(buildServerFleetTriageFilters(card.id, filters))}
                    >
                      {card.actionLabel}
                    </button>
                    {onTriageDraftOpen && (
                      <button
                        type="button"
                        className="secondary"
                        data-server-triage-draft={card.id}
                        disabled={card.count === 0}
                        onClick={() => onTriageDraftOpen(card.id)}
                      >
                        {t('servers.triageDraftAction')}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

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
        {filters.health && (
          <div className="region-scope-chip health-scope-chip" data-health-scope-chip="true">
            <ShieldCheck size={15} />
            <span>{t('servers.healthScopeLabel')}</span>
            <strong>{healthScopeLabel}</strong>
            <button type="button" onClick={() => onFiltersChange({ ...filters, health: undefined })}>
              {t('servers.clearHealthScope')}
            </button>
          </div>
        )}
      </div>

      {formVisible && (
      <form
        className={sshReleaseFocusActive ? 'connect-form open release-focus-anchor active' : 'connect-form open'}
        data-release-focus-anchor="server-ssh"
        tabIndex={-1}
        onSubmit={handleConnect}
      >
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

      {sshDoctorReport && (
        <div className={`ssh-connection-doctor ${sshDoctorReport.tone}`} data-ssh-connection-doctor="true" aria-live="polite">
          <div className="ssh-connection-doctor-header">
            <span className="ssh-connection-doctor-icon" aria-hidden="true">
              <ShieldCheck size={20} />
            </span>
            <div>
              <small>{t('servers.sshDoctorEyebrow')}</small>
              <h3>{sshDoctorReport.title}</h3>
              <p>{sshDoctorReport.detail}</p>
            </div>
            <div className="ssh-connection-doctor-actions">
              <button type="button" onClick={copySshDoctorSummary}>
                <Copy size={14} />
                {t('servers.sshDoctorCopy')}
              </button>
              <button type="button" data-ssh-troubleshooting-report-copy="true" onClick={copySshTroubleshootingReport} disabled={!sshTroubleshootingReport}>
                <FileText size={14} />
                {t('servers.sshTroubleshootingReportCopy')}
              </button>
              <button type="button" data-ssh-channel-check-run="true" disabled={!sshDoctorServer?.ssh?.connected || checkingSshChannelServerId === sshDoctorServer?.id} onClick={() => sshDoctorServer && runSshChannelSelfCheck(sshDoctorServer)}>
                <Network size={14} />
                {checkingSshChannelServerId === sshDoctorServer?.id ? t('servers.sshChannelCheckRunning') : t('servers.sshChannelCheckRun')}
              </button>
              <button type="button" disabled={!sshDoctorServer?.ssh?.connected} onClick={() => sshDoctorServer && openSshConsole(sshDoctorServer)}>
                <Terminal size={14} />
                {t('servers.sshDoctorOpenTerminal')}
              </button>
              <button type="button" className="icon-button" aria-label={t('common.cancel')} onClick={() => setSshDoctorReport(null)}>
                <X size={15} />
              </button>
            </div>
          </div>
          <div className="ssh-connection-doctor-steps">
            {sshDoctorReport.steps.map((step) => (
              <article key={step.id} className={step.tone} data-ssh-connection-doctor-step={step.id}>
                <span>{step.label}</span>
                <strong>{step.value}</strong>
                <small>{step.detail}</small>
              </article>
            ))}
          </div>
          {sshDoctorTrend && (
            <div className={`ssh-connection-doctor-trend ${sshDoctorTrend.tone}`} data-ssh-connection-doctor-trend="true">
              <div className="ssh-connection-doctor-trend-summary">
                <span>{t('servers.sshDoctorTrendEyebrow')}</span>
                <strong>{sshDoctorTrend.title}</strong>
                <small>{sshDoctorTrend.detail}</small>
              </div>
              <div className="ssh-connection-doctor-trend-lanes">
                {sshDoctorTrend.lanes.map((lane) => (
                  <article key={lane.id} className={lane.tone} data-ssh-connection-doctor-trend-lane={lane.id}>
                    <span>{lane.label}</span>
                    <strong>{lane.value}</strong>
                    <small>{lane.detail}</small>
                  </article>
                ))}
              </div>
            </div>
          )}
          {sshTroubleshootingReport && (
            <div className={`ssh-troubleshooting-report ${sshTroubleshootingReport.tone}`} data-ssh-troubleshooting-report="true">
              <div className="ssh-troubleshooting-report-summary">
                <span>{t('servers.sshTroubleshootingReportGenerated', { time: sshTroubleshootingReport.generatedAt })}</span>
                <strong>{sshTroubleshootingReport.title}</strong>
                <small>{sshTroubleshootingReport.detail}</small>
              </div>
              <div className="ssh-troubleshooting-report-items">
                {sshTroubleshootingReport.items.map((item) => (
                  <article key={item.id} className={item.tone} data-ssh-troubleshooting-report-item={item.id}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                    <small>{item.detail}</small>
                  </article>
                ))}
              </div>
            </div>
          )}
          {sshChannelCheckReport && (
            <div className={`ssh-channel-check ${sshChannelCheckReport.tone}`} data-ssh-channel-check="true">
              <div className="ssh-channel-check-summary">
                <span>{t('servers.sshChannelCheckEyebrow')}</span>
                <strong>{sshChannelCheckReport.title}</strong>
                <small>{sshChannelCheckReport.detail}</small>
              </div>
              <div className="ssh-channel-check-stages">
                {sshChannelCheckReport.stages.map((stage) => (
                  <article key={stage.id} className={stage.tone} data-ssh-channel-check-stage={stage.id}>
                    <span>{stage.label}</span>
                    <strong>{stage.value}</strong>
                    <small>{stage.detail}</small>
                  </article>
                ))}
              </div>
              {sshChannelFixPlan && (
                <div className={`ssh-channel-fix-plan ${sshChannelFixPlan.tone}`} data-ssh-channel-fix-plan="true">
                  <div className="ssh-channel-fix-plan-summary">
                    <span>{t('servers.sshChannelFixPlanEyebrow')}</span>
                    <strong>{sshChannelFixPlan.title}</strong>
                    <small>{sshChannelFixPlan.detail}</small>
                    <button type="button" data-ssh-channel-fix-plan-copy="true" onClick={copySshChannelFixPlan}>
                      <Copy size={14} />
                      {t('servers.sshChannelFixPlanCopy')}
                    </button>
                  </div>
                  <div className="ssh-channel-fix-plan-actions">
                    {sshChannelFixPlan.actions.map((action) => (
                      <article key={action.id} className={action.tone} data-ssh-channel-fix-plan-action={action.id}>
                        <span>{action.label}</span>
                        <strong>{action.title}</strong>
                        <small>{action.detail}</small>
                        <em>{action.action}</em>
                      </article>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <p className="ssh-connection-doctor-safe">{t('servers.sshDoctorSafeNote')}</p>
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
                    <button type="button" disabled={diagnosingServerId === server.id} onClick={() => runSshConnectionDoctor(server)}>
                      <ShieldCheck size={15} />
                      {diagnosingServerId === server.id ? t('servers.sshDoctorRunningShort') : t('servers.diagnostic')}
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
                  <ActionButton label={diagnosingServerId === server.id ? t('servers.sshDoctorRunning') : t('servers.diagnostic')} disabled={diagnosingServerId === server.id} onClick={() => runSshConnectionDoctor(server)} icon={<ShieldCheck size={15} />} />
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
                      <span
                        className={`ssh-terminal-network ${terminalNetworkQuality?.tone ?? 'pending'}`}
                        title={terminalNetworkQuality?.detail ?? t('servers.terminalNetworkStats')}
                      >
                        <b>{terminalNetworkQuality?.label ?? t('servers.terminalNetworkPending')}</b>
                        <small>{terminalNetworkLabel}</small>
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
                <div className={`ssh-terminal-quality ${terminalQualityInsight.tone}`} aria-live="polite">
                  <span className="ssh-terminal-quality-beacon" aria-hidden="true" />
                  <div>
                    <strong>{terminalQualityInsight.title}</strong>
                    <small>{terminalQualityInsight.detail}</small>
                  </div>
                  <code>{terminalQualityInsight.metric}</code>
                </div>
                <div className={`ssh-terminal-telemetry ${terminalTelemetryInsight.tone}`} data-ssh-terminal-telemetry="true" aria-live="polite">
                  <div className="ssh-terminal-telemetry-heading">
                    <span>{t('servers.telemetryTitle')}</span>
                    <strong>{terminalTelemetryInsight.title}</strong>
                    <small>{terminalTelemetryInsight.detail}</small>
                  </div>
                  <div className="ssh-terminal-telemetry-grid">
                    {terminalTelemetryInsight.cards.map((card) => (
                      <article key={card.id} className={card.tone} data-ssh-terminal-telemetry-card={card.id} aria-label={`${card.label}: ${card.value}`}>
                        <span>{card.label}</span>
                        <strong>{card.value}</strong>
                        <small>{card.detail}</small>
                      </article>
                    ))}
                  </div>
                </div>
                <div className={`ssh-terminal-bottleneck ${terminalBottleneckAdvisor.tone}`} data-ssh-terminal-bottleneck="true" aria-live="polite">
                  <div className="ssh-terminal-bottleneck-summary">
                    <span>{t('servers.bottleneckTitle')}</span>
                    <strong>{terminalBottleneckAdvisor.title}</strong>
                    <small>{terminalBottleneckAdvisor.detail}</small>
                    <em>{terminalBottleneckAdvisor.action}</em>
                  </div>
                  <div className="ssh-terminal-bottleneck-radar" aria-label={terminalBottleneckAdvisor.primaryLabel}>
                    {terminalBottleneckAdvisor.items.map((item) => (
                      <article key={item.id} className={item.tone} data-ssh-terminal-bottleneck-item={item.id}>
                        <div>
                          <span>{item.label}</span>
                          <strong>{item.value}</strong>
                        </div>
                        <i aria-hidden="true"><b style={{ width: `${item.level}%` }} /></i>
                        <small>{item.detail}</small>
                      </article>
                    ))}
                  </div>
                </div>
                {terminalLagAction && (
                  <div className={`ssh-terminal-lag-action ${terminalLagAction.tone}`} data-ssh-terminal-lag-action="true" aria-live="polite" onClick={(event) => event.stopPropagation()}>
                    <div className="ssh-terminal-lag-action-copy">
                      <span><Sparkles size={14} /> {t('servers.terminalLagActionEyebrow')}</span>
                      <strong>{terminalLagAction.title}</strong>
                      <small>{terminalLagAction.detail}</small>
                    </div>
                    <code>{terminalLagAction.evidence}</code>
                    <button
                      type="button"
                      onClick={() => runTerminalLagAction(terminalLagAction.action)}
                      disabled={!terminalShellId || sshInterrupting || (terminalLagAction.action === 'self-test' && terminalSelfTestRunning)}
                    >
                      {terminalLagAction.buttonLabel}
                    </button>
                  </div>
                )}
                {terminalPasteReview && (
                  <div className="ssh-paste-review" data-ssh-paste-review="true" onClick={(event) => event.stopPropagation()}>
                    <div className="ssh-paste-review-summary">
                      <span><FileText size={15} /> {t('servers.sshPasteReviewEyebrow')}</span>
                      <strong>{t('servers.sshPasteReviewTitle')}</strong>
                      <small>{t('servers.sshPasteReviewDetail', {
                        lines: terminalPasteReview.lineCount,
                        size: formatCompactBytes(terminalPasteReview.byteCount),
                      })}</small>
                    </div>
                    <pre>{terminalPasteReview.preview}</pre>
                    <div className="ssh-paste-review-actions">
                      <button
                        type="button"
                        className="tool-button primary"
                        data-ssh-paste-review-send="true"
                        onClick={sendReviewedTerminalPaste}
                        disabled={terminalPasteSending}
                      >
                        {terminalPasteSending ? t('servers.sshPasteReviewSending') : t('servers.sshPasteReviewSend')}
                      </button>
                      <button type="button" className="tool-button" data-ssh-paste-review-cancel="true" onClick={cancelReviewedTerminalPaste} disabled={terminalPasteSending}>
                        {t('servers.sshPasteReviewCancel')}
                      </button>
                    </div>
                  </div>
                )}
                <div className="ssh-quick-command-deck" data-ssh-quick-command-deck="true" onClick={(event) => event.stopPropagation()}>
                  <div className="ssh-quick-command-heading">
                    <span>{t('servers.quickCommandEyebrow')}</span>
                    <strong>{t('servers.quickCommandTitle')}</strong>
                    <small>{sshRunbookLoading ? t('servers.quickCommandLoading') : t('servers.quickCommandDetail')}</small>
                  </div>
                  <div className="ssh-runbook-workspace">
                    <form className={editingSshRunbookId ? 'ssh-runbook-form editing' : 'ssh-runbook-form'} data-ssh-runbook-form="true" onSubmit={saveSshRunbookCommand}>
                      <input
                        value={sshRunbookForm.title}
                        onChange={(event) => setSshRunbookForm((current) => ({ ...current, title: event.target.value }))}
                        placeholder={t('servers.quickCommandCustomTitlePlaceholder')}
                        maxLength={48}
                      />
                      <input
                        value={sshRunbookForm.command}
                        onChange={(event) => setSshRunbookForm((current) => ({ ...current, command: event.target.value }))}
                        placeholder={t('servers.quickCommandCustomCommandPlaceholder')}
                        maxLength={360}
                      />
                      <button type="submit" disabled={sshRunbookSaving}>
                        {sshRunbookSaving ? t('common.processing') : editingSshRunbookId ? t('servers.quickCommandUpdate') : t('servers.quickCommandSave')}
                      </button>
                      {editingSshRunbookId && (
                        <button type="button" className="secondary" data-ssh-runbook-edit-cancel="true" onClick={cancelSshRunbookEdit}>
                          {t('servers.quickCommandCancelEdit')}
                        </button>
                      )}
                    </form>
                    <div className="ssh-runbook-lens" data-ssh-runbook-lens="true">
                      <label className="ssh-runbook-search">
                        <Search size={13} />
                        <input
                          data-ssh-runbook-search="true"
                          value={sshRunbookSearch}
                          onChange={(event) => setSshRunbookSearch(event.target.value)}
                          placeholder={t('servers.quickCommandSearchPlaceholder')}
                          aria-label={t('servers.quickCommandSearchPlaceholder')}
                        />
                      </label>
                      <div className="ssh-runbook-categories" aria-label={t('servers.quickCommandFilterLabel')}>
                        {sshRunbookCategories.map((category) => (
                          <button
                            key={category}
                            type="button"
                            className={sshRunbookCategory === category ? 'active' : undefined}
                            data-ssh-runbook-category={category}
                            aria-pressed={sshRunbookCategory === category}
                            onClick={() => setSshRunbookCategory(category)}
                          >
                            <span>{t(`servers.quickCommandCategory.${category}`)}</span>
                            <small>{category === 'all' ? sshRunbookCommands.length : sshRunbookCategoryCounts[category]}</small>
                          </button>
                        ))}
                      </div>
                      <div className="ssh-runbook-views" aria-label={t('servers.quickCommandViewLabel')} data-ssh-runbook-views="true">
                        {sshRunbookViews.map((view) => (
                          <button
                            key={view}
                            type="button"
                            className={sshRunbookView === view ? 'active' : undefined}
                            data-ssh-runbook-view={view}
                            aria-pressed={sshRunbookView === view}
                            onClick={() => setSshRunbookView(view)}
                          >
                            <span>{t(`servers.quickCommandView.${view}`)}</span>
                          </button>
                        ))}
                      </div>
                      {sshRunbookView !== 'manual' && (
                        <small className="ssh-runbook-view-hint" data-ssh-runbook-view-hint="true">
                          {t(`servers.quickCommandViewHint.${sshRunbookView}`)}
                        </small>
                      )}
                      {sshRunbookHasFilters && (
                        <button
                          type="button"
                          className="ssh-runbook-clear-filter"
                          data-ssh-runbook-clear-filter="true"
                          onClick={() => {
                            setSshRunbookSearch('');
                            setSshRunbookCategory('all');
                            setSshRunbookView('manual');
                          }}
                        >
                          {t('servers.quickCommandFilterClear')}
                        </button>
                      )}
                    </div>
                    {sshRunbookRecommendations.length > 0 && (
                      <div className="ssh-runbook-recommendations" data-ssh-runbook-recommendations="true" aria-label={t('servers.quickCommandRecommendTitle')}>
                        <div className="ssh-runbook-recommendations-heading">
                          <span><Sparkles size={13} /> {t('servers.quickCommandRecommendEyebrow')}</span>
                          <strong>{t('servers.quickCommandRecommendTitle')}</strong>
                          <small>{t('servers.quickCommandRecommendDetail')}</small>
                        </div>
                        <div className="ssh-runbook-recommendation-grid">
                          {sshRunbookRecommendations.map((item) => (
                            <article key={item.command.id} className={item.tone} data-ssh-runbook-recommendation={item.command.id}>
                              <span>{item.reason}</span>
                              <strong>{item.command.title}</strong>
                              <small>{item.detail}</small>
                              <div>
                                <button
                                  type="button"
                                  data-ssh-runbook-recommendation-insert={item.command.id}
                                  onClick={() => sendSshQuickCommand(item.command.command, item.command.title, 'insert', item.command.id)}
                                  disabled={!terminalShellId}
                                >
                                  {t('servers.quickCommandInsert')}
                                </button>
                                <button
                                  type="button"
                                  data-ssh-runbook-recommendation-run={item.command.id}
                                  onClick={() => sendSshQuickCommand(item.command.command, item.command.title, 'run', item.command.id)}
                                  disabled={!terminalShellId}
                                >
                                  {t('servers.quickCommandRun')}
                                </button>
                              </div>
                            </article>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="ssh-runbook-pack-dock" data-ssh-runbook-pack-dock="true" aria-label={t('servers.quickCommandPackTitle')}>
                      <div className="ssh-runbook-pack-heading">
                        <span>{t('servers.quickCommandPackEyebrow')}</span>
                        <strong>{t('servers.quickCommandPackTitle')}</strong>
                        <small>{t('servers.quickCommandPackDetail')}</small>
                      </div>
                      <div className="ssh-runbook-pack-grid">
                        {sshRunbookPacks.map((pack) => (
                          <article key={pack.id} className={`accent-${pack.accent}`} data-ssh-runbook-pack={pack.id}>
                            <span>{pack.commands.length} {t('servers.quickCommandPackCommandCount')}</span>
                            <strong>{t(`servers.quickCommandPack.${pack.id}.title`)}</strong>
                            <small>{t(`servers.quickCommandPack.${pack.id}.detail`)}</small>
                            <button
                              type="button"
                              data-ssh-runbook-pack-import={pack.id}
                              onClick={() => importSshRunbookPack(pack)}
                              disabled={Boolean(importingSshRunbookPackId)}
                            >
                              {importingSshRunbookPackId === pack.id ? t('common.processing') : t('servers.quickCommandPackImport')}
                            </button>
                          </article>
                        ))}
                      </div>
                    </div>
                    <div className="ssh-quick-command-grid" role="list" aria-label={t('servers.quickCommandTitle')}>
                      {sshQuickCommands.map((item) => {
                        const title = t(`servers.quickCommand.${item.id}.title`);
                        return (
                          <article key={item.id} role="listitem" data-ssh-quick-command={item.id}>
                            <span>{t(`servers.quickCommand.${item.id}.label`)}</span>
                            <strong>{title}</strong>
                            <code>{item.command}</code>
                            <div>
                              <button
                                type="button"
                                data-ssh-quick-command-insert={item.id}
                                onClick={() => sendSshQuickCommand(item.command, title, 'insert')}
                                disabled={!terminalShellId}
                              >
                                {t('servers.quickCommandInsert')}
                              </button>
                              <button
                                type="button"
                                data-ssh-quick-command-run={item.id}
                                onClick={() => sendSshQuickCommand(item.command, title, 'run')}
                                disabled={!terminalShellId}
                              >
                                {t('servers.quickCommandRun')}
                              </button>
                            </div>
                          </article>
                        );
                      })}
                      {visibleSshRunbookCommands.map((item) => {
                        const orderIndex = sshRunbookCommands.findIndex((command) => command.id === item.id);
                        return (
                          <article key={item.id} role="listitem" className={item.pinned ? 'custom pinned' : 'custom'} data-ssh-runbook-command={item.id}>
                            <span>{item.pinned ? t('servers.quickCommandPinnedLabel') : t(`servers.quickCommandCategory.${classifySshRunbookCommand(item)}`)}</span>
                            <strong>{item.title}</strong>
                            <small className="ssh-runbook-usage" data-ssh-runbook-usage={item.id}>{formatSshRunbookUsage(item, t)}</small>
                            <code>{item.command}</code>
                            <div>
                              <button
                                type="button"
                                className="pin"
                                data-ssh-runbook-command-pin={item.id}
                                aria-label={t(item.pinned ? 'servers.quickCommandUnpinAria' : 'servers.quickCommandPinAria', { title: item.title })}
                                onClick={() => toggleSshRunbookPin(item)}
                                disabled={pinningSshRunbookId === item.id}
                              >
                                <Star size={12} fill={item.pinned ? 'currentColor' : 'none'} />
                              </button>
                              <button
                                type="button"
                                data-ssh-runbook-command-edit={item.id}
                                aria-label={t('servers.quickCommandEditAria', { title: item.title })}
                                onClick={() => startEditSshRunbookCommand(item)}
                              >
                                {t('servers.quickCommandEdit')}
                              </button>
                              <button
                                type="button"
                                data-ssh-runbook-command-insert={item.id}
                                onClick={() => sendSshQuickCommand(item.command, item.title, 'insert', item.id)}
                                disabled={!terminalShellId}
                              >
                                {t('servers.quickCommandInsert')}
                              </button>
                              <button
                                type="button"
                                data-ssh-runbook-command-run={item.id}
                                onClick={() => sendSshQuickCommand(item.command, item.title, 'run', item.id)}
                                disabled={!terminalShellId}
                              >
                                {t('servers.quickCommandRun')}
                              </button>
                              <button
                                type="button"
                                className="delete"
                                data-ssh-runbook-command-delete={item.id}
                                aria-label={t('servers.quickCommandDeleteAria', { title: item.title })}
                                onClick={() => removeSshRunbookCommand(item.id)}
                                disabled={deletingSshRunbookId === item.id}
                              >
                                <Trash2 size={12} />
                              </button>
                              <button
                                type="button"
                                className="sort"
                                data-ssh-runbook-command-move-up={item.id}
                                aria-label={t('servers.quickCommandMoveUpAria', { title: item.title })}
                                onClick={() => moveSshRunbookCommand(item.id, -1)}
                                disabled={!sshRunbookManualView || orderIndex <= 0 || movingSshRunbookId === item.id}
                              >
                                <ChevronUp size={12} />
                              </button>
                              <button
                                type="button"
                                className="sort"
                                data-ssh-runbook-command-move-down={item.id}
                                aria-label={t('servers.quickCommandMoveDownAria', { title: item.title })}
                                onClick={() => moveSshRunbookCommand(item.id, 1)}
                                disabled={!sshRunbookManualView || orderIndex === -1 || orderIndex === sshRunbookCommands.length - 1 || movingSshRunbookId === item.id}
                              >
                                <ChevronDown size={12} />
                              </button>
                            </div>
                          </article>
                        );
                      })}
                      {!sshRunbookLoading && sshRunbookCommands.length === 0 && (
                        <article className="empty" data-ssh-runbook-empty="true">
                          <span>{t('servers.quickCommandCustomLabel')}</span>
                          <strong>{t('servers.quickCommandEmptyTitle')}</strong>
                          <small>{t('servers.quickCommandEmptyDetail')}</small>
                        </article>
                      )}
                      {!sshRunbookLoading && sshRunbookCommands.length > 0 && visibleSshRunbookCommands.length === 0 && (
                        <article className="empty" data-ssh-runbook-filter-empty="true">
                          <span>{t('servers.quickCommandFilterLabel')}</span>
                          <strong>{t('servers.quickCommandFilterEmptyTitle')}</strong>
                          <small>{t('servers.quickCommandFilterEmptyDetail')}</small>
                        </article>
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
    resetTerminalTelemetry();
    setTerminalTransport(null);
    sshConsoleReplayHistoryRef.current = !terminalShellIdRef.current || terminalShellServerIdRef.current !== server.id;
    setSshConsoleOpen(true);
    refreshShellStatus();
  }

  function scheduleTerminalRuntimeWarmup() {
    let timerId: number | null = null;
    let idleId: number | null = null;
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    const warmRuntime = () => {
      if (!terminalRuntimeRef.current) {
        void loadTerminalRuntime();
      }
    };

    timerId = window.setTimeout(() => {
      timerId = null;
      if (typeof idleWindow.requestIdleCallback === 'function') {
        idleId = idleWindow.requestIdleCallback(() => {
          idleId = null;
          warmRuntime();
        }, { timeout: terminalRuntimeIdleTimeoutMs });
        return;
      }
      warmRuntime();
    }, terminalRuntimePrefetchDelayMs);

    return () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
      if (idleId !== null && typeof idleWindow.cancelIdleCallback === 'function') {
        idleWindow.cancelIdleCallback(idleId);
      }
    };
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
    resetTerminalTelemetry();
    setTerminalTransport(null);
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
    resetTerminalTelemetry();
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
      resetTerminalTelemetry();
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
    if (Date.now() < terminalWebSocketFallbackUntilRef.current) {
      return Promise.reject(new Error('SSH WebSocket recently failed; using compatible stream first'));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let ready = false;
      let openTimeout: number | null = null;
      let readyTimeout: number | null = null;

      const clearConnectTimers = () => {
        if (openTimeout !== null) {
          window.clearTimeout(openTimeout);
          openTimeout = null;
        }
        if (readyTimeout !== null) {
          window.clearTimeout(readyTimeout);
          readyTimeout = null;
        }
      };

      const fallback = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearConnectTimers();
        terminalWebSocketFallbackUntilRef.current = Date.now() + terminalWebSocketFallbackCacheMs;
        terminalShellSocketRef.current = null;
        terminalShellTransportRef.current = null;
        setTerminalTransport(null);
        socket.close();
        reject(error);
      };

      const socket = connectServerShellSocket(
        server.id,
        getTerminalDimensions(),
        (event) => handleTerminalStreamEvent(server.id, terminal, event, lifecycleSeq),
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
          terminalShellTransportRef.current = 'websocket';
          setTerminalTransport('websocket');
          attachTerminalInput(event.sessionId);
          refreshShellStatus();
          if (!settled) {
            settled = true;
            clearConnectTimers();
            resolve();
          }
        },
        (error) => {
          if (!ready && !settled) {
            fallback(error);
            return;
          }
          if (terminalShellIdRef.current && sshConsoleOpenRef.current) {
            flushTerminalWriteBuffer(terminal, { drainAll: true });
            terminal.writeln(`\r\n${error.message}`);
            terminal.scrollToBottom();
          }
        },
        (metrics) => updateTerminalNetworkStats(metrics),
        (event) => handleTerminalSocketClose(server, terminal, lifecycleSeq, event),
        () => {
          if (settled) {
            return;
          }
          if (openTimeout !== null) {
            window.clearTimeout(openTimeout);
            openTimeout = null;
          }
          readyTimeout = window.setTimeout(() => {
            fallback(new Error('SSH WebSocket opened but shell was not ready in time'));
          }, terminalWebSocketReadyTimeoutMs);
        },
      );
      terminalShellSocketRef.current = socket;
      terminalShellTransportRef.current = 'websocket';
      openTimeout = window.setTimeout(() => {
        fallback(new Error('SSH WebSocket did not open quickly'));
      }, terminalWebSocketOpenTimeoutMs);
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
    setTerminalTransport('compatible');
    refreshShellStatus();
    attachTerminalInput(shell.sessionId);
    const stream = streamServerShell(
      shell.sessionId,
      (event) => handleTerminalStreamEvent(server.id, terminal, event, lifecycleSeq),
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

  function handleTerminalStreamEvent(serverId: string, terminal: XTerm, event: ServerShellStreamEvent, lifecycleSeq?: number) {
    if (sshPanelServerIdRef.current !== serverId || (typeof lifecycleSeq === 'number' && !isCurrentTerminalLifecycle(serverId, lifecycleSeq))) {
      return;
    }
    if ((event.type === 'stdout' || event.type === 'stderr') && event.content) {
      recordTerminalOutput(event.content);
      queueTerminalWrite(terminal, event.content);
      captureTerminalSelfTestOutput(terminal, event.content);
      return;
    }
    if (event.type === 'close') {
      persistTerminalBottleneckSnapshot('remote-close');
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
      setTerminalTransport(null);
      updateTerminalPasteReview(null);
      clearTerminalNetworkStats();
      updateTerminalTelemetry((current) => ({
        ...current,
        pendingBytes: 0,
        commandSubmittedAt: null,
      }), { force: true });
      refreshShellStatus();
    }
    if (event.type === 'error' && sshConsoleOpenRef.current) {
      flushTerminalWriteBuffer(terminal, { drainAll: true });
      terminal.writeln(`\r\n${event.message ?? 'SSH shell stream failed'}`);
      terminal.scrollToBottom();
    }
  }

  function handleTerminalSocketClose(
    server: ServerNode,
    terminal: XTerm,
    lifecycleSeq: number,
    event: ServerShellSocketCloseEvent,
  ) {
    if (!event.ready || !isCurrentTerminalLifecycle(server.id, lifecycleSeq) || terminalShellTransportRef.current !== 'websocket' || !terminalShellIdRef.current) {
      return;
    }

    const closedSessionId = terminalShellIdRef.current;
    flushTerminalWriteBuffer(terminal, { drainAll: true });
    terminalShellSocketRef.current = null;
    terminalShellTransportRef.current = null;
    terminalShellIdRef.current = null;
    setTerminalShellId(null);
    setTerminalTransport(null);
    clearTerminalInputBuffer();
    clearTerminalNetworkStats();
    terminal.writeln(`\r\nWebSocket terminal disconnected (${event.code || 'closed'}); reconnecting with compatible stream mode...`);
    terminal.scrollToBottom();
    closeServerShell(closedSessionId).catch(() => undefined);
    openCompatibleTerminalTransport(server, terminal, lifecycleSeq)
      .then(() => {
        if (isCurrentTerminalLifecycle(server.id, lifecycleSeq)) {
          terminal.writeln('\r\nCompatible stream mode is active.');
          terminal.scrollToBottom();
          showActionMessage(t('servers.sshConnectedMessage', { name: server.name }));
        }
      })
      .catch((error) => {
        if (!isCurrentTerminalLifecycle(server.id, lifecycleSeq)) {
          return;
        }
        terminal.writeln(`\r\n${error instanceof Error ? error.message : 'SSH fallback reconnect failed'}`);
        terminal.scrollToBottom();
        showActionMessage(error instanceof Error ? error.message : 'SSH fallback reconnect failed', { autoDismissMs: 7000 });
        refreshShellStatus();
      });
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

  function updateTerminalTelemetry(
    updater: (current: TerminalTelemetryState) => TerminalTelemetryState,
    options: { force?: boolean } = {},
  ) {
    const next = updater(terminalTelemetryRef.current);
    terminalTelemetryRef.current = next;
    const now = performance.now();
    if (options.force || now - terminalTelemetryRenderedAtRef.current >= terminalTelemetryUiRefreshMs) {
      terminalTelemetryRenderedAtRef.current = now;
      setTerminalTelemetry(next);
    }
  }

  function resetTerminalTelemetry() {
    const next = { ...emptyTerminalTelemetry };
    terminalTelemetryRef.current = next;
    terminalTelemetryRenderedAtRef.current = 0;
    setTerminalTelemetry(next);
  }

  function updateTerminalPasteReview(review: TerminalPasteReview | null) {
    terminalPasteReviewRef.current = review;
    setTerminalPasteReview(review);
  }

  function recordTerminalInput(data: string) {
    const now = performance.now();
    const bytes = measureTerminalTextBytes(data);
    const submitted = data.includes('\r') || data.includes('\n') || data.includes('\u0003');
    updateTerminalTelemetry((current) => ({
      ...current,
      inputEvents: current.inputEvents + 1,
      inputBytes: current.inputBytes + bytes,
      lastInputAt: now,
      commandSubmittedAt: submitted ? now : current.commandSubmittedAt,
      latestFirstOutputMs: submitted ? null : current.latestFirstOutputMs,
    }), { force: submitted });
  }

  function recordTerminalOutput(content: string) {
    const now = performance.now();
    const bytes = measureTerminalTextBytes(content);
    const lines = countTerminalOutputLines(content);
    updateTerminalTelemetry((current) => {
      const latestFirstOutputMs = current.commandSubmittedAt !== null
        ? Math.max(0, now - current.commandSubmittedAt)
        : current.latestFirstOutputMs;
      return {
        ...current,
        outputBytes: current.outputBytes + bytes,
        outputLines: current.outputLines + lines,
        latestFirstOutputMs,
        lastOutputAt: now,
        commandSubmittedAt: null,
      };
    }, { force: terminalTelemetryRef.current.commandSubmittedAt !== null });
  }

  function recordTerminalRender(renderLagMs: number, pendingBytes: number) {
    updateTerminalTelemetry((current) => ({
      ...current,
      renderLagMs: Math.max(0, renderLagMs),
      pendingBytes,
      peakPendingBytes: Math.max(current.peakPendingBytes, pendingBytes),
    }), { force: renderLagMs >= 24 || pendingBytes === 0 });
  }

  function persistTerminalBottleneckSnapshot(reason: TerminalBottleneckSnapshotReason) {
    if (typeof window === 'undefined' || !terminalShellIdRef.current) {
      return;
    }
    const telemetry = terminalTelemetryRef.current;
    if (telemetry.inputEvents === 0 && telemetry.outputBytes === 0) {
      return;
    }
    const stats = terminalNetworkRenderedRef.current;
    const advisor = getTerminalBottleneckAdvisor(telemetry, stats, terminalShellTransportRef.current, true, t);
    const primary = advisor.items.reduce((best, item) => (item.level > best.level ? item : best), advisor.items[0]);
    const levels = advisor.items.reduce<Record<TerminalBottleneckItem['id'], number>>((current, item) => ({
      ...current,
      [item.id]: Math.round(item.level),
    }), {
      network: 0,
      input: 0,
      output: 0,
      render: 0,
    });
    const metrics: TerminalBottleneckSnapshot['metrics'] = {
      rttMs: stats?.rttMs ?? null,
      throughputBytesPerSecond: Math.round(stats?.throughputBytesPerSecond ?? 0),
      inputEvents: telemetry.inputEvents,
      inputBytes: telemetry.inputBytes,
      outputLines: telemetry.outputLines,
      outputBytes: telemetry.outputBytes,
      firstOutputMs: telemetry.latestFirstOutputMs === null ? null : Math.round(telemetry.latestFirstOutputMs),
      renderLagMs: Math.round(telemetry.renderLagMs),
      pendingBytes: telemetry.pendingBytes,
      peakPendingBytes: telemetry.peakPendingBytes,
    };
    const signature = `${primary.id}|${advisor.tone}|${levels.network}|${levels.input}|${levels.output}|${levels.render}|${metrics.outputLines}|${metrics.inputEvents}`;
    const now = Date.now();
    const lastSnapshot = terminalLastBottleneckSnapshotRef.current;
    if (lastSnapshot?.signature === signature && now - lastSnapshot.savedAt < terminalBottleneckSnapshotDedupeMs) {
      return;
    }
    const createdAt = new Date(now).toISOString();
    const snapshot: TerminalBottleneckSnapshot = {
      version: 1,
      id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt,
      reason,
      tone: advisor.tone,
      primary: primary.id,
      levels,
      metrics,
    };
    try {
      const raw = window.localStorage.getItem(terminalBottleneckHistoryStorageKey);
      const current = raw ? JSON.parse(raw) : [];
      const history = Array.isArray(current) ? current.filter(isTerminalBottleneckSnapshot) : [];
      const next = [snapshot, ...history.filter((item) => item.id !== snapshot.id)].slice(0, terminalBottleneckHistoryLimit);
      window.localStorage.setItem(terminalBottleneckHistoryStorageKey, JSON.stringify(next));
      terminalLastBottleneckSnapshotRef.current = { signature, savedAt: now };
    } catch {
      // Browser storage can be disabled; SSH interaction must continue unaffected.
    }
  }

  function beginTerminalSelfTest(sessionId: string) {
    clearTerminalSelfTestTimer();
    const networkStats = terminalNetworkRenderedRef.current;
    const networkLabel = terminalNetworkLabel || formatTerminalRtt(networkStats?.rttMs ?? null);
    const tracker: TerminalSelfTestTracker = {
      sessionId,
      startedAt: performance.now(),
      lineCount: 0,
      firstLineAt: null,
      lastLineAt: null,
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
      firstResponseMs: 0,
      outputSpanMs: 0,
      rttMs: networkStats?.rttMs ?? null,
      throughputBytesPerSecond: networkStats?.throughputBytesPerSecond ?? 0,
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
      const now = performance.now();
      if (tracker.firstLineAt === null) {
        tracker.firstLineAt = now;
      }
      tracker.lastLineAt = now;
      tracker.lineCount += lineMatches.length;
      const elapsedMs = Math.max(0, now - tracker.startedAt);
      const firstResponseMs = Math.max(0, tracker.firstLineAt - tracker.startedAt);
      const outputSpanMs = Math.max(0, tracker.lastLineAt - tracker.firstLineAt);
      setTerminalSelfTest((current) => current?.status === 'running'
        ? {
            ...current,
            lines: tracker.lineCount,
            durationMs: elapsedMs,
            linesPerSecond: calculateSelfTestRate(tracker.lineCount, elapsedMs),
            firstResponseMs,
            outputSpanMs,
          }
        : current);
    }

    if (content.includes('colipas-ssh-self-test-end')) {
      finishTerminalSelfTest('complete', terminal);
    }
  }

  function finishTerminalSelfTest(status: Exclude<TerminalSelfTestState['status'], 'running'>, terminal?: XTerm, message?: string) {
    const tracker = terminalSelfTestRef.current;
    if (!tracker) {
      if (status === 'failed' && message) {
        const networkStats = terminalNetworkRenderedRef.current;
        setTerminalSelfTest({
          status,
          lines: 0,
          durationMs: 0,
          linesPerSecond: 0,
          firstResponseMs: 0,
          outputSpanMs: 0,
          rttMs: networkStats?.rttMs ?? null,
          throughputBytesPerSecond: networkStats?.throughputBytesPerSecond ?? 0,
          networkLabel: terminalNetworkLabel || formatTerminalRtt(networkStats?.rttMs ?? null),
          message,
        });
      }
      return;
    }

    const durationMs = Math.max(0, performance.now() - tracker.startedAt);
    const networkStats = terminalNetworkRenderedRef.current;
    const firstResponseMs = tracker.firstLineAt === null ? 0 : Math.max(0, tracker.firstLineAt - tracker.startedAt);
    const outputSpanMs = tracker.firstLineAt === null || tracker.lastLineAt === null
      ? 0
      : Math.max(0, tracker.lastLineAt - tracker.firstLineAt);
    clearTerminalSelfTestTimer();
    terminalSelfTestRef.current = null;

    const nextState: TerminalSelfTestState = {
      status,
      lines: tracker.lineCount,
      durationMs,
      linesPerSecond: calculateSelfTestRate(tracker.lineCount, durationMs),
      firstResponseMs,
      outputSpanMs,
      rttMs: networkStats?.rttMs ?? null,
      throughputBytesPerSecond: networkStats?.throughputBytesPerSecond ?? 0,
      networkLabel: terminalNetworkLabel || formatTerminalRtt(networkStats?.rttMs ?? null),
      message,
    };
    setTerminalSelfTest(nextState);
    void recordServerShellSelfTest(tracker.sessionId, {
      status,
      lines: nextState.lines,
      durationMs: nextState.durationMs,
      linesPerSecond: nextState.linesPerSecond,
      firstResponseMs: nextState.firstResponseMs,
      outputSpanMs: nextState.outputSpanMs,
      rttMs: nextState.rttMs,
      throughputBytesPerSecond: nextState.throughputBytesPerSecond,
      networkLabel: nextState.networkLabel,
    }).catch(() => undefined);

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
    attachTerminalPasteGuard(terminal);
    terminal.focus();
  }

  function attachTerminalPasteGuard(terminal: XTerm) {
    detachTerminalPasteGuard();
    const helper = terminal.element?.querySelector('.xterm-helper-textarea');
    if (!(helper instanceof HTMLTextAreaElement)) {
      return;
    }

    const handler = (event: ClipboardEvent) => {
      const sessionId = terminalShellIdRef.current;
      const content = event.clipboardData?.getData('text/plain') ?? event.clipboardData?.getData('text') ?? '';
      if (!sessionId || !shouldReviewTerminalPaste(content)) {
        return;
      }
      event.preventDefault();
      openTerminalPasteReview(sessionId, content);
    };

    helper.addEventListener('paste', handler);
    terminalPasteListenerRef.current = { element: helper, handler };
  }

  function detachTerminalPasteGuard() {
    const current = terminalPasteListenerRef.current;
    if (!current) {
      return;
    }
    current.element.removeEventListener('paste', current.handler);
    terminalPasteListenerRef.current = null;
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
    if (shouldReviewTerminalPaste(data)) {
      openTerminalPasteReview(sessionId, data);
      return;
    }

    recordTerminalInput(data);
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

  function shouldReviewTerminalPaste(data: string) {
    if (!data || data.includes('\u0003')) {
      return false;
    }
    const byteCount = measureTerminalTextBytes(data);
    if (byteCount >= terminalPasteReviewMinBytes) {
      return true;
    }
    return countTerminalPasteLines(data) >= terminalPasteReviewMinLines;
  }

  function openTerminalPasteReview(sessionId: string, content: string) {
    const current = terminalPasteReviewRef.current;
    const mergedContent = current?.sessionId === sessionId ? `${current.content}${content}` : content;
    const review = buildTerminalPasteReview(sessionId, mergedContent);
    updateTerminalPasteReview(review);
    showActionMessage(t('servers.sshPasteReviewQueued', {
      lines: review.lineCount,
      size: formatCompactBytes(review.byteCount),
    }));
  }

  async function sendReviewedTerminalPaste() {
    const review = terminalPasteReviewRef.current;
    if (!review || terminalPasteSending) {
      return;
    }
    const activeSessionId = terminalShellIdRef.current;
    if (!activeSessionId || activeSessionId !== review.sessionId) {
      updateTerminalPasteReview(null);
      showActionMessage(t('servers.sshPasteReviewExpired'));
      return;
    }

    setTerminalPasteSending(true);
    try {
      await flushTerminalInput(review.sessionId);
      recordTerminalInput(review.content);
      await sendTerminalInput(review.sessionId, review.content);
      updateTerminalPasteReview(null);
      showActionMessage(t('servers.sshPasteReviewSent', {
        lines: review.lineCount,
        size: formatCompactBytes(review.byteCount),
      }));
      xtermRef.current?.focus();
    } catch (error) {
      showActionMessage(error instanceof Error ? error.message : t('servers.sshPasteReviewSendFailed'));
    } finally {
      setTerminalPasteSending(false);
    }
  }

  function cancelReviewedTerminalPaste() {
    updateTerminalPasteReview(null);
    showActionMessage(t('servers.sshPasteReviewCancelled'));
    xtermRef.current?.focus();
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

  async function copySshDoctorSummary() {
    if (!sshDoctorReport) {
      return;
    }

    try {
      await writeClipboardText(sshDoctorReport.summary);
      showActionMessage(t('servers.sshDoctorCopied'));
    } catch {
      showActionMessage(t('servers.terminalCopyFailed'));
    }
  }

  async function copySshTroubleshootingReport() {
    if (!sshTroubleshootingReport) {
      return;
    }

    try {
      await writeClipboardText(sshTroubleshootingReport.text);
      showActionMessage(t('servers.sshTroubleshootingReportCopied'));
    } catch {
      showActionMessage(t('servers.terminalCopyFailed'));
    }
  }

  async function copySshChannelFixPlan() {
    if (!sshChannelFixPlan) {
      return;
    }

    try {
      await writeClipboardText(sshChannelFixPlan.text);
      showActionMessage(t('servers.sshChannelFixPlanCopied'));
    } catch {
      showActionMessage(t('servers.terminalCopyFailed'));
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

  async function saveSshRunbookCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = sshRunbookForm.title.trim();
    const command = sshRunbookForm.command.trim();
    if (!title || !command) {
      showActionMessage(t('servers.quickCommandInvalid'));
      return;
    }

    setSshRunbookSaving(true);
    try {
      const saved = editingSshRunbookId
        ? await updateSshRunbookCommand(editingSshRunbookId, { title, command })
        : await createSshRunbookCommand({ title, command });
      setSshRunbookCommands((current) => (editingSshRunbookId
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [saved, ...current.filter((item) => item.id !== saved.id)]));
      setSshRunbookForm({ title: '', command: '' });
      setEditingSshRunbookId('');
      showActionMessage(t(editingSshRunbookId ? 'servers.quickCommandUpdated' : 'servers.quickCommandSaved'));
    } catch (error) {
      showActionMessage(error instanceof Error ? error.message : t('servers.quickCommandSaveFailed'));
    } finally {
      setSshRunbookSaving(false);
    }
  }

  function startEditSshRunbookCommand(command: SshRunbookCommand) {
    setEditingSshRunbookId(command.id);
    setSshRunbookForm({ title: command.title, command: command.command });
    showActionMessage(t('servers.quickCommandEditing', { title: command.title }));
  }

  function cancelSshRunbookEdit() {
    setEditingSshRunbookId('');
    setSshRunbookForm({ title: '', command: '' });
  }

  async function moveSshRunbookCommand(commandId: string, direction: -1 | 1) {
    const index = sshRunbookCommands.findIndex((item) => item.id === commandId);
    const targetIndex = index + direction;
    if (index === -1 || targetIndex < 0 || targetIndex >= sshRunbookCommands.length) {
      return;
    }

    const previous = sshRunbookCommands;
    const next = previous.slice();
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    setMovingSshRunbookId(commandId);
    setSshRunbookCommands(next);
    try {
      const result = await reorderSshRunbookCommands(next.map((item) => item.id));
      setSshRunbookCommands(result.commands);
      showActionMessage(t('servers.quickCommandMoved'));
    } catch (error) {
      setSshRunbookCommands(previous);
      showActionMessage(error instanceof Error ? error.message : t('servers.quickCommandReorderFailed'));
    } finally {
      setMovingSshRunbookId('');
    }
  }

  async function importSshRunbookPack(pack: (typeof sshRunbookPacks)[number]) {
    setImportingSshRunbookPackId(pack.id);
    try {
      const result = await importSshRunbookCommands(pack.commands.map((command) => ({
        title: t(`servers.quickCommandPack.${pack.id}.${command.id}.title`),
        command: command.command,
      })));
      setSshRunbookCommands(result.commands);
      setSshRunbookSearch('');
      setSshRunbookCategory('all');
      showActionMessage(t('servers.quickCommandPackImported', {
        imported: result.imported.length,
        skipped: result.skipped.length,
      }));
    } catch (error) {
      showActionMessage(error instanceof Error ? error.message : t('servers.quickCommandPackImportFailed'));
    } finally {
      setImportingSshRunbookPackId('');
    }
  }

  async function toggleSshRunbookPin(command: SshRunbookCommand) {
    setPinningSshRunbookId(command.id);
    try {
      const result = await updateSshRunbookCommandPin(command.id, !command.pinned);
      setSshRunbookCommands(result.commands);
      showActionMessage(t(result.command.pinned ? 'servers.quickCommandPinned' : 'servers.quickCommandUnpinned', {
        title: result.command.title,
      }));
    } catch (error) {
      showActionMessage(error instanceof Error ? error.message : t('servers.quickCommandPinFailed'));
    } finally {
      setPinningSshRunbookId('');
    }
  }

  async function removeSshRunbookCommand(commandId: string) {
    setDeletingSshRunbookId(commandId);
    try {
      await deleteSshRunbookCommand(commandId);
      setSshRunbookCommands((current) => current.filter((item) => item.id !== commandId));
      if (editingSshRunbookId === commandId) {
        cancelSshRunbookEdit();
      }
      showActionMessage(t('servers.quickCommandDeleted'));
    } catch (error) {
      showActionMessage(error instanceof Error ? error.message : t('servers.quickCommandDeleteFailed'));
    } finally {
      setDeletingSshRunbookId('');
    }
  }

  function sendSshQuickCommand(command: string, title: string, mode: 'insert' | 'run', runbookCommandId?: string) {
    const sessionId = terminalShellId;
    if (!sessionId) {
      showActionMessage(t('servers.quickCommandUnavailable'));
      return;
    }

    const payload = mode === 'run' ? `${command}\r` : command;
    flushTerminalInput(sessionId)
      .then(() => {
        recordTerminalInput(payload);
        return sendTerminalInput(sessionId, payload);
      })
      .then(() => {
        showActionMessage(t(mode === 'run' ? 'servers.quickCommandRunMessage' : 'servers.quickCommandInsertMessage', { title }));
        xtermRef.current?.focus();
        if (runbookCommandId) {
          markSshRunbookCommandUsed(runbookCommandId, mode)
            .then((result) => setSshRunbookCommands(result.commands))
            .catch(() => undefined);
        }
      })
      .catch((error) => {
        showActionMessage(error instanceof Error ? error.message : t('servers.quickCommandFailed'));
      });
  }

  function runTerminalLagAction(action: TerminalLagAction['action']) {
    if (action === 'clear') {
      clearTerminalOutput();
      return;
    }
    runTerminalSelfTest();
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
    if (sessionId) {
      persistTerminalBottleneckSnapshot('disconnect');
    }
    terminalShellIdRef.current = null;
    clearTerminalWriteBuffer();
    clearTerminalInputBuffer();
    resetTerminalSelfTest();
    updateTerminalPasteReview(null);
    setTerminalPasteSending(false);
    if (syncState) {
      setTerminalShellId(null);
      clearTerminalNetworkStats();
      resetTerminalTelemetry();
      setTerminalTransport(null);
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
        rows: Math.max(12, Math.min(80, terminal.rows || 30)),
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
    const renderStartedAt = performance.now();
    updateTerminalTelemetry((current) => ({
      ...current,
      pendingBytes: terminalWriteBufferRef.current.length,
      peakPendingBytes: Math.max(current.peakPendingBytes, content.length),
    }));
    terminal.write(chunk, () => {
      recordTerminalRender(performance.now() - renderStartedAt, terminalWriteBufferRef.current.length);
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
    detachTerminalPasteGuard();
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

function buildServerFleetTriageCards(
  servers: ServerNode[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): ServerFleetTriageCard[] {
  if (servers.length === 0) {
    return [];
  }
  const counts = servers.reduce<Record<ServerFleetTriageCardId, number>>((result, server) => {
    if (Math.max(server.cpu, server.memory, server.disk) >= 70) {
      result.resourcePressure += 1;
    }
    if (!server.ssh?.connected) {
      result.sshMissing += 1;
    }
    if (server.ssh?.verifyMode === 'simulate') {
      result.sshSimulated += 1;
    }
    if (resolveServerLifecycleStatus(server) === 'stopped') {
      result.stopped += 1;
    }
    return result;
  }, {
    resourcePressure: 0,
    sshMissing: 0,
    sshSimulated: 0,
    stopped: 0,
  });

  return ([
    ['resourcePressure', counts.resourcePressure, counts.resourcePressure > 0 ? 'warn' : 'good'],
    ['sshMissing', counts.sshMissing, counts.sshMissing > 0 ? 'slow' : 'good'],
    ['sshSimulated', counts.sshSimulated, counts.sshSimulated > 0 ? 'warn' : 'good'],
    ['stopped', counts.stopped, counts.stopped > 0 ? 'pending' : 'good'],
  ] as const).map(([id, count, tone]) => ({
    id,
    count,
    tone,
    title: t(`servers.triage.${id}.title`),
    detail: t(`servers.triage.${id}.detail`, { count }),
    actionLabel: t(`servers.triage.${id}.action`),
  }));
}

function buildServerFleetTriageFilters(id: ServerFleetTriageCardId, current: ServerFilters): ServerFilters {
  const base: ServerFilters = {
    ...current,
    query: '',
    provider: 'all',
    region: 'all',
    regionScope: undefined,
  };
  if (id === 'stopped') {
    return {
      ...base,
      status: 'stopped',
      health: undefined,
    };
  }
  return {
    ...base,
    status: 'all',
    health: id,
  };
}

function isServerFleetTriageActive(id: ServerFleetTriageCardId, filters: ServerFilters) {
  return id === 'stopped'
    ? filters.status === 'stopped' && !filters.health
    : filters.status === 'all' && filters.health === id;
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

function formatCompactBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${Math.round(value)} B`;
}

function measureTerminalTextBytes(value: string) {
  return terminalTextEncoder.encode(value).length;
}

function countTerminalOutputLines(content: string) {
  if (!content) {
    return 0;
  }
  const newlines = content.match(/\n/g)?.length ?? 0;
  return Math.max(newlines, content.trim() ? 1 : 0);
}

function countTerminalPasteLines(content: string) {
  if (!content.trim()) {
    return 0;
  }
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((line) => line.trim().length > 0).length;
}

function buildTerminalPasteReview(sessionId: string, content: string): TerminalPasteReview {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const previewLines = normalized.split('\n').slice(0, terminalPasteReviewPreviewLines);
  const preview = previewLines.join('\n').slice(0, terminalPasteReviewPreviewChars);
  const truncated = normalized.length > preview.length || normalized.split('\n').length > terminalPasteReviewPreviewLines;
  return {
    sessionId,
    content,
    preview: `${preview}${truncated ? '\n…' : ''}`,
    lineCount: countTerminalPasteLines(content),
    byteCount: measureTerminalTextBytes(content),
    createdAt: Date.now(),
  };
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

function getTerminalNetworkQuality(
  stats: TerminalNetworkStats,
  t: (key: string, vars?: Record<string, string | number>) => string,
): TerminalNetworkQuality {
  const rttLabel = formatTerminalRtt(stats.rttMs);
  const rateLabel = formatBytesPerSecond(stats.throughputBytesPerSecond);
  const detailVars = { rtt: rttLabel, rate: rateLabel };

  if (stats.rttMs === null) {
    return {
      tone: 'pending',
      label: t('servers.terminalNetworkPending'),
      detail: t('servers.terminalNetworkPendingDetail', detailVars),
    };
  }

  if (stats.rttMs >= 350) {
    return {
      tone: 'slow',
      label: t('servers.terminalNetworkSlow'),
      detail: t('servers.terminalNetworkSlowDetail', detailVars),
    };
  }

  if (stats.rttMs >= 120 && stats.throughputBytesPerSecond > 0 && stats.throughputBytesPerSecond < 16 * 1024) {
    return {
      tone: 'warn',
      label: t('servers.terminalNetworkThroughputLow'),
      detail: t('servers.terminalNetworkThroughputLowDetail', detailVars),
    };
  }

  return {
    tone: 'good',
    label: t('servers.terminalNetworkGood'),
    detail: t('servers.terminalNetworkGoodDetail', detailVars),
  };
}

function getTerminalQualityInsight(
  stats: TerminalNetworkStats | null,
  selfTest: TerminalSelfTestState | null,
  transport: 'websocket' | 'compatible' | null,
  connected: boolean,
  running: boolean,
  t: (key: string, vars?: Record<string, string | number>) => string,
): TerminalQualityInsight {
  const transportLabel = getTerminalTransportLabel(transport, t);
  const metric = stats
    ? `${formatTerminalRtt(stats.rttMs)} / ${formatBytesPerSecond(stats.throughputBytesPerSecond)}`
    : transportLabel;
  const vars = {
    transport: transportLabel,
    rtt: stats ? formatTerminalRtt(stats.rttMs) : formatTerminalRtt(null),
    rate: stats ? formatBytesPerSecond(stats.throughputBytesPerSecond) : formatBytesPerSecond(0),
  };

  if (!connected) {
    return {
      tone: 'pending',
      title: running ? t('servers.terminalQualityConnectingTitle') : t('servers.terminalQualityIdleTitle'),
      detail: t('servers.terminalQualityConnectingDetail', vars),
      metric,
    };
  }

  if (transport === 'compatible') {
    return {
      tone: 'warn',
      title: t('servers.terminalQualityCompatibleTitle'),
      detail: t('servers.terminalQualityCompatibleDetail', vars),
      metric,
    };
  }

  if (!stats || stats.rttMs === null) {
    return {
      tone: 'pending',
      title: t('servers.terminalQualityPendingTitle'),
      detail: t('servers.terminalQualityPendingDetail', vars),
      metric,
    };
  }

  if (stats.rttMs >= 350) {
    return {
      tone: 'slow',
      title: t('servers.terminalQualityLatencyTitle'),
      detail: t('servers.terminalQualityLatencyDetail', vars),
      metric,
    };
  }

  if (stats.rttMs >= 120 && stats.throughputBytesPerSecond > 0 && stats.throughputBytesPerSecond < 16 * 1024) {
    return {
      tone: 'warn',
      title: t('servers.terminalQualityThroughputTitle'),
      detail: t('servers.terminalQualityThroughputDetail', vars),
      metric,
    };
  }

  if (selfTest && selfTest.status !== 'running' && selfTest.status !== 'complete') {
    return {
      tone: 'warn',
      title: t('servers.terminalQualitySelfTestTitle'),
      detail: t('servers.terminalQualitySelfTestDetail', vars),
      metric,
    };
  }

  return {
    tone: 'good',
    title: t('servers.terminalQualityGoodTitle'),
    detail: t('servers.terminalQualityGoodDetail', vars),
    metric,
  };
}

function getTerminalTelemetryInsight(
  telemetry: TerminalTelemetryState,
  stats: TerminalNetworkStats | null,
  transport: 'websocket' | 'compatible' | null,
  connected: boolean,
  t: (key: string, vars?: Record<string, string | number>) => string,
): TerminalTelemetryInsight {
  const inputTone: TerminalTelemetryCard['tone'] = telemetry.inputEvents === 0
    ? 'pending'
    : telemetry.inputEvents >= 40 && telemetry.inputBytes / Math.max(1, telemetry.inputEvents) <= 2
      ? 'warn'
      : 'good';
  const firstOutputTone: TerminalTelemetryCard['tone'] = telemetry.latestFirstOutputMs === null
    ? 'pending'
    : telemetry.latestFirstOutputMs >= 1800
      ? 'slow'
      : telemetry.latestFirstOutputMs >= 700
        ? 'warn'
        : 'good';
  const outputTone: TerminalTelemetryCard['tone'] = telemetry.outputBytes === 0
    ? 'pending'
    : stats && stats.throughputBytesPerSecond > 0 && stats.throughputBytesPerSecond < 16 * 1024 && telemetry.outputBytes > 16 * 1024
      ? 'warn'
      : 'good';
  const renderTone: TerminalTelemetryCard['tone'] = telemetry.renderLagMs >= 64 || telemetry.pendingBytes >= terminalWriteLargeBacklogThreshold
    ? 'slow'
    : telemetry.renderLagMs >= 24 || telemetry.pendingBytes > 0
      ? 'warn'
      : connected ? 'good' : 'pending';
  const tone: TerminalTelemetryInsight['tone'] = [inputTone, firstOutputTone, outputTone, renderTone].includes('slow')
    ? 'slow'
    : [inputTone, firstOutputTone, outputTone, renderTone].includes('warn')
      ? 'warn'
      : connected && telemetry.outputBytes > 0
        ? 'good'
        : 'pending';
  const cards: TerminalTelemetryCard[] = [
    {
      id: 'input',
      label: t('servers.telemetryInputLabel'),
      value: telemetry.inputEvents > 0 ? t('servers.telemetryInputValue', { count: telemetry.inputEvents }) : '--',
      detail: t('servers.telemetryInputDetail', { bytes: formatCompactBytes(telemetry.inputBytes) }),
      tone: inputTone,
    },
    {
      id: 'first-output',
      label: t('servers.telemetryFirstOutputLabel'),
      value: telemetry.latestFirstOutputMs === null ? '--' : `${Math.round(telemetry.latestFirstOutputMs)}ms`,
      detail: telemetry.latestFirstOutputMs === null
        ? t('servers.telemetryFirstOutputPending')
        : t('servers.telemetryFirstOutputDetail', { value: Math.round(telemetry.latestFirstOutputMs) }),
      tone: firstOutputTone,
    },
    {
      id: 'output',
      label: t('servers.telemetryOutputLabel'),
      value: telemetry.outputLines > 0 ? t('servers.telemetryOutputValue', { count: telemetry.outputLines }) : formatCompactBytes(telemetry.outputBytes),
      detail: t('servers.telemetryOutputDetail', { bytes: formatCompactBytes(telemetry.outputBytes), rate: formatBytesPerSecond(stats?.throughputBytesPerSecond ?? 0) }),
      tone: outputTone,
    },
    {
      id: 'render',
      label: t('servers.telemetryRenderLabel'),
      value: `${Math.round(telemetry.renderLagMs)}ms`,
      detail: t('servers.telemetryRenderDetail', { pending: formatCompactBytes(telemetry.pendingBytes), peak: formatCompactBytes(telemetry.peakPendingBytes) }),
      tone: renderTone,
    },
  ];
  return {
    tone,
    title: connected
      ? tone === 'slow'
        ? t('servers.telemetrySlowTitle')
        : tone === 'warn'
          ? t('servers.telemetryWarnTitle')
          : tone === 'good'
            ? t('servers.telemetryGoodTitle')
            : t('servers.telemetryPendingTitle')
      : t('servers.telemetryIdleTitle'),
    detail: connected
      ? getTerminalTelemetryDetail(tone, transport, t)
      : t('servers.telemetryIdleDetail'),
    cards,
  };
}

function getTerminalTelemetryDetail(
  tone: TerminalTelemetryInsight['tone'],
  transport: 'websocket' | 'compatible' | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  const transportLabel = getTerminalTransportLabel(transport, t);
  if (tone === 'slow') {
    return t('servers.telemetrySlowDetail', { transport: transportLabel });
  }
  if (tone === 'warn') {
    return t('servers.telemetryWarnDetail', { transport: transportLabel });
  }
  if (tone === 'good') {
    return t('servers.telemetryGoodDetail', { transport: transportLabel });
  }
  return t('servers.telemetryPendingDetail', { transport: transportLabel });
}

function getTerminalBottleneckAdvisor(
  telemetry: TerminalTelemetryState,
  stats: TerminalNetworkStats | null,
  transport: 'websocket' | 'compatible' | null,
  connected: boolean,
  t: (key: string, vars?: Record<string, string | number>) => string,
): TerminalBottleneckAdvisor {
  const transportLabel = getTerminalTransportLabel(transport, t);
  const rttMs = stats?.rttMs ?? null;
  const throughput = stats?.throughputBytesPerSecond ?? 0;
  const networkLevel = !connected
    ? 0
    : rttMs === null
      ? 22
      : rttMs >= 1500
        ? 96
        : rttMs >= 700
          ? 74
          : rttMs >= 250
            ? 44
            : 16;
  const averageInputBytes = telemetry.inputBytes / Math.max(1, telemetry.inputEvents);
  const inputLevel = !connected || telemetry.inputEvents === 0
    ? 0
    : telemetry.inputEvents >= 40 && averageInputBytes <= 2
      ? 38
      : 14;
  const outputLevel = !connected || telemetry.outputBytes === 0
    ? 0
    : throughput > 0 && throughput < 16 * 1024 && telemetry.outputBytes > 16 * 1024
      ? 72
      : throughput > 0 && throughput < 64 * 1024 && telemetry.outputBytes > 128 * 1024
        ? 54
        : 18;
  const renderLevel = !connected
    ? 0
    : telemetry.renderLagMs >= 64 || telemetry.pendingBytes >= terminalWriteLargeBacklogThreshold
      ? 92
      : telemetry.renderLagMs >= 24 || telemetry.pendingBytes > 0
        ? 56
        : 12;
  const items: TerminalBottleneckItem[] = [
    {
      id: 'network',
      label: t('servers.bottleneckNetworkLabel'),
      value: formatTerminalRtt(rttMs),
      detail: t('servers.bottleneckNetworkDetail', { transport: transportLabel }),
      level: networkLevel,
      tone: getBottleneckTone(networkLevel, connected),
    },
    {
      id: 'input',
      label: t('servers.bottleneckInputLabel'),
      value: telemetry.inputEvents > 0 ? t('servers.telemetryInputValue', { count: telemetry.inputEvents }) : '--',
      detail: t('servers.bottleneckInputDetail', { bytes: formatCompactBytes(telemetry.inputBytes) }),
      level: inputLevel,
      tone: getBottleneckTone(inputLevel, connected && telemetry.inputEvents > 0),
    },
    {
      id: 'output',
      label: t('servers.bottleneckOutputLabel'),
      value: formatBytesPerSecond(throughput),
      detail: t('servers.bottleneckOutputDetail', { bytes: formatCompactBytes(telemetry.outputBytes), lines: telemetry.outputLines }),
      level: outputLevel,
      tone: getBottleneckTone(outputLevel, connected && telemetry.outputBytes > 0),
    },
    {
      id: 'render',
      label: t('servers.bottleneckRenderLabel'),
      value: `${Math.round(telemetry.renderLagMs)}ms`,
      detail: t('servers.bottleneckRenderDetail', { pending: formatCompactBytes(telemetry.pendingBytes), peak: formatCompactBytes(telemetry.peakPendingBytes) }),
      level: renderLevel,
      tone: getBottleneckTone(renderLevel, connected),
    },
  ];
  const primary = items.reduce((best, item) => (item.level > best.level ? item : best), items[0]);
  const tone = getBottleneckTone(primary.level, connected);
  return {
    tone,
    title: connected
      ? tone === 'slow'
        ? t('servers.bottleneckSlowTitle', { target: primary.label })
        : tone === 'warn'
          ? t('servers.bottleneckWarnTitle', { target: primary.label })
          : t('servers.bottleneckGoodTitle')
      : t('servers.bottleneckIdleTitle'),
    detail: connected
      ? t('servers.bottleneckDetail', { target: primary.label, value: primary.value })
      : t('servers.bottleneckIdleDetail'),
    action: connected
      ? tone === 'slow'
        ? t('servers.bottleneckSlowAction')
        : tone === 'warn'
          ? t('servers.bottleneckWarnAction')
          : t('servers.bottleneckGoodAction')
      : t('servers.bottleneckIdleAction'),
    primaryLabel: t('servers.bottleneckPrimaryLabel', { target: primary.label }),
    items,
  };
}

function getTerminalLagAction(
  advisor: TerminalBottleneckAdvisor,
  telemetry: TerminalTelemetryState,
  stats: TerminalNetworkStats | null,
  transport: 'websocket' | 'compatible' | null,
  connected: boolean,
  t: (key: string, vars?: Record<string, string | number>) => string,
): TerminalLagAction | null {
  if (!connected) {
    return null;
  }

  const primary = advisor.items.reduce((best, item) => (item.level > best.level ? item : best), advisor.items[0]);
  const evidence = t('servers.terminalLagActionEvidence', {
    target: primary.label,
    value: primary.value,
    transport: getTerminalTransportLabel(transport, t),
    rate: formatBytesPerSecond(stats?.throughputBytesPerSecond ?? 0),
    first: telemetry.latestFirstOutputMs === null ? '--' : `${Math.round(telemetry.latestFirstOutputMs)}ms`,
    pending: formatCompactBytes(telemetry.pendingBytes),
  });

  if (primary.id === 'render' && primary.level >= 50) {
    return {
      tone: primary.tone,
      title: t('servers.terminalLagActionRenderTitle'),
      detail: t('servers.terminalLagActionRenderDetail'),
      evidence,
      action: 'clear',
      buttonLabel: t('servers.terminalLagActionClearButton'),
    };
  }

  if (primary.id === 'network' && primary.level >= 50) {
    return {
      tone: primary.tone,
      title: t('servers.terminalLagActionNetworkTitle'),
      detail: t('servers.terminalLagActionNetworkDetail'),
      evidence,
      action: 'self-test',
      buttonLabel: t('servers.terminalLagActionSelfTestButton'),
    };
  }

  if (primary.id === 'output' && primary.level >= 50) {
    return {
      tone: primary.tone,
      title: t('servers.terminalLagActionOutputTitle'),
      detail: t('servers.terminalLagActionOutputDetail'),
      evidence,
      action: 'self-test',
      buttonLabel: t('servers.terminalLagActionSelfTestButton'),
    };
  }

  if (primary.id === 'input' && primary.level >= 35) {
    return {
      tone: primary.tone,
      title: t('servers.terminalLagActionInputTitle'),
      detail: t('servers.terminalLagActionInputDetail'),
      evidence,
      action: 'self-test',
      buttonLabel: t('servers.terminalLagActionSelfTestButton'),
    };
  }

  return {
    tone: advisor.tone === 'pending' ? 'good' : advisor.tone,
    title: t('servers.terminalLagActionGoodTitle'),
    detail: transport === 'compatible'
      ? t('servers.terminalLagActionCompatibleDetail')
      : t('servers.terminalLagActionGoodDetail'),
    evidence,
    action: 'self-test',
    buttonLabel: t('servers.terminalLagActionSelfTestButton'),
  };
}

function getBottleneckTone(level: number, active: boolean): TerminalNetworkQuality['tone'] {
  if (!active) {
    return 'pending';
  }
  if (level >= 80) {
    return 'slow';
  }
  if (level >= 50) {
    return 'warn';
  }
  return 'good';
}

function isTerminalBottleneckSnapshot(value: unknown): value is TerminalBottleneckSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const snapshot = value as Partial<TerminalBottleneckSnapshot>;
  const levels = snapshot.levels as Partial<Record<TerminalBottleneckItem['id'], unknown>> | undefined;
  const metrics = snapshot.metrics as Partial<Record<keyof TerminalBottleneckSnapshot['metrics'], unknown>> | undefined;
  return snapshot.version === 1
    && typeof snapshot.id === 'string'
    && typeof snapshot.createdAt === 'string'
    && ['close', 'remote-close', 'disconnect'].includes(String(snapshot.reason))
    && ['pending', 'good', 'warn', 'slow'].includes(String(snapshot.tone))
    && ['network', 'input', 'output', 'render'].includes(String(snapshot.primary))
    && Boolean(levels)
    && ['network', 'input', 'output', 'render'].every((key) => Number.isFinite(Number(levels?.[key as TerminalBottleneckItem['id']])))
    && Boolean(metrics)
    && ['throughputBytesPerSecond', 'inputEvents', 'inputBytes', 'outputLines', 'outputBytes', 'renderLagMs', 'pendingBytes', 'peakPendingBytes']
      .every((key) => Number.isFinite(Number(metrics?.[key as keyof TerminalBottleneckSnapshot['metrics']])));
}

function getTerminalTransportLabel(
  transport: 'websocket' | 'compatible' | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  if (transport === 'websocket') {
    return t('servers.terminalTransportWebSocket');
  }
  if (transport === 'compatible') {
    return t('servers.terminalTransportCompatible');
  }
  return t('servers.terminalTransportPending');
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
  const split = ` / first ${Math.round(state.firstResponseMs)}ms / output ${Math.round(state.outputSpanMs)}ms`;
  const network = state.networkLabel ? ` / ${state.networkLabel}` : '';
  const timeoutLabel = language === 'en' ? 'timeout' : language === 'ja' ? 'タイムアウト' : '超时';
  return state.status === 'timeout' ? `${timeoutLabel} · ${base}${split}${network}` : `${base}${split}${network}`;
}

function buildSshConnectionDoctorReport({
  server,
  diagnostic,
  error,
  terminalActive,
  terminalTransport,
  terminalNetworkStats,
  terminalTelemetry,
  t,
}: {
  server: ServerNode;
  diagnostic: ServerDiagnosticResponse | null;
  error: unknown;
  terminalActive: boolean;
  terminalTransport: 'websocket' | 'compatible' | null;
  terminalNetworkStats: TerminalNetworkStats | null;
  terminalTelemetry: TerminalTelemetryState;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): SshConnectionDoctorReport {
  const serverName = sanitizeSshDoctorText(server.name || t('common.server'));
  const sshAccess = server.ssh;
  const connected = Boolean(sshAccess?.connected);
  const errorInfo = error ? classifySshDoctorError(error) : null;
  const credentialTone: TerminalNetworkQuality['tone'] = !connected
    ? 'pending'
    : sshAccess?.verifyMode === 'simulate'
      ? 'warn'
      : 'good';
  const backendTone: TerminalNetworkQuality['tone'] = diagnostic
    ? 'good'
    : errorInfo && (errorInfo.stage === 'backend' || errorInfo.stage === 'credential')
      ? 'slow'
      : 'pending';
  const shellSignals = countSshDiagnosticSignals(diagnostic?.output ?? '');
  const shellTone: TerminalNetworkQuality['tone'] = diagnostic
    ? shellSignals >= 3
      ? 'good'
      : 'warn'
    : errorInfo?.stage === 'shell'
      ? 'slow'
      : 'pending';
  const terminalAdvisor = terminalActive
    ? getTerminalBottleneckAdvisor(terminalTelemetry, terminalNetworkStats, terminalTransport, true, t)
    : null;
  const terminalValue = terminalAdvisor
    ? getTerminalTransportLabel(terminalTransport, t)
    : t('servers.sshDoctorTerminalNotOpen');
  const terminalDetail = terminalAdvisor
    ? terminalAdvisor.detail
    : t('servers.sshDoctorTerminalNotOpenDetail');
  const terminalTone: TerminalNetworkQuality['tone'] = terminalAdvisor?.tone ?? 'pending';
  const credentialDetail = connected && sshAccess
    ? t('servers.sshDoctorCredentialReadyDetail', {
      mode: formatSshDoctorVerifyMode(sshAccess.verifyMode, t),
      auth: sshAccess.authType === 'password' ? t('servers.passwordAuth') : t('servers.keyAuth'),
    })
    : t('servers.sshDoctorCredentialMissingDetail');

  const steps: SshConnectionDoctorStep[] = [
    {
      id: 'asset',
      label: t('servers.sshDoctorStepAsset'),
      value: connected ? t('servers.sshDoctorAssetReady') : t('servers.sshDoctorAssetMissing'),
      detail: connected ? t('servers.sshDoctorAssetReadyDetail') : t('servers.sshDoctorAssetMissingDetail'),
      tone: connected ? 'good' : 'slow',
    },
    {
      id: 'credential',
      label: t('servers.sshDoctorStepCredential'),
      value: connected && sshAccess
        ? (sshAccess.authType === 'password' ? t('servers.passwordAuth') : t('servers.keyAuth'))
        : t('servers.sshDoctorCredentialMissing'),
      detail: errorInfo?.stage === 'credential' ? errorInfo.detail : credentialDetail,
      tone: errorInfo?.stage === 'credential' ? 'slow' : credentialTone,
    },
    {
      id: 'backend',
      label: t('servers.sshDoctorStepBackend'),
      value: diagnostic ? t('servers.sshDoctorBackendReady') : errorInfo ? t('servers.sshDoctorBackendBlocked') : t('servers.sshDoctorBackendPending'),
      detail: errorInfo && errorInfo.stage !== 'terminal' ? errorInfo.detail : diagnostic ? t('servers.sshDoctorBackendReadyDetail') : t('servers.sshDoctorBackendPendingDetail'),
      tone: backendTone,
    },
    {
      id: 'shell',
      label: t('servers.sshDoctorStepShell'),
      value: diagnostic ? t('servers.sshDoctorShellSignals', { count: shellSignals }) : t('servers.sshDoctorShellPending'),
      detail: diagnostic
        ? shellSignals >= 3
          ? t('servers.sshDoctorShellReadyDetail')
          : t('servers.sshDoctorShellWeakDetail')
        : errorInfo?.stage === 'shell'
          ? errorInfo.detail
          : t('servers.sshDoctorShellPendingDetail'),
      tone: shellTone,
    },
    {
      id: 'terminal',
      label: t('servers.sshDoctorStepTerminal'),
      value: terminalValue,
      detail: errorInfo?.stage === 'terminal' ? errorInfo.detail : terminalDetail,
      tone: errorInfo?.stage === 'terminal' ? 'slow' : terminalTone,
    },
  ];
  const tone = getSshDoctorOverallTone(steps);
  const title = tone === 'slow'
    ? t('servers.sshDoctorTitleSlow', { name: serverName })
    : tone === 'warn'
      ? t('servers.sshDoctorTitleWarn', { name: serverName })
      : tone === 'pending'
        ? t('servers.sshDoctorTitlePending', { name: serverName })
        : t('servers.sshDoctorTitleGood', { name: serverName });
  const detail = tone === 'slow'
    ? t('servers.sshDoctorDetailSlow')
    : tone === 'warn'
      ? t('servers.sshDoctorDetailWarn')
      : tone === 'pending'
        ? t('servers.sshDoctorDetailPending')
        : t('servers.sshDoctorDetailGood');
  const checkedAt = diagnostic?.checkedAt ?? new Date().toISOString();
  const summary = sanitizeSshDoctorText([
    title,
    detail,
    `${t('servers.sshDoctorCheckedAt')}: ${checkedAt}`,
    ...steps.map((step) => `${step.label}: ${step.value} - ${step.detail}`),
  ].join('\n'));

  return {
    serverId: server.id,
    serverName,
    checkedAt,
    tone,
    title,
    detail,
    summary,
    steps: steps.map((step) => ({
      ...step,
      value: sanitizeSshDoctorText(step.value),
      detail: sanitizeSshDoctorText(step.detail),
    })),
  };
}

function formatSshDoctorVerifyMode(
  mode: SshVerifyMode,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  if (mode === 'simulate') {
    return t('servers.simulateSsh');
  }
  if (mode === 'real') {
    return t('servers.realSsh');
  }
  return t('servers.assetOnly');
}

function countSshDiagnosticSignals(output: string) {
  const checks = [
    /host=/i,
    /\b(?:linux|ubuntu|debian|centos|almalinux|rocky|windows|darwin|bsd|kernel)\b/i,
    /\b(?:load average|up\s+\d|uptime)\b/i,
    /\b(?:filesystem|\/dev\/|\d+%)\b/i,
  ];
  return checks.reduce((count, pattern) => count + (pattern.test(output) ? 1 : 0), 0);
}

function classifySshDoctorError(error: unknown): { stage: SshConnectionDoctorStepId; detail: string } {
  const detail = sanitizeSshDoctorText(error instanceof Error ? error.message : String(error || 'SSH diagnostic failed'));
  const lower = detail.toLowerCase();
  if (/permission|denied|auth|password|publickey|passphrase|credential/.test(lower)) {
    return { stage: 'credential', detail };
  }
  if (/websocket|socket|upgrade|stream|session/.test(lower)) {
    return { stage: 'terminal', detail };
  }
  if (/shell|pty|channel|exec/.test(lower)) {
    return { stage: 'shell', detail };
  }
  if (/timeout|timed out|refused|unreachable|network|host|port|dns|enotfound|ehostunreach|econnreset/.test(lower)) {
    return { stage: 'backend', detail };
  }
  return { stage: 'backend', detail };
}

function getSshDoctorOverallTone(steps: SshConnectionDoctorStep[]): TerminalNetworkQuality['tone'] {
  if (steps.some((step) => step.tone === 'slow')) {
    return 'slow';
  }
  if (steps.some((step) => step.tone === 'warn')) {
    return 'warn';
  }
  const blockingPending = steps.some((step) => step.tone === 'pending' && step.id !== 'terminal');
  return blockingPending ? 'pending' : 'good';
}

function rememberSshDoctorReport(report: SshConnectionDoctorReport, currentHistory: SshConnectionDoctorHistoryEntry[]) {
  const nextEntry = buildSshDoctorHistoryEntry(report);
  const nextHistory = [
    nextEntry,
    ...currentHistory.filter((entry) => entry.id !== nextEntry.id),
  ].slice(0, sshDoctorHistoryLimit);
  writeSshDoctorHistory(nextHistory);
  return nextHistory;
}

function buildSshDoctorHistoryEntry(report: SshConnectionDoctorReport): SshConnectionDoctorHistoryEntry {
  const stepTones = sshConnectionDoctorStepIds.reduce((result, stepId) => {
    result[stepId] = report.steps.find((step) => step.id === stepId)?.tone ?? 'pending';
    return result;
  }, {} as Record<SshConnectionDoctorStepId, TerminalNetworkQuality['tone']>);
  const primary = getSshDoctorPrimaryStep(report.steps);
  return {
    version: 1,
    id: `${hashSshDoctorTarget(report.serverId)}:${Date.parse(report.checkedAt) || Date.now()}:${report.tone}:${primary}`,
    targetKey: hashSshDoctorTarget(report.serverId),
    createdAt: report.checkedAt,
    tone: report.tone,
    primary,
    stepTones,
    slowCount: Object.values(stepTones).filter((tone) => tone === 'slow').length,
    warnCount: Object.values(stepTones).filter((tone) => tone === 'warn').length,
    pendingCount: Object.values(stepTones).filter((tone) => tone === 'pending').length,
  };
}

function buildSshDoctorTrend(
  report: SshConnectionDoctorReport,
  history: SshConnectionDoctorHistoryEntry[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): SshConnectionDoctorTrend {
  const currentEntry = buildSshDoctorHistoryEntry(report);
  const entries = [
    currentEntry,
    ...history.filter((entry) => entry.targetKey === currentEntry.targetKey && entry.id !== currentEntry.id),
  ].slice(0, sshDoctorHistoryLimit);
  const previousEntry = entries[1] ?? null;
  const currentScore = getSshDoctorToneScore(currentEntry.tone);
  const previousScore = previousEntry ? getSshDoctorToneScore(previousEntry.tone) : currentScore;
  const primaryLabel = report.steps.find((step) => step.id === currentEntry.primary)?.label ?? t('servers.sshDoctorStepTerminal');
  const trendTone: TerminalNetworkQuality['tone'] = !previousEntry
    ? currentEntry.tone
    : currentScore < previousScore
      ? 'good'
      : currentScore > previousScore
        ? 'slow'
        : currentEntry.tone;
  const title = !previousEntry
    ? t('servers.sshDoctorTrendNewTitle')
    : currentScore < previousScore
      ? t('servers.sshDoctorTrendImprovedTitle')
      : currentScore > previousScore
        ? t('servers.sshDoctorTrendWorseTitle')
        : t('servers.sshDoctorTrendStableTitle');
  const detail = !previousEntry
    ? t('servers.sshDoctorTrendNewDetail', { samples: entries.length, primary: primaryLabel })
    : currentScore < previousScore
      ? t('servers.sshDoctorTrendImprovedDetail', { samples: entries.length, primary: primaryLabel })
      : currentScore > previousScore
        ? t('servers.sshDoctorTrendWorseDetail', { samples: entries.length, primary: primaryLabel })
        : t('servers.sshDoctorTrendStableDetail', { samples: entries.length, primary: primaryLabel });
  return {
    tone: trendTone,
    title,
    detail,
    lanes: report.steps.map((step) => {
      const previousTone = previousEntry?.stepTones[step.id] ?? null;
      return {
        id: step.id,
        label: step.label,
        value: formatSshDoctorTone(step.tone, t),
        detail: previousTone
          ? t('servers.sshDoctorTrendLaneCompare', {
            previous: formatSshDoctorTone(previousTone, t),
            current: formatSshDoctorTone(step.tone, t),
          })
          : t('servers.sshDoctorTrendLaneNew'),
        tone: step.tone,
      };
    }),
  };
}

function buildSshTroubleshootingReport({
  report,
  trend,
  terminalActive,
  terminalTelemetry,
  terminalNetworkStats,
  terminalTransport,
  terminalSelfTest,
  terminalBottleneckAdvisor,
  t,
}: {
  report: SshConnectionDoctorReport;
  trend: SshConnectionDoctorTrend | null;
  terminalActive: boolean;
  terminalTelemetry: TerminalTelemetryState;
  terminalNetworkStats: TerminalNetworkStats | null;
  terminalTransport: 'websocket' | 'compatible' | null;
  terminalSelfTest: TerminalSelfTestState | null;
  terminalBottleneckAdvisor: TerminalBottleneckAdvisor | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): SshTroubleshootingReport {
  const generatedAt = new Date().toISOString();
  const telemetryInsight = getTerminalTelemetryInsight(terminalTelemetry, terminalNetworkStats, terminalTransport, terminalActive, t);
  const channelValue = getTerminalTransportLabel(terminalTransport, t);
  const networkValue = terminalNetworkStats
    ? `${formatTerminalRtt(terminalNetworkStats.rttMs)} / ${formatBytesPerSecond(terminalNetworkStats.throughputBytesPerSecond)}`
    : t('servers.sshTroubleshootingReportNoLiveTerminal');
  const selfTestValue = terminalSelfTest
    ? `${terminalSelfTest.status} / ${terminalSelfTest.lines} ${t('servers.sshTroubleshootingReportLines')} / ${Math.round(terminalSelfTest.durationMs)}ms`
    : t('servers.sshTroubleshootingReportNoSelfTest');
  const primaryStep = report.steps.find((step) => step.id === getSshDoctorPrimaryStep(report.steps)) ?? report.steps[0];
  const actionValue = terminalBottleneckAdvisor?.primaryLabel ?? primaryStep?.label ?? t('servers.sshTroubleshootingReportRecommendedAction');
  const actionDetail = terminalBottleneckAdvisor?.action ?? primaryStep?.detail ?? report.detail;

  const rawItems: SshTroubleshootingReportItem[] = [
    {
      id: 'doctor',
      label: t('servers.sshTroubleshootingReportDoctorLabel'),
      value: formatSshDoctorTone(report.tone, t),
      detail: report.detail,
      tone: report.tone,
    },
    {
      id: 'trend',
      label: t('servers.sshTroubleshootingReportTrendLabel'),
      value: trend?.title ?? t('servers.sshDoctorTrendNewTitle'),
      detail: trend?.detail ?? t('servers.sshDoctorTrendNewDetail', { samples: 1, primary: primaryStep?.label ?? t('servers.sshDoctorStepTerminal') }),
      tone: trend?.tone ?? report.tone,
    },
    {
      id: 'channel',
      label: t('servers.sshTroubleshootingReportChannelLabel'),
      value: channelValue,
      detail: `${networkValue} / ${selfTestValue}`,
      tone: terminalActive ? (terminalNetworkStats ? getTerminalNetworkQuality(terminalNetworkStats, t).tone : 'pending') : 'pending',
    },
    {
      id: 'telemetry',
      label: t('servers.sshTroubleshootingReportTelemetryLabel'),
      value: telemetryInsight.title,
      detail: telemetryInsight.cards.map((card) => `${card.label}: ${card.value}`).join(' / '),
      tone: telemetryInsight.tone,
    },
    {
      id: 'action',
      label: t('servers.sshTroubleshootingReportActionLabel'),
      value: actionValue,
      detail: actionDetail,
      tone: terminalBottleneckAdvisor?.tone ?? report.tone,
    },
  ];
  const items: SshTroubleshootingReportItem[] = rawItems.map((item) => ({
    ...item,
    value: sanitizeSshDoctorText(item.value),
    detail: sanitizeSshDoctorText(item.detail),
  }));

  const text = sanitizeSshDoctorText([
    `[${t('servers.sshTroubleshootingReportTitle')}]`,
    `${t('servers.sshTroubleshootingReportGenerated', { time: generatedAt })}`,
    `${t('servers.sshTroubleshootingReportDoctorLabel')}: ${formatSshDoctorTone(report.tone, t)}`,
    `${t('servers.sshTroubleshootingReportIncludes')}: ${t('servers.sshTroubleshootingReportIncludesValue')}`,
    '',
    `[${t('servers.sshDoctorEyebrow')}]`,
    ...report.steps.map((step) => `- ${step.label}: ${step.value} - ${step.detail}`),
    '',
    `[${t('servers.sshDoctorTrendEyebrow')}]`,
    `${trend?.title ?? t('servers.sshDoctorTrendNewTitle')} - ${trend?.detail ?? ''}`,
    '',
    `[${t('servers.sshTroubleshootingReportChannelLabel')}]`,
    `- ${channelValue}`,
    `- ${networkValue}`,
    `- ${selfTestValue}`,
    '',
    `[${t('servers.telemetryTitle')}]`,
    ...telemetryInsight.cards.map((card) => `- ${card.label}: ${card.value} (${card.detail})`),
    '',
    `[${t('servers.sshTroubleshootingReportRecommendedAction')}]`,
    `${actionValue}: ${actionDetail}`,
    '',
    `[${t('servers.sshTroubleshootingReportSafeNote')}]`,
    t('servers.sshTroubleshootingReportSafeNoteDetail'),
  ].join('\n'));

  const tone: TerminalNetworkQuality['tone'] = items.some((item) => item.tone === 'slow')
    ? 'slow'
    : items.some((item) => item.tone === 'warn')
      ? 'warn'
      : items.some((item) => item.tone === 'pending')
        ? 'pending'
        : 'good';

  return {
    generatedAt,
    tone,
    title: t('servers.sshTroubleshootingReportTitle'),
    detail: t('servers.sshTroubleshootingReportDetail'),
    items,
    text,
  };
}

function buildSshChannelBrowserStage(t: (key: string, vars?: Record<string, string | number>) => string): SshChannelCheckStage {
  const websocketReady = typeof WebSocket !== 'undefined';
  const eventSourceReady = typeof EventSource !== 'undefined';
  const fetchReady = typeof fetch !== 'undefined';
  const ok = websocketReady && eventSourceReady && fetchReady;
  return {
    id: 'browser',
    label: t('servers.sshChannelCheckBrowser'),
    value: ok ? t('servers.sshChannelCheckReady') : t('servers.sshChannelCheckBlocked'),
    detail: t('servers.sshChannelCheckBrowserDetail', {
      websocket: websocketReady ? 'ok' : 'missing',
      eventsource: eventSourceReady ? 'ok' : 'missing',
      fetch: fetchReady ? 'ok' : 'missing',
    }),
    tone: ok ? 'good' : 'slow',
  };
}

function probeWebSocketSshChannel(
  server: ServerNode,
  getDimensions: () => { cols: number; rows: number },
  t: (key: string, vars?: Record<string, string | number>) => string,
): Promise<SshChannelCheckStage> {
  const startedAt = performance.now();
  const marker = buildSshChannelCheckMarker('ws');
  return new Promise((resolve) => {
    let settled = false;
    let sessionId = '';
    let output = '';
    let latestMetric = '';
    let socket: ReturnType<typeof connectServerShellSocket> | null = null;

    const finish = (tone: TerminalNetworkQuality['tone'], value: string, detail: string) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      socket?.close();
      if (sessionId) {
        closeServerShell(sessionId).catch(() => undefined);
      }
      resolve({
        id: 'websocket',
        label: t('servers.sshChannelCheckWebSocket'),
        value,
        detail: sanitizeSshDoctorText(detail),
        tone,
        durationMs: Math.round(performance.now() - startedAt),
      });
    };

    const timeoutId = window.setTimeout(() => {
      finish('slow', t('servers.sshChannelCheckTimeout'), t('servers.sshChannelCheckWebSocketTimeout'));
    }, 8000);

    try {
      socket = connectServerShellSocket(
        server.id,
        getDimensions(),
        (event) => {
          if ((event.type === 'stdout' || event.type === 'stderr') && event.content) {
            output += event.content;
            if (output.includes(marker)) {
              finish('good', t('servers.sshChannelCheckRoundTripOk'), latestMetric || t('servers.sshChannelCheckWebSocketReady'));
            }
          }
          if (event.type === 'error') {
            finish('slow', t('servers.sshChannelCheckFailed'), event.message ?? t('servers.sshChannelCheckWebSocketFailed'));
          }
        },
        (event) => {
          sessionId = event.sessionId;
          socket?.sendInput(`printf '${marker}\\n'\r`);
        },
        (error) => {
          finish('slow', t('servers.sshChannelCheckFailed'), error.message);
        },
        (metrics) => {
          latestMetric = `${formatTerminalRtt(metrics.rttMs)} / ${formatBytesPerSecond(metrics.throughputBytesPerSecond)}`;
        },
        (event) => {
          if (!settled && event.ready) {
            finish('warn', t('servers.sshChannelCheckClosed'), t('servers.sshChannelCheckClosedDetail', { code: event.code || 'closed' }));
          }
        },
      );
    } catch (error) {
      finish('slow', t('servers.sshChannelCheckFailed'), error instanceof Error ? error.message : String(error));
    }
  });
}

async function probeCompatibleSshChannel(
  server: ServerNode,
  getDimensions: () => { cols: number; rows: number },
  t: (key: string, vars?: Record<string, string | number>) => string,
): Promise<SshChannelCheckStage> {
  const startedAt = performance.now();
  const marker = buildSshChannelCheckMarker('sse');
  let sessionId = '';
  let stream: EventSource | null = null;

  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    const finish = (tone: TerminalNetworkQuality['tone'], value: string, detail: string) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      stream?.close();
      if (sessionId) {
        closeServerShell(sessionId).catch(() => undefined);
      }
      resolve({
        id: 'compatible',
        label: t('servers.sshChannelCheckCompatible'),
        value,
        detail: sanitizeSshDoctorText(detail),
        tone,
        durationMs: Math.round(performance.now() - startedAt),
      });
    };

    const timeoutId = window.setTimeout(() => {
      finish('slow', t('servers.sshChannelCheckTimeout'), t('servers.sshChannelCheckCompatibleTimeout'));
    }, 9000);

    openServerShell(server.id, getDimensions())
      .then((shell) => {
        sessionId = shell.sessionId;
        stream = streamServerShell(
          shell.sessionId,
          (event) => {
            if ((event.type === 'stdout' || event.type === 'stderr') && event.content) {
              output += event.content;
              if (output.includes(marker)) {
                finish('good', t('servers.sshChannelCheckRoundTripOk'), t('servers.sshChannelCheckCompatibleReady'));
              }
            }
            if (event.type === 'error') {
              finish('slow', t('servers.sshChannelCheckFailed'), event.message ?? t('servers.sshChannelCheckCompatibleFailed'));
            }
          },
          (error) => {
            if (!settled) {
              finish('slow', t('servers.sshChannelCheckFailed'), error.message);
            }
          },
          { replayHistory: true },
        );
        window.setTimeout(() => {
          writeServerShell(shell.sessionId, `printf '${marker}\\n'\r`).catch((error) => {
            finish('slow', t('servers.sshChannelCheckFailed'), error instanceof Error ? error.message : String(error));
          });
        }, 80);
      })
      .catch((error) => {
        finish('slow', t('servers.sshChannelCheckFailed'), error instanceof Error ? error.message : String(error));
      });
  });
}

function buildSshChannelCleanupStage(
  beforeActiveCount: number,
  afterActiveCount: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): SshChannelCheckStage {
  const ok = afterActiveCount <= beforeActiveCount;
  return {
    id: 'cleanup',
    label: t('servers.sshChannelCheckCleanup'),
    value: ok ? t('servers.sshChannelCheckCleanupOk') : t('servers.sshChannelCheckCleanupWarn'),
    detail: t('servers.sshChannelCheckCleanupDetail', { before: beforeActiveCount, after: afterActiveCount }),
    tone: ok ? 'good' : 'warn',
  };
}

function buildSshChannelFailureStage(
  id: SshChannelCheckStageId,
  error: unknown,
  t: (key: string, vars?: Record<string, string | number>) => string,
): SshChannelCheckStage {
  return {
    id,
    label: formatSshChannelStageLabel(id, t),
    value: t('servers.sshChannelCheckFailed'),
    detail: sanitizeSshDoctorText(error instanceof Error ? error.message : String(error || 'SSH channel check failed')),
    tone: 'slow',
  };
}

function buildSshChannelCheckReport(
  server: ServerNode,
  stages: SshChannelCheckStage[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): SshChannelCheckReport {
  const checkedAt = new Date().toISOString();
  const serverName = sanitizeSshDoctorText(server.name || t('common.server'));
  const tone = stages.some((stage) => stage.tone === 'slow')
    ? 'slow'
    : stages.some((stage) => stage.tone === 'warn')
      ? 'warn'
      : stages.some((stage) => stage.tone === 'pending')
        ? 'pending'
        : 'good';
  const title = tone === 'slow'
    ? t('servers.sshChannelCheckTitleSlow', { name: serverName })
    : tone === 'warn'
      ? t('servers.sshChannelCheckTitleWarn', { name: serverName })
      : t('servers.sshChannelCheckTitleGood', { name: serverName });
  const detail = tone === 'slow'
    ? t('servers.sshChannelCheckDetailSlow')
    : tone === 'warn'
      ? t('servers.sshChannelCheckDetailWarn')
      : t('servers.sshChannelCheckDetailGood');
  const safeStages = stages.map((stage) => ({
    ...stage,
    value: sanitizeSshDoctorText(stage.value),
    detail: sanitizeSshDoctorText(stage.durationMs ? `${stage.detail} / ${stage.durationMs}ms` : stage.detail),
  }));
  const summary = sanitizeSshDoctorText([
    title,
    detail,
    `${t('servers.sshDoctorCheckedAt')}: ${checkedAt}`,
    ...safeStages.map((stage) => `${stage.label}: ${stage.value} - ${stage.detail}`),
  ].join('\n'));

  return {
    serverId: server.id,
    checkedAt,
    tone,
    title,
    detail,
    summary,
    stages: safeStages,
  };
}

function buildSshChannelFixPlan(
  report: SshChannelCheckReport,
  t: (key: string, vars?: Record<string, string | number>) => string,
): SshChannelFixPlan {
  const attentionStages = report.stages.filter((stage) => stage.tone === 'slow' || stage.tone === 'warn');
  const sourceStages = attentionStages.length > 0 ? attentionStages : report.stages.filter((stage) => stage.id !== 'cleanup').slice(0, 1);
  const actions = sourceStages.map((stage) => buildSshChannelFixAction(stage, report, t));
  if (attentionStages.length === 0) {
    actions.push({
      id: 'summary',
      label: t('servers.sshChannelFixPlanKeepLabel'),
      title: t('servers.sshChannelFixPlanKeepTitle'),
      detail: t('servers.sshChannelFixPlanKeepDetail'),
      action: t('servers.sshChannelFixPlanKeepAction'),
      tone: 'good',
    });
  }

  const tone: TerminalNetworkQuality['tone'] = actions.some((action) => action.tone === 'slow')
    ? 'slow'
    : actions.some((action) => action.tone === 'warn')
      ? 'warn'
      : 'good';
  const title = tone === 'slow'
    ? t('servers.sshChannelFixPlanTitleSlow')
    : tone === 'warn'
      ? t('servers.sshChannelFixPlanTitleWarn')
      : t('servers.sshChannelFixPlanTitleGood');
  const detail = tone === 'good'
    ? t('servers.sshChannelFixPlanDetailGood')
    : t('servers.sshChannelFixPlanDetailActionable');
  const text = sanitizeSshDoctorText([
    `[${t('servers.sshChannelFixPlanTitle')}]`,
    `${t('servers.sshChannelCheckEyebrow')}: ${report.title}`,
    `${t('servers.sshDoctorCheckedAt')}: ${report.checkedAt}`,
    '',
    `[${t('servers.sshChannelFixPlanSteps')}]`,
    ...actions.map((action, index) => `${index + 1}. ${action.title}\n   ${action.detail}\n   ${t('servers.sshChannelFixPlanNextAction')}: ${action.action}`),
    '',
    `[${t('servers.sshTroubleshootingReportSafeNote')}]`,
    t('servers.sshChannelFixPlanSafeNote'),
  ].join('\n'));

  return {
    tone,
    title,
    detail,
    actions: actions.map((action) => ({
      ...action,
      title: sanitizeSshDoctorText(action.title),
      detail: sanitizeSshDoctorText(action.detail),
      action: sanitizeSshDoctorText(action.action),
    })),
    text,
  };
}

function buildSshChannelFixAction(
  stage: SshChannelCheckStage,
  report: SshChannelCheckReport,
  t: (key: string, vars?: Record<string, string | number>) => string,
): SshChannelFixAction {
  const tone = stage.tone === 'slow' ? 'slow' : stage.tone === 'warn' ? 'warn' : 'good';
  if (stage.id === 'browser') {
    return {
      id: stage.id,
      label: stage.label,
      title: t('servers.sshChannelFixBrowserTitle'),
      detail: t('servers.sshChannelFixBrowserDetail'),
      action: t('servers.sshChannelFixBrowserAction'),
      tone,
    };
  }
  if (stage.id === 'websocket') {
    return {
      id: stage.id,
      label: stage.label,
      title: t('servers.sshChannelFixWebSocketTitle'),
      detail: t('servers.sshChannelFixWebSocketDetail'),
      action: t('servers.sshChannelFixWebSocketAction'),
      tone,
    };
  }
  if (stage.id === 'compatible') {
    return {
      id: stage.id,
      label: stage.label,
      title: t('servers.sshChannelFixCompatibleTitle'),
      detail: t('servers.sshChannelFixCompatibleDetail'),
      action: t('servers.sshChannelFixCompatibleAction'),
      tone,
    };
  }
  if (stage.id === 'cleanup') {
    return {
      id: stage.id,
      label: stage.label,
      title: t('servers.sshChannelFixCleanupTitle'),
      detail: t('servers.sshChannelFixCleanupDetail'),
      action: t('servers.sshChannelFixCleanupAction'),
      tone,
    };
  }
  return {
    id: 'summary',
    label: t('servers.sshChannelFixPlanKeepLabel'),
    title: report.title,
    detail: report.detail,
    action: t('servers.sshChannelFixPlanKeepAction'),
    tone,
  };
}

function buildSshChannelCheckMarker(prefix: 'ws' | 'sse') {
  return `__colipas_${prefix}_channel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}__`;
}

function formatSshChannelStageLabel(
  id: SshChannelCheckStageId,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  if (id === 'browser') {
    return t('servers.sshChannelCheckBrowser');
  }
  if (id === 'websocket') {
    return t('servers.sshChannelCheckWebSocket');
  }
  if (id === 'compatible') {
    return t('servers.sshChannelCheckCompatible');
  }
  return t('servers.sshChannelCheckCleanup');
}

function classifySshRunbookCommand(command: SshRunbookCommand): Exclude<SshRunbookCategory, 'all'> {
  const text = normalizeRunbookSearchText(`${command.title} ${command.command}`);
  if (/\b(journalctl|tail|grep|awk|sed|logrotate|dmesg|syslog|log)\b/u.test(text)) {
    return 'logs';
  }
  if (/\b(ip|ifconfig|ss|netstat|curl|wget|ping|traceroute|tracepath|dig|nslookup|iptables|nft|ufw|firewall-cmd|route)\b/u.test(text)) {
    return 'network';
  }
  if (/\b(df|du|lsblk|blkid|mount|umount|iostat|smartctl|fdisk|parted|xfs|ext4|disk)\b/u.test(text)) {
    return 'storage';
  }
  if (/\b(uname|uptime|free|top|htop|ps|vmstat|systemctl|service|who|w|hostname|cpu|memory|load)\b/u.test(text)) {
    return 'system';
  }
  return 'other';
}

function countSshRunbookCategories(commands: SshRunbookCommand[]): Record<SshRunbookCategory, number> {
  const counts = sshRunbookCategories.reduce((next, category) => {
    next[category] = 0;
    return next;
  }, {} as Record<SshRunbookCategory, number>);
  counts.all = commands.length;
  for (const command of commands) {
    counts[classifySshRunbookCommand(command)] += 1;
  }
  return counts;
}

function buildSshRunbookRecommendations(
  commands: SshRunbookCommand[],
  doctorReport: SshConnectionDoctorReport | null,
  bottleneckAdvisor: TerminalBottleneckAdvisor,
  terminalActive: boolean,
  t: (key: string, vars?: Record<string, string | number>) => string,
): SshRunbookRecommendation[] {
  if (commands.length === 0) {
    return [];
  }

  const doctorFocus = getRunbookDoctorFocus(doctorReport, bottleneckAdvisor);
  const bottleneckFocus = terminalActive ? getRunbookBottleneckFocus(bottleneckAdvisor) : null;
  const manualIndex = new Map(commands.map((command, index) => [command.id, index]));
  return commands
    .map((command) => buildSshRunbookRecommendation(command, manualIndex.get(command.id) ?? 0, doctorFocus, bottleneckFocus, t))
    .sort((left, right) => compareRunbookMetric(right.score, left.score) || compareRunbookMetric(manualIndex.get(left.command.id) ?? 0, manualIndex.get(right.command.id) ?? 0))
    .slice(0, 3);
}

function buildSshRunbookRecommendation(
  command: SshRunbookCommand,
  index: number,
  doctorFocus: SshRunbookRecommendationFocus | null,
  bottleneckFocus: SshRunbookRecommendationFocus | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): SshRunbookRecommendation {
  const category = classifySshRunbookCommand(command);
  const useCount = Math.max(0, Math.trunc(command.useCount ?? 0));
  const lastUsedMs = getRunbookLastUsedMs(command);
  const now = Date.now();
  const recentBoost = lastUsedMs > 0 ? Math.max(0, 16 - Math.floor((now - lastUsedMs) / 36e5)) : 0;
  let score = Math.max(0, 16 - index) + Math.min(useCount, 20) * 3 + recentBoost;
  let reasonType: SshRunbookRecommendationReason = useCount > 0 ? 'usage' : 'ready';
  let detailKey = useCount > 0 ? 'servers.quickCommandRecommendDetail.usage' : 'servers.quickCommandRecommendDetail.ready';
  let detailVars: Record<string, string | number> = {
    category: t(`servers.quickCommandCategory.${category}`),
    count: useCount,
  };
  let tone: TerminalNetworkQuality['tone'] = useCount > 0 ? 'good' : 'pending';

  if (command.pinned) {
    score += 32;
    reasonType = 'pinned';
    detailKey = 'servers.quickCommandRecommendDetail.pinned';
    tone = 'good';
  }

  if (bottleneckFocus?.categories.has(category)) {
    score += 48 + bottleneckFocus.strength;
    reasonType = 'bottleneck';
    detailKey = 'servers.quickCommandRecommendDetail.bottleneck';
    detailVars = { ...detailVars, signal: bottleneckFocus.label };
    tone = bottleneckFocus.tone;
  }

  if (doctorFocus?.categories.has(category)) {
    score += 64 + doctorFocus.strength;
    reasonType = 'diagnostic';
    detailKey = 'servers.quickCommandRecommendDetail.diagnostic';
    detailVars = { ...detailVars, signal: doctorFocus.label };
    tone = doctorFocus.tone;
  }

  return {
    command,
    category,
    score,
    tone,
    reason: t(`servers.quickCommandRecommendReason.${reasonType}`),
    detail: t(detailKey, detailVars),
  };
}

interface SshRunbookRecommendationFocus {
  categories: Set<Exclude<SshRunbookCategory, 'all'>>;
  label: string;
  strength: number;
  tone: TerminalNetworkQuality['tone'];
}

function getRunbookDoctorFocus(report: SshConnectionDoctorReport | null, bottleneckAdvisor: TerminalBottleneckAdvisor): SshRunbookRecommendationFocus | null {
  if (!report) {
    return null;
  }
  const focusStep = report.steps.find((step) => step.tone === 'slow') ?? report.steps.find((step) => step.tone === 'warn');
  if (!focusStep) {
    return null;
  }
  return {
    categories: mapDoctorStepToRunbookCategories(focusStep.id, bottleneckAdvisor),
    label: focusStep.label,
    strength: focusStep.tone === 'slow' ? 28 : 14,
    tone: focusStep.tone,
  };
}

function mapDoctorStepToRunbookCategories(stepId: SshConnectionDoctorStepId, bottleneckAdvisor: TerminalBottleneckAdvisor): Set<Exclude<SshRunbookCategory, 'all'>> {
  if (stepId === 'terminal') {
    return mapBottleneckToRunbookCategories(getPrimaryBottleneckItem(bottleneckAdvisor)?.id ?? 'network');
  }
  if (stepId === 'shell' || stepId === 'backend' || stepId === 'credential') {
    return new Set(['logs', 'system']);
  }
  return new Set(['system']);
}

function getRunbookBottleneckFocus(advisor: TerminalBottleneckAdvisor): SshRunbookRecommendationFocus | null {
  const primary = getPrimaryBottleneckItem(advisor);
  if (!primary || primary.tone === 'pending' || primary.level < 22) {
    return null;
  }
  return {
    categories: mapBottleneckToRunbookCategories(primary.id),
    label: primary.label,
    strength: Math.round(primary.level / 3),
    tone: primary.tone,
  };
}

function getPrimaryBottleneckItem(advisor: TerminalBottleneckAdvisor): TerminalBottleneckItem | null {
  const [firstItem, ...restItems] = advisor.items;
  if (!firstItem) {
    return null;
  }
  return restItems.reduce((best, item) => (item.level > best.level ? item : best), firstItem);
}

function mapBottleneckToRunbookCategories(id: TerminalBottleneckItem['id']): Set<Exclude<SshRunbookCategory, 'all'>> {
  if (id === 'network') {
    return new Set(['network']);
  }
  if (id === 'output' || id === 'render') {
    return new Set(['logs', 'system']);
  }
  return new Set(['system']);
}

function filterSshRunbookCommands(commands: SshRunbookCommand[], query: string, category: SshRunbookCategory, view: SshRunbookView) {
  const normalizedQuery = normalizeRunbookSearchText(query);
  const filtered = commands.filter((command) => {
    if (category !== 'all' && classifySshRunbookCommand(command) !== category) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    return normalizeRunbookSearchText(`${command.title} ${command.command}`).includes(normalizedQuery);
  });

  if (view === 'manual') {
    return filtered;
  }

  const manualIndex = new Map(commands.map((command, index) => [command.id, index]));
  return filtered.slice().sort((left, right) => compareSshRunbookCommands(left, right, view, manualIndex));
}

function compareSshRunbookCommands(left: SshRunbookCommand, right: SshRunbookCommand, view: Exclude<SshRunbookView, 'manual'>, manualIndex: Map<string, number>) {
  const pinnedDelta = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
  if (pinnedDelta !== 0) {
    return pinnedDelta;
  }

  if (view === 'recent') {
    return compareRunbookMetric(getRunbookLastUsedMs(right), getRunbookLastUsedMs(left))
      || compareRunbookMetric(right.useCount ?? 0, left.useCount ?? 0)
      || compareRunbookMetric(manualIndex.get(left.id) ?? 0, manualIndex.get(right.id) ?? 0);
  }

  return compareRunbookMetric(right.useCount ?? 0, left.useCount ?? 0)
    || compareRunbookMetric(getRunbookLastUsedMs(right), getRunbookLastUsedMs(left))
    || compareRunbookMetric(manualIndex.get(left.id) ?? 0, manualIndex.get(right.id) ?? 0);
}

function compareRunbookMetric(left: number, right: number) {
  return left === right ? 0 : left > right ? 1 : -1;
}

function getRunbookLastUsedMs(command: SshRunbookCommand) {
  const value = command.lastUsedAt ? Date.parse(command.lastUsedAt) : 0;
  return Number.isFinite(value) ? value : 0;
}

function normalizeRunbookSearchText(value: string) {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function readSshDoctorHistory(): SshConnectionDoctorHistoryEntry[] {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(sshDoctorHistoryStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(isSshDoctorHistoryEntry).slice(0, sshDoctorHistoryLimit)
      : [];
  } catch {
    return [];
  }
}

function writeSshDoctorHistory(history: SshConnectionDoctorHistoryEntry[]) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(sshDoctorHistoryStorageKey, JSON.stringify(history.slice(0, sshDoctorHistoryLimit)));
  } catch {
    // Local history is best-effort and must never block SSH diagnostics.
  }
}

function isSshDoctorHistoryEntry(value: unknown): value is SshConnectionDoctorHistoryEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Partial<SshConnectionDoctorHistoryEntry>;
  const stepTones = entry.stepTones as Partial<Record<SshConnectionDoctorStepId, unknown>> | undefined;
  return entry.version === 1
    && typeof entry.id === 'string'
    && typeof entry.targetKey === 'string'
    && typeof entry.createdAt === 'string'
    && isSshDoctorTone(entry.tone)
    && sshConnectionDoctorStepIds.includes(entry.primary as SshConnectionDoctorStepId)
    && Boolean(stepTones)
    && sshConnectionDoctorStepIds.every((stepId) => isSshDoctorTone(stepTones?.[stepId]))
    && Number.isInteger(entry.slowCount)
    && Number.isInteger(entry.warnCount)
    && Number.isInteger(entry.pendingCount);
}

function isSshDoctorTone(value: unknown): value is TerminalNetworkQuality['tone'] {
  return value === 'pending' || value === 'good' || value === 'warn' || value === 'slow';
}

function getSshDoctorPrimaryStep(steps: SshConnectionDoctorStep[]) {
  return steps.reduce((primary, step) => (
    getSshDoctorToneScore(step.tone) > getSshDoctorToneScore(primary.tone) ? step : primary
  ), steps[0] ?? {
    id: 'terminal',
    tone: 'pending',
  } as SshConnectionDoctorStep).id;
}

function getSshDoctorToneScore(tone: TerminalNetworkQuality['tone']) {
  if (tone === 'slow') {
    return 3;
  }
  if (tone === 'warn') {
    return 2;
  }
  if (tone === 'pending') {
    return 1;
  }
  return 0;
}

function formatSshDoctorTone(
  tone: TerminalNetworkQuality['tone'],
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  if (tone === 'slow') {
    return t('servers.sshDoctorToneSlow');
  }
  if (tone === 'warn') {
    return t('servers.sshDoctorToneWarn');
  }
  if (tone === 'pending') {
    return t('servers.sshDoctorTonePending');
  }
  return t('servers.sshDoctorToneGood');
}

function hashSshDoctorTarget(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `target-${(hash >>> 0).toString(36)}`;
}

function sanitizeSshDoctorText(text: string) {
  return text
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-host]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-api-key]')
    .replace(/\b(?:password|passphrase|api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, (match) => {
      const separator = match.includes(':') ? ':' : '=';
      return `${match.split(separator)[0]}${separator} [redacted]`;
    });
}

function formatSshRunbookUsage(command: SshRunbookCommand, t: (key: string, vars?: Record<string, string | number>) => string) {
  if (!command.useCount) {
    return t('servers.quickCommandUsageNever');
  }

  return t('servers.quickCommandUsageMeta', {
    count: command.useCount,
    time: formatSshRunbookUsageTime(command.lastUsedAt, t),
  });
}

function formatSshRunbookUsageTime(value: string | undefined, t: (key: string, vars?: Record<string, string | number>) => string) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    return t('servers.quickCommandUsageUnknown');
  }

  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) {
    return t('servers.quickCommandUsageJustNow');
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return t('servers.quickCommandUsageMinutes', { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t('servers.quickCommandUsageHours', { count: hours });
  }
  return t('servers.quickCommandUsageDays', { count: Math.floor(hours / 24) });
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
