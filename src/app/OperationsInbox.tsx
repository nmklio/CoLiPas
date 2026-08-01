import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BellRing,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  Clock3,
  Inbox,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import type { OperationEvent, ResourceAlertEvaluation, ResourceAlertSignal } from '../types';

export type OperationsInboxSection = 'overview' | 'servers' | 'operations' | 'ai' | 'api' | 'security';
export type OperationsInboxTone = 'critical' | 'warning' | 'info';

interface OperationsInboxLaunchStep {
  rank: number;
  priority: string;
  item: {
    id: string;
    title: string;
    detail: string;
    action: string;
    section: OperationsInboxSection;
    tone: 'ok' | 'warn' | 'fail';
  };
}

export interface OperationsInboxItem {
  id: string;
  tone: OperationsInboxTone;
  section: OperationsInboxSection;
  title: string;
  detail: string;
  action: string;
  sourceLabel: string;
  priorityLabel: string;
  occurredAt?: string;
  sortOrder: number;
  reviewTtlMs?: number;
  serverId?: string;
  serverName?: string;
}

export interface OperationsInboxSummary {
  unreadCount: number;
  reviewedCount: number;
  criticalUnreadCount: number;
  tone: 'clear' | 'warning' | 'critical';
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;
type ReviewedAtById = Record<string, number>;

const operationsInboxStorageKey = 'colipas.operationsInbox.review.v1';
const operationsInboxStorageVersion = 1;
const operationsInboxStorageLimit = 120;
const operationsInboxReviewTtlMs = 45 * 24 * 60 * 60 * 1000;
const operationsInboxIdPattern = /^ops-(?:launch-[a-z0-9-]{1,32}|event-[a-z0-9]{8,20}|resource-[a-z0-9]{8,24})$/;
const operationsInboxEventLimit = 24;

export function buildOperationsInboxItems(input: {
  launchSteps: OperationsInboxLaunchStep[];
  events: OperationEvent[];
  resourceAlerts?: ResourceAlertEvaluation | null;
  resourceAlertReminderMinutes?: number;
  t: Translate;
}): OperationsInboxItem[] {
  const { launchSteps, events, resourceAlerts, resourceAlertReminderMinutes = 60, t } = input;
  const launchItems = launchSteps.map<OperationsInboxItem>((step) => ({
    id: `ops-launch-${step.item.id}`,
    tone: step.item.tone === 'fail' ? 'critical' : 'warning',
    section: step.item.section,
    title: step.item.title,
    detail: step.item.detail,
    action: step.item.action,
    sourceLabel: t('operationsInbox.sourceLaunch'),
    priorityLabel: step.priority,
    sortOrder: step.rank,
  }));
  const resourceAlertItems = (resourceAlerts?.signals ?? []).map<OperationsInboxItem>((signal, index) => (
    buildResourceAlertInboxItem(signal, index, resourceAlertReminderMinutes, t)
  ));
  const severityRank: Record<OperationEvent['severity'], number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  const eventItems = [...events]
    .filter((event) => event.status === 'open')
    .sort((left, right) => (
      severityRank[left.severity] - severityRank[right.severity]
      || parseEventTime(right.time) - parseEventTime(left.time)
    ))
    .slice(0, operationsInboxEventLimit)
    .map<OperationsInboxItem>((event, index) => ({
      id: `ops-event-${hashOpaqueStableId(event.id || `${event.time}:${event.source}:${event.title}`)}`,
      tone: event.severity === 'critical' ? 'critical' : event.severity === 'warning' ? 'warning' : 'info',
      section: 'security',
      title: event.title,
      detail: t('operationsInbox.eventDetail'),
      action: t('operationsInbox.openEvent'),
      sourceLabel: event.source.trim() || t('operationsInbox.sourceEvent'),
      priorityLabel: t(`operationsInbox.eventPriority.${event.severity}`),
      occurredAt: event.time,
      sortOrder: 100 + index,
    }));
  const toneRank: Record<OperationsInboxTone, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };

  return [...launchItems, ...resourceAlertItems, ...eventItems].sort((left, right) => (
    toneRank[left.tone] - toneRank[right.tone]
    || left.sortOrder - right.sortOrder
  ));
}

function buildResourceAlertInboxItem(
  signal: ResourceAlertSignal,
  index: number,
  reminderMinutes: number,
  t: Translate,
): OperationsInboxItem {
  const metricLabel = t(`overview.resourceAlertMetric.${signal.metric}`);
  return {
    id: `ops-resource-${signal.id}`,
    tone: signal.severity,
    section: 'servers',
    title: t('operationsInbox.resourceAlertTitle', { server: signal.serverName, metric: metricLabel }),
    detail: t('operationsInbox.resourceAlertDetail', {
      value: signal.value,
      threshold: signal.threshold,
      metric: metricLabel,
    }),
    action: t('operationsInbox.openResourceAlert'),
    sourceLabel: t('operationsInbox.sourceResourceAlert'),
    priorityLabel: t(`operationsInbox.eventPriority.${signal.severity}`),
    sortOrder: 40 + index,
    reviewTtlMs: Math.max(15, Math.round(reminderMinutes)) * 60 * 1000,
    serverId: signal.serverId,
    serverName: signal.serverName,
  };
}

export function useOperationsInboxReview(items: OperationsInboxItem[]) {
  const [reviewedAtById, setReviewedAtById] = useState<ReviewedAtById>(readOperationsInboxReview);
  const [reviewClock, setReviewClock] = useState(() => Date.now());
  const effectiveReviewedAtById = useMemo<ReviewedAtById>(() => {
    const now = reviewClock;
    const next: ReviewedAtById = {};
    for (const item of items) {
      const reviewedAt = reviewedAtById[item.id];
      if (!reviewedAt) {
        continue;
      }
      if (item.reviewTtlMs && now - reviewedAt >= item.reviewTtlMs) {
        continue;
      }
      next[item.id] = reviewedAt;
    }
    return next;
  }, [items, reviewedAtById, reviewClock]);
  const summary = useMemo<OperationsInboxSummary>(() => {
    let unreadCount = 0;
    let reviewedCount = 0;
    let criticalUnreadCount = 0;
    for (const item of items) {
      if (effectiveReviewedAtById[item.id]) {
        reviewedCount += 1;
      } else {
        unreadCount += 1;
        if (item.tone === 'critical') {
          criticalUnreadCount += 1;
        }
      }
    }
    return {
      unreadCount,
      reviewedCount,
      criticalUnreadCount,
      tone: criticalUnreadCount > 0 ? 'critical' : unreadCount > 0 ? 'warning' : 'clear',
    };
  }, [effectiveReviewedAtById, items]);

  useEffect(() => {
    writeOperationsInboxReview(reviewedAtById);
  }, [reviewedAtById]);

  useEffect(() => {
    const now = Date.now();
    const nextExpiry = items
      .map((item) => {
        const reviewedAt = reviewedAtById[item.id];
        return reviewedAt && item.reviewTtlMs ? reviewedAt + item.reviewTtlMs : 0;
      })
      .filter((value) => value > now)
      .sort((left, right) => left - right)[0];
    if (!nextExpiry) {
      return undefined;
    }
    const timer = window.setTimeout(() => setReviewClock(Date.now()), Math.max(1000, nextExpiry - now + 20));
    return () => window.clearTimeout(timer);
  }, [items, reviewedAtById]);

  useEffect(() => {
    function syncReviewState(event: StorageEvent) {
      if (event.key === operationsInboxStorageKey) {
        setReviewedAtById(readOperationsInboxReview());
      }
    }
    window.addEventListener('storage', syncReviewState);
    return () => window.removeEventListener('storage', syncReviewState);
  }, []);

  function markReviewed(itemId: string) {
    if (!operationsInboxIdPattern.test(itemId)) {
      return;
    }
    setReviewedAtById((current) => {
      const reviewedAt = current[itemId];
      const item = items.find((candidate) => candidate.id === itemId);
      const now = Date.now();
      const reviewExpired = Boolean(
        reviewedAt
        && item?.reviewTtlMs
        && now - reviewedAt >= item.reviewTtlMs,
      );
      return reviewedAt && !reviewExpired
        ? current
        : { ...current, [itemId]: now };
    });
  }

  function markAllReviewed() {
    const reviewedAt = Date.now();
    setReviewedAtById((current) => {
      const next = { ...current };
      for (const item of items) {
        next[item.id] = next[item.id] || reviewedAt;
      }
      return next;
    });
  }

  function clearReviewState() {
    setReviewedAtById({});
    try {
      window.localStorage.removeItem(operationsInboxStorageKey);
    } catch {
      // Review state is optional and must not block operational navigation.
    }
  }

  return {
    reviewedAtById: effectiveReviewedAtById,
    summary,
    markReviewed,
    markAllReviewed,
    clearReviewState,
  };
}

export function OperationsInboxTrigger(props: {
  summary: OperationsInboxSummary;
  onOpen: () => void;
  t: Translate;
}) {
  const { summary, onOpen, t } = props;
  return (
    <button
      type="button"
      className={`operations-inbox-trigger ${summary.tone}`}
      data-operations-inbox-open="true"
      aria-label={t('operationsInbox.openAria', { count: summary.unreadCount })}
      title={t('operationsInbox.openAria', { count: summary.unreadCount })}
      onClick={onOpen}
    >
      <BellRing size={15} aria-hidden="true" />
      <span>{t('operationsInbox.open')}</span>
      <b aria-live="polite">
        {summary.unreadCount > 0 ? summary.unreadCount : <Check size={12} aria-hidden="true" />}
      </b>
    </button>
  );
}

export function OperationsInboxMobileAction(props: {
  summary: OperationsInboxSummary;
  onOpen: () => void;
  t: Translate;
}) {
  const { summary, onOpen, t } = props;
  return (
    <button
      type="button"
      className={`operator-utility-action operations-inbox-mobile-action ${summary.tone}`}
      data-operator-utility-inbox="true"
      data-mobile-utility-inbox="true"
      onClick={onOpen}
    >
      <Inbox size={17} aria-hidden="true" />
      <span>{t('operationsInbox.open')}</span>
      <b>{summary.unreadCount > 0
        ? t('operationsInbox.unreadCount', { count: summary.unreadCount })
        : t('operationsInbox.allReviewed')}</b>
    </button>
  );
}

export function OperationsInboxDrawer(props: {
  open: boolean;
  items: OperationsInboxItem[];
  reviewedAtById: ReviewedAtById;
  summary: OperationsInboxSummary;
  locale: string;
  onClose: () => void;
  onOpenItem: (item: OperationsInboxItem) => void;
  onMarkReviewed: (itemId: string) => void;
  onMarkAllReviewed: () => void;
  onClearReviewState: () => void;
  t: Translate;
}) {
  const {
    open,
    items,
    reviewedAtById,
    summary,
    locale,
    onClose,
    onOpenItem,
    onMarkReviewed,
    onMarkAllReviewed,
    onClearReviewState,
    t,
  } = props;
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const groups = useMemo(() => {
    const unreadCritical = items.filter((item) => !reviewedAtById[item.id] && item.tone === 'critical');
    const unreadWatch = items.filter((item) => !reviewedAtById[item.id] && item.tone !== 'critical');
    const reviewed = items.filter((item) => Boolean(reviewedAtById[item.id]));
    return [
      {
        id: 'critical',
        title: t('operationsInbox.groupCritical'),
        detail: t('operationsInbox.groupCriticalDetail'),
        items: unreadCritical,
      },
      {
        id: 'watch',
        title: t('operationsInbox.groupWatch'),
        detail: t('operationsInbox.groupWatchDetail'),
        items: unreadWatch,
      },
      {
        id: 'reviewed',
        title: t('operationsInbox.groupReviewed'),
        detail: t('operationsInbox.groupReviewedDetail'),
        items: reviewed,
      },
    ].filter((group) => group.items.length > 0);
  }, [items, reviewedAtById, t]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 20);
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      openerRef.current?.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        className="operations-inbox-backdrop"
        aria-label={t('operationsInbox.close')}
        onClick={onClose}
      />
      <aside
        className="operations-inbox-drawer"
        data-operations-inbox-drawer="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby="operations-inbox-title"
      >
        <header className="operations-inbox-head">
          <div className="operations-inbox-signal" data-tone={summary.tone} aria-hidden="true">
            <ShieldAlert size={22} />
            <span />
          </div>
          <div className="operations-inbox-heading">
            <span>{t('operationsInbox.eyebrow')}</span>
            <h2 id="operations-inbox-title">{t('operationsInbox.title')}</h2>
            <p>{t('operationsInbox.detail')}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button operations-inbox-close"
            aria-label={t('operationsInbox.close')}
            title={t('operationsInbox.close')}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        <div className="operations-inbox-ledger" aria-label={t('operationsInbox.statusAria')}>
          <div>
            <CircleAlert size={15} aria-hidden="true" />
            <span>{t('operationsInbox.unread')}</span>
            <strong>{summary.unreadCount}</strong>
          </div>
          <div>
            <CheckCheck size={15} aria-hidden="true" />
            <span>{t('operationsInbox.reviewed')}</span>
            <strong>{summary.reviewedCount}</strong>
          </div>
          <div>
            <Clock3 size={15} aria-hidden="true" />
            <span>{t('operationsInbox.active')}</span>
            <strong>{items.length}</strong>
          </div>
        </div>

        <div className="operations-inbox-toolbar">
          <button
            type="button"
            className="tool-button"
            data-operations-inbox-mark-all="true"
            disabled={summary.unreadCount === 0}
            onClick={onMarkAllReviewed}
          >
            <CheckCheck size={14} aria-hidden="true" />
            {t('operationsInbox.markAll')}
          </button>
          <button
            type="button"
            className="tool-button"
            data-operations-inbox-clear-review="true"
            disabled={summary.reviewedCount === 0}
            onClick={onClearReviewState}
          >
            <Trash2 size={14} aria-hidden="true" />
            {t('operationsInbox.clearReview')}
          </button>
        </div>

        <div className="operations-inbox-body">
          {groups.length > 0 ? groups.map((group) => (
            <section
              key={group.id}
              className={`operations-inbox-group ${group.id}`}
              data-operations-inbox-group={group.id}
              aria-labelledby={`operations-inbox-group-${group.id}`}
            >
              <div className="operations-inbox-group-head">
                <div>
                  <span>{group.items.length}</span>
                  <div>
                    <strong id={`operations-inbox-group-${group.id}`}>{group.title}</strong>
                    <small>{group.detail}</small>
                  </div>
                </div>
              </div>
              <div className="operations-inbox-list">
                {group.items.map((item) => {
                  const reviewedAt = reviewedAtById[item.id];
                  const itemTime = reviewedAt
                    ? formatInboxTime(new Date(reviewedAt).toISOString(), locale)
                    : item.occurredAt
                      ? formatInboxTime(item.occurredAt, locale)
                      : '';
                  return (
                    <article
                      key={item.id}
                      className={`operations-inbox-item ${item.tone}${reviewedAt ? ' reviewed' : ''}`}
                      data-operations-inbox-item={item.id}
                      data-inbox-section={item.section}
                      data-inbox-reviewed={reviewedAt ? 'true' : 'false'}
                    >
                      <span className="operations-inbox-item-rail" aria-hidden="true" />
                      <button
                        type="button"
                        className="operations-inbox-item-action"
                        onClick={() => {
                          onMarkReviewed(item.id);
                          onOpenItem(item);
                          onClose();
                        }}
                      >
                        <span className="operations-inbox-item-meta">
                          <b>{item.priorityLabel}</b>
                          <em>{item.sourceLabel}</em>
                          {itemTime ? <time>{reviewedAt
                            ? t('operationsInbox.reviewedAt', { time: itemTime })
                            : itemTime}</time> : null}
                        </span>
                        <strong>{item.title}</strong>
                        <small>{item.detail}</small>
                        <span className="operations-inbox-item-next">
                          {item.action}
                          <ChevronRight size={14} aria-hidden="true" />
                        </span>
                      </button>
                      {!reviewedAt ? (
                        <button
                          type="button"
                          className="operations-inbox-review-button"
                          aria-label={t('operationsInbox.markReviewedAria', { title: item.title })}
                          title={t('operationsInbox.markReviewed')}
                          onClick={() => onMarkReviewed(item.id)}
                        >
                          <Check size={14} aria-hidden="true" />
                        </button>
                      ) : (
                        <span className="operations-inbox-reviewed-mark" title={t('operationsInbox.reviewed')}>
                          <CheckCheck size={14} aria-hidden="true" />
                        </span>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          )) : (
            <section className="operations-inbox-empty" data-operations-inbox-empty="true">
              <CheckCheck size={24} aria-hidden="true" />
              <strong>{t('operationsInbox.emptyTitle')}</strong>
              <p>{t('operationsInbox.emptyDetail')}</p>
            </section>
          )}
        </div>

        <footer className="operations-inbox-footer">
          <ShieldAlert size={14} aria-hidden="true" />
          <span>{t('operationsInbox.privacy')}</span>
        </footer>
      </aside>
    </>
  );
}

function parseEventTime(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatInboxTime(value: string, locale: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return '';
  }
  return new Date(parsed).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function hashOpaqueStableId(value: string) {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + ((index + 1) * 17)), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(36)}${(right >>> 0).toString(36)}`.slice(0, 20);
}

function readOperationsInboxReview(): ReviewedAtById {
  if (typeof window === 'undefined') {
    return {};
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(operationsInboxStorageKey) ?? 'null');
    if (parsed?.version !== operationsInboxStorageVersion || !Array.isArray(parsed.reviewed)) {
      return {};
    }
    const now = Date.now();
    const earliestAllowed = now - operationsInboxReviewTtlMs;
    const result: ReviewedAtById = {};
    for (const entry of parsed.reviewed.slice(0, operationsInboxStorageLimit) as unknown[]) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const candidate = entry as { id?: unknown; at?: unknown };
      if (
        typeof candidate.id === 'string'
        && operationsInboxIdPattern.test(candidate.id)
        && Number.isSafeInteger(candidate.at)
        && (candidate.at as number) >= earliestAllowed
        && (candidate.at as number) <= now + 24 * 60 * 60 * 1000
      ) {
        result[candidate.id] = candidate.at as number;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeOperationsInboxReview(reviewedAtById: ReviewedAtById) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const earliestAllowed = Date.now() - operationsInboxReviewTtlMs;
    const reviewed = Object.entries(reviewedAtById)
      .filter(([id, at]) => (
        operationsInboxIdPattern.test(id)
        && Number.isSafeInteger(at)
        && at >= earliestAllowed
      ))
      .sort((left, right) => right[1] - left[1])
      .slice(0, operationsInboxStorageLimit)
      .map(([id, at]) => ({ id, at }));
    if (reviewed.length === 0) {
      window.localStorage.removeItem(operationsInboxStorageKey);
      return;
    }
    window.localStorage.setItem(operationsInboxStorageKey, JSON.stringify({
      version: operationsInboxStorageVersion,
      reviewed,
    }));
  } catch {
    // The inbox remains fully usable when localStorage is blocked or full.
  }
}
