import { useCallback, useEffect, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  ShieldX,
} from 'lucide-react';
import { getLocale, useI18n } from '../i18n';
import {
  fetchAccountSessions,
  revokeAccountSession,
  revokeOtherAccountSessions,
  type AccountSessionsResponse,
} from '../services/apiClient';

export function AccountSessionControl() {
  const { language, t } = useI18n();
  const [sessions, setSessions] = useState<AccountSessionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [revokingId, setRevokingId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const locale = getLocale(language);

  const refreshSessions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSessions(await fetchAccountSessions());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('account.sessionsLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  async function handleRevoke(sessionId: string) {
    setRevokingId(sessionId);
    setError('');
    setMessage('');
    try {
      const result = await revokeAccountSession(sessionId);
      setSessions(result.sessions);
      setMessage(t('account.sessionsRevoked'));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('account.sessionsRevokeFailed'));
    } finally {
      setRevokingId('');
    }
  }

  async function handleRevokeOthers() {
    setRevokingId('others');
    setError('');
    setMessage('');
    try {
      const result = await revokeOtherAccountSessions();
      setSessions(result.sessions);
      setMessage(t('account.sessionsOthersRevoked', { count: result.revoked }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : t('account.sessionsRevokeFailed'));
    } finally {
      setRevokingId('');
    }
  }

  return (
    <article className="account-settings-card account-session-control" data-account-session-control="true">
      <div className="account-session-heading">
        <div className="account-card-title">
          <div className="account-session-title-icon"><MonitorSmartphone size={20} /></div>
          <div>
            <strong>{t('account.sessionsTitle')}</strong>
            <span>{t('account.sessionsDesc')}</span>
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('account.sessionsRefresh')}
          title={t('account.sessionsRefresh')}
          disabled={loading || Boolean(revokingId)}
          onClick={() => void refreshSessions()}
        >
          <RefreshCw size={16} className={loading ? 'spin-icon' : ''} />
        </button>
      </div>

      <div className="account-session-summary" aria-label={t('account.sessionsSummary')}>
        <div>
          <span>{t('account.sessionsActive')}</span>
          <strong>{sessions?.summary.active ?? '—'}</strong>
        </div>
        <div>
          <span>{t('account.sessionsCurrent')}</span>
          <strong>{sessions?.items.some((session) => session.current) ? '1' : '—'}</strong>
        </div>
        <div>
          <span>{t('account.sessionsOther')}</span>
          <strong>{sessions?.summary.otherSessions ?? '—'}</strong>
        </div>
      </div>

      {loading && !sessions ? (
        <div className="account-session-state" role="status">
          <RefreshCw size={16} className="spin-icon" />
          {t('account.sessionsLoading')}
        </div>
      ) : sessions?.items.length ? (
        <div className="account-session-list">
          {sessions.items.map((session) => (
            <div
              key={session.id}
              className={`account-session-row${session.current ? ' is-current' : ''}`}
              data-account-session-current={session.current ? 'true' : undefined}
            >
              <span className="account-session-node" aria-hidden="true">
                {session.current ? <CheckCircle2 size={15} /> : <MonitorSmartphone size={15} />}
              </span>
              <div className="account-session-body">
                <div className="account-session-identity">
                  <div>
                    <strong>{session.deviceLabel}</strong>
                    <span>
                      {session.current
                        ? t('account.sessionsCurrentDetail')
                        : t('account.sessionsOtherDetail')}
                    </span>
                  </div>
                  {session.current ? (
                    <span className="account-session-current-badge">
                      <ShieldCheck size={13} />
                      {t('account.sessionsCurrent')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="tool-button account-session-revoke"
                      disabled={Boolean(revokingId)}
                      onClick={() => void handleRevoke(session.id)}
                    >
                      <ShieldX size={14} />
                      {revokingId === session.id ? t('common.processing') : t('account.sessionsRevoke')}
                    </button>
                  )}
                </div>
                <div className="account-session-meta">
                  <span title={formatSessionTime(session.createdAt, locale)}>
                    <CalendarClock size={13} />
                    {t('account.sessionsCreated')}: {formatSessionTime(session.createdAt, locale)}
                  </span>
                  <span title={formatSessionTime(session.lastSeenAt, locale)}>
                    <Clock3 size={13} />
                    {t('account.sessionsLastSeen')}: {formatSessionTime(session.lastSeenAt, locale)}
                  </span>
                  <span title={formatSessionTime(session.expiresAt, locale)}>
                    <ShieldCheck size={13} />
                    {t('account.sessionsExpires')}: {formatSessionTime(session.expiresAt, locale)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="account-session-state">{t('account.sessionsEmpty')}</div>
      )}

      <div className="account-session-footer">
        <p><ShieldCheck size={14} /> {t('account.sessionsPrivacy')}</p>
        <button
          type="button"
          className="tool-button account-session-revoke-others"
          data-account-session-revoke-others="true"
          disabled={!sessions?.summary.otherSessions || Boolean(revokingId)}
          onClick={() => void handleRevokeOthers()}
        >
          <ShieldX size={15} />
          {revokingId === 'others' ? t('common.processing') : t('account.sessionsRevokeOthers')}
        </button>
      </div>

      {message && <div className="account-session-message success" role="status">{message}</div>}
      {error && <div className="account-session-message error" role="alert">{error}</div>}
    </article>
  );
}

function formatSessionTime(value: string, locale: string) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return '—';
  }
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}
