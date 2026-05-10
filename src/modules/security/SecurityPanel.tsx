import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  Fingerprint,
  LockKeyhole,
  RefreshCw,
  Rocket,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
  XCircle,
} from 'lucide-react';
import { getLocale, useI18n } from '../../i18n';
import { OperationEvent } from '../../types';
import { fetchReleaseReadiness, fetchReleaseReadinessReport, recordReleaseReadinessSnapshot, remediateSecurityRisk } from '../../services/apiClient';
import type { SecurityRemediationResponse } from '../../services/apiClient';
import type { ReleaseReadinessResponse } from '../../types';

interface SecurityPanelProps {
  events: OperationEvent[];
  onNavigate: (section: 'overview' | 'servers' | 'operations' | 'ai' | 'api' | 'security') => void;
  onRemediated: () => void | Promise<void>;
}

interface ConfigSummary {
  nodeEnv: string;
  corsOrigins: string[];
  customApiAllowedHosts: string[];
  customApiTimeoutMs: number;
  ai: {
    baseUrl: string;
    model: string;
    configured: boolean;
  };
  security: {
    adminPasswordDefault: boolean;
    sessionSecretDefault: boolean;
    credentialEncryptionKeyConfigured: boolean;
    credentialEncryptionKeyDefault: boolean;
  };
}

interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  target: string;
  status: 'success' | 'blocked' | 'failed';
  detail: string;
  createdAt: string;
}

type AuditStatusFilter = 'all' | AuditEntry['status'];
type SecurityRelationKey = 'runtime' | 'ai' | 'api' | 'cors' | 'timeout' | 'ssh' | 'secrets';

interface SecurityCheck {
  id: string;
  title: string;
  detail: string;
  state: 'pass' | 'warn' | 'fail';
}

interface SecurityRelationItem {
  key: SecurityRelationKey;
  label: string;
  value: string;
  detail: string;
  state: 'pass' | 'warn' | 'fail';
  count: number;
}

interface AuditInsight {
  domain: string;
  severity: 'low' | 'medium' | 'high';
  reason: string;
  nextStep: string;
}

interface SecurityRiskAction {
  id: string;
  title: string;
  detail: string;
  severity: 'warn' | 'fail';
  actionLabel: string;
  actionType: SecurityRemediationResponse['type'] | 'navigate';
  target: string;
  navigateTo?: 'overview' | 'servers' | 'operations' | 'ai' | 'api' | 'security';
  note?: string;
}

export function SecurityPanel({ events, onNavigate, onRemediated }: SecurityPanelProps) {
  const { language, t } = useI18n();
  const copy = securityCopyByLanguage[language] ?? securityCopyByLanguage.zh;
  const locale = getLocale(language);
  const openEvents = events.filter((event) => event.status === 'open');
  const [config, setConfig] = useState<ConfigSummary | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<AuditStatusFilter>('all');
  const [relationFilter, setRelationFilter] = useState<SecurityRelationKey | null>(null);
  const [query, setQuery] = useState('');
  const [selectedAuditId, setSelectedAuditId] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [loadError, setLoadError] = useState('');
  const [remediationMessage, setRemediationMessage] = useState('');
  const [remediationError, setRemediationError] = useState(false);
  const [remediatingId, setRemediatingId] = useState('');
  const [readiness, setReadiness] = useState<ReleaseReadinessResponse | null>(null);
  const [recordingSnapshot, setRecordingSnapshot] = useState(false);
  const [exportingReadinessReport, setExportingReadinessReport] = useState(false);

  const filteredAudits = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return auditEntries.filter((entry) => {
      const statusMatched = statusFilter === 'all' || entry.status === statusFilter;
      const relationMatched = !relationFilter || isAuditRelated(entry, relationFilter, config);
      const queryMatched = !normalizedQuery || [entry.action, entry.actor, entry.target, entry.detail]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
      return statusMatched && relationMatched && queryMatched;
    });
  }, [auditEntries, config, query, relationFilter, statusFilter]);

  const selectedAudit = filteredAudits.find((entry) => entry.id === selectedAuditId)
    ?? filteredAudits[0]
    ?? null;
  const selectedAuditInsight = selectedAudit ? buildAuditInsight(selectedAudit, copy) : null;
  const activeAuditIssues = useMemo(() => getActiveAuditIssues(auditEntries), [auditEntries]);
  const checks = useMemo(() => buildSecurityChecks(config, auditEntries, openEvents, copy), [auditEntries, config, openEvents, copy]);
  const riskActions = useMemo(() => buildSecurityRiskActions(checks, auditEntries, openEvents, copy), [auditEntries, checks, openEvents, copy]);
  const relationItems = useMemo(() => buildSecurityRelationItems(config, auditEntries, copy), [auditEntries, config, copy]);
  const selectedRelation = relationFilter ? relationItems.find((item) => item.key === relationFilter) ?? null : null;
  const runtimeItems = relationItems.filter((item) => item.key === 'runtime' || item.key === 'cors' || item.key === 'timeout');
  const secretItems = relationItems.filter((item) => item.key === 'ai' || item.key === 'api' || item.key === 'ssh' || item.key === 'secrets');
  const failedCount = activeAuditIssues.failed;
  const blockedCount = activeAuditIssues.blocked;
  const riskyCount = checks.filter((check) => check.state !== 'pass').length + activeAuditIssues.total + openEvents.length;
  const successRate = auditEntries.length > 0
    ? Math.round((auditEntries.filter((entry) => entry.status === 'success').length / auditEntries.length) * 100)
    : 100;

  useEffect(() => {
    refreshSecurityData().catch(() => undefined);
  }, []);

  async function refreshSecurityData() {
    setLoading(true);
    setLoadError('');
    try {
      const [configResponse, auditResponse] = await Promise.all([
        fetch('/api/config'),
        fetch('/api/audit/events'),
      ]);
      const readinessPromise = fetchReleaseReadiness();
      if (!configResponse.ok || !auditResponse.ok) {
        throw new Error(copy.loadFailed);
      }
      const [configBody, auditBody, readinessBody] = await Promise.all([
        configResponse.json(),
        auditResponse.json(),
        readinessPromise,
      ]);
      if (!Array.isArray(auditBody.items)) {
        throw new Error(copy.loadFailed);
      }
      setConfig(configBody as ConfigSummary);
      setAuditEntries((auditBody.items ?? []) as AuditEntry[]);
      setReadiness(readinessBody);
      setLastRefreshedAt(new Date());
    } catch {
      setLoadError(copy.loadFailed);
      setConfig(null);
      setAuditEntries([]);
      setReadiness(null);
    } finally {
      setLoading(false);
    }
  }

  function exportAudit() {
    const payload = JSON.stringify({ exportedAt: new Date().toISOString(), items: filteredAudits }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `colipas-audit-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function applyRelationFilter(relation: SecurityRelationKey) {
    setRelationFilter(relation);
    setQuery('');
    setStatusFilter('all');
    const firstMatchedAudit = auditEntries.find((entry) => isAuditRelated(entry, relation, config));
    setSelectedAuditId(firstMatchedAudit?.id ?? '');
  }

  function clearRelationFilter() {
    setRelationFilter(null);
  }

  function applyReadinessFilter(check: ReleaseReadinessResponse['checks'][number]) {
    if (check.relatedModule === 'ai') {
      onNavigate('ai');
      return;
    }

    if (check.relatedModule === 'api') {
      onNavigate('api');
      return;
    }

    if (check.relatedModule === 'servers' || check.relatedModule === 'ssh') {
      onNavigate('servers');
      return;
    }

    if (check.relatedModule === 'events') {
      onNavigate('operations');
      return;
    }

    if (check.relatedModule === 'audit') {
      setRelationFilter(null);
      setStatusFilter('all');
      setQuery('');
      setSelectedAuditId(getActiveAuditEntries(auditEntries)[0]?.id ?? '');
      focusRemediation();
      return;
    }

    if (check.relatedModule === 'runtime') {
      applyRelationFilter('runtime');
    }
  }

  function focusRemediation() {
    document.getElementById('security-remediation')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function handleRiskAction(action: SecurityRiskAction) {
    setRemediationMessage('');
    setRemediationError(false);
    if (action.actionType === 'navigate' && action.navigateTo) {
      onNavigate(action.navigateTo);
      return;
    }

    setRemediatingId(action.id);
    try {
      await remediateSecurityRisk({
        type: action.actionType as SecurityRemediationResponse['type'],
        target: action.target,
        note: action.note ?? action.detail,
      });
      setRemediationMessage(copy.remediationDone(action.title));
      setRemediationError(false);
      await refreshSecurityData();
      await onRemediated();
    } catch (error) {
      setRemediationMessage(error instanceof Error ? error.message : copy.remediationFailed);
      setRemediationError(true);
    } finally {
      setRemediatingId('');
    }
  }

  async function handleRecordReadinessSnapshot() {
    setRecordingSnapshot(true);
    setRemediationMessage('');
    setRemediationError(false);
    try {
      const result = await recordReleaseReadinessSnapshot();
      setReadiness(result.readiness);
      setRemediationMessage(copy.snapshotRecorded(result.snapshot.score));
    } catch (error) {
      setRemediationMessage(error instanceof Error ? error.message : copy.snapshotFailed);
      setRemediationError(true);
    } finally {
      setRecordingSnapshot(false);
    }
  }

  async function exportReadinessReport() {
    setExportingReadinessReport(true);
    setRemediationMessage('');
    setRemediationError(false);
    try {
      const report = await fetchReleaseReadinessReport();
      const blob = new Blob([report.markdown], { type: `${report.contentType};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = report.filename;
      link.click();
      URL.revokeObjectURL(url);
      setRemediationMessage(copy.reportExported);
    } catch (error) {
      setRemediationMessage(error instanceof Error ? error.message : copy.reportFailed);
      setRemediationError(true);
    } finally {
      setExportingReadinessReport(false);
    }
  }

  return (
    <section className="module-section security-workbench" aria-labelledby="security-title">
      <div className="section-header security-header">
        <div>
          <p>{t('security.eyebrow')}</p>
          <h2 id="security-title">{t('security.title')}</h2>
        </div>
        <div className="section-actions">
          <button type="button" className={riskyCount > 0 ? 'config-state invalid action' : 'config-state ready action'} onClick={focusRemediation}>
            {riskyCount > 0 ? copy.riskItems(riskyCount) : t('security.pending', { count: openEvents.length })}
          </button>
          <button type="button" className="tool-button" onClick={refreshSecurityData} disabled={loading}>
            <RefreshCw size={16} />
            {loading ? t('common.processing') : copy.refresh}
          </button>
          <button type="button" className="tool-button primary" onClick={exportAudit} disabled={filteredAudits.length === 0}>
            <Download size={16} />
            {copy.exportAudit}
          </button>
        </div>
      </div>

      {loadError && <div className="error-box">{loadError}</div>}
      {remediationMessage && <div className={remediationError ? 'error-box' : 'validation-box'}>{remediationMessage}</div>}

      <article className={`security-readiness-card ${readiness?.status ?? 'review'}`}>
        <div className="security-readiness-score">
          <span><Rocket size={17} /> {copy.readinessTitle}</span>
          <strong>{readiness ? readiness.score : '--'}</strong>
          <small>{readiness ? copy.readinessStatus(readiness.status) : copy.waitingRefresh}</small>
        </div>
        <div className="security-readiness-body">
          <div className="security-readiness-meter" aria-hidden="true">
            <span style={{ width: `${readiness?.score ?? 0}%` }} />
          </div>
          <div className="security-readiness-meta">
            <span>{readiness ? copy.readinessChecks(readiness.summary.passed, readiness.summary.totalChecks) : copy.waitingRefresh}</span>
            <span>{readiness ? copy.readinessIssues(readiness.summary.failures, readiness.summary.warnings) : copy.readinessCalculating}</span>
          </div>
          <p>{readiness?.nextBestAction ?? copy.readinessCalculating}</p>
          {readiness && (
            <div className="security-readiness-trend">
              <span>{copy.readinessTrend(readiness.history.trend.direction, readiness.history.trend.deltaScore)}</span>
              <span>{copy.readinessSnapshotCount(readiness.history.trend.snapshotCount)}</span>
              {readiness.history.trend.changedBlockers.length > 0 && (
                <span>{copy.readinessChangedBlockers(readiness.history.trend.changedBlockers.length)}</span>
              )}
            </div>
          )}
          {readiness && readiness.blockers.length > 0 && (
            <div className="security-readiness-blockers">
              {readiness.blockers.slice(0, 3).map((check) => (
                <button
                  key={check.id}
                  type="button"
                  className={`security-readiness-blocker ${check.severity}`}
                  onClick={() => applyReadinessFilter(check)}
                >
                  <span>{check.label}</span>
                  <strong>{check.value}</strong>
                  <small>{check.evidence}</small>
                </button>
              ))}
            </div>
          )}
          <div className="security-readiness-actions">
            <button type="button" className="tool-button" onClick={handleRecordReadinessSnapshot} disabled={recordingSnapshot || !readiness}>
              <Clock3 size={15} />
              {recordingSnapshot ? copy.snapshotRecording : copy.snapshotRecord}
            </button>
            <button type="button" className="tool-button" onClick={exportReadinessReport} disabled={exportingReadinessReport || !readiness}>
              <Download size={15} />
              {exportingReadinessReport ? copy.reportExporting : copy.reportExport}
            </button>
          </div>
        </div>
      </article>

      <div className="security-kpi-grid">
        <article className={riskyCount > 0 ? 'warn' : 'ok'}>
          <span>{riskyCount > 0 ? <AlertTriangle size={16} /> : <ShieldCheck size={16} />} {copy.riskPosture}</span>
          <strong>{riskyCount}</strong>
          <small>{riskyCount > 0 ? copy.hasRisk : copy.noRisk}</small>
        </article>
        <article>
          <span><ShieldAlert size={16} /> {copy.auditRecords}</span>
          <strong>{auditEntries.length}</strong>
          <small>{lastRefreshedAt ? copy.updated(lastRefreshedAt.toLocaleTimeString(locale)) : copy.waitingRefresh}</small>
        </article>
        <article className={blockedCount > 0 ? 'warn' : ''}>
          <span><XCircle size={16} /> {copy.blockedFailed}</span>
          <strong>{blockedCount + failedCount}</strong>
          <small>{copy.blockedFailedCount(blockedCount, failedCount)}</small>
        </article>
        <article className={successRate >= 90 ? 'ok' : 'warn'}>
          <span><CheckCircle2 size={16} /> {copy.successRate}</span>
          <strong>{successRate}%</strong>
          <small>{copy.recentAudits(auditEntries.length)}</small>
        </article>
      </div>

      <article className="security-remediation-card" id="security-remediation">
        <div className="security-audit-toolbar">
          <h3><Wrench size={18} /> {copy.remediationTitle}</h3>
          <span>{riskActions.length > 0 ? copy.remediationCount(riskActions.length) : copy.remediationClear}</span>
        </div>
        {riskActions.length > 0 ? (
          <div className="security-remediation-list">
            {riskActions.map((action) => (
              <div key={action.id} className={`security-remediation-item ${action.severity}`}>
                <span>{action.severity === 'fail' ? <XCircle size={16} /> : <AlertTriangle size={16} />}</span>
                <div>
                  <strong>{action.title}</strong>
                  <small>{action.detail}</small>
                </div>
                <button type="button" className="tool-button" disabled={remediatingId === action.id} onClick={() => handleRiskAction(action)}>
                  {remediatingId === action.id ? copy.remediating : action.actionLabel}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="quiet-state">{copy.noRemediation}</div>
        )}
      </article>

      <div className="security-control-grid">
        <article className="security-control-card">
          <h3><Fingerprint size={18} /> {copy.identityAccess}</h3>
          <div className="security-check-list">
            {checks.map((check) => (
              <div key={check.id} className={`security-check ${check.state}`}>
                {check.state === 'pass' ? <CheckCircle2 size={16} /> : check.state === 'warn' ? <AlertTriangle size={16} /> : <XCircle size={16} />}
                <span>
                  <strong>{check.title}</strong>
                  <small>{check.detail}</small>
                </span>
              </div>
            ))}
          </div>
        </article>

        <article className="security-control-card">
          <h3><SlidersHorizontal size={18} /> {t('security.runtimeConfig')}</h3>
          {config ? (
            <div className="config-list security-config-list">
              {runtimeItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={relationFilter === item.key ? `security-config-row active ${item.state}` : `security-config-row ${item.state}`}
                  onClick={() => applyRelationFilter(item.key)}
                >
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                  <small>{item.detail}</small>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted">{t('security.configUnavailable')}</p>
          )}
        </article>

        <article className="security-control-card">
          <h3><LockKeyhole size={18} /> {copy.secretsProxy}</h3>
          <div className="security-policy-grid">
            {secretItems.map((item) => (
              <button
                key={item.key}
                type="button"
                className={relationFilter === item.key ? `security-policy-item active ${item.state}` : `security-policy-item ${item.state}`}
                onClick={() => applyRelationFilter(item.key)}
              >
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.detail}</small>
              </button>
            ))}
          </div>
        </article>
      </div>

      <div className="security-audit-workspace">
        <article className="security-audit-list-card">
          <div className="security-audit-toolbar">
            <h3><ShieldAlert size={18} /> {t('security.recentAudit')}</h3>
            <div className="segmented" role="group" aria-label={copy.auditFilter}>
              {(['all', 'success', 'blocked', 'failed'] as AuditStatusFilter[]).map((status) => (
                <button
                  key={status}
                  type="button"
                  className={statusFilter === status ? 'active' : ''}
                  onClick={() => setStatusFilter(status)}
                >
                  {status === 'all' ? t('common.all') : copy.auditStatus(status)}
                </button>
              ))}
            </div>
          </div>
          {selectedRelation && (
            <div className="security-relation-banner">
              <span>{copy.relationApplied(selectedRelation.label, selectedRelation.count)}</span>
              <button type="button" onClick={clearRelationFilter}>{copy.clearRelation}</button>
            </div>
          )}
          <label className="security-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setRelationFilter(null);
              }}
              placeholder={copy.searchPlaceholder}
            />
          </label>
          <div className="security-audit-list">
            {filteredAudits.length === 0 ? (
              <div className="quiet-state">{t('security.noAudit')}</div>
            ) : (
              filteredAudits.slice(0, 30).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={selectedAudit?.id === entry.id ? `security-audit-row active ${entry.status}` : `security-audit-row ${entry.status}`}
                  onClick={() => setSelectedAuditId(entry.id)}
                >
                  <span className={`audit-status-dot ${entry.status}`} />
                  <span>
                    <strong>{entry.action}</strong>
                    <small>{entry.target}</small>
                  </span>
                  <b>{copy.auditStatus(entry.status)}</b>
                  <time>{formatAuditTime(entry.createdAt, locale)}</time>
                </button>
              ))
            )}
          </div>
        </article>

        <article className="security-audit-detail-card">
          <h3><Clock3 size={18} /> {copy.auditDetail}</h3>
          {selectedAudit ? (
            <div className={`security-audit-detail ${selectedAudit.status}`}>
              <span className={`status-pill ${selectedAudit.status === 'success' ? 'running' : selectedAudit.status === 'blocked' ? 'warning' : 'critical'}`}>
                {copy.auditStatus(selectedAudit.status)}
              </span>
              <strong>{selectedAudit.action}</strong>
              {selectedAuditInsight && (
                <div className={`security-audit-insight ${selectedAuditInsight.severity}`}>
                  <span>{selectedAuditInsight.domain}</span>
                  <strong>{selectedAuditInsight.reason}</strong>
                  <small>{selectedAuditInsight.nextStep}</small>
                </div>
              )}
              <dl>
                <div>
                  <dt>{copy.actor}</dt>
                  <dd>{selectedAudit.actor}</dd>
                </div>
                <div>
                  <dt>{copy.target}</dt>
                  <dd>{selectedAudit.target}</dd>
                </div>
                <div>
                  <dt>{copy.time}</dt>
                  <dd>{new Date(selectedAudit.createdAt).toLocaleString(locale)}</dd>
                </div>
                <div>
                  <dt>{copy.detail}</dt>
                  <dd>{selectedAudit.detail}</dd>
                </div>
              </dl>
            </div>
          ) : (
            <div className="quiet-state">{copy.selectAudit}</div>
          )}
        </article>
      </div>
    </section>
  );
}

function buildSecurityChecks(
  config: ConfigSummary | null,
  auditEntries: AuditEntry[],
  openEvents: OperationEvent[],
  copy: SecurityCopy,
): SecurityCheck[] {
  const auditIssues = getActiveAuditIssues(auditEntries);
  const defaultSecretCount = getDefaultSecretCount(config);
  return [
    {
      id: 'runtime-secrets',
      title: copy.runtimeSecrets,
      detail: defaultSecretCount > 0 ? copy.defaultSecretsDetected(defaultSecretCount) : copy.runtimeSecretsManaged,
      state: defaultSecretCount > 0 ? 'fail' : 'pass',
    },
    {
      id: 'ai-key',
      title: copy.aiKey,
      detail: config?.ai.configured ? copy.aiKeyManaged : copy.aiSimulatedDetail,
      state: config?.ai.configured ? 'pass' : 'warn',
    },
    {
      id: 'api-allowlist',
      title: copy.apiAllowlist,
      detail: config?.customApiAllowedHosts.length ? config.customApiAllowedHosts.join(', ') : copy.noAllowedHosts,
      state: config?.customApiAllowedHosts.length ? 'pass' : 'fail',
    },
    {
      id: 'audit-errors',
      title: copy.auditBlocks,
      detail: copy.blockedFailedCount(auditIssues.blocked, auditIssues.failed),
      state: auditIssues.failed > 0 ? 'fail' : auditIssues.blocked > 0 ? 'warn' : 'pass',
    },
    {
      id: 'events',
      title: copy.openEvents,
      detail: copy.openEventCount(openEvents.length),
      state: openEvents.length > 0 ? 'warn' : 'pass',
    },
  ];
}

function buildSecurityRiskActions(
  checks: SecurityCheck[],
  auditEntries: AuditEntry[],
  openEvents: OperationEvent[],
  copy: SecurityCopy,
): SecurityRiskAction[] {
  const actions: SecurityRiskAction[] = [];

  for (const check of checks.filter((item) => item.state !== 'pass')) {
    if (check.id === 'ai-key') {
      actions.push({
        id: `check-${check.id}`,
        title: check.title,
        detail: check.detail,
        severity: check.state === 'fail' ? 'fail' : 'warn',
        actionLabel: copy.goConfigureAi,
        actionType: 'navigate',
        target: check.id,
        navigateTo: 'ai',
      });
    } else if (check.id === 'api-allowlist') {
      actions.push({
        id: `check-${check.id}`,
        title: check.title,
        detail: check.detail,
        severity: check.state === 'fail' ? 'fail' : 'warn',
        actionLabel: copy.goConfigureApi,
        actionType: 'navigate',
        target: check.id,
        navigateTo: 'api',
      });
    } else if (check.id === 'audit-errors') {
      actions.push({
        id: `check-${check.id}`,
        title: check.title,
        detail: check.detail,
        severity: check.state === 'fail' ? 'fail' : 'warn',
        actionLabel: copy.reviewAndClose,
        actionType: 'acknowledgeAuditFailures',
        target: check.id,
      });
    } else if (check.id === 'events') {
      actions.push({
        id: `check-${check.id}`,
        title: check.title,
        detail: check.detail,
        severity: check.state === 'fail' ? 'fail' : 'warn',
        actionLabel: copy.closeEvents,
        actionType: 'closeOpenEvents',
        target: check.id,
      });
    } else {
      actions.push({
        id: `check-${check.id}`,
        title: check.title,
        detail: check.detail,
        severity: check.state === 'fail' ? 'fail' : 'warn',
        actionLabel: copy.markReviewed,
        actionType: 'acknowledgeCheck',
        target: check.id,
      });
    }
  }

  for (const entry of getActiveAuditEntries(auditEntries).slice(0, 8)) {
    const insight = buildAuditInsight(entry, copy);
    actions.push({
      id: `audit-${entry.id}`,
      title: `${entry.action} / ${copy.auditStatus(entry.status)}`,
      detail: `${insight.reason}: ${entry.detail}`,
      severity: entry.status === 'failed' ? 'fail' : 'warn',
      actionLabel: getAuditNavigationLabel(entry, copy),
      actionType: 'navigate',
      target: entry.id,
      navigateTo: getAuditNavigationTarget(entry),
    });
  }

  if (openEvents.length > 0 && !actions.some((action) => action.actionType === 'closeOpenEvents')) {
    actions.push({
      id: 'events-open',
      title: copy.openEvents,
      detail: copy.openEventCount(openEvents.length),
      severity: 'warn',
      actionLabel: copy.closeEvents,
      actionType: 'closeOpenEvents',
      target: 'events',
    });
  }

  return actions;
}

function getActiveAuditIssues(auditEntries: AuditEntry[]) {
  const items = getActiveAuditEntries(auditEntries);
  return {
    blocked: items.filter((entry) => entry.status === 'blocked').length,
    failed: items.filter((entry) => entry.status === 'failed').length,
    total: items.length,
  };
}

function getActiveAuditEntries(auditEntries: AuditEntry[]) {
  const lastAuditReview = getLastRemediationTime(auditEntries, 'audit-errors');
  return auditEntries.filter((entry) => {
    if (entry.action === 'SECURITY_REMEDIATION') {
      return false;
    }

    if (lastAuditReview && new Date(entry.createdAt).getTime() <= lastAuditReview) {
      return false;
    }

    return entry.status === 'blocked' || entry.status === 'failed';
  });
}

function getLastRemediationTime(auditEntries: AuditEntry[], target: string) {
  const remediation = auditEntries.find((entry) => entry.action === 'SECURITY_REMEDIATION' && entry.target === target);
  return remediation ? new Date(remediation.createdAt).getTime() : 0;
}

function getAuditNavigationTarget(entry: AuditEntry): SecurityRiskAction['navigateTo'] {
  const action = entry.action.toUpperCase();
  if (action.startsWith('AI_')) {
    return 'ai';
  }
  if (action === 'CUSTOM_API_TEST') {
    return 'api';
  }
  if (action.startsWith('SERVER_')) {
    return 'servers';
  }
  if (action === 'OPERATIONS_TASK') {
    return 'operations';
  }
  return 'security';
}

function getAuditNavigationLabel(entry: AuditEntry, copy: SecurityCopy) {
  const target = getAuditNavigationTarget(entry);
  if (target === 'ai') {
    return copy.goConfigureAi;
  }
  if (target === 'api') {
    return copy.goConfigureApi;
  }
  if (target === 'servers') {
    return copy.goServers;
  }
  if (target === 'operations') {
    return copy.goOperations;
  }
  return copy.markReviewed;
}

function buildSecurityRelationItems(
  config: ConfigSummary | null,
  auditEntries: AuditEntry[],
  copy: SecurityCopy,
): SecurityRelationItem[] {
  const count = (key: SecurityRelationKey) => auditEntries.filter((entry) => isAuditRelated(entry, key, config)).length;
  const apiHosts = config?.customApiAllowedHosts ?? [];
  const corsOrigins = config?.corsOrigins ?? [];
  const apiHostText = apiHosts.length ? apiHosts.join(', ') : copy.noAllowedHosts;
  const corsOriginText = corsOrigins.length ? corsOrigins.join(', ') : copy.notConfigured;
  const timeoutMs = config?.customApiTimeoutMs ?? 0;
  const defaultSecretCount = getDefaultSecretCount(config);

  return [
    {
      key: 'runtime',
      label: copy.environment,
      value: config?.nodeEnv ? config.nodeEnv.toUpperCase() : copy.unavailable,
      detail: copy.linkedAudits(count('runtime')),
      state: config?.nodeEnv === 'production' ? 'pass' : 'warn',
      count: count('runtime'),
    },
    {
      key: 'cors',
      label: copy.corsPolicy,
      value: corsOrigins.length ? copy.corsOriginCount(corsOrigins.length) : copy.notConfigured,
      detail: copy.configRelationDetail(corsOriginText, count('cors')),
      state: corsOrigins.length ? 'pass' : 'warn',
      count: count('cors'),
    },
    {
      key: 'timeout',
      label: copy.requestTimeout,
      value: timeoutMs ? copy.timeoutMs(timeoutMs) : copy.unavailable,
      detail: copy.linkedAudits(count('timeout')),
      state: timeoutMs > 0 && timeoutMs <= 15000 ? 'pass' : 'warn',
      count: count('timeout'),
    },
    {
      key: 'secrets',
      label: copy.runtimeSecrets,
      value: defaultSecretCount > 0 ? copy.defaultSecretsDetected(defaultSecretCount) : copy.runtimeSecretsManaged,
      detail: copy.secretPostureDetail(config?.security.credentialEncryptionKeyConfigured === true),
      state: defaultSecretCount > 0 ? 'fail' : 'pass',
      count: count('secrets'),
    },
    {
      key: 'ai',
      label: copy.aiRuntime,
      value: config?.ai.configured ? config.ai.model : copy.simulated,
      detail: copy.configRelationDetail(config?.ai.baseUrl ?? copy.unavailable, count('ai')),
      state: config?.ai.configured ? 'pass' : 'warn',
      count: count('ai'),
    },
    {
      key: 'api',
      label: copy.apiProxy,
      value: apiHosts.length ? copy.apiHostCount(apiHosts.length) : copy.notConfigured,
      detail: copy.configRelationDetail(apiHostText, count('api')),
      state: apiHosts.length ? 'pass' : 'fail',
      count: count('api'),
    },
    {
      key: 'ssh',
      label: copy.sshCredential,
      value: copy.localEncryptedCache,
      detail: count('ssh') > 0 ? copy.linkedAudits(count('ssh')) : copy.noSshAudit,
      state: count('ssh') > 0 ? 'pass' : 'warn',
      count: count('ssh'),
    },
  ];
}

function isAuditRelated(entry: AuditEntry, relation: SecurityRelationKey, config: ConfigSummary | null) {
  const action = entry.action.toUpperCase();
  const haystack = `${entry.action} ${entry.actor} ${entry.target} ${entry.detail}`.toLowerCase();

  if (relation === 'runtime') {
    return action === 'HEALTH_CHECK' || action === 'CLOUD_SYNC' || action.startsWith('AUTH_') || haystack.includes('runtime') || haystack.includes('auth');
  }

  if (relation === 'ai') {
    return action.startsWith('AI_') || /\bai\b/.test(haystack);
  }

  if (relation === 'api') {
    return action === 'CUSTOM_API_TEST' || haystack.includes('custom api');
  }

  if (relation === 'cors') {
    const corsOrigins = config?.corsOrigins ?? [];
    return haystack.includes('cors') || corsOrigins.some((origin) => origin && haystack.includes(origin.toLowerCase()));
  }

  if (relation === 'timeout') {
    return haystack.includes('timeout') || haystack.includes('timed out');
  }

  if (relation === 'secrets') {
    return action.startsWith('AUTH_') || action === 'PROFILE_UPDATE' || haystack.includes('secret') || haystack.includes('password') || haystack.includes('credential');
  }

  return (
    action === 'SERVER_SSH_VERIFY'
    || action === 'SERVER_SSH_DIAGNOSTIC'
    || action === 'SERVER_SSH_COMMAND'
    || action === 'SERVER_ACTION'
    || haystack.includes('ssh')
  );
}

function getDefaultSecretCount(config: ConfigSummary | null) {
  if (!config) {
    return 0;
  }
  return [
    config.security.adminPasswordDefault,
    config.security.sessionSecretDefault,
    config.security.credentialEncryptionKeyDefault,
  ].filter(Boolean).length;
}

function buildAuditInsight(entry: AuditEntry, copy: SecurityCopy): AuditInsight {
  const action = entry.action.toUpperCase();
  const failedOrBlocked = entry.status === 'failed' || entry.status === 'blocked';
  const highRisk = entry.status === 'failed' || (entry.status === 'blocked' && (action.includes('SERVER_ACTION') || action.includes('CUSTOM_API')));
  const severity: AuditInsight['severity'] = highRisk ? 'high' : failedOrBlocked ? 'medium' : 'low';

  if (action.startsWith('AUTH_')) {
    return {
      domain: copy.auditDomainAuth,
      severity,
      reason: failedOrBlocked ? copy.auditReasonAuthRisk : copy.auditReasonAuthOk,
      nextStep: failedOrBlocked ? copy.auditNextAuthRisk : copy.auditNextAuthOk,
    };
  }

  if (action.startsWith('AI_')) {
    return {
      domain: copy.auditDomainAi,
      severity,
      reason: failedOrBlocked ? copy.auditReasonAiRisk : copy.auditReasonAiOk,
      nextStep: failedOrBlocked ? copy.auditNextAiRisk : copy.auditNextAiOk,
    };
  }

  if (action === 'CUSTOM_API_TEST') {
    return {
      domain: copy.auditDomainApi,
      severity,
      reason: failedOrBlocked ? copy.auditReasonApiRisk : copy.auditReasonApiOk,
      nextStep: failedOrBlocked ? copy.auditNextApiRisk : copy.auditNextApiOk,
    };
  }

  if (action.startsWith('SERVER_') || action === 'OPERATIONS_TASK') {
    return {
      domain: action === 'OPERATIONS_TASK' ? copy.auditDomainOps : copy.auditDomainSsh,
      severity,
      reason: failedOrBlocked ? copy.auditReasonSshRisk : copy.auditReasonSshOk,
      nextStep: failedOrBlocked ? copy.auditNextSshRisk : copy.auditNextSshOk,
    };
  }

  return {
    domain: copy.auditDomainRuntime,
    severity,
    reason: failedOrBlocked ? copy.auditReasonRuntimeRisk : copy.auditReasonRuntimeOk,
    nextStep: failedOrBlocked ? copy.auditNextRuntimeRisk : copy.auditNextRuntimeOk,
  };
}

function formatAuditTime(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

interface SecurityCopy {
  refresh: string;
  exportAudit: string;
  riskPosture: string;
  hasRisk: string;
  noRisk: string;
  auditRecords: string;
  waitingRefresh: string;
  blockedFailed: string;
  successRate: string;
  identityAccess: string;
  secretsProxy: string;
  runtimeSecrets: string;
  runtimeSecretsManaged: string;
  configured: string;
  simulated: string;
  localEncryptedCache: string;
  auditFilter: string;
  searchPlaceholder: string;
  auditDetail: string;
  actor: string;
  target: string;
  time: string;
  detail: string;
  selectAudit: string;
  aiKey: string;
  aiKeyManaged: string;
  aiSimulatedDetail: string;
  apiAllowlist: string;
  noAllowedHosts: string;
  environment: string;
  corsPolicy: string;
  requestTimeout: string;
  aiRuntime: string;
  apiProxy: string;
  sshCredential: string;
  unavailable: string;
  notConfigured: string;
  noSshAudit: string;
  clearRelation: string;
  loadFailed: string;
  auditBlocks: string;
  openEvents: string;
  auditDomainAuth: string;
  auditDomainAi: string;
  auditDomainApi: string;
  auditDomainSsh: string;
  auditDomainOps: string;
  auditDomainRuntime: string;
  auditReasonAuthRisk: string;
  auditReasonAuthOk: string;
  auditNextAuthRisk: string;
  auditNextAuthOk: string;
  auditReasonAiRisk: string;
  auditReasonAiOk: string;
  auditNextAiRisk: string;
  auditNextAiOk: string;
  auditReasonApiRisk: string;
  auditReasonApiOk: string;
  auditNextApiRisk: string;
  auditNextApiOk: string;
  auditReasonSshRisk: string;
  auditReasonSshOk: string;
  auditNextSshRisk: string;
  auditNextSshOk: string;
  auditReasonRuntimeRisk: string;
  auditReasonRuntimeOk: string;
  auditNextRuntimeRisk: string;
  auditNextRuntimeOk: string;
  remediationTitle: string;
  remediationClear: string;
  noRemediation: string;
  remediating: string;
  remediationFailed: string;
  snapshotRecord: string;
  snapshotRecording: string;
  snapshotFailed: string;
  reportExport: string;
  reportExporting: string;
  reportExported: string;
  reportFailed: string;
  goConfigureAi: string;
  goConfigureApi: string;
  goServers: string;
  goOperations: string;
  markReviewed: string;
  reviewAndClose: string;
  closeEvents: string;
  readinessTitle: string;
  readinessCalculating: string;
  riskItems: (count: number) => string;
  readinessChecks: (passed: number, total: number) => string;
  readinessIssues: (failures: number, warnings: number) => string;
  readinessStatus: (status: ReleaseReadinessResponse['status']) => string;
  readinessTrend: (direction: ReleaseReadinessResponse['history']['trend']['direction'], deltaScore: number) => string;
  readinessSnapshotCount: (count: number) => string;
  readinessChangedBlockers: (count: number) => string;
  snapshotRecorded: (score: number) => string;
  remediationCount: (count: number) => string;
  remediationDone: (title: string) => string;
  updated: (time: string) => string;
  recentAudits: (count: number) => string;
  openEventCount: (count: number) => string;
  linkedAudits: (count: number) => string;
  configRelationDetail: (value: string, count: number) => string;
  defaultSecretsDetected: (count: number) => string;
  secretPostureDetail: (credentialKeyConfigured: boolean) => string;
  blockedFailedCount: (blocked: number, failed: number) => string;
  relationApplied: (label: string, count: number) => string;
  apiHostCount: (count: number) => string;
  corsOriginCount: (count: number) => string;
  timeoutMs: (ms: number) => string;
  auditStatus: (status: AuditStatusFilter) => string;
}

const securityCopyByLanguage: Record<string, SecurityCopy> = {
  zh: {
    refresh: '刷新',
    exportAudit: '导出审计',
    riskPosture: '风险态势',
    hasRisk: '存在需处理项',
    noRisk: '当前无明显风险',
    auditRecords: '审计记录',
    waitingRefresh: '等待刷新',
    blockedFailed: '阻断/失败',
    successRate: '成功率',
    identityAccess: '身份与访问',
    secretsProxy: '密钥与代理',
    runtimeSecrets: '运行时密钥姿态',
    runtimeSecretsManaged: '未使用内置默认值',
    configured: '已配置',
    simulated: '模拟模式',
    localEncryptedCache: '本地加密缓存',
    auditFilter: '审计状态筛选',
    searchPlaceholder: '搜索 action / target / detail',
    auditDetail: '审计详情',
    actor: '操作者',
    target: '目标',
    time: '时间',
    detail: '详情',
    selectAudit: '选择一条审计记录查看详情',
    aiKey: 'AI 调用密钥',
    aiKeyManaged: 'AI Key 已由服务端托管',
    aiSimulatedDetail: '当前为模拟模式，不会向真实模型发送密钥请求',
    apiAllowlist: '自定义 API 白名单',
    noAllowedHosts: '未配置可调用域名',
    environment: '运行环境',
    corsPolicy: 'CORS 来源',
    requestTimeout: '请求超时',
    aiRuntime: 'AI 模型',
    apiProxy: 'API 代理',
    sshCredential: 'SSH 凭据',
    unavailable: '不可用',
    notConfigured: '未配置',
    noSshAudit: '暂无 SSH 关联审计',
    clearRelation: '显示全部',
    loadFailed: '安全配置或审计记录加载失败',
    auditBlocks: '阻断与失败审计',
    openEvents: '待处理事件',
    auditDomainAuth: '认证访问',
    auditDomainAi: 'AI 调用',
    auditDomainApi: '自定义 API',
    auditDomainSsh: '服务器 / SSH',
    auditDomainOps: '运维编排',
    auditDomainRuntime: '运行环境',
    auditReasonAuthRisk: '认证链路出现失败或阻断',
    auditReasonAuthOk: '认证链路正常完成',
    auditNextAuthRisk: '检查来源、账号和登录频率，必要时轮换管理员密码。',
    auditNextAuthOk: '保留记录用于追踪登录与退出链路。',
    auditReasonAiRisk: 'AI 请求或连通性检查未成功',
    auditReasonAiOk: 'AI 调用链路已通过审计',
    auditNextAiRisk: '检查 API Key、模型名称和上游 Base URL。',
    auditNextAiOk: '持续观察模型返回和密钥托管状态。',
    auditReasonApiRisk: '自定义 API 请求被阻断或失败',
    auditReasonApiOk: '自定义 API 请求通过代理策略',
    auditNextApiRisk: '核对允许域名、请求头和 SSRF 防护命中原因。',
    auditNextApiOk: '保留允许域名与响应记录，便于追踪外部依赖。',
    auditReasonSshRisk: '服务器命令、动作或 SSH 验证未完成',
    auditReasonSshOk: '服务器操作已按策略执行',
    auditNextSshRisk: '检查服务器是否已接入、凭据是否仍有效、危险动作是否确认。',
    auditNextSshOk: '可在服务器模块继续执行诊断或查看目标资产。',
    auditReasonRuntimeRisk: '运行环境或系统任务出现异常',
    auditReasonRuntimeOk: '运行环境事件已正常记录',
    auditNextRuntimeRisk: '检查服务配置、CORS、超时和系统健康状态。',
    auditNextRuntimeOk: '继续保持周期性巡检。',
    remediationTitle: '风险处置',
    remediationClear: '暂无待处置',
    noRemediation: '当前没有需要处理的风险项。',
    remediating: '处理中',
    remediationFailed: '处置失败',
    snapshotRecord: '记录本轮快照',
    snapshotRecording: '记录中',
    snapshotFailed: '快照记录失败',
    reportExport: '导出巡检报告',
    reportExporting: '导出中',
    reportExported: '巡检报告已生成',
    reportFailed: '巡检报告导出失败',
    goConfigureAi: '去配置 AI',
    goConfigureApi: '去配置 API',
    goServers: '去服务器',
    goOperations: '去编排',
    markReviewed: '标记已复核',
    reviewAndClose: '复核并闭环',
    closeEvents: '关闭事件',
    readinessTitle: '上线就绪评分',
    readinessCalculating: '正在汇总运行时、审计、SSH、AI 和 API 证据',
    riskItems: (count) => `${count} 风险项`,
    readinessChecks: (passed, total) => `${passed}/${total} 项通过`,
    readinessIssues: (failures, warnings) => `${failures} 阻断 / ${warnings} 预警`,
    readinessStatus: (status) => ({
      ready: '可发布',
      review: '需复核',
      blocked: '阻断发布',
    })[status],
    readinessTrend: (direction, deltaScore) => ({
      up: `较上轮提升 ${deltaScore} 分`,
      down: `较上轮下降 ${Math.abs(deltaScore)} 分`,
      flat: '较上轮持平',
      new: '暂无历史趋势',
    })[direction],
    readinessSnapshotCount: (count) => `${count} 条快照`,
    readinessChangedBlockers: (count) => `${count} 项阻断变化`,
    snapshotRecorded: (score) => `已记录上线就绪快照：${score} 分`,
    remediationCount: (count) => `${count} 项可处理`,
    remediationDone: (title) => `已处理：${title}`,
    updated: (time) => `更新 ${time}`,
    recentAudits: (count) => `最近 ${count} 条审计`,
    openEventCount: (count) => `${count} 个待处理事件`,
    linkedAudits: (count) => `${count} 条关联审计`,
    configRelationDetail: (value, count) => `${value} / ${count} 条关联审计`,
    defaultSecretsDetected: (count) => `${count} 项默认密钥风险`,
    secretPostureDetail: (credentialKeyConfigured) => credentialKeyConfigured ? '管理员密码、会话密钥和 SSH 凭据加密 Key 均由运行环境托管' : '管理员密码和会话密钥已检查，建议配置专用 SSH 凭据加密 Key',
    blockedFailedCount: (blocked, failed) => `${blocked} 个阻断 / ${failed} 个失败`,
    relationApplied: (label, count) => `正在查看「${label}」关联审计，共 ${count} 条`,
    apiHostCount: (count) => `${count} 个允许域名`,
    corsOriginCount: (count) => `${count} 个来源`,
    timeoutMs: (ms) => `${ms} ms`,
    auditStatus: (status) => ({
      all: '全部',
      success: '成功',
      blocked: '已阻断',
      failed: '失败',
    })[status],
  },
  en: {
    refresh: 'Refresh',
    exportAudit: 'Export audit',
    riskPosture: 'Risk posture',
    hasRisk: 'Action required',
    noRisk: 'No obvious risk',
    auditRecords: 'Audit records',
    waitingRefresh: 'Waiting for refresh',
    blockedFailed: 'Blocked / Failed',
    successRate: 'Success rate',
    identityAccess: 'Identity and access',
    secretsProxy: 'Secrets and proxy',
    runtimeSecrets: 'Runtime secret posture',
    runtimeSecretsManaged: 'No built-in defaults',
    configured: 'Configured',
    simulated: 'Simulated',
    localEncryptedCache: 'Local encrypted cache',
    auditFilter: 'Audit status filter',
    searchPlaceholder: 'Search action / target / detail',
    auditDetail: 'Audit detail',
    actor: 'Actor',
    target: 'Target',
    time: 'Time',
    detail: 'Detail',
    selectAudit: 'Select an audit record to view details',
    aiKey: 'AI API key',
    aiKeyManaged: 'AI key is managed on the server',
    aiSimulatedDetail: 'Simulation mode is active; no real model request is sent',
    apiAllowlist: 'Custom API allowlist',
    noAllowedHosts: 'No callable host is configured',
    environment: 'Runtime',
    corsPolicy: 'CORS origins',
    requestTimeout: 'Request timeout',
    aiRuntime: 'AI model',
    apiProxy: 'API proxy',
    sshCredential: 'SSH credential',
    unavailable: 'Unavailable',
    notConfigured: 'Not configured',
    noSshAudit: 'No linked SSH audit yet',
    clearRelation: 'Show all',
    loadFailed: 'Failed to load security configuration or audit records',
    auditBlocks: 'Blocked and failed audits',
    openEvents: 'Open events',
    auditDomainAuth: 'Auth access',
    auditDomainAi: 'AI call',
    auditDomainApi: 'Custom API',
    auditDomainSsh: 'Server / SSH',
    auditDomainOps: 'Operations',
    auditDomainRuntime: 'Runtime',
    auditReasonAuthRisk: 'Authentication was blocked or failed',
    auditReasonAuthOk: 'Authentication completed normally',
    auditNextAuthRisk: 'Review source, account, and login frequency; rotate the admin password if needed.',
    auditNextAuthOk: 'Keep the record for login/logout traceability.',
    auditReasonAiRisk: 'AI request or connectivity check did not complete',
    auditReasonAiOk: 'AI call path is covered by audit',
    auditNextAiRisk: 'Check API key, model name, and upstream base URL.',
    auditNextAiOk: 'Continue watching model responses and server-side key handling.',
    auditReasonApiRisk: 'Custom API request was blocked or failed',
    auditReasonApiOk: 'Custom API request passed proxy policy',
    auditNextApiRisk: 'Review allowed host, request headers, and SSRF guard evidence.',
    auditNextApiOk: 'Keep allowlist and response evidence for external dependency tracking.',
    auditReasonSshRisk: 'Server command, action, or SSH verification did not complete',
    auditReasonSshOk: 'Server operation executed under policy',
    auditNextSshRisk: 'Check server connection state, credential validity, and dangerous-action confirmation.',
    auditNextSshOk: 'Continue with diagnostics or target asset review in the server module.',
    auditReasonRuntimeRisk: 'Runtime or system task showed an exception',
    auditReasonRuntimeOk: 'Runtime event was recorded normally',
    auditNextRuntimeRisk: 'Check service config, CORS, timeout, and health status.',
    auditNextRuntimeOk: 'Keep periodic patrol enabled.',
    remediationTitle: 'Risk remediation',
    remediationClear: 'Nothing to handle',
    noRemediation: 'No risk item requires action right now.',
    remediating: 'Handling',
    remediationFailed: 'Remediation failed',
    snapshotRecord: 'Record snapshot',
    snapshotRecording: 'Recording',
    snapshotFailed: 'Snapshot failed',
    reportExport: 'Export report',
    reportExporting: 'Exporting',
    reportExported: 'Readiness report generated',
    reportFailed: 'Report export failed',
    goConfigureAi: 'Configure AI',
    goConfigureApi: 'Configure API',
    goServers: 'Open servers',
    goOperations: 'Open operations',
    markReviewed: 'Mark reviewed',
    reviewAndClose: 'Review and close',
    closeEvents: 'Close events',
    readinessTitle: 'Release readiness',
    readinessCalculating: 'Aggregating runtime, audit, SSH, AI, and API evidence',
    riskItems: (count) => `${count} risk items`,
    readinessChecks: (passed, total) => `${passed}/${total} checks passed`,
    readinessIssues: (failures, warnings) => `${failures} blockers / ${warnings} warnings`,
    readinessStatus: (status) => ({
      ready: 'Ready',
      review: 'Needs review',
      blocked: 'Blocked',
    })[status],
    readinessTrend: (direction, deltaScore) => ({
      up: `Up ${deltaScore} points from last run`,
      down: `Down ${Math.abs(deltaScore)} points from last run`,
      flat: 'Flat against last run',
      new: 'No trend yet',
    })[direction],
    readinessSnapshotCount: (count) => `${count} snapshots`,
    readinessChangedBlockers: (count) => `${count} blocker changes`,
    snapshotRecorded: (score) => `Recorded readiness snapshot: ${score}`,
    remediationCount: (count) => `${count} actionable`,
    remediationDone: (title) => `Handled: ${title}`,
    updated: (time) => `Updated ${time}`,
    recentAudits: (count) => `Latest ${count} audits`,
    openEventCount: (count) => `${count} open events`,
    linkedAudits: (count) => `${count} linked audits`,
    configRelationDetail: (value, count) => `${value} / ${count} linked audits`,
    defaultSecretsDetected: (count) => `${count} default secret risks`,
    secretPostureDetail: (credentialKeyConfigured) => credentialKeyConfigured ? 'Admin password, session secret, and SSH credential key are environment-managed' : 'Admin password and session secret are checked; configure a dedicated SSH credential key',
    blockedFailedCount: (blocked, failed) => `${blocked} blocked / ${failed} failed`,
    relationApplied: (label, count) => `Viewing ${label} linked audits, ${count} total`,
    apiHostCount: (count) => `${count} allowed hosts`,
    corsOriginCount: (count) => `${count} origins`,
    timeoutMs: (ms) => `${ms} ms`,
    auditStatus: (status) => ({
      all: 'All',
      success: 'Success',
      blocked: 'Blocked',
      failed: 'Failed',
    })[status],
  },
  ja: {
    refresh: '更新',
    exportAudit: '監査を出力',
    riskPosture: 'リスク状況',
    hasRisk: '対応が必要',
    noRisk: '明確なリスクなし',
    auditRecords: '監査記録',
    waitingRefresh: '更新待ち',
    blockedFailed: 'ブロック/失敗',
    successRate: '成功率',
    identityAccess: 'ID とアクセス',
    secretsProxy: 'シークレットとプロキシ',
    runtimeSecrets: 'ランタイムシークレット状態',
    runtimeSecretsManaged: '組み込み既定値なし',
    configured: '設定済み',
    simulated: 'シミュレーション',
    localEncryptedCache: 'ローカル暗号化キャッシュ',
    auditFilter: '監査ステータスフィルター',
    searchPlaceholder: 'action / target / detail を検索',
    auditDetail: '監査詳細',
    actor: '実行者',
    target: '対象',
    time: '時刻',
    detail: '詳細',
    selectAudit: '監査記録を選択して詳細を表示',
    aiKey: 'AI API キー',
    aiKeyManaged: 'AI Key はサーバー側で管理されています',
    aiSimulatedDetail: 'シミュレーションモードのため実モデルへ送信しません',
    apiAllowlist: 'カスタム API 許可リスト',
    noAllowedHosts: '呼び出し可能なホストが未設定です',
    environment: '実行環境',
    corsPolicy: 'CORS オリジン',
    requestTimeout: 'リクエストタイムアウト',
    aiRuntime: 'AI モデル',
    apiProxy: 'API プロキシ',
    sshCredential: 'SSH 認証情報',
    unavailable: '利用不可',
    notConfigured: '未設定',
    noSshAudit: 'SSH 関連の監査はまだありません',
    clearRelation: 'すべて表示',
    loadFailed: 'セキュリティ設定または監査記録の読み込みに失敗しました',
    auditBlocks: 'ブロックと失敗の監査',
    openEvents: '未対応イベント',
    auditDomainAuth: '認証アクセス',
    auditDomainAi: 'AI 呼び出し',
    auditDomainApi: 'カスタム API',
    auditDomainSsh: 'サーバー / SSH',
    auditDomainOps: '運用編成',
    auditDomainRuntime: '実行環境',
    auditReasonAuthRisk: '認証がブロックまたは失敗しました',
    auditReasonAuthOk: '認証は正常に完了しました',
    auditNextAuthRisk: '送信元、アカウント、ログイン頻度を確認し、必要なら管理者パスワードを更新します。',
    auditNextAuthOk: 'ログイン/ログアウト追跡用に記録を保持します。',
    auditReasonAiRisk: 'AI リクエストまたは接続確認が完了しませんでした',
    auditReasonAiOk: 'AI 呼び出し経路は監査済みです',
    auditNextAiRisk: 'API Key、モデル名、上流 Base URL を確認します。',
    auditNextAiOk: 'モデル応答とサーバー側キー管理を継続監視します。',
    auditReasonApiRisk: 'カスタム API リクエストがブロックまたは失敗しました',
    auditReasonApiOk: 'カスタム API リクエストはプロキシ方針を通過しました',
    auditNextApiRisk: '許可ホスト、リクエストヘッダー、SSRF 防御の根拠を確認します。',
    auditNextApiOk: '許可リストと応答記録を外部依存の追跡に残します。',
    auditReasonSshRisk: 'サーバーコマンド、操作、SSH 検証が完了しませんでした',
    auditReasonSshOk: 'サーバー操作は方針に沿って実行されました',
    auditNextSshRisk: '接続状態、認証情報の有効性、危険操作の確認状態を確認します。',
    auditNextSshOk: 'サーバーモジュールで診断または対象資産の確認を続けられます。',
    auditReasonRuntimeRisk: '実行環境またはシステムタスクに例外があります',
    auditReasonRuntimeOk: '実行環境イベントは正常に記録されました',
    auditNextRuntimeRisk: 'サービス設定、CORS、タイムアウト、ヘルス状態を確認します。',
    auditNextRuntimeOk: '定期巡回を継続します。',
    remediationTitle: 'リスク対応',
    remediationClear: '対応不要',
    noRemediation: '現在対応が必要なリスク項目はありません。',
    remediating: '対応中',
    remediationFailed: '対応に失敗しました',
    snapshotRecord: 'スナップショットを記録',
    snapshotRecording: '記録中',
    snapshotFailed: 'スナップショット記録に失敗しました',
    reportExport: 'レポートを書き出す',
    reportExporting: '書き出し中',
    reportExported: '準備レポートを生成しました',
    reportFailed: 'レポート書き出しに失敗しました',
    goConfigureAi: 'AI を設定',
    goConfigureApi: 'API を設定',
    goServers: 'サーバーへ',
    goOperations: '運用へ',
    markReviewed: '確認済みにする',
    reviewAndClose: '確認して閉じる',
    closeEvents: 'イベントを閉じる',
    readinessTitle: 'リリース準備スコア',
    readinessCalculating: '実行環境、監査、SSH、AI、API の証拠を集計中',
    riskItems: (count) => `${count} 件のリスク`,
    readinessChecks: (passed, total) => `${passed}/${total} 件合格`,
    readinessIssues: (failures, warnings) => `${failures} 件ブロック / ${warnings} 件警告`,
    readinessStatus: (status) => ({
      ready: 'リリース可能',
      review: '確認が必要',
      blocked: 'ブロック中',
    })[status],
    readinessTrend: (direction, deltaScore) => ({
      up: `前回より ${deltaScore} 点向上`,
      down: `前回より ${Math.abs(deltaScore)} 点低下`,
      flat: '前回と同じ',
      new: '履歴はまだありません',
    })[direction],
    readinessSnapshotCount: (count) => `${count} 件のスナップショット`,
    readinessChangedBlockers: (count) => `${count} 件のブロッカー変更`,
    snapshotRecorded: (score) => `リリース準備スナップショットを記録しました: ${score}`,
    remediationCount: (count) => `${count} 件対応可能`,
    remediationDone: (title) => `対応済み: ${title}`,
    updated: (time) => `更新 ${time}`,
    recentAudits: (count) => `直近 ${count} 件の監査`,
    openEventCount: (count) => `${count} 件の未対応イベント`,
    linkedAudits: (count) => `${count} 件の関連監査`,
    configRelationDetail: (value, count) => `${value} / ${count} 件の関連監査`,
    defaultSecretsDetected: (count) => `${count} 件の既定シークレットリスク`,
    secretPostureDetail: (credentialKeyConfigured) => credentialKeyConfigured ? '管理者パスワード、セッションシークレット、SSH 資格情報キーは環境で管理されています' : '管理者パスワードとセッションシークレットは確認済みです。専用の SSH 資格情報キーを設定してください',
    blockedFailedCount: (blocked, failed) => `${blocked} 件ブロック / ${failed} 件失敗`,
    relationApplied: (label, count) => `${label} の関連監査を表示中、計 ${count} 件`,
    apiHostCount: (count) => `${count} 件の許可ホスト`,
    corsOriginCount: (count) => `${count} 件のオリジン`,
    timeoutMs: (ms) => `${ms} ms`,
    auditStatus: (status) => ({
      all: 'すべて',
      success: '成功',
      blocked: 'ブロック',
      failed: '失敗',
    })[status],
  },
};
