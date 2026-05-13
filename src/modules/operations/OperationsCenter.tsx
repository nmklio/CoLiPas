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
import { percentClass, statusLabel } from '../../utils/format';

interface OperationsCenterProps {
  events: OperationEvent[];
  servers: ServerNode[];
  onTaskFinished?: () => Promise<void> | void;
  onAuditTraceOpen?: (correlationId: string) => void;
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
    warning: '要対応',
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
    confirmDanger: '{count} 台のサーバーに実際の{name}コマンドを実行します。続行しますか？',
    confirmPower: '{count} 台のサーバーに{name}を実行します。続行しますか？',
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
    viewTrace: '監査 trace を表示',
    choiceWindow: '候補サーバー {shown} / {total} 台を表示中。追加読み込みしても選択は維持されます。',
    loadMoreTargets: '{count} 台を追加読み込み',
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
    title: '実行前チェック',
    ready: '実行できます',
    blocked: 'チェックでブロックされました',
    warn: '確認後に実行できます',
    targets: '対象 / 実行可能',
    issues: 'リスク項目',
    unavailable: '未チェック',
    runnable: '実行可能',
    blockedTarget: 'ブロック',
    detailTitle: '対象詳細',
    planTitle: '実行計画',
    commandPreview: 'コマンドプレビュー',
  },
};

export function OperationsCenter({ events, servers, onTaskFinished, onAuditTraceOpen }: OperationsCenterProps) {
  const { language, t } = useI18n();
  const copy = copyByLanguage[language] ?? copyByLanguage.zh;
  const preflightCopy = preflightCopyByLanguage[language] ?? preflightCopyByLanguage.zh;
  const providerName = (provider: string) => formatProviderName(provider, t);
  const connectedServers = useMemo(() => servers.filter((server) => server.ssh?.connected), [servers]);
  const warningServers = useMemo(
    () => servers.filter((server) => server.status === 'warning' || server.cpu > 80 || server.disk > 85),
    [servers],
  );
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
  const [tasks, setTasks] = useState<OperationTaskResponse[]>([]);
  const [activeTaskId, setActiveTaskId] = useState('');

  const taskMeta = useMemo(() => buildTaskMeta(language), [language]);
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? tasks[0] ?? null;
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

  useEffect(() => {
    if (sshRequiredTask && targetMode === 'allServers') {
      setTargetMode('allConnected');
    }
  }, [sshRequiredTask, targetMode]);

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

  async function runTask() {
    const validation = validateTask();
    if (validation) {
      setMessage(validation);
      return;
    }

    const preflightPayload = buildTaskPayload(false);
    setPreflighting(true);
    setMessage('');
    let preflightResult: OperationTaskPreflightResponse;
    try {
      preflightResult = await preflightOperationTask(preflightPayload);
      setPreflight(preflightResult);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : preflightCopy.unavailable);
      setPreflighting(false);
      return;
    }
    setPreflighting(false);

    if (!preflightResult.ok) {
      setMessage(preflightResult.issues[0]?.message ?? preflightCopy.blocked);
      return;
    }

    const confirmMessage = buildOperationConfirmMessage(taskType, previewCount, taskMeta[taskType].label, copy);
    if (!window.confirm(confirmMessage)) {
      return;
    }

    const payload = buildTaskPayload(actionTaskIds.includes(taskType), preflightResult.correlationId);
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

  return (
    <section className="module-section" aria-labelledby="ops-title">
      <div className="section-header">
        <div>
          <p>{t('ops.eyebrow')}</p>
          <h2 id="ops-title">{t('ops.title')}</h2>
        </div>
        <button type="button" className="tool-button primary" onClick={() => setBuilderOpen((value) => !value)}>
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
            <div className="ops-builder">
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
                          <small>{providerName(server.provider)} / {server.region}</small>
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

              <div className="ops-runner-footer">
                <div>
                  <span>{copy.preview}</span>
                  <strong>{previewCount} {t('common.servers')}</strong>
                </div>
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
                    ? `${preflightCopy.targets}: ${preflight.summary.totalTargets}/${preflight.summary.runnableTargets} · ${preflightCopy.issues}: ${preflight.issues.length}`
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
                    <p>{preflight.plan.targetSummary} · {preflight.plan.riskSummary}</p>
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
                          <small>{providerName(target.provider)} / {target.region} / {statusLabel(target.status, language)}</small>
                        </div>
                        <em>{target.runnable ? preflightCopy.runnable : preflightCopy.blockedTarget}</em>
                        {target.issues.length > 0 && (
                          <p>{target.issues.map((issue) => issue.message).join(' / ')}</p>
                        )}
                      </div>
                    ))}
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
