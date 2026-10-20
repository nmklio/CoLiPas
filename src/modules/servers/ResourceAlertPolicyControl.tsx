import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, BellRing, CheckCircle2, LoaderCircle, RefreshCw, RotateCcw, Save, SlidersHorizontal, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import type {
  ResourceAlertEvaluation,
  ResourceAlertMetric,
  ResourceAlertPolicy,
  ResourceAlertPolicyLoadStatus,
  ResourceAlertPolicyUpdate,
} from '../../types';
import {
  defaultResourceAlertPolicy,
  resourceAlertReminderOptions,
  resourceAlertThresholdMaximum,
  resourceAlertThresholdMinimum,
  toResourceAlertPolicyUpdate,
} from '../../shared/resourceAlerts';

interface ResourceAlertPolicyControlProps {
  policy: ResourceAlertPolicy | null;
  evaluation: ResourceAlertEvaluation | null;
  status: ResourceAlertPolicyLoadStatus;
  onRetry: () => Promise<boolean>;
  onSave: (policy: ResourceAlertPolicyUpdate) => Promise<ResourceAlertPolicy>;
}

interface ResourceThresholdControlProps {
  metric: ResourceAlertMetric;
  value: number;
  onChange: (value: number) => void;
}

export function ResourceAlertPolicyControl({ policy, evaluation, status, onRetry, onSave }: ResourceAlertPolicyControlProps) {
  const { language, t } = useI18n();
  const displayPolicy = policy ?? defaultResourceAlertPolicy;
  const ready = status === 'ready' && policy !== null && evaluation !== null;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ResourceAlertPolicyUpdate>(() => toResourceAlertPolicyUpdate(displayPolicy));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const currentPolicy = useMemo(() => toResourceAlertPolicyUpdate(displayPolicy), [displayPolicy]);
  const dirty = ready && !resourceAlertPolicyEquals(draft, currentPolicy);
  const tone = status === 'error'
    ? 'error'
    : status === 'loading'
      ? 'loading'
      : !displayPolicy.enabled
        ? 'paused'
        : (evaluation?.summary.criticalAlerts ?? 0) > 0
          ? 'critical'
          : (evaluation?.summary.activeAlerts ?? 0) > 0
            ? 'warning'
            : 'clear';
  const locale = language === 'en' ? 'en-US' : language === 'ja' ? 'ja-JP' : 'zh-CN';
  const updatedAt = status !== 'ready'
    ? '--'
    : displayPolicy.updatedAt
      ? new Date(displayPolicy.updatedAt).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : t('overview.resourceAlertPolicyDefault');

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 20);
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !savingRef.current) {
        event.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      triggerRef.current?.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (open && status === 'ready') {
      setDraft(currentPolicy);
    }
  }, [currentPolicy, open, status]);

  function closePolicy() {
    if (savingRef.current) {
      return;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setOpen(false);
  }

  function openPolicy() {
    setDraft(currentPolicy);
    setFeedback(null);
    setOpen(true);
  }

  function updateDraft(patch: Partial<ResourceAlertPolicyUpdate>) {
    setFeedback(null);
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving || !ready) {
      return;
    }
    setSaving(true);
    savingRef.current = true;
    setFeedback(null);
    try {
      const saved = await onSave(draft);
      setDraft(toResourceAlertPolicyUpdate(saved));
      setFeedback({ tone: 'ok', text: t('overview.resourceAlertPolicySaved') });
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        setOpen(false);
      }, 700);
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: error instanceof Error ? error.message : t('overview.resourceAlertPolicySaveFailed'),
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`resource-alert-policy-trigger ${tone}`}
        data-resource-alert-policy-open="true"
        data-resource-alert-policy-status={status}
        aria-haspopup="dialog"
        onClick={openPolicy}
      >
        <BellRing size={15} aria-hidden="true" />
        <span>
          <strong>{t('overview.resourceAlertPolicyOpen')}</strong>
          <small>{status === 'loading'
            ? t('overview.resourceAlertPolicyLoading')
            : status === 'error'
              ? t('overview.resourceAlertPolicyLoadFailedShort')
              : displayPolicy.enabled
                ? t('overview.resourceAlertPolicyThresholdSummary', {
                  cpu: displayPolicy.cpuThreshold,
                  memory: displayPolicy.memoryThreshold,
                  disk: displayPolicy.diskThreshold,
                })
                : t('overview.resourceAlertPolicyPaused')}</small>
        </span>
        <b aria-live="polite">{status === 'loading'
          ? <LoaderCircle size={14} className="spin" aria-hidden="true" />
          : status === 'error'
            ? <AlertCircle size={14} aria-hidden="true" />
            : evaluation?.summary.activeAlerts ?? 0}</b>
      </button>

      {open && typeof document !== 'undefined' ? createPortal((
        <>
          <button
            type="button"
            className="resource-alert-policy-backdrop"
            aria-label={t('overview.resourceAlertPolicyClose')}
            onClick={closePolicy}
          />
          <aside
            className="resource-alert-policy-drawer"
            data-resource-alert-policy-drawer="true"
            role="dialog"
            aria-modal="true"
            aria-labelledby="resource-alert-policy-title"
          >
            <header className="resource-alert-policy-head">
              <div className={`resource-alert-policy-signal ${tone}`} aria-hidden="true">
                <BellRing size={21} />
                <span />
              </div>
              <div>
                <span>{t('overview.resourceAlertPolicyEyebrow')}</span>
                <h2 id="resource-alert-policy-title">{t('overview.resourceAlertPolicyTitle')}</h2>
                <p>{t('overview.resourceAlertPolicyDetail')}</p>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                className="icon-button"
                aria-label={t('overview.resourceAlertPolicyClose')}
                title={t('overview.resourceAlertPolicyClose')}
                onClick={closePolicy}
              >
                <X size={17} />
              </button>
            </header>

            <div className="resource-alert-policy-summary" aria-label={t('overview.resourceAlertPolicyLiveStatus')}>
              <div>
                <span>{t('overview.resourceAlertPolicyActive')}</span>
                <strong>{evaluation?.summary.activeAlerts ?? '--'}</strong>
              </div>
              <div>
                <span>{t('overview.resourceAlertPolicyAffected')}</span>
                <strong>{evaluation?.summary.affectedServers ?? '--'}</strong>
              </div>
              <div>
                <span>{t('overview.resourceAlertPolicyCritical')}</span>
                <strong>{evaluation?.summary.criticalAlerts ?? '--'}</strong>
              </div>
              <div>
                <span>{t('overview.resourceAlertPolicyConnected')}</span>
                <strong>{evaluation?.summary.connectedServers ?? '--'}</strong>
              </div>
              <div>
                <span>{t('overview.resourceAlertPolicyFresh')}</span>
                <strong>{evaluation?.summary.freshSamples ?? '--'}</strong>
              </div>
              <div>
                <span>{t('overview.resourceAlertPolicySkipped')}</span>
                <strong>{evaluation?.summary.skippedServers ?? '--'}</strong>
              </div>
            </div>

            {status !== 'ready' ? (
              <div className={`resource-alert-policy-load-state ${status}`} data-resource-alert-policy-load-state={status} role={status === 'error' ? 'alert' : 'status'}>
                {status === 'loading' ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : <AlertCircle size={17} aria-hidden="true" />}
                <span>
                  <strong>{status === 'loading' ? t('overview.resourceAlertPolicyLoading') : t('overview.resourceAlertPolicyLoadFailed')}</strong>
                  <small>{status === 'loading' ? t('overview.resourceAlertPolicyLoadingDetail') : t('overview.resourceAlertPolicyLoadFailedDetail')}</small>
                </span>
                {status === 'error' ? (
                  <button type="button" className="tool-button" data-resource-alert-policy-retry="true" onClick={() => void onRetry()}>
                    <RefreshCw size={14} aria-hidden="true" />
                    {t('app.retryApi')}
                  </button>
                ) : null}
              </div>
            ) : null}

            <form className="resource-alert-policy-form" onSubmit={handleSubmit}>
              <div className="resource-alert-policy-fields">
                <label className="resource-alert-policy-toggle">
                  <span>
                    <strong>{t('overview.resourceAlertPolicyEnabled')}</strong>
                    <small>{t('overview.resourceAlertPolicyEnabledDetail')}</small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={ready && draft.enabled}
                    disabled={!ready || saving}
                    onChange={(event) => updateDraft({ enabled: event.target.checked })}
                  />
                  <i aria-hidden="true" />
                </label>

                <fieldset disabled={!ready || !draft.enabled || saving}>
                  <legend><SlidersHorizontal size={15} aria-hidden="true" /> {t('overview.resourceAlertPolicyThresholds')}</legend>
                  <ResourceThresholdControl
                    metric="cpu"
                    value={draft.cpuThreshold}
                    onChange={(cpuThreshold) => updateDraft({ cpuThreshold })}
                  />
                  <ResourceThresholdControl
                    metric="memory"
                    value={draft.memoryThreshold}
                    onChange={(memoryThreshold) => updateDraft({ memoryThreshold })}
                  />
                  <ResourceThresholdControl
                    metric="disk"
                    value={draft.diskThreshold}
                    onChange={(diskThreshold) => updateDraft({ diskThreshold })}
                  />
                </fieldset>

                <label className="resource-alert-policy-reminder">
                  <span>
                    <strong>{t('overview.resourceAlertPolicyReminder')}</strong>
                    <small>{t('overview.resourceAlertPolicyReminderDetail')}</small>
                  </span>
                  <select
                    value={draft.reminderMinutes}
                    disabled={!ready || !draft.enabled || saving}
                    onChange={(event) => updateDraft({ reminderMinutes: Number(event.target.value) })}
                  >
                    {resourceAlertReminderOptions.map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {t('overview.resourceAlertPolicyReminderOption', { minutes })}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="resource-alert-policy-rule-note">
                  <BellRing size={14} aria-hidden="true" />
                  <span>{t('overview.resourceAlertPolicyCriticalRule')}</span>
                </div>

                {feedback ? (
                  <div className={`resource-alert-policy-feedback ${feedback.tone}`} role={feedback.tone === 'error' ? 'alert' : 'status'}>
                    {feedback.tone === 'ok' ? <CheckCircle2 size={15} aria-hidden="true" /> : null}
                    {feedback.text}
                  </div>
                ) : null}
              </div>

              <footer className="resource-alert-policy-actions">
                <span>{t('overview.resourceAlertPolicyUpdated', { time: updatedAt })}</span>
                <div>
                  <button
                    type="button"
                    className="tool-button"
                    disabled={!ready || saving}
                    onClick={() => updateDraft(toResourceAlertPolicyUpdate(defaultResourceAlertPolicy))}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    {t('overview.resourceAlertPolicyDefaults')}
                  </button>
                  <button type="button" className="tool-button" disabled={saving} onClick={closePolicy}>
                    {t('common.cancel')}
                  </button>
                  <button type="submit" className="tool-button primary" disabled={!dirty || saving || !ready}>
                    {saving ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
                    {saving ? t('common.processing') : t('overview.resourceAlertPolicySave')}
                  </button>
                </div>
              </footer>
            </form>
          </aside>
        </>
      ), document.body) : null}
    </>
  );
}

function ResourceThresholdControl({ metric, value, onChange }: ResourceThresholdControlProps) {
  const { t } = useI18n();
  const label = t(`overview.resourceAlertMetric.${metric}`);
  return (
    <label className="resource-alert-threshold" data-resource-alert-threshold={metric}>
      <span>
        <strong>{label}</strong>
        <small>{t('overview.resourceAlertPolicyThresholdDetail', { metric: label })}</small>
      </span>
      <input
        type="range"
        min={resourceAlertThresholdMinimum}
        max={resourceAlertThresholdMaximum}
        step={1}
        value={value}
        aria-label={t('overview.resourceAlertPolicyThresholdAria', { metric: label })}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{value}%</output>
    </label>
  );
}

function resourceAlertPolicyEquals(left: ResourceAlertPolicyUpdate, right: ResourceAlertPolicyUpdate) {
  return left.enabled === right.enabled
    && left.cpuThreshold === right.cpuThreshold
    && left.memoryThreshold === right.memoryThreshold
    && left.diskThreshold === right.diskThreshold
    && left.reminderMinutes === right.reminderMinutes;
}
