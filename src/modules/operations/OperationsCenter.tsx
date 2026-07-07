import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Clock3,
  PlayCircle,
  Plus,
  Power,
  PowerOff,
  RotateCcw,
  Server,
  ShieldCheck,
  Terminal,
  Workflow,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { createOperationTask, preflightOperationTask } from '../../services/apiClient';
import { getSshCommandConfirmationReason } from '../../shared/sshCommandRisk';
import {
  OperationEvent,
  OperationTaskPreflightResponse,
  OperationTaskRequest,
  OperationTaskResponse,
  OperationTaskStatus,
  OperationTaskTargetMode,
  OperationTaskType,
  ServerNode,
} from '../../types';
import { formatRegionName, percentClass, statusLabel } from '../../utils/format';

interface OperationsCenterProps {
  events: OperationEvent[];
  servers: ServerNode[];
  draft?: OperationsDraft | null;
  onDraftPreflight?: (draft: OperationsDraft, preflight: OperationTaskPreflightResponse) => void;
  onTaskFinished?: () => Promise<void> | void;
  onAuditTraceOpen?: (correlationId: string) => void;
  releaseFocusAnchor?: string;
}

export interface OperationsDraft {
  id: string;
  title: string;
  description: string;
  type: OperationTaskType;
  targetMode: OperationTaskTargetMode;
  serverIds?: string[];
  command?: string;
  reason?: string;
}

interface PreflightHistoryEntry {
  id: string;
  type: OperationTaskType;
  targetMode: OperationTaskTargetMode;
  serverIds: string[];
  command: string;
  reason: string;
  targetCount: number;
  createdAt: string;
  preflight: OperationTaskPreflightResponse;
}

interface TaskMeta {
  id: OperationTaskType;
  label: string;
  description: string;
  icon: LucideIcon;
}

type Copy = {
  running: string;
  completed: string;
  partial: string;
  failed: string;
  queued: string;
  dashboard: string;
  assets: string;
  sshReady: string;
  warning: string;
  executed: string;
  targetScope: string;
  allConnected: string;
  allServers: string;
  selected: string;
  selectServers: string;
  command: string;
  commandPlaceholder: string;
  reason: string;
  reasonPlaceholder: string;
  run: string;
  runningTask: string;
  noServers: string;
  noConnected: string;
  selectAtLeastOne: string;
  commandRequired: string;
  confirm: string;
  confirmDanger: string;
  confirmPower: string;
  queue: string;
  noTasks: string;
  result: string;
  noResult: string;
  target: string;
  eventEmpty: string;
  skipped: string;
  success: string;
  output: string;
  error: string;
  preview: string;
  activeServers: string;
  serverLoad: string;
  viewTrace: string;
  choiceWindow: string;
  loadMoreTargets: string;
  draftApplied: string;
  draftHint: string;
  dismissDraft: string;
  runPreflight: string;
  preflightOnlyHint: string;
  preflightHistory: string;
  noPreflightHistory: string;
  restorePreflight: string;
  viewPreflightEvidence: string;
  latestPreflight: string;
  draftRiskTitle: string;
  draftRiskTask: string;
  draftRiskTargets: string;
  draftRiskTargetMode: string;
  draftRiskCommand: string;
  draftRiskReady: string;
  draftRiskWarn: string;
  draftRiskBlocked: string;
  draftRiskCommandSafe: string;
  draftRiskCommandWarn: string;
  draftRiskCommandMissing: string;
  draftRiskActionConfirm: string;
  draftRiskNoCommand: string;
  truncatedOutputs?: string;
};

const taskIds: OperationTaskType[] = ['assetSync', 'healthCheck', 'sshCommand', 'powerOn', 'shutdown', 'reboot'];
const actionTaskIds: OperationTaskType[] = ['powerOn', 'shutdown', 'reboot'];
const opsServerChoiceBatchSize = 120;
const opsServerChoiceBatchStep = 120;

const copyByLanguage: Record<string, Copy> = {
  zh: {
    running: '执行中',
    completed: '完成',
    partial: '部分完成',
    failed: '失败',
    queued: '排队中',
    dashboard: '编排控制台',
    assets: '资产',
    sshReady: 'SSH 已接入',
    warning: '待处理',
    executed: '已执行任务',
    targetScope: '目标范围',
    allConnected: '全部已接入 SSH',
    allServers: '全部服务器资产',
    selected: '指定服务器',
    selectServers: '选择服务器',
    command: 'SSH 命令',
    commandPlaceholder: '例如：hostname && uptime',
    reason: '执行原因',
    reasonPlaceholder: '例如：计划维护窗口',
    run: '执行编排',
    runningTask: '正在执行...',
    noServers: '暂无服务器资产，先到服务器模块接入资产。',
    noConnected: '当前没有已接入 SSH 的服务器，健康检查、命令和电源动作无法执行。',
    selectAtLeastOne: '请至少选择一台服务器。',
    commandRequired: '请输入要执行的 SSH 命令。',
    confirm: '将执行运维编排任务，是否继续？',
    confirmDanger: '将对 {count} 台服务器执行真实{name}命令，是否继续？',
    confirmPower: '将对 {count} 台服务器执行{name}检测，是否继续？',
    queue: '任务队列',
    noTasks: '还没有执行任务，点击“新建任务”创建编排。',
    result: '执行结果',
    noResult: '任务完成后会在这里显示每台服务器的输出。',
    target: '目标',
    eventEmpty: '事件队列为空，当前没有待处理告警。',
    skipped: '跳过',
    success: '成功',
    output: '输出',
    error: '错误',
    preview: '预计影响',
    activeServers: '可执行服务器',
    serverLoad: '服务器负载',
    viewTrace: '查看审计链',
    choiceWindow: '已显示 {shown} / {total} 台候选服务器，继续加载不会影响已选择目标。',
    loadMoreTargets: '再加载 {count} 台',
    draftApplied: '健康草稿已生成',
    draftHint: '草稿只预填任务；点击执行编排后仍会先预检并要求确认。',
    dismissDraft: '收起草稿提示',
    runPreflight: '只预检',
    preflightOnlyHint: '只验证目标和风险，不执行命令。',
    preflightHistory: '最近预检记录',
    noPreflightHistory: '还没有预检记录。点击“只预检”后会在这里留下上线前检查证据。',
    restorePreflight: '恢复这次预检上下文',
    viewPreflightEvidence: '证据',
    latestPreflight: '最新',
    draftRiskTitle: '执行前摘要',
    draftRiskTask: '任务',
    draftRiskTargets: '目标数',
    draftRiskTargetMode: '目标范围',
    draftRiskCommand: '命令风险',
    draftRiskReady: '已选择 {count} 台目标，可先预检再执行。',
    draftRiskWarn: '命中 {count} 台目标，包含高影响动作，执行前必须确认预检结果。',
    draftRiskBlocked: '当前没有可执行目标，请调整目标范围或先接入 SSH。',
    draftRiskCommandSafe: '低风险命令',
    draftRiskCommandWarn: '高影响命令，需要确认',
    draftRiskCommandMissing: '等待输入命令',
    draftRiskActionConfirm: '动作需要确认',
    draftRiskNoCommand: '无需 SSH 命令',
  },
  en: {
    running: 'Running',
    completed: 'Completed',
    partial: 'Partial',
    failed: 'Failed',
    queued: 'Queued',
    dashboard: 'Orchestration console',
    assets: 'Assets',
    sshReady: 'SSH ready',
    warning: 'Needs attention',
    executed: 'Tasks run',
    targetScope: 'Target scope',
    allConnected: 'All SSH-connected',
    allServers: 'All server assets',
    selected: 'Selected servers',
    selectServers: 'Select servers',
    command: 'SSH command',
    commandPlaceholder: 'Example: hostname && uptime',
    reason: 'Reason',
    reasonPlaceholder: 'Example: scheduled maintenance window',
    run: 'Run orchestration',
    runningTask: 'Running...',
    noServers: 'No server assets yet. Add servers first.',
    noConnected: 'No SSH-connected servers are available for health checks, commands, or power actions.',
    selectAtLeastOne: 'Select at least one server.',
    commandRequired: 'Enter an SSH command.',
    confirm: 'This will run an operations task. Continue?',
    confirmDanger: 'This will run a real {name} command on {count} server(s). Continue?',
    confirmPower: 'This will run {name} on {count} server(s). Continue?',
    queue: 'Task queue',
    noTasks: 'No tasks yet. Create one with New task.',
    result: 'Execution result',
    noResult: 'Per-server output appears here after a task finishes.',
    target: 'Target',
    eventEmpty: 'No events are waiting in the queue.',
    skipped: 'Skipped',
    success: 'Success',
    output: 'Output',
    error: 'Error',
    preview: 'Impact preview',
    activeServers: 'Runnable servers',
    serverLoad: 'Server load',
    viewTrace: 'View audit trace',
    choiceWindow: 'Showing {shown} / {total} candidate servers. Loading more keeps selected targets.',
    loadMoreTargets: 'Load {count} more',
    draftApplied: 'Health draft generated',
    draftHint: 'The draft only fills the task. Running it still performs preflight and confirmation first.',
    dismissDraft: 'Dismiss draft note',
    runPreflight: 'Preflight only',
    preflightOnlyHint: 'Validate targets and risk without running commands.',
    preflightHistory: 'Preflight history',
    noPreflightHistory: 'No preflight evidence yet. Run Preflight only to keep a release-check record here.',
    restorePreflight: 'Restore this preflight context',
    viewPreflightEvidence: 'Evidence',
    latestPreflight: 'Latest',
    draftRiskTitle: 'Before-run summary',
    draftRiskTask: 'Task',
    draftRiskTargets: 'Targets',
    draftRiskTargetMode: 'Scope',
    draftRiskCommand: 'Command risk',
    draftRiskReady: '{count} target(s) selected. Run preflight before execution.',
    draftRiskWarn: '{count} target(s) matched with a high-impact action. Confirm preflight evidence before running.',
    draftRiskBlocked: 'No runnable targets are available. Adjust the scope or connect SSH first.',
    draftRiskCommandSafe: 'Low-risk command',
    draftRiskCommandWarn: 'High-impact command; confirmation required',
    draftRiskCommandMissing: 'Waiting for command input',
    draftRiskActionConfirm: 'Action requires confirmation',
    draftRiskNoCommand: 'No SSH command required',
  },
  ja: {
    running: '実行中',
    completed: '完了',
    partial: '一部完了',
    failed: '失敗',
    queued: '待機中',
    dashboard: '運用編成コンソール',
    assets: '資産',
    sshReady: 'SSH 接続済み',
    warning: '対応が必要',
    executed: '実行済みタスク',
    targetScope: '対象範囲',
    allConnected: 'SSH 接続済みすべて',
    allServers: 'すべてのサーバー資産',
    selected: '指定サーバー',
    selectServers: 'サーバーを選択',
    command: 'SSH コマンド',
    commandPlaceholder: '例: hostname && uptime',
    reason: '実行理由',
    reasonPlaceholder: '例: 定期メンテナンス',
    run: '編成を実行',
    runningTask: '実行中...',
    noServers: 'サーバー資産がありません。先にサーバーを接続してください。',
    noConnected: 'SSH 接続済みサーバーがないため、ヘルスチェック、コマンド、電源操作は実行できません。',
    selectAtLeastOne: '少なくとも 1 台のサーバーを選択してください。',
    commandRequired: '実行する SSH コマンドを入力してください。',
    confirm: '運用編成タスクを実行します。続行しますか？',
    confirmDanger: '{count} 台のサーバーで実際の{name}コマンドを実行します。続行しますか？',
    confirmPower: '{count} 台のサーバーで{name}を実行します。続行しますか？',
    queue: 'タスクキュー',
    noTasks: 'タスクはまだありません。新規タスクから作成してください。',
    result: '実行結果',
    noResult: 'タスク完了後、サーバーごとの出力がここに表示されます。',
    target: '対象',
    eventEmpty: 'イベントキューは空です。',
    skipped: 'スキップ',
    success: '成功',
    output: '出力',
    error: 'エラー',
    preview: '影響プレビュー',
    activeServers: '実行可能サーバー',
    serverLoad: 'サーバー負荷',
    viewTrace: '監査トレースを表示',
    choiceWindow: '候補サーバー {shown} / {total} 台を表示中。追加読み込みしても選択は維持されます。',
    loadMoreTargets: '{count} 台を追加読み込み',
    draftApplied: 'ヘルス草案を生成しました',
    draftHint: '草案はタスクを入力するだけです。実行時は先にプリフライトと確認を行います。',
    dismissDraft: '草案メモを閉じる',
    runPreflight: 'プリフライトのみ',
    preflightOnlyHint: 'コマンドを実行せず、対象とリスクだけ確認します。',
    preflightHistory: '最新プリフライト履歴',
    noPreflightHistory: 'プリフライト履歴はまだありません。プリフライトのみを実行すると、リリース前の確認証跡を残せます。',
    restorePreflight: 'このプリフライト内容を復元',
    viewPreflightEvidence: '証跡',
    latestPreflight: '最新',
    draftRiskTitle: '実行前サマリー',
    draftRiskTask: 'タスク',
    draftRiskTargets: '対象数',
    draftRiskTargetMode: '対象範囲',
    draftRiskCommand: 'コマンドリスク',
    draftRiskReady: '{count} 台の対象を選択済みです。実行前にプリフライトできます。',
    draftRiskWarn: '{count} 台が対象で、高影響の操作を含みます。実行前にプリフライト証跡を確認してください。',
    draftRiskBlocked: '実行可能な対象がありません。範囲を調整するか SSH を接続してください。',
    draftRiskCommandSafe: '低リスクコマンド',
    draftRiskCommandWarn: '高影響コマンド、確認が必要',
    draftRiskCommandMissing: 'コマンド入力待ち',
    draftRiskActionConfirm: '操作には確認が必要',
    draftRiskNoCommand: 'SSH コマンド不要',
  },
};

const preflightCopyByLanguage: Record<string, {
  title: string;
  ready: string;
  blocked: string;
  warn: string;
  targets: string;
  issues: string;
  unavailable: string;
  runnable: string;
  blockedTarget: string;
  detailTitle: string;
  planTitle: string;
  commandPreview: string;
}> = {
  zh: {
    title: '执行预检',
    ready: '预检通过，可以执行',
    blocked: '预检发现阻断项',
    warn: '需要确认后执行',
    targets: '目标 / 可执行',
    issues: '风险项',
    unavailable: '预检未完成',
    runnable: '可执行',
    blockedTarget: '阻断',
    detailTitle: '目标明细',
    planTitle: '执行计划',
    commandPreview: '命令预览',
  },
  en: {
    title: 'Preflight',
    ready: 'Ready to run',
    blocked: 'Blocked by preflight',
    warn: 'Confirmation required',
    targets: 'Targets / runnable',
    issues: 'Issues',
    unavailable: 'Preflight not run',
    runnable: 'Runnable',
    blockedTarget: 'Blocked',
    detailTitle: 'Target details',
    planTitle: 'Execution plan',
    commandPreview: 'Command preview',
  },
  ja: {
    title: '実行前プリフライト',
    ready: '実行できます',
    blocked: 'プリフライトでブロックされました',
    warn: '確認後に実行できます',
    targets: '対象 / 実行可能',
    issues: 'リスク項目',
    unavailable: '未プリフライト',
    runnable: '実行可能',
    blockedTarget: 'ブロック',
    detailTitle: '対象詳細',
    planTitle: '実行計画',
    commandPreview: 'コマンドプレビュー',
  },
};

export function OperationsCenter({ events, servers, draft, onDraftPreflight, onTaskFinished, onAuditTraceOpen, releaseFocusAnchor }: OperationsCenterProps) {
  const { language, t } = useI18n();
  const copy = copyByLanguage[language] ?? copyByLanguage.zh;
  const preflightCopy = preflightCopyByLanguage[language] ?? preflightCopyByLanguage.zh;
  const providerName = (provider: string) => formatProviderName(provider, t);
  const regionName = (region: string) => formatRegionName(region, language);
  const operationServerGroups = useMemo(() => buildOperationServerGroups(servers), [servers]);
  const { connectedServers, warningServers } = operationServerGroups;
  const [builderOpen, setBuilderOpen] = useState(false);
  const [taskType, setTaskType] = useState<OperationTaskType>('healthCheck');
  const [targetMode, setTargetMode] = useState<OperationTaskTargetMode>('allConnected');
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>([]);
  const [visibleServerChoiceLimit, setVisibleServerChoiceLimit] = useState(opsServerChoiceBatchSize);
  const [command, setCommand] = useState('hostname && uptime');
  const [reason, setReason] = useState('');
  const [running, setRunning] = useState(false);
  const [preflighting, setPreflighting] = useState(false);
  const [message, setMessage] = useState('');
  const [preflight, setPreflight] = useState<OperationTaskPreflightResponse | null>(null);
  const [preflightHistory, setPreflightHistory] = useState<PreflightHistoryEntry[]>([]);
  const [tasks, setTasks] = useState<OperationTaskResponse[]>([]);
  const [activeTaskId, setActiveTaskId] = useState('');
  const [appliedDraftId, setAppliedDraftId] = useState('');
  const [draftNotice, setDraftNotice] = useState<OperationsDraft | null>(null);
  const operationsReleaseFocusActive = releaseFocusAnchor === 'operations-builder';

  const taskMeta = useMemo(() => buildTaskMeta(language), [language]);
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? tasks[0] ?? null;
  const activeTaskLabel = taskMeta[taskType]?.label ?? taskType;
  const activeTargetModeLabel = targetMode === 'selected' ? copy.selected : targetMode === 'allServers' ? copy.allServers : copy.allConnected;
  const canOpenActiveTaskTrace = Boolean(
    activeTask
      && activeTask.status !== 'queued'
      && activeTask.status !== 'running'
      && activeTask.correlationId.startsWith('ops-trace-'),
  );
  const sshRequiredTask = taskType !== 'assetSync';
  const eligibleServers = sshRequiredTask ? connectedServers : servers;
  const eligibleServerIds = useMemo(() => new Set(eligibleServers.map((server) => server.id)), [eligibleServers]);
  const activeSelectedServerIds = useMemo(
    () => selectedServerIds.filter((id) => eligibleServerIds.has(id)),
    [eligibleServerIds, selectedServerIds],
  );
  const activeSelectedServerIdSet = useMemo(() => new Set(activeSelectedServerIds), [activeSelectedServerIds]);
  const visibleEligibleServers = useMemo(
    () => eligibleServers.slice(0, visibleServerChoiceLimit),
    [eligibleServers, visibleServerChoiceLimit],
  );
  const hiddenServerChoiceCount = Math.max(eligibleServers.length - visibleEligibleServers.length, 0);
  const previewCount = resolvePreviewCount(targetMode, eligibleServers.length, activeSelectedServerIds.length);
  const draftRiskSummary = useMemo(() => buildDraftRiskSummary({
    command,
    copy,
    previewCount,
    targetModeLabel: activeTargetModeLabel,
    taskLabel: activeTaskLabel,
    taskType,
  }), [activeTargetModeLabel, activeTaskLabel, command, copy, previewCount, taskType]);

  useEffect(() => {
    if (sshRequiredTask && targetMode === 'allServers') {
      setTargetMode('allConnected');
    }
  }, [sshRequiredTask, targetMode]);

  useEffect(() => {
    if (releaseFocusAnchor !== 'operations-builder') {
      return;
    }
    setBuilderOpen(true);
  }, [releaseFocusAnchor]);

  useEffect(() => {
    setSelectedServerIds((current) => current.filter((id) => eligibleServerIds.has(id)));
  }, [eligibleServerIds]);

  useEffect(() => {
    setVisibleServerChoiceLimit(opsServerChoiceBatchSize);
  }, [eligibleServers.length, targetMode, taskType]);

  useEffect(() => {
    if (targetMode !== 'selected' || activeSelectedServerIds.length > 0 || eligibleServers.length === 0) {
      return;
    }
    setSelectedServerIds([eligibleServers[0].id]);
  }, [activeSelectedServerIds.length, eligibleServers, targetMode]);

  useEffect(() => {
    setPreflight(null);
  }, [activeSelectedServerIds, command, reason, targetMode, taskType]);

  useEffect(() => {
    if (!draft || draft.id === appliedDraftId) {
      return;
    }

    setBuilderOpen(true);
    setTaskType(draft.type);
    setTargetMode(draft.targetMode);
    setSelectedServerIds(draft.serverIds ?? []);
    setCommand(draft.command ?? 'hostname && uptime');
    setReason(draft.reason ?? '');
    setPreflight(null);
    setMessage('');
    setDraftNotice(draft);
    setAppliedDraftId(draft.id);
  }, [appliedDraftId, draft]);

  async function executePreflightOnly() {
    const validation = validateTask();
    if (validation) {
      setMessage(validation);
      return null;
    }

    const preflightPayload = buildTaskPayload(false);
    setPreflighting(true);
    setMessage('');
    try {
      const preflightResult = await preflightOperationTask(preflightPayload);
      setPreflight(preflightResult);
      const historyEntry = createPreflightHistoryEntry(preflightResult, {
        type: taskType,
        targetMode,
        serverIds: activeSelectedServerIds,
        command,
        reason,
        targetCount: previewCount,
      });
      setPreflightHistory((current) => [
        historyEntry,
        ...current.filter((entry) => entry.id !== historyEntry.id),
      ].slice(0, 5));
      setMessage(preflightResult.ok ? preflightStatusText(preflightResult, preflightCopy) : preflightResult.issues[0]?.message ?? preflightCopy.blocked);
      if (draftNotice) {
        onDraftPreflight?.(draftNotice, preflightResult);
      }
      return preflightResult;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : preflightCopy.unavailable);
      return null;
    } finally {
      setPreflighting(false);
    }
  }

  async function runTask() {
    const preflightResult = await executePreflightOnly();
    if (!preflightResult) {
      return;
    }

    if (!preflightResult.ok) {
      setMessage(preflightResult.issues[0]?.message ?? preflightCopy.blocked);
      return;
    }

    const confirmMessage = buildOperationConfirmMessage(taskType, previewCount, taskMeta[taskType].label, copy);
    if (!window.confirm(confirmMessage)) {
      return;
    }

    const payload = buildTaskPayload(preflightResult.requiresConfirmation, preflightResult.correlationId);
    setRunning(true);
    setMessage('');
    const pendingTask = createPendingTask(taskType, targetMode, previewCount, language);
    setTasks((current) => [pendingTask, ...current]);
    setActiveTaskId(pendingTask.id);

    try {
      const result = await createOperationTask(payload);
      setTasks((current) => current.map((task) => (task.id === pendingTask.id ? result : task)));
      setActiveTaskId(result.id);
      setMessage(result.message);
      await onTaskFinished?.();
    } catch (error) {
      const failedTask = createFailedTask(pendingTask, error instanceof Error ? error.message : 'operation task failed');
      setTasks((current) => current.map((task) => (task.id === pendingTask.id ? failedTask : task)));
      setActiveTaskId(failedTask.id);
      setMessage(failedTask.message);
    } finally {
      setRunning(false);
    }
  }

  function buildTaskPayload(confirmed = actionTaskIds.includes(taskType), correlationId?: string): OperationTaskRequest {
    return {
      type: taskType,
      targetMode,
      serverIds: targetMode === 'selected' ? activeSelectedServerIds : [],
      command: taskType === 'sshCommand' ? command.trim() : undefined,
      reason: reason.trim() || `operator requested ${taskType}`,
      confirmed,
      correlationId,
    };
  }

  function validateTask() {
    if (servers.length === 0) {
      return copy.noServers;
    }

    if (targetMode === 'selected' && activeSelectedServerIds.length === 0) {
      return copy.selectAtLeastOne;
    }

    if (taskType !== 'assetSync' && previewCount === 0) {
      return copy.noConnected;
    }

    if (taskType === 'sshCommand' && command.trim().length === 0) {
      return copy.commandRequired;
    }

    return '';
  }

  function toggleServer(serverId: string) {
    setSelectedServerIds((current) => (
      current.includes(serverId)
        ? current.filter((id) => id !== serverId)
        : [...current, serverId]
    ));
  }

  function restorePreflightHistory(entry: PreflightHistoryEntry) {
    setBuilderOpen(true);
    setTaskType(entry.type);
    setTargetMode(entry.targetMode);
    setSelectedServerIds(entry.serverIds);
    setCommand(entry.command || 'hostname && uptime');
    setReason(entry.reason);
    setPreflight(entry.preflight);
    setMessage(preflightStatusText(entry.preflight, preflightCopy));
  }

  return (
    <section className="module-section" aria-labelledby="ops-title">
      <div className="section-header">
        <div>
          <p>{t('ops.eyebrow')}</p>
          <h2 id="ops-title">{t('ops.title')}</h2>
        </div>
        <button type="button" className="tool-button primary" onClick={() => setBuilderOpen(true)}>
          <PlayCircle size={16} />
          {t('ops.newTask')}
        </button>
      </div>

      <div className="ops-summary-grid">
        <article>
          <span><Server size={16} /> {copy.assets}</span>
          <strong>{servers.length}</strong>
          <small>{copy.activeServers}: {connectedServers.length}</small>
        </article>
        <article>
          <span><Terminal size={16} /> {copy.sshReady}</span>
          <strong>{connectedServers.length}</strong>
          <small>{connectedServers.length > 0 ? connectedServers[0].name : copy.noConnected}</small>
        </article>
        <article>
          <span><AlertTriangle size={16} /> {copy.warning}</span>
          <strong>{warningServers.length}</strong>
          <small>{t('ops.healthDesc', { count: warningServers.length })}</small>
        </article>
        <article>
          <span><ClipboardList size={16} /> {copy.executed}</span>
          <strong>{tasks.length}</strong>
          <small>{activeTask ? statusText(activeTask.status, copy) : copy.noTasks}</small>
        </article>
      </div>

      <div className="ops-layout">
        <div className="workflow-panel ops-runner">
          <h3><Workflow size={18} /> {copy.dashboard}</h3>

          {builderOpen && (
            <div
              className={operationsReleaseFocusActive ? 'ops-builder release-focus-anchor active' : 'ops-builder'}
              data-release-focus-anchor="operations-builder"
              tabIndex={-1}
            >
              {draftNotice && (
                <div className="ops-draft-banner" data-ops-draft-banner="true">
                  <div>
                    <span><Workflow size={16} /> {copy.draftApplied}</span>
                    <strong>{draftNotice.title}</strong>
                    <p>{draftNotice.description}</p>
                    <small>{copy.draftHint}</small>
                  </div>
                  <button type="button" className="icon-button" aria-label={copy.dismissDraft} title={copy.dismissDraft} onClick={() => setDraftNotice(null)}>
                    <XCircle size={16} />
                  </button>
                </div>
              )}

              <div className="ops-type-grid" role="group" aria-label={t('ops.workflow')}>
                {taskIds.map((id) => {
                  const meta = taskMeta[id];
                  const Icon = meta.icon;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={taskType === id ? 'ops-type-card active' : 'ops-type-card'}
                      onClick={() => setTaskType(id)}
                    >
                      <Icon size={17} />
                      <strong>{meta.label}</strong>
                      <span>{meta.description}</span>
                    </button>
                  );
                })}
              </div>

              <div className="ops-form-grid">
                <label className="field-block">
                  {copy.targetScope}
                  <select value={targetMode} onChange={(event) => setTargetMode(event.target.value as OperationTaskTargetMode)}>
                    <option value="allConnected">{copy.allConnected}</option>
                    <option value="selected">{copy.selected}</option>
                    <option value="allServers" disabled={sshRequiredTask}>{copy.allServers}</option>
                  </select>
                </label>

                {actionTaskIds.includes(taskType) && (
                  <label className="field-block">
                    {copy.reason}
                    <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={copy.reasonPlaceholder} />
                  </label>
                )}

                {taskType === 'sshCommand' && (
                  <label className="field-block ops-command-field">
                    {copy.command}
                    <textarea value={command} onChange={(event) => setCommand(event.target.value)} placeholder={copy.commandPlaceholder} />
                  </label>
                )}
              </div>

              {targetMode === 'selected' && (
                <div className="ops-server-picker">
                  <div className="ops-picker-title">
                    <strong>{copy.selectServers}</strong>
                    <span>{activeSelectedServerIds.length}/{eligibleServers.length}</span>
                  </div>
                  <div className="ops-server-choice-grid">
                    {visibleEligibleServers.map((server) => (
                      <label key={server.id} className={activeSelectedServerIdSet.has(server.id) ? 'ops-server-choice active' : 'ops-server-choice'}>
                        <input
                          type="checkbox"
                          checked={activeSelectedServerIdSet.has(server.id)}
                          onChange={() => toggleServer(server.id)}
                        />
                        <span>
                          <strong>{server.name}</strong>
                          <small>{providerName(server.provider)} / {regionName(server.region)}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                  {hiddenServerChoiceCount > 0 && (
                    <div className="server-render-window ops-server-choice-window" aria-live="polite">
                      <span>
                        {interpolateCopy(copy.choiceWindow, {
                          shown: visibleEligibleServers.length,
                          total: eligibleServers.length,
                        })}
                      </span>
                      <button
                        type="button"
                        className="tool-button"
                        onClick={() => setVisibleServerChoiceLimit((current) => Math.min(
                          eligibleServers.length,
                          current + opsServerChoiceBatchStep,
                        ))}
                      >
                        <Plus size={16} />
                        {interpolateCopy(copy.loadMoreTargets, {
                          count: Math.min(opsServerChoiceBatchStep, hiddenServerChoiceCount),
                        })}
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className={`ops-draft-risk-card ${draftRiskSummary.tone}`} data-ops-draft-risk-summary="true">
                <div className="ops-draft-risk-heading">
                  <span>{draftRiskSummary.tone === 'ready' ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />} {copy.draftRiskTitle}</span>
                  <strong>{draftRiskSummary.message}</strong>
                </div>
                <div className="ops-draft-risk-grid">
                  <div>
                    <small>{copy.draftRiskTask}</small>
                    <strong>{draftRiskSummary.taskLabel}</strong>
                  </div>
                  <div>
                    <small>{copy.draftRiskTargetMode}</small>
                    <strong>{draftRiskSummary.targetModeLabel}</strong>
                  </div>
                  <div>
                    <small>{copy.draftRiskTargets}</small>
                    <strong>{previewCount}</strong>
                  </div>
                  <div>
                    <small>{copy.draftRiskCommand}</small>
                    <strong>{draftRiskSummary.commandLabel}</strong>
                  </div>
                </div>
              </div>

                <div className="ops-runner-footer">
                  <div>
                    <span>{copy.preview}</span>
                    <strong>{previewCount} {t('common.servers')}</strong>
                    <small>{copy.preflightOnlyHint}</small>
                  </div>
                  <button
                    type="button"
                    className="tool-button"
                    data-ops-draft-preflight-button="true"
                    disabled={running || preflighting || previewCount === 0}
                    onClick={executePreflightOnly}
                  >
                    <ShieldCheck size={16} />
                    {preflighting ? preflightCopy.title : copy.runPreflight}
                  </button>
                  <button type="button" className="tool-button primary" disabled={running || preflighting || previewCount === 0} onClick={runTask}>
                    <PlayCircle size={16} />
                    {running ? copy.runningTask : preflighting ? preflightCopy.title : copy.run}
                </button>
              </div>

              <div className={preflight ? `ops-preflight-card ${preflightTone(preflight)}` : 'ops-preflight-card'}>
                <span><ShieldCheck size={15} /> {preflightCopy.title}</span>
                <strong>{preflight ? preflightStatusText(preflight, preflightCopy) : preflightCopy.unavailable}</strong>
                <small>
                  {preflight
                    ? formatPreflightSummaryLine(preflight, preflightCopy, copy.preview, previewCount)
                    : preflightCopy.unavailable}
                </small>
                {preflight && preflight.issues.length > 0 && (
                  <ul>
                    {preflight.issues.map((issue) => (
                      <li key={`${issue.code}-${issue.severity}`}>{issue.message}</li>
                    ))}
                  </ul>
                )}
                {preflight && (
                  <div className="ops-preflight-plan" aria-label={preflightCopy.planTitle}>
                    <span>{preflightCopy.planTitle}</span>
                    <strong>{preflight.plan.title}</strong>
                    <p>{formatPreflightPlanTargetSummary(preflight, previewCount)} / {preflight.plan.riskSummary}</p>
                    <p>{preflight.plan.impact}</p>
                    {preflight.plan.commandPreview && (
                      <code>{preflightCopy.commandPreview}: {preflight.plan.commandPreview}</code>
                    )}
                  </div>
                )}
                {preflight && preflight.targets.length > 0 && (
                  <div className="ops-preflight-targets" aria-label={preflightCopy.detailTitle}>
                    <span>{preflightCopy.detailTitle}</span>
                    {preflight.targets.slice(0, 8).map((target) => (
                      <div key={target.id} className={target.runnable ? 'ops-preflight-target runnable' : 'ops-preflight-target blocked'}>
                        <div>
                          <strong>{target.name}</strong>
                          <small>{providerName(target.provider)} / {regionName(target.region)} / {statusLabel(target.status, language)}</small>
                        </div>
                        <em>{target.runnable ? preflightCopy.runnable : preflightCopy.blockedTarget}</em>
                        {target.issues.length > 0 && (
                          <p>{target.issues.map((issue) => issue.message).join(' / ')}</p>
                        )}
                      </div>
                    ))}
                    {preflight.targetsTruncated && (
                      <div className="ops-preflight-truncated">
                        {formatPreflightTruncation(preflight, language)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {!builderOpen && (
            <ol className="workflow-list ops-workflow-list">
              <li>
                <span><CheckCircle2 size={16} /></span>
                <div>
                  <strong>{t('ops.collectTitle')}</strong>
                  <p>{t('ops.collectDesc')}</p>
                </div>
              </li>
              <li>
                <span><Clock3 size={16} /></span>
                <div>
                  <strong>{t('ops.healthTitle')}</strong>
                  <p>{t('ops.healthDesc', { count: warningServers.length })}</p>
                </div>
              </li>
              <li>
                <span><PlayCircle size={16} /></span>
                <div>
                  <strong>{t('ops.repairTitle')}</strong>
                  <p>{t('ops.repairDesc')}</p>
                </div>
              </li>
            </ol>
          )}

          {message && <div className={message.includes('failed') || message.includes('失败') ? 'error-box' : 'validation-box'}>{message}</div>}

          <div className="ops-load-list">
            <div className="ops-panel-title">
              <strong>{copy.serverLoad}</strong>
              <span>{servers.length}</span>
            </div>
            {servers.slice(0, 5).map((server) => (
              <div key={server.id} className="ops-load-row">
                <span>{server.name}</span>
                <div className="load-meter" aria-hidden="true">
                  <span className={percentClass(Math.max(server.cpu, server.memory, server.disk))} style={{ width: `${Math.max(server.cpu, server.memory, server.disk)}%` }} />
                </div>
                <b>{Math.max(server.cpu, server.memory, server.disk)}%</b>
              </div>
            ))}
            {servers.length === 0 && <div className="quiet-state">{copy.noServers}</div>}
          </div>
        </div>

        <div className="event-panel ops-queue-panel">
          <div className="ops-panel-title">
            <h3>{copy.queue}</h3>
            <span>{tasks.length}</span>
          </div>
          <div className="ops-task-list">
            {tasks.length === 0 ? (
              <div className="quiet-state">{copy.noTasks}</div>
            ) : (
              tasks.map((task) => {
                const meta = taskMeta[task.type];
                const Icon = meta.icon;
                return (
                  <button
                    key={task.id}
                    type="button"
                    className={activeTask?.id === task.id ? `ops-task-item active ${task.status}` : `ops-task-item ${task.status}`}
                    onClick={() => setActiveTaskId(task.id)}
                  >
                    <Icon size={17} />
                    <span>
                      <strong>{meta.label}</strong>
                      <small>{formatTaskTime(task.startedAt, language)} / {targetSummary(task, copy)} / {shortTraceId(task.correlationId)}</small>
                    </span>
                    <b>{statusText(task.status, copy)}</b>
                  </button>
                );
              })
            )}
          </div>

          <div className="ops-preflight-history" data-ops-preflight-history="true">
            <div className="ops-panel-title">
              <h3>{copy.preflightHistory}</h3>
              <span>{preflightHistory.length}</span>
            </div>
            <div className="ops-preflight-history-list">
              {preflightHistory.length === 0 ? (
                <div className="quiet-state">{copy.noPreflightHistory}</div>
              ) : (
                preflightHistory.map((entry, index) => {
                  const meta = taskMeta[entry.type];
                  const Icon = meta.icon;
                  return (
                    <div
                      key={entry.id}
                      className={`ops-preflight-history-item ${preflightTone(entry.preflight)}`}
                      title={copy.restorePreflight}
                      role="button"
                      tabIndex={0}
                      data-ops-preflight-history-item="true"
                      onClick={() => restorePreflightHistory(entry)}
                      onKeyDown={(event) => {
                        if (event.currentTarget !== event.target) {
                          return;
                        }
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          restorePreflightHistory(entry);
                        }
                      }}
                    >
                      <Icon size={16} />
                      <span>
                        <strong>
                          {meta.label}
                          {index === 0 && <em>{copy.latestPreflight}</em>}
                        </strong>
                        <small>
                          {formatTaskTime(entry.createdAt, language)} / {formatPreflightSummaryLine(entry.preflight, preflightCopy, copy.preview, entry.targetCount)}
                        </small>
                      </span>
                      <div className="ops-preflight-history-actions">
                        <b>{preflightStatusText(entry.preflight, preflightCopy)}</b>
                        <button
                          type="button"
                          className="ops-preflight-evidence-button"
                          data-ops-preflight-evidence-button="true"
                          onClick={(event) => {
                            event.stopPropagation();
                            onAuditTraceOpen?.(entry.id);
                          }}
                        >
                          <ShieldCheck size={13} />
                          {copy.viewPreflightEvidence}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="ops-mini-events">
            <div className="ops-panel-title">
              <h3>{t('ops.eventQueue')}</h3>
              <span>{events.length}</span>
            </div>
            <div className="event-list">
              {events.length === 0 ? (
                <div className="quiet-state">{copy.eventEmpty}</div>
              ) : (
                events.slice(0, 5).map((event) => (
                  <article className={`event-item ${event.severity}`} key={event.id}>
                    <span>{event.time}</span>
                    <div>
                      <strong>{event.title}</strong>
                      <p>{event.source} / {statusLabel(event.status, language)}</p>
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="ops-result-panel">
        <div className="ops-panel-title">
          <h3>{copy.result}</h3>
          {activeTask && (
            <div className="ops-result-actions">
              <span>{activeTask.summary.success} {copy.success} / {activeTask.summary.failed} {copy.failed} / {activeTask.summary.skipped} {copy.skipped}</span>
              {canOpenActiveTaskTrace && (
                <button type="button" className="inline-trace-button" onClick={() => onAuditTraceOpen?.(activeTask.correlationId)}>
                  <ShieldCheck size={14} />
                  {copy.viewTrace}
                </button>
              )}
            </div>
          )}
        </div>
        {!activeTask ? (
          <div className="quiet-state">{copy.noResult}</div>
        ) : (
          <div className="ops-output-grid">
            {activeTask.outputsTruncated && (
              <div className="ops-output-truncated">
                {formatTruncatedOutputs(activeTask, language, copy)}
              </div>
            )}
            {activeTask.outputs.length === 0 ? (
              <div className="quiet-state">{activeTask.message}</div>
            ) : (
              activeTask.outputs.map((output) => (
                <article key={`${activeTask.id}-${output.serverId}`} className={`ops-output-card ${output.status}`}>
                  <div>
                    <span className={`ops-status ${output.status}`}>
                      {output.status === 'success' ? <CheckCircle2 size={14} /> : output.status === 'skipped' ? <Clock3 size={14} /> : <XCircle size={14} />}
                      {output.status === 'success' ? copy.success : output.status === 'skipped' ? copy.skipped : copy.failed}
                    </span>
                    <strong>{output.serverName}</strong>
                    <small>{copy.target}: {output.serverId}</small>
                  </div>
                  {output.command && <code>{output.command}</code>}
                  <pre>{output.output || output.error || copy.noResult}</pre>
                </article>
              ))
            )}
          </div>
        )}
      </div>
    </section>
  );
}


type DraftRiskTone = 'ready' | 'warn' | 'blocked';

interface DraftRiskSummary {
  tone: DraftRiskTone;
  message: string;
  commandLabel: string;
  taskLabel: string;
  targetModeLabel: string;
}

function buildDraftRiskSummary({
  command,
  copy,
  previewCount,
  targetModeLabel,
  taskLabel,
  taskType,
}: {
  command: string;
  copy: Copy;
  previewCount: number;
  targetModeLabel: string;
  taskLabel: string;
  taskType: OperationTaskType;
}): DraftRiskSummary {
  const commandText = command.trim();
  const commandWarning = taskType === 'sshCommand' ? getSshCommandConfirmationReason(commandText) : '';
  const highImpactAction = taskType === 'shutdown' || taskType === 'reboot';
  const tone: DraftRiskTone = previewCount === 0 ? 'blocked' : commandWarning || highImpactAction ? 'warn' : 'ready';
  const message = tone === 'blocked'
    ? copy.draftRiskBlocked
    : interpolateCopy(tone === 'warn' ? copy.draftRiskWarn : copy.draftRiskReady, { count: previewCount });
  const commandLabel = taskType === 'sshCommand'
    ? commandText.length === 0
      ? copy.draftRiskCommandMissing
      : commandWarning
        ? copy.draftRiskCommandWarn
        : copy.draftRiskCommandSafe
    : actionTaskIds.includes(taskType)
      ? copy.draftRiskActionConfirm
      : copy.draftRiskNoCommand;

  return {
    tone,
    message,
    commandLabel,
    taskLabel,
    targetModeLabel,
  };
}

function buildTaskMeta(language: string): Record<OperationTaskType, TaskMeta> {
  const zh: Record<OperationTaskType, TaskMeta> = {
    assetSync: { id: 'assetSync', label: '资产巡检', description: '汇总服务器资产、地域、SSH 和资源状态', icon: Activity },
    healthCheck: { id: 'healthCheck', label: '健康检查', description: '调用诊断接口读取主机、负载和磁盘信息', icon: CheckCircle2 },
    sshCommand: { id: 'sshCommand', label: '执行命令', description: '对目标服务器批量执行自定义 SSH 命令', icon: Terminal },
    powerOn: { id: 'powerOn', label: '服务器开机', description: '通过 SSH 检测可达性并执行开机确认命令', icon: Power },
    shutdown: { id: 'shutdown', label: '服务器关机', description: '执行关机命令，适合维护窗口使用', icon: PowerOff },
    reboot: { id: 'reboot', label: '服务器重启', description: '执行重启命令并记录审计', icon: RotateCcw },
  };
  const en: Record<OperationTaskType, TaskMeta> = {
    assetSync: { id: 'assetSync', label: 'Asset sweep', description: 'Summarize server asset, region, SSH, and resource state.', icon: Activity },
    healthCheck: { id: 'healthCheck', label: 'Health check', description: 'Run diagnostics for host, load, and disk output.', icon: CheckCircle2 },
    sshCommand: { id: 'sshCommand', label: 'Run command', description: 'Run a custom SSH command on target servers.', icon: Terminal },
    powerOn: { id: 'powerOn', label: 'Power on', description: 'Verify SSH reachability with the power-on command.', icon: Power },
    shutdown: { id: 'shutdown', label: 'Shutdown', description: 'Run shutdown during a maintenance window.', icon: PowerOff },
    reboot: { id: 'reboot', label: 'Reboot', description: 'Run reboot and record audit evidence.', icon: RotateCcw },
  };
  const ja: Record<OperationTaskType, TaskMeta> = {
    assetSync: { id: 'assetSync', label: '資産巡回', description: 'サーバー資産、リージョン、SSH、リソース状態を集計します。', icon: Activity },
    healthCheck: { id: 'healthCheck', label: 'ヘルスチェック', description: 'ホスト、負荷、ディスクの診断を実行します。', icon: CheckCircle2 },
    sshCommand: { id: 'sshCommand', label: 'コマンド実行', description: '対象サーバーで SSH コマンドを実行します。', icon: Terminal },
    powerOn: { id: 'powerOn', label: '起動', description: 'SSH 到達性を確認して起動コマンドを実行します。', icon: Power },
    shutdown: { id: 'shutdown', label: '停止', description: 'メンテナンス時間帯に停止コマンドを実行します。', icon: PowerOff },
    reboot: { id: 'reboot', label: '再起動', description: '再起動を実行し監査に記録します。', icon: RotateCcw },
  };

  return language === 'en' ? en : language === 'ja' ? ja : zh;
}

function formatProviderName(provider: string, t: (key: string, vars?: Record<string, string | number>) => string) {
  return provider.trim().toLowerCase() === 'custom' ? t('servers.providerCustomDisplay') : provider;
}

function buildOperationServerGroups(servers: ServerNode[]) {
  const connectedServers: ServerNode[] = [];
  const warningServers: ServerNode[] = [];
  for (const server of servers) {
    if (server.ssh?.connected) {
      connectedServers.push(server);
    }
    if (server.status === 'warning' || server.cpu > 80 || server.disk > 85) {
      warningServers.push(server);
    }
  }
  return { connectedServers, warningServers };
}

function resolvePreviewCount(targetMode: OperationTaskTargetMode, eligibleServerCount: number, selectedServerCount: number) {
  if (targetMode === 'selected') {
    return selectedServerCount;
  }

  return eligibleServerCount;
}

function createPendingTask(
  type: OperationTaskType,
  targetMode: OperationTaskTargetMode,
  total: number,
  language: string,
): OperationTaskResponse {
  const now = new Date().toISOString();
  const copy = copyByLanguage[language] ?? copyByLanguage.zh;
  return {
    id: `pending-${Date.now()}`,
    correlationId: `srv-trace-00000000-0000-4000-8000-${String(Date.now()).padStart(12, '0').slice(-12)}`,
    type,
    targetMode,
    status: 'running',
    startedAt: now,
    finishedAt: now,
    summary: {
      total,
      success: 0,
      failed: 0,
      skipped: 0,
    },
    outputs: [],
    message: copy.runningTask,
  };
}

function createPreflightHistoryEntry(
  preflight: OperationTaskPreflightResponse,
  form: {
    type: OperationTaskType;
    targetMode: OperationTaskTargetMode;
    serverIds: string[];
    command: string;
    reason: string;
    targetCount: number;
  },
): PreflightHistoryEntry {
  return {
    id: preflight.correlationId,
    type: form.type,
    targetMode: form.targetMode,
    serverIds: [...form.serverIds],
    command: form.command,
    reason: form.reason,
    targetCount: form.targetCount,
    createdAt: preflight.generatedAt,
    preflight,
  };
}

function createFailedTask(pendingTask: OperationTaskResponse, error: string): OperationTaskResponse {
  const now = new Date().toISOString();
  return {
    ...pendingTask,
    status: 'failed',
    finishedAt: now,
    summary: {
      total: pendingTask.summary.total,
      success: 0,
      failed: pendingTask.summary.total || 1,
      skipped: 0,
    },
    outputs: [{
      serverId: 'operation-task',
      serverName: pendingTask.type,
      status: 'failed',
      output: '',
      error,
      startedAt: pendingTask.startedAt,
      finishedAt: now,
    }],
    message: error,
  };
}

function statusText(status: OperationTaskStatus, copy: Copy) {
  return {
    queued: copy.queued,
    running: copy.running,
    completed: copy.completed,
    partial: copy.partial,
    failed: copy.failed,
  }[status];
}

function targetSummary(task: OperationTaskResponse, copy: Copy) {
  return `${copy.target} ${task.summary.total}`;
}

function formatTruncatedOutputs(task: OperationTaskResponse, language: string, copy: Copy) {
  const omitted = task.omittedOutputs ?? Math.max(task.summary.total - task.outputs.length, 0);
  const template = copy.truncatedOutputs
    ?? (language === 'zh'
      ? '已显示前 {shown} 条结果，另有 {omitted} 条仅计入汇总与审计链，避免大批量任务卡顿。'
      : language === 'ja'
        ? '先頭 {shown} 件のみ表示しています。残り {omitted} 件は集計と監査 trace に反映されています。'
        : 'Showing the first {shown} results. Another {omitted} are counted in the summary and audit trace to keep bulk tasks responsive.');

  return interpolateCopy(template, {
    shown: task.outputs.length,
    omitted,
  });
}

function formatPreflightTruncation(preflight: OperationTaskPreflightResponse, language: string) {
  const omitted = preflight.omittedTargets ?? Math.max(preflight.summary.totalTargets - preflight.targets.length, 0);
  const shown = Math.min(preflight.targets.length, 8);

  if (language === 'zh') {
    return `预检明细只展示前 ${shown} 台，另有 ${omitted} 台已计入上方汇总。`;
  }

  if (language === 'ja') {
    return `事前確認の詳細は先頭 ${shown} 台のみ表示しています。残り ${omitted} 台は上の集計に反映されています。`;
  }

  return `Showing the first ${shown} preflight targets. Another ${omitted} are counted in the summary above.`;
}

function formatTaskTime(value: string, language: string) {
  const locale = language === 'en' ? 'en-US' : language === 'ja' ? 'ja-JP' : 'zh-CN';
  return new Date(value).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function shortTraceId(value: string) {
  return value.replace(/^(ops|srv)-trace-/, '').slice(0, 8);
}

function buildOperationConfirmMessage(type: OperationTaskType, count: number, name: string, copy: Copy) {
  if (type === 'shutdown' || type === 'reboot') {
    return interpolateCopy(copy.confirmDanger, { count, name });
  }

  if (type === 'powerOn') {
    return interpolateCopy(copy.confirmPower, { count, name });
  }

  return `${copy.confirm}\n${copy.preview}: ${count}`;
}

function preflightStatusText(
  preflight: OperationTaskPreflightResponse,
  copy: (typeof preflightCopyByLanguage)[string],
) {
  if (!preflight.ok) {
    return copy.blocked;
  }
  if (preflight.issues.some((issue) => issue.severity === 'warn')) {
    return copy.warn;
  }
  return copy.ready;
}

function formatPreflightSummaryLine(
  preflight: OperationTaskPreflightResponse,
  copy: (typeof preflightCopyByLanguage)[string],
  nonSshTargetLabel: string,
  fallbackTargetCount = 0,
) {
  const totalTargets = resolveDisplayedPreflightTargetCount(preflight, fallbackTargetCount);
  if (!preflight.requiresSsh) {
    return `${nonSshTargetLabel}: ${totalTargets} / ${copy.issues}: ${preflight.issues.length}`;
  }

  return `${copy.targets}: ${totalTargets}/${preflight.summary.runnableTargets} / ${copy.issues}: ${preflight.issues.length}`;
}

function formatPreflightPlanTargetSummary(preflight: OperationTaskPreflightResponse, fallbackTargetCount = 0) {
  if (preflight.requiresSsh) {
    return preflight.plan.targetSummary;
  }

  const totalTargets = resolveDisplayedPreflightTargetCount(preflight, fallbackTargetCount);
  return `${totalTargets} target${totalTargets === 1 ? '' : 's'} included`;
}

function resolveDisplayedPreflightTargetCount(preflight: OperationTaskPreflightResponse, fallbackTargetCount = 0) {
  return !preflight.requiresSsh && preflight.summary.totalTargets === 0 && fallbackTargetCount > 0
    ? fallbackTargetCount
    : preflight.summary.totalTargets;
}

function preflightTone(preflight: OperationTaskPreflightResponse) {
  if (!preflight.ok) {
    return 'blocked';
  }
  if (preflight.issues.some((issue) => issue.severity === 'warn')) {
    return 'warn';
  }
  return 'ready';
}

function interpolateCopy(template: string, vars: Record<string, string | number>) {
  return Object.entries(vars).reduce(
    (current, [key, value]) => current.replaceAll(`{${key}}`, String(value)),
    template,
  );
}
