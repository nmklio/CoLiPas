import { memo, useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  Plus,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  createMaintenanceWindow,
  deleteMaintenanceWindow,
  fetchMaintenanceWindows,
  type MaintenanceWindowPayload,
} from '../../services/apiClient';
import type { MaintenanceWindow, MaintenanceWindowPhase, MaintenanceWindowScope, ServerNode } from '../../types';
import { formatRegionName } from '../../utils/format';

interface MaintenanceWindowPanelProps {
  servers: ServerNode[];
}

type Copy = {
  title: string;
  description: string;
  schedule: string;
  cancel: string;
  create: string;
  creating: string;
  titleLabel: string;
  titlePlaceholder: string;
  titleRequired: string;
  invalidTime: string;
  noteLabel: string;
  notePlaceholder: string;
  scopeLabel: string;
  all: string;
  allConnected: string;
  selected: string;
  startsAt: string;
  endsAt: string;
  selectServers: string;
  searchServers: string;
  loadMore: string;
  noMatches: string;
  emptyTitle: string;
  noWindows: string;
  active: string;
  upcoming: string;
  ended: string;
  protected: string;
  exposed: string;
  activeSummary: string;
  upcomingSummary: string;
  endedSummary: string;
  delete: string;
  selectedSummary: string;
  formHint: string;
  durationLabel: string;
  durationHint: string;
  activeBadge: string;
  upcomingBadge: string;
  emptyBadge: string;
};

const maintenanceCopyByLanguage: Record<string, Copy> = {
  zh: {
    title: '维护窗口',
    description: '为重启、关机和高影响 SSH 命令登记可审查的时间范围；未覆盖目标会在预检中提示，原有人工确认不变。',
    schedule: '安排窗口',
    cancel: '取消',
    create: '创建窗口',
    creating: '正在创建…',
    titleLabel: '窗口名称',
    titlePlaceholder: '例如：周日内核升级',
    titleRequired: '请填写维护窗口名称',
    invalidTime: '请填写有效的开始和结束时间',
    noteLabel: '执行说明（可选）',
    notePlaceholder: '记录变更单、负责人或回滚方向',
    scopeLabel: '覆盖范围',
    all: '全部服务器资产',
    allConnected: '全部已接入 SSH',
    selected: '指定服务器',
    startsAt: '开始时间',
    endsAt: '结束时间',
    selectServers: '选择服务器',
    searchServers: '按名称、厂商或地域筛选',
    loadMore: '加载更多',
    noMatches: '没有匹配的服务器',
    emptyTitle: '暂时没有维护窗口',
    noWindows: '先安排一个窗口，再执行高影响操作时可在预检中看到覆盖状态。',
    active: '进行中',
    upcoming: '即将开始',
    ended: '已结束',
    protected: '当前受保护',
    exposed: '尚无活动窗口',
    activeSummary: '个活动窗口正在为高影响操作提供预检覆盖。',
    upcomingSummary: '下一个窗口已安排，执行前会自动切换为活动状态。',
    endedSummary: '历史窗口保留在本地，可按需删除。',
    delete: '删除',
    selectedSummary: '已选择 {count} 台服务器',
    formHint: '窗口至少 5 分钟、最长 7 天；仅保存标题、说明、范围和时间，不保存 SSH 凭据或命令。',
    durationLabel: '预设时长',
    durationHint: '以当前开始时间自动计算结束时间',
    activeBadge: '{count} 个活动窗口',
    upcomingBadge: '{count} 个待开始窗口',
    emptyBadge: '暂无活动窗口',
  },
  en: {
    title: 'Maintenance windows',
    description: 'Record an auditable window for reboots, shutdowns, and high-impact SSH commands. Uncovered targets stay visible in preflight; operator confirmation is unchanged.',
    schedule: 'Schedule window',
    cancel: 'Cancel',
    create: 'Create window',
    creating: 'Creating…',
    titleLabel: 'Window name',
    titlePlaceholder: 'Example: Sunday kernel upgrade',
    titleRequired: 'Enter a maintenance window name',
    invalidTime: 'Enter a valid start and end time',
    noteLabel: 'Execution note (optional)',
    notePlaceholder: 'Change reference, owner, or rollback direction',
    scopeLabel: 'Coverage',
    all: 'All server assets',
    allConnected: 'All SSH-connected',
    selected: 'Selected servers',
    startsAt: 'Starts',
    endsAt: 'Ends',
    selectServers: 'Select servers',
    searchServers: 'Filter by name, provider, or region',
    loadMore: 'Load more',
    noMatches: 'No matching servers',
    emptyTitle: 'No maintenance windows yet',
    noWindows: 'Schedule a window to make high-impact preflight coverage visible before execution.',
    active: 'Active',
    upcoming: 'Upcoming',
    ended: 'Ended',
    protected: 'Protection active',
    exposed: 'No active window',
    activeSummary: 'active window(s) currently provide high-impact preflight coverage.',
    upcomingSummary: 'The next window is scheduled and becomes active automatically.',
    endedSummary: 'Historical windows stay local and can be removed when no longer needed.',
    delete: 'Delete',
    selectedSummary: '{count} server(s) selected',
    formHint: 'Windows run from 5 minutes to 7 days. Only title, note, scope, and time are stored—never SSH credentials or commands.',
    durationLabel: 'Quick duration',
    durationHint: 'Updates the end time from the selected start',
    activeBadge: '{count} active window(s)',
    upcomingBadge: '{count} upcoming window(s)',
    emptyBadge: 'No active window',
  },
  ja: {
    title: 'メンテナンス時間枠',
    description: '再起動、停止、高影響 SSH コマンドのために監査可能な時間枠を記録します。未カバーの対象は事前確認で表示され、操作者の確認手順は変わりません。',
    schedule: '時間枠を追加',
    cancel: 'キャンセル',
    create: '時間枠を作成',
    creating: '作成中…',
    titleLabel: '時間枠の名前',
    titlePlaceholder: '例：日曜のカーネル更新',
    titleRequired: 'メンテナンス時間枠の名前を入力してください',
    invalidTime: '有効な開始時刻と終了時刻を入力してください',
    noteLabel: '実施メモ（任意）',
    notePlaceholder: '変更番号、担当者、ロールバック方針',
    scopeLabel: '適用範囲',
    all: 'すべてのサーバー資産',
    allConnected: 'SSH 接続済みすべて',
    selected: '指定サーバー',
    startsAt: '開始時刻',
    endsAt: '終了時刻',
    selectServers: 'サーバーを選択',
    searchServers: '名前、プロバイダー、リージョンで絞り込み',
    loadMore: 'さらに表示',
    noMatches: '一致するサーバーはありません',
    emptyTitle: 'メンテナンス時間枠はまだありません',
    noWindows: '時間枠を追加すると、高影響操作の事前確認でカバー状況を確認できます。',
    active: '実施中',
    upcoming: '予定',
    ended: '終了',
    protected: '保護中',
    exposed: '有効な時間枠なし',
    activeSummary: '件の有効な時間枠が高影響操作の事前確認をカバーしています。',
    upcomingSummary: '次の時間枠は設定済みで、開始時刻に自動で有効になります。',
    endedSummary: '履歴はローカルに残り、不要になれば削除できます。',
    delete: '削除',
    selectedSummary: '{count} 台のサーバーを選択',
    formHint: '時間枠は 5 分以上 7 日以内です。保存されるのは名前、メモ、範囲、時刻だけで、SSH 認証情報やコマンドは保存されません。',
    durationLabel: '時間プリセット',
    durationHint: '開始時刻を基準に終了時刻を更新します',
    activeBadge: '有効な時間枠 {count} 件',
    upcomingBadge: '開始待ちの時間枠 {count} 件',
    emptyBadge: '有効な時間枠はありません',
  },
};

const initialVisibleServerLimit = 24;
const visibleServerStep = 24;
const durationPresets = [30, 60, 120, 240] as const;

export const MaintenanceWindowPanel = memo(function MaintenanceWindowPanel({ servers }: MaintenanceWindowPanelProps) {
  const { language } = useI18n();
  const copy = maintenanceCopyByLanguage[language] ?? maintenanceCopyByLanguage.zh;
  const [windows, setWindows] = useState<MaintenanceWindow[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [scope, setScope] = useState<MaintenanceWindowScope>('allConnected');
  const [startsAt, setStartsAt] = useState(() => toDateTimeInputValue(Date.now()));
  const [endsAt, setEndsAt] = useState(() => toDateTimeInputValue(Date.now() + 60 * 60_000));
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [visibleServerLimit, setVisibleServerLimit] = useState(initialVisibleServerLimit);
  const deferredSearch = useDeferredValue(search);
  const availableServerIds = useMemo(() => new Set(servers.map((server) => server.id)), [servers]);

  useEffect(() => {
    let active = true;
    void fetchMaintenanceWindows()
      .then((result) => {
        if (active) {
          setWindows(result.items);
        }
      })
      .catch((error) => {
        if (active) {
          setMessage(error instanceof Error ? error.message : 'Unable to load maintenance windows');
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setSelectedServerIds((current) => current.filter((id) => availableServerIds.has(id)));
  }, [availableServerIds]);

  useEffect(() => {
    setVisibleServerLimit(initialVisibleServerLimit);
  }, [scope, search]);

  const activeWindows = useMemo(() => windows.filter((window) => window.phase === 'active'), [windows]);
  const upcomingWindows = useMemo(() => windows.filter((window) => window.phase === 'upcoming'), [windows]);
  const endedWindows = useMemo(() => windows.filter((window) => window.phase === 'ended'), [windows]);
  const matchingCandidates = useMemo(() => {
    const normalizedSearch = deferredSearch.trim().toLowerCase();
    return normalizedSearch.length === 0
      ? servers
      : servers.filter((server) => `${server.name} ${server.provider} ${server.region}`.toLowerCase().includes(normalizedSearch));
  }, [deferredSearch, servers]);
  const visibleCandidates = useMemo(
    () => matchingCandidates.slice(0, visibleServerLimit),
    [matchingCandidates, visibleServerLimit],
  );
  const matchingCandidateCount = matchingCandidates.length;
  const hiddenCandidateCount = Math.max(matchingCandidateCount - visibleCandidates.length, 0);
  const selectedServerIdSet = useMemo(() => new Set(selectedServerIds), [selectedServerIds]);
  const phaseSummary = activeWindows.length > 0
    ? `${activeWindows.length} ${copy.activeSummary}`
    : upcomingWindows.length > 0
      ? copy.upcomingSummary
      : endedWindows.length > 0
        ? copy.endedSummary
        : copy.noWindows;
  const railBadge = activeWindows.length > 0
    ? interpolate(copy.activeBadge, { count: activeWindows.length })
    : upcomingWindows.length > 0
      ? interpolate(copy.upcomingBadge, { count: upcomingWindows.length })
      : copy.emptyBadge;

  function resetForm() {
    setTitle('');
    setNote('');
    setScope('allConnected');
    setStartsAt(toDateTimeInputValue(Date.now()));
    setEndsAt(toDateTimeInputValue(Date.now() + 60 * 60_000));
    setSelectedServerIds([]);
    setSearch('');
    setVisibleServerLimit(initialVisibleServerLimit);
  }

  function closeForm() {
    setFormOpen(false);
    setMessage('');
    resetForm();
  }

  function toggleServer(serverId: string) {
    setSelectedServerIds((current) => current.includes(serverId)
      ? current.filter((id) => id !== serverId)
      : [...current, serverId]);
  }

  function applyDuration(durationMinutes: number) {
    const startTimestamp = new Date(startsAt).getTime();
    const normalizedStart = Number.isFinite(startTimestamp) ? startTimestamp : Date.now();
    setStartsAt(toDateTimeInputValue(normalizedStart));
    setEndsAt(toDateTimeInputValue(normalizedStart + durationMinutes * 60_000));
  }

  async function submitWindow() {
    if (!title.trim()) {
      setMessage(copy.titleRequired);
      return;
    }

    const startTimestamp = new Date(startsAt).getTime();
    const endTimestamp = new Date(endsAt).getTime();
    if (!Number.isFinite(startTimestamp) || !Number.isFinite(endTimestamp)) {
      setMessage(copy.invalidTime);
      return;
    }

    const payload: MaintenanceWindowPayload = {
      title: title.trim(),
      note: note.trim(),
      scope,
      serverIds: scope === 'selected' ? selectedServerIds : [],
      startsAt: new Date(startTimestamp).toISOString(),
      endsAt: new Date(endTimestamp).toISOString(),
    };

    setSaving(true);
    setMessage('');
    try {
      const result = await createMaintenanceWindow(payload);
      setWindows(result.windows);
      closeForm();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to create maintenance window');
    } finally {
      setSaving(false);
    }
  }

  async function removeWindow(windowId: string) {
    setMessage('');
    try {
      const result = await deleteMaintenanceWindow(windowId);
      setWindows(result.windows);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to delete maintenance window');
    }
  }

  return (
    <section className="ops-maintenance-panel" data-ops-maintenance-panel="true" aria-labelledby="ops-maintenance-title">
      <div className="ops-maintenance-heading">
        <div className="ops-maintenance-orbit" aria-hidden="true">
          <CalendarClock size={18} />
        </div>
        <div>
          <span>{copy.protected}</span>
          <h3 id="ops-maintenance-title">{copy.title}</h3>
          <p>{copy.description}</p>
        </div>
        <button
          type="button"
          className="tool-button"
          data-ops-maintenance-open="true"
          onClick={() => {
            setFormOpen(true);
            setMessage('');
          }}
        >
          <Plus size={16} />
          {copy.schedule}
        </button>
      </div>

      <div className={activeWindows.length > 0 ? 'ops-maintenance-rail protected' : 'ops-maintenance-rail'}>
        <span className="ops-maintenance-rail-node">
          {activeWindows.length > 0 ? <CheckCircle2 size={15} /> : <ShieldAlert size={15} />}
        </span>
        <div>
          <strong>{activeWindows.length > 0 ? copy.protected : copy.exposed}</strong>
          <p>{phaseSummary}</p>
        </div>
        <b data-ops-maintenance-status-count="true">{railBadge}</b>
      </div>

      {formOpen && (
        <div className="ops-maintenance-form" data-ops-maintenance-form="true">
          <div className="ops-maintenance-form-grid">
            <label className="field-block">
              {copy.titleLabel}
              <input data-ops-maintenance-title="true" value={title} maxLength={64} placeholder={copy.titlePlaceholder} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="field-block">
              {copy.scopeLabel}
              <select data-ops-maintenance-scope="true" value={scope} onChange={(event) => setScope(event.target.value as MaintenanceWindowScope)}>
                <option value="all">{copy.all}</option>
                <option value="allConnected">{copy.allConnected}</option>
                <option value="selected">{copy.selected}</option>
              </select>
            </label>
            <label className="field-block">
              {copy.startsAt}
              <input data-ops-maintenance-start="true" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
            </label>
            <label className="field-block">
              {copy.endsAt}
              <input data-ops-maintenance-end="true" type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
            </label>
            <div className="ops-maintenance-duration" aria-label={copy.durationLabel}>
              <span>{copy.durationLabel}</span>
              <div>
                {durationPresets.map((durationMinutes) => (
                  <button
                    key={durationMinutes}
                    type="button"
                    data-ops-maintenance-duration={durationMinutes}
                    onClick={() => applyDuration(durationMinutes)}
                  >
                    {formatDurationPreset(durationMinutes, language)}
                  </button>
                ))}
              </div>
              <small>{copy.durationHint}</small>
            </div>
            <label className="field-block ops-maintenance-note">
              {copy.noteLabel}
              <textarea value={note} maxLength={240} placeholder={copy.notePlaceholder} onChange={(event) => setNote(event.target.value)} />
            </label>
          </div>

          {scope === 'selected' && (
            <div className="ops-maintenance-target-picker">
              <div className="ops-picker-title">
                <strong>{copy.selectServers}</strong>
                <span>{interpolate(copy.selectedSummary, { count: selectedServerIds.length })}</span>
              </div>
              <input
                className="ops-maintenance-search"
                data-ops-maintenance-search="true"
                value={search}
                placeholder={copy.searchServers}
                onChange={(event) => setSearch(event.target.value)}
              />
              {visibleCandidates.length === 0 ? (
                <div className="quiet-state">{copy.noMatches}</div>
              ) : (
                <div className="ops-maintenance-target-grid">
                  {visibleCandidates.map((server) => (
                    <label key={server.id} className={selectedServerIdSet.has(server.id) ? 'ops-maintenance-target active' : 'ops-maintenance-target'}>
                      <input
                        type="checkbox"
                        checked={selectedServerIdSet.has(server.id)}
                        onChange={() => toggleServer(server.id)}
                      />
                      <span>
                        <strong>{server.name}</strong>
                        <small>{server.provider} / {formatRegionName(server.region, language)}</small>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {hiddenCandidateCount > 0 && (
                <button
                  type="button"
                  className="ops-maintenance-load-more"
                  onClick={() => setVisibleServerLimit((current) => Math.min(matchingCandidateCount, current + visibleServerStep))}
                >
                  {copy.loadMore} ({Math.min(visibleServerStep, hiddenCandidateCount)})
                </button>
              )}
            </div>
          )}

          <p className="ops-maintenance-form-hint">{copy.formHint}</p>
          <div className="ops-maintenance-form-actions">
            <button type="button" className="tool-button" disabled={saving} onClick={closeForm}>
              <X size={16} />
              {copy.cancel}
            </button>
            <button type="button" className="tool-button primary" data-ops-maintenance-create="true" disabled={saving} onClick={submitWindow}>
              {saving ? <LoaderCircle size={16} className="icon-spin" /> : <CalendarClock size={16} />}
              {saving ? copy.creating : copy.create}
            </button>
          </div>
        </div>
      )}

      {message && <div className="error-box">{message}</div>}

      <div className="ops-maintenance-list">
        {loading ? (
          <div className="quiet-state"><LoaderCircle size={16} className="icon-spin" /> {copy.title}</div>
        ) : windows.length === 0 ? (
          <div className="quiet-state">
            <strong>{copy.emptyTitle}</strong>
            <span>{copy.noWindows}</span>
          </div>
        ) : (
          windows.map((window) => (
            <article key={window.id} className={`ops-maintenance-item ${window.phase}`} data-ops-maintenance-item={window.phase}>
              <span className="ops-maintenance-phase">
                <Clock3 size={14} />
                {phaseLabel(window.phase, copy)}
              </span>
              <div>
                <strong>{window.title}</strong>
                <small>{scopeLabel(window, copy)} · {formatWindowTime(window, language)}</small>
                {window.note && <p>{window.note}</p>}
              </div>
              <button
                type="button"
                className="icon-button"
                title={copy.delete}
                aria-label={copy.delete}
                onClick={() => removeWindow(window.id)}
              >
                <Trash2 size={15} />
              </button>
            </article>
          ))
        )}
      </div>
    </section>
  );
});

function phaseLabel(phase: MaintenanceWindowPhase, copy: Copy) {
  return phase === 'active' ? copy.active : phase === 'upcoming' ? copy.upcoming : copy.ended;
}

function scopeLabel(window: MaintenanceWindow, copy: Copy) {
  if (window.scope === 'all') {
    return copy.all;
  }
  if (window.scope === 'allConnected') {
    return copy.allConnected;
  }
  return interpolate(copy.selectedSummary, { count: window.serverIds.length });
}

function formatWindowTime(window: MaintenanceWindow, language: string) {
  const locale = language === 'en' ? 'en-US' : language === 'ja' ? 'ja-JP' : 'zh-CN';
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  };
  return `${new Intl.DateTimeFormat(locale, options).format(new Date(window.startsAt))} – ${new Intl.DateTimeFormat(locale, options).format(new Date(window.endsAt))}`;
}

function toDateTimeInputValue(timestamp: number) {
  const date = new Date(timestamp);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatDurationPreset(durationMinutes: number, language: string) {
  if (durationMinutes < 60) {
    return language === 'ja' ? `${durationMinutes}分` : `${durationMinutes}m`;
  }
  if (language === 'zh') {
    return `${durationMinutes / 60} 小时`;
  }
  if (language === 'ja') {
    return `${durationMinutes / 60}時間`;
  }
  return `${durationMinutes / 60}h`;
}

function interpolate(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);
}
