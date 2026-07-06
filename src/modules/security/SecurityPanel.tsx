import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
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
import { fetchDiagnosticExport, fetchReleaseReadiness, fetchReleaseReadinessReport, recordReleaseReadinessSnapshot, remediateSecurityRisk } from '../../services/apiClient';
import type { SecurityRemediationResponse } from '../../services/apiClient';
import type { DiagnosticExportResponse, ReleaseDeploymentEvidence, ReleaseReadinessResponse } from '../../types';

interface SecurityPanelProps {
  events: OperationEvent[];
  onNavigate: (section: 'overview' | 'servers' | 'operations' | 'ai' | 'api' | 'security') => void;
  onRemediated: () => void | Promise<void>;
  focusTraceId?: string;
  onTraceFocused?: () => void;
  onTraceFilterChange?: (correlationId: string) => void;
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
  correlationId?: string;
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

interface OperationAuditTrace {
  tone: 'ready' | 'blocked' | 'executed' | 'failed' | 'orphaned';
  statusLabel: string;
  preflight: AuditEntry | null;
  execution: AuditEntry | null;
  elapsedLabel: string;
  evidence: string;
  correlationLabel: string;
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

interface ReleaseEvidenceMetric {
  label: string;
  value: string;
  detail: string;
  tone: 'ok' | 'warn' | 'fail';
}

interface ReleaseEvidenceBrief {
  generatedLabel: string;
  metrics: ReleaseEvidenceMetric[];
  blockers: string[];
  deployment: ReleaseDeploymentEvidence | null;
  nextAction: string;
  text: string;
}

interface ReleaseFailurePlaybookItem {
  id: string;
  tone: 'ok' | 'warn' | 'fail';
  title: string;
  signal: string;
  action: string;
}

interface SshPerformanceMetric {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone: 'ok' | 'warn' | 'fail';
}

interface SshPerformanceGroup {
  id: 'track' | 'latency' | 'audit';
  title: string;
  metrics: SshPerformanceMetric[];
}

interface SshPerformanceSummary {
  tone: 'ok' | 'warn' | 'fail';
  status: string;
  nextAction: string;
  copyText: string;
  reportHeadline: string;
  reportFindings: string[];
  reportContext: string[];
  reportText: string;
  metrics: SshPerformanceMetric[];
  groups: SshPerformanceGroup[];
}

interface SshLagReportSnapshot {
  id: string;
  createdAt: string;
  tone?: SshPerformanceSummary['tone'];
  status: string;
  headline: string;
  context: string[];
  findings: string[];
  text: string;
}

interface SshLagReportComparison {
  tone: 'ok' | 'warn' | 'fail';
  title: string;
  detail: string;
  delta: string;
}

const sshLagReportHistoryStorageKey = 'colipas.sshLagReportHistory.v1';
const sshLagReportHistoryVisibleLimit = 5;

type SshSelfTestBottleneck = NonNullable<DiagnosticExportResponse['sshTerminal']['lastSelfTest']>['bottleneck'];

export function SecurityPanel({ events, onNavigate, onRemediated, focusTraceId, onTraceFocused, onTraceFilterChange }: SecurityPanelProps) {
  const { language, t } = useI18n();
  const copy = securityCopyByLanguage[language] ?? securityCopyByLanguage.zh;
  const diagnosticCopy = diagnosticCopyByLanguage[language] ?? diagnosticCopyByLanguage.zh;
  const sshPerformanceCopy = sshPerformanceCopyByLanguage[language] ?? sshPerformanceCopyByLanguage.zh;
  const locale = getLocale(language);
  const [config, setConfig] = useState<ConfigSummary | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [diagnosticBundle, setDiagnosticBundle] = useState<DiagnosticExportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<AuditStatusFilter>('all');
  const [relationFilter, setRelationFilter] = useState<SecurityRelationKey | null>(null);
  const [activeTraceId, setActiveTraceId] = useState('');
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
  const [exportingDiagnostic, setExportingDiagnostic] = useState(false);
  const [expandedSshMetricId, setExpandedSshMetricId] = useState('');
  const [sshLagReportHistory, setSshLagReportHistory] = useState<SshLagReportSnapshot[]>(() => loadSshLagReportHistory());

  const openEvents = useMemo(() => events.filter((event) => event.status === 'open'), [events]);
  const filteredAudits = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return auditEntries.filter((entry) => {
      const statusMatched = statusFilter === 'all' || entry.status === statusFilter;
      const relationMatched = !relationFilter || isAuditRelated(entry, relationFilter, config);
      const traceMatched = !activeTraceId || entry.correlationId === activeTraceId;
      const queryMatched = !normalizedQuery || [entry.action, entry.actor, entry.target, entry.detail, entry.correlationId]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery);
      return statusMatched && relationMatched && traceMatched && queryMatched;
    });
  }, [activeTraceId, auditEntries, config, query, relationFilter, statusFilter]);

  const selectedAudit = filteredAudits.find((entry) => entry.id === selectedAuditId)
    ?? filteredAudits[0]
    ?? null;
  const selectedAuditInsight = selectedAudit ? buildAuditInsight(selectedAudit, copy) : null;
  const selectedOperationTrace = useMemo(
    () => selectedAudit ? buildOperationAuditTrace(selectedAudit, auditEntries, copy, locale) : null,
    [auditEntries, copy, locale, selectedAudit],
  );
  const activeAuditIssues = useMemo(() => getActiveAuditIssues(auditEntries), [auditEntries]);
  const auditStatusSummary = useMemo(() => summarizeAuditStatus(auditEntries), [auditEntries]);
  const checks = useMemo(() => buildSecurityChecks(config, auditEntries, openEvents, copy), [auditEntries, config, openEvents, copy]);
  const riskActions = useMemo(() => buildSecurityRiskActions(checks, auditEntries, openEvents, copy), [auditEntries, checks, openEvents, copy]);
  const relationItems = useMemo(() => buildSecurityRelationItems(config, auditEntries, copy), [auditEntries, config, copy]);
  const relationGroups = useMemo(() => groupSecurityRelationItems(relationItems), [relationItems]);
  const selectedRelation = relationFilter ? relationItems.find((item) => item.key === relationFilter) ?? null : null;
  const { runtimeItems, secretItems } = relationGroups;
  const failedCount = activeAuditIssues.failed;
  const blockedCount = activeAuditIssues.blocked;
  const riskyCheckCount = useMemo(() => checks.reduce((count, check) => count + (check.state !== 'pass' ? 1 : 0), 0), [checks]);
  const riskyCount = riskyCheckCount + activeAuditIssues.total + openEvents.length;
  const successRate = auditStatusSummary.successRate;
  const evidenceBrief = useMemo(
    () => buildReleaseEvidenceBrief({
      readiness,
      auditTotal: auditEntries.length,
      activeAuditIssues,
      successRate,
      openEventCount: openEvents.length,
      lastRefreshedAt,
      copy,
      locale,
    }),
    [activeAuditIssues.blocked, activeAuditIssues.failed, activeAuditIssues.total, auditEntries.length, copy, lastRefreshedAt, locale, openEvents.length, readiness, successRate],
  );
  const sshPerformance = useMemo(
    () => buildSshPerformanceSummary(diagnosticBundle, sshPerformanceCopy, locale),
    [diagnosticBundle, locale, sshPerformanceCopy],
  );
  const sshLagReportComparison = useMemo(
    () => buildSshLagReportComparison(sshPerformance, sshLagReportHistory[0] ?? null, sshPerformanceCopy),
    [sshLagReportHistory, sshPerformance, sshPerformanceCopy],
  );
  const expandedSshMetric = useMemo(
    () => sshPerformance.metrics.find((metric) => metric.id === expandedSshMetricId) ?? sshPerformance.metrics[0] ?? null,
    [expandedSshMetricId, sshPerformance.metrics],
  );

  useEffect(() => {
    refreshSecurityData().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!focusTraceId) {
      return;
    }

    setActiveTraceId(focusTraceId);
    setRelationFilter(null);
    setQuery('');
    setStatusFilter('all');
    const firstMatchedAudit = auditEntries.find((entry) => entry.correlationId === focusTraceId);
    setSelectedAuditId(firstMatchedAudit?.id ?? '');
    onTraceFilterChange?.(focusTraceId);
    if (firstMatchedAudit || auditEntries.length > 0) {
      onTraceFocused?.();
    }
  }, [auditEntries, focusTraceId, onTraceFilterChange, onTraceFocused]);

  useEffect(() => {
    if (!activeTraceId || auditEntries.some((entry) => entry.correlationId === activeTraceId)) {
      return undefined;
    }

    let cancelled = false;
    let attempts = 0;
    let timeoutId: number | undefined;

    const refreshMissingTrace = async () => {
      attempts += 1;
      await refreshSecurityData().catch(() => undefined);
      if (!cancelled && attempts < 4) {
        timeoutId = window.setTimeout(refreshMissingTrace, 650);
      }
    };

    timeoutId = window.setTimeout(refreshMissingTrace, 350);

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [activeTraceId, auditEntries]);

  async function refreshSecurityData() {
    setLoading(true);
    setLoadError('');
    try {
      const [configResponse, auditResponse] = await Promise.all([
        fetch('/api/config'),
        fetch('/api/audit/events'),
      ]);
      const readinessPromise = fetchReleaseReadiness();
      const diagnosticPromise = fetchDiagnosticExport().catch(() => null);
      if (!configResponse.ok || !auditResponse.ok) {
        throw new Error(copy.loadFailed);
      }
      const [configBody, auditBody, readinessBody, diagnosticBody] = await Promise.all([
        configResponse.json(),
        auditResponse.json(),
        readinessPromise,
        diagnosticPromise,
      ]);
      if (!Array.isArray(auditBody.items)) {
        throw new Error(copy.loadFailed);
      }
      setConfig(configBody as ConfigSummary);
      setAuditEntries((auditBody.items ?? []) as AuditEntry[]);
      setReadiness(readinessBody);
      setDiagnosticBundle(diagnosticBody);
      setLastRefreshedAt(new Date());
    } catch {
      setLoadError(copy.loadFailed);
      setConfig(null);
      setAuditEntries([]);
      setReadiness(null);
      setDiagnosticBundle(null);
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
    setActiveTraceId('');
    onTraceFilterChange?.('');
    setQuery('');
    setStatusFilter('all');
    const firstMatchedAudit = auditEntries.find((entry) => isAuditRelated(entry, relation, config));
    setSelectedAuditId(firstMatchedAudit?.id ?? '');
  }

  function clearRelationFilter() {
    setRelationFilter(null);
  }

  function applyTraceFilter(correlationId: string) {
    setActiveTraceId(correlationId);
    setRelationFilter(null);
    setQuery('');
    setStatusFilter('all');
    const firstMatchedAudit = auditEntries.find((entry) => entry.correlationId === correlationId);
    setSelectedAuditId(firstMatchedAudit?.id ?? '');
    onTraceFilterChange?.(correlationId);
  }

  function clearTraceFilter() {
    setActiveTraceId('');
    onTraceFilterChange?.('');
  }

  async function copyTraceLink() {
    if (!activeTraceId || typeof window === 'undefined') {
      return;
    }

    const url = `${window.location.origin}${window.location.pathname}${window.location.search}#security?trace=${encodeURIComponent(activeTraceId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setRemediationMessage(copy.traceLinkCopied);
      setRemediationError(false);
    } catch {
      setRemediationMessage(url);
      setRemediationError(false);
    }
  }

  async function copyEvidenceBrief() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setRemediationMessage(evidenceBrief.text);
      setRemediationError(false);
      return;
    }

    try {
      await navigator.clipboard.writeText(evidenceBrief.text);
      setRemediationMessage(copy.evidenceBriefCopied);
      setRemediationError(false);
    } catch {
      setRemediationMessage(evidenceBrief.text);
      setRemediationError(false);
    }
  }

  async function copySshPerformanceSummary() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setRemediationMessage(sshPerformance.copyText);
      setRemediationError(false);
      return;
    }

    try {
      await navigator.clipboard.writeText(sshPerformance.copyText);
      setRemediationMessage(sshPerformanceCopy.copyCopied);
      setRemediationError(false);
    } catch {
      setRemediationMessage(sshPerformance.copyText);
      setRemediationError(false);
    }
  }

  async function copySshLagReport() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setRemediationMessage(sshPerformance.reportText);
      setRemediationError(false);
      return;
    }

    try {
      await navigator.clipboard.writeText(sshPerformance.reportText);
      setRemediationMessage(sshPerformanceCopy.reportCopied);
      setRemediationError(false);
    } catch {
      setRemediationMessage(sshPerformance.reportText);
      setRemediationError(false);
    }
  }

  function saveSshLagReportSnapshot() {
    const snapshot = createSshLagReportSnapshot(sshPerformance);
    setSshLagReportHistory((current) => {
      const next = [snapshot, ...current.filter((item) => item.text !== snapshot.text)];
      saveSshLagReportHistory(next);
      return next;
    });
    setRemediationMessage(sshPerformanceCopy.historySaved);
    setRemediationError(false);
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

    if (check.relatedModule === 'deployment') {
      focusRemediation();
      return;
    }

    if (check.relatedModule === 'audit') {
      setRelationFilter(null);
      setActiveTraceId('');
      onTraceFilterChange?.('');
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

  async function exportDiagnosticBundle() {
    setExportingDiagnostic(true);
    setRemediationMessage('');
    setRemediationError(false);
    try {
      const bundle = await fetchDiagnosticExport();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: `${bundle.contentType};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = bundle.filename;
      link.click();
      URL.revokeObjectURL(url);
      setRemediationMessage(diagnosticCopy.exported);
    } catch (error) {
      setRemediationMessage(error instanceof Error ? error.message : diagnosticCopy.failed);
      setRemediationError(true);
    } finally {
      setExportingDiagnostic(false);
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
            <button type="button" className="tool-button" onClick={exportDiagnosticBundle} disabled={exportingDiagnostic}>
              <Download size={15} />
              {exportingDiagnostic ? diagnosticCopy.exporting : diagnosticCopy.export}
            </button>
          </div>
        </div>
      </article>

      <article className={`security-evidence-brief ${readiness?.status ?? 'review'}`} aria-labelledby="security-evidence-brief-title">
        <div className="security-evidence-heading">
          <div>
            <h3 id="security-evidence-brief-title"><ClipboardCheck size={18} /> {copy.evidenceBriefTitle}</h3>
            <p>{copy.evidenceBriefDescription}</p>
          </div>
          <button type="button" className="tool-button" onClick={copyEvidenceBrief} disabled={!evidenceBrief.text}>
            <ClipboardCheck size={15} />
            {copy.evidenceBriefCopy}
          </button>
        </div>
        <div className="security-evidence-metrics">
          {evidenceBrief.metrics.map((metric) => (
            <div key={metric.label} className={`security-evidence-metric ${metric.tone}`}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              <small>{metric.detail}</small>
            </div>
          ))}
        </div>
        <div className="security-evidence-footer">
          <div>
            <span>{copy.evidenceBriefNextAction}</span>
            <p>{evidenceBrief.nextAction}</p>
          </div>
          <div>
            <span>{copy.evidenceBriefBlockersTitle}</span>
            <p>{evidenceBrief.blockers.length > 0 ? evidenceBrief.blockers.join(' / ') : copy.evidenceBriefNoBlockers}</p>
          </div>
        </div>
        {evidenceBrief.deployment && (
          <div className="security-deployment-evidence" data-release-deployment-evidence="true">
            <span>{copy.evidenceDeploymentTitle}</span>
            <strong>{evidenceBrief.deployment.targetName} · {evidenceBrief.deployment.gitCommit}</strong>
            <small>{copy.evidenceDeploymentDetail(evidenceBrief.deployment.channel, evidenceBrief.deployment.deploymentMode, evidenceBrief.deployment.publicHost)}</small>
          </div>
        )}
        <small className="security-evidence-generated">{copy.evidenceBriefGenerated(evidenceBrief.generatedLabel)}</small>
      </article>

      <article className="security-release-playbook" aria-labelledby="security-release-playbook-title" data-release-playbook="true">
        <div className="security-release-playbook-heading">
          <div>
            <h3 id="security-release-playbook-title"><ShieldAlert size={18} /> {copy.releasePlaybookTitle}</h3>
            <p>{copy.releasePlaybookDescription}</p>
          </div>
          <span>{copy.releasePlaybookItems.length}</span>
        </div>
        <div className="security-release-playbook-grid">
          {copy.releasePlaybookItems.map((item) => (
            <div key={item.id} className={`security-release-playbook-item ${item.tone}`}>
              <span className="security-release-playbook-icon">
                {item.tone === 'fail' ? <XCircle size={16} /> : item.tone === 'warn' ? <AlertTriangle size={16} /> : <Wrench size={16} />}
              </span>
              <div>
                <strong>{item.title}</strong>
                <small><b>{copy.releasePlaybookSignalLabel}</b>{item.signal}</small>
                <small><b>{copy.releasePlaybookActionLabel}</b>{item.action}</small>
              </div>
            </div>
          ))}
        </div>
      </article>

      <article className={`security-ssh-performance-card ${sshPerformance.tone}`} aria-labelledby="security-ssh-performance-title" data-ssh-performance-card="true">
        <div className="security-ssh-performance-heading">
          <div>
            <h3 id="security-ssh-performance-title"><SlidersHorizontal size={18} /> {sshPerformanceCopy.title}</h3>
            <p>{sshPerformanceCopy.description}</p>
          </div>
          <div className="security-ssh-performance-actions">
            <span>{sshPerformance.status}</span>
            <button type="button" className="tool-button" onClick={copySshPerformanceSummary}>
              <ClipboardCheck size={15} />
              {sshPerformanceCopy.copySummary}
            </button>
          </div>
        </div>
        <div className="security-ssh-performance-groups">
          {sshPerformance.groups.map((group) => (
            <section key={group.id} className={`security-ssh-performance-group ${group.id}`} aria-label={group.title}>
              <div className="security-ssh-performance-group-title">
                <span>{group.title}</span>
                <small>{group.metrics.length}</small>
              </div>
              <div className="security-ssh-performance-grid">
                {group.metrics.map((metric) => (
                  <button
                    key={metric.id}
                    type="button"
                    className={`security-ssh-performance-metric ${metric.tone} ${expandedSshMetric?.id === metric.id ? 'selected' : ''}`}
                    onClick={() => setExpandedSshMetricId(metric.id)}
                    aria-pressed={expandedSshMetric?.id === metric.id}
                  >
                    <span>{metric.label}</span>
                    <strong>{metric.value}</strong>
                    <small>{metric.detail}</small>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
        {expandedSshMetric ? (
          <div className={`security-ssh-performance-detail ${expandedSshMetric.tone}`} data-ssh-performance-detail="true">
            <span>{sshPerformanceCopy.detailTitle}</span>
            <strong>{expandedSshMetric.label}: {expandedSshMetric.value}</strong>
            <p>{expandedSshMetric.detail}</p>
          </div>
        ) : null}
        <div className={`security-ssh-lag-report ${sshPerformance.tone}`} data-ssh-lag-report="true">
          <div>
            <span>{sshPerformanceCopy.reportTitle}</span>
            <strong>{sshPerformance.reportHeadline}</strong>
            <p>{sshPerformanceCopy.reportDescription}</p>
            <div className="security-ssh-lag-report-context" aria-label={sshPerformanceCopy.reportContextLabel}>
              {sshPerformance.reportContext.map((item) => (
                <small key={item}>{item}</small>
              ))}
            </div>
          </div>
          <ul>
            {sshPerformance.reportFindings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
          <button type="button" className="tool-button" onClick={copySshLagReport}>
            <ClipboardCheck size={15} />
            {sshPerformanceCopy.copyReport}
          </button>
        </div>
        <div className="security-ssh-lag-history" data-ssh-lag-history="true">
          <div className="security-ssh-lag-history-heading">
            <div>
              <span>{sshPerformanceCopy.historyTitle}</span>
              <p>{sshPerformanceCopy.historyDescription}</p>
            </div>
            <button type="button" className="tool-button" onClick={saveSshLagReportSnapshot}>
              <Download size={15} />
              {sshPerformanceCopy.saveSnapshot}
            </button>
          </div>
          {sshLagReportHistory.length > 0 ? (
            <>
              <div className={`security-ssh-lag-history-compare ${sshLagReportComparison.tone}`} data-ssh-lag-history-compare="true">
                <span>{sshPerformanceCopy.historyCompareTitle}</span>
                <strong>{sshLagReportComparison.title}</strong>
                <p>{sshLagReportComparison.detail}</p>
                <small>{sshLagReportComparison.delta}</small>
              </div>
              <div className="security-ssh-lag-history-list">
                {sshLagReportHistory.slice(0, sshLagReportHistoryVisibleLimit).map((snapshot) => (
                  <article key={snapshot.id}>
                    <span>{new Date(snapshot.createdAt).toLocaleString(locale)}</span>
                    <strong>{snapshot.status}</strong>
                    <p>{snapshot.headline}</p>
                    <small>{snapshot.findings.slice(0, 2).join(' · ')}</small>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <p className="security-ssh-lag-history-empty">{sshPerformanceCopy.historyEmpty}</p>
          )}
        </div>
        <p className="security-ssh-performance-next">{sshPerformance.nextAction}</p>
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
          {activeTraceId && (
            <div className="security-trace-filter-banner">
              <span>{copy.traceApplied(shortenOperationCorrelationId(activeTraceId), filteredAudits.length)}</span>
              <div className="security-trace-filter-actions">
                <button type="button" onClick={copyTraceLink}>{copy.copyTraceLink}</button>
                <button type="button" onClick={clearTraceFilter}>{copy.clearTrace}</button>
              </div>
            </div>
          )}
          <label className="security-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setRelationFilter(null);
                setActiveTraceId('');
                onTraceFilterChange?.('');
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
                  <span className="security-audit-main">
                    <strong>{entry.action}</strong>
                    <small>{entry.target}</small>
                    {entry.correlationId && <em>{shortenOperationCorrelationId(entry.correlationId)}</em>}
                  </span>
                  <span className="security-audit-meta">
                    <b>{copy.auditStatus(entry.status)}</b>
                    <time>{formatAuditTime(entry.createdAt, locale)}</time>
                  </span>
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
              {selectedOperationTrace && (
                <div className={`security-audit-trace ${selectedOperationTrace.tone}`}>
                  <div className="security-audit-trace-head">
                    <span>{copy.operationTraceTitle}</span>
                    <b>{selectedOperationTrace.statusLabel}</b>
                  </div>
                  <div className="security-audit-trace-steps">
                    <div className={selectedOperationTrace.preflight ? 'complete' : 'missing'}>
                      <span>{copy.operationTracePreflight}</span>
                      <strong>{selectedOperationTrace.preflight?.status ? copy.auditStatus(selectedOperationTrace.preflight.status) : copy.operationTraceMissing}</strong>
                      <small>{selectedOperationTrace.preflight ? formatAuditTime(selectedOperationTrace.preflight.createdAt, locale) : copy.operationTraceNoPreflight}</small>
                    </div>
                    <div className={selectedOperationTrace.execution ? 'complete' : 'missing'}>
                      <span>{copy.operationTraceExecution}</span>
                      <strong>{selectedOperationTrace.execution?.status ? copy.auditStatus(selectedOperationTrace.execution.status) : copy.operationTraceMissing}</strong>
                      <small>{selectedOperationTrace.execution ? formatAuditTime(selectedOperationTrace.execution.createdAt, locale) : copy.operationTraceNoExecution}</small>
                    </div>
                  </div>
                  <p>{selectedOperationTrace.evidence}</p>
                  <small>{selectedOperationTrace.elapsedLabel}</small>
                  <small>{selectedOperationTrace.correlationLabel}</small>
                  <div className="security-audit-trace-actions">
                    {selectedAudit.correlationId && (
                      <button type="button" className="tool-button" onClick={() => applyTraceFilter(selectedAudit.correlationId ?? '')}>
                        <Search size={15} />
                        {copy.viewTrace}
                      </button>
                    )}
                    <button type="button" className="tool-button" onClick={() => onNavigate(getAuditNavigationTarget(selectedAudit))}>
                      {getAuditNavigationLabel(selectedAudit, copy)}
                    </button>
                  </div>
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
  let blocked = 0;
  let failed = 0;
  for (const entry of items) {
    if (entry.status === 'blocked') {
      blocked += 1;
    } else if (entry.status === 'failed') {
      failed += 1;
    }
  }
  return {
    blocked,
    failed,
    total: items.length,
  };
}

function summarizeAuditStatus(auditEntries: AuditEntry[]) {
  let successful = 0;
  for (const entry of auditEntries) {
    if (entry.status === 'success') {
      successful += 1;
    }
  }
  return {
    successRate: auditEntries.length > 0 ? Math.round((successful / auditEntries.length) * 100) : 100,
  };
}

function groupSecurityRelationItems(items: SecurityRelationItem[]) {
  const runtimeItems: SecurityRelationItem[] = [];
  const secretItems: SecurityRelationItem[] = [];
  for (const item of items) {
    if (item.key === 'runtime' || item.key === 'cors' || item.key === 'timeout') {
      runtimeItems.push(item);
    }
    if (item.key === 'ai' || item.key === 'api' || item.key === 'ssh' || item.key === 'secrets') {
      secretItems.push(item);
    }
  }
  return { runtimeItems, secretItems };
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

function getAuditNavigationTarget(entry: AuditEntry): NonNullable<SecurityRiskAction['navigateTo']> {
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
  if (action === 'OPERATIONS_PREFLIGHT' || action === 'OPERATIONS_TASK') {
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
    || action === 'OPERATIONS_PREFLIGHT'
    || action === 'OPERATIONS_TASK'
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

  if (action.startsWith('SERVER_') || action === 'OPERATIONS_PREFLIGHT' || action === 'OPERATIONS_TASK') {
    return {
      domain: action === 'OPERATIONS_PREFLIGHT' || action === 'OPERATIONS_TASK' ? copy.auditDomainOps : copy.auditDomainSsh,
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

function buildOperationAuditTrace(
  selectedAudit: AuditEntry,
  auditEntries: AuditEntry[],
  copy: SecurityCopy,
  locale: string,
): OperationAuditTrace | null {
  const action = selectedAudit.action.toUpperCase();
  if (!isCorrelatableAuditAction(action)) {
    return null;
  }

  const selectedTime = new Date(selectedAudit.createdAt).getTime();
  if (Number.isNaN(selectedTime)) {
    return null;
  }

  const selectedSignature = getOperationAuditSignature(selectedAudit);
  const relatedEntries = getRelatedOperationAuditEntries(selectedAudit, auditEntries, selectedTime, selectedSignature)
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  const directServerTrace = action === 'SERVER_ACTION' || action === 'SERVER_SSH_COMMAND';

  const preflight = action === 'OPERATIONS_PREFLIGHT'
    ? selectedAudit
    : getLastOperationAuditBefore(relatedEntries, selectedTime, 'OPERATIONS_PREFLIGHT');
  const execution = action === 'OPERATIONS_TASK' || directServerTrace
    ? selectedAudit
    : relatedEntries.find((entry) => entry.action === 'OPERATIONS_TASK' && new Date(entry.createdAt).getTime() >= selectedTime) ?? null;

  const tone: OperationAuditTrace['tone'] = execution
    ? execution.status === 'failed'
      ? 'failed'
      : 'executed'
    : preflight?.status === 'blocked'
      ? 'blocked'
      : 'orphaned';

  const statusLabel = execution
    ? execution.status === 'success'
      ? copy.operationTraceExecuted
      : copy.operationTraceExecutionRisk
    : preflight?.status === 'blocked'
      ? copy.operationTraceBlocked
      : copy.operationTraceWaiting;

  const elapsedLabel = preflight && execution
    ? copy.operationTraceElapsed(formatAuditDuration(new Date(preflight.createdAt).getTime(), new Date(execution.createdAt).getTime(), locale))
    : copy.operationTraceWindow;
  const evidence = [preflight?.detail, execution?.detail].filter(Boolean).join(' -> ') || selectedAudit.detail;
  const correlationLabel = selectedAudit.correlationId
    ? copy.operationTraceCorrelation(shortenOperationCorrelationId(selectedAudit.correlationId))
    : copy.operationTraceWindow;

  return {
    tone,
    statusLabel,
    preflight,
    execution,
    elapsedLabel,
    evidence,
    correlationLabel,
  };
}

function getRelatedOperationAuditEntries(
  selectedAudit: AuditEntry,
  auditEntries: AuditEntry[],
  selectedTime: number,
  selectedSignature: ReturnType<typeof getOperationAuditSignature>,
) {
  if (selectedAudit.correlationId) {
    return auditEntries.filter((entry) => (
      isCorrelatableAuditAction(entry.action.toUpperCase())
      && entry.correlationId === selectedAudit.correlationId
    ));
  }

  return auditEntries
    .filter((entry) => isCorrelatableAuditAction(entry.action.toUpperCase()))
    .filter((entry) => {
      const entryTime = new Date(entry.createdAt).getTime();
      if (Number.isNaN(entryTime) || Math.abs(entryTime - selectedTime) > 15 * 60 * 1000) {
        return false;
      }

      const entrySignature = getOperationAuditSignature(entry);
      const sameType = selectedSignature.taskType === 'unknown' || entrySignature.taskType === 'unknown' || selectedSignature.taskType === entrySignature.taskType;
      const sameTarget = selectedSignature.targetKey === entrySignature.targetKey;
      return sameType && sameTarget;
    });
}

function getLastOperationAuditBefore(entries: AuditEntry[], selectedTime: number, action: 'OPERATIONS_PREFLIGHT' | 'OPERATIONS_TASK') {
  const matches = entries.filter((entry) => entry.action === action && new Date(entry.createdAt).getTime() <= selectedTime);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

function getOperationAuditSignature(entry: AuditEntry) {
  const detail = entry.detail.toLowerCase();
  const taskType = (
    detail.match(/\b(assetSync|healthCheck|sshCommand|powerOn|shutdown|reboot)\b/i)?.[1]
    ?? detail.match(/Plan:\s*([^|]+?)\s+on\s+/i)?.[1]
    ?? 'unknown'
  )
    .replace(/\s+/g, '')
    .toLowerCase();
  const targetKey = normalizeAuditTarget(entry.target);

  return { taskType, targetKey };
}

function isCorrelatableAuditAction(action: string) {
  return (
    action === 'OPERATIONS_PREFLIGHT'
    || action === 'OPERATIONS_TASK'
    || action === 'SERVER_ACTION'
    || action === 'SERVER_SSH_COMMAND'
  );
}

function normalizeAuditTarget(target: string) {
  return target
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .sort()
    .join(',');
}

function formatAuditDuration(start: number, end: number, locale: string) {
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) {
    return new Intl.NumberFormat(locale).format(seconds) + 's';
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${new Intl.NumberFormat(locale).format(minutes)}m ${new Intl.NumberFormat(locale).format(remainingSeconds)}s`;
}

function shortenOperationCorrelationId(value: string) {
  return value.replace(/^(ops|srv)-trace-/, '').slice(0, 8);
}

function formatAuditTime(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function buildReleaseEvidenceBrief(input: {
  readiness: ReleaseReadinessResponse | null;
  auditTotal: number;
  activeAuditIssues: ReturnType<typeof getActiveAuditIssues>;
  successRate: number;
  openEventCount: number;
  lastRefreshedAt: Date | null;
  copy: SecurityCopy;
  locale: string;
}): ReleaseEvidenceBrief {
  const { readiness, auditTotal, activeAuditIssues, successRate, openEventCount, lastRefreshedAt, copy, locale } = input;
  const generatedLabel = lastRefreshedAt
    ? lastRefreshedAt.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })
    : copy.waitingRefresh;
  const readinessStatus = readiness ? copy.readinessStatus(readiness.status) : copy.waitingRefresh;
  const checksDetail = readiness ? copy.readinessIssues(readiness.summary.failures, readiness.summary.warnings) : copy.readinessCalculating;
  const blockers = readiness?.blockers.slice(0, 3).map((check) => sanitizeEvidenceBriefText(`${check.label}: ${check.value}`)) ?? [];
  const nextAction = sanitizeEvidenceBriefText(readiness?.nextBestAction ?? copy.readinessCalculating);
  const deploymentCheck = readiness?.checks.find((check) => check.id === 'deployment-evidence');
  const deployment = deploymentCheck ? parseDeploymentEvidence(deploymentCheck.evidence) : null;
  const metrics: ReleaseEvidenceMetric[] = [
    {
      label: copy.evidenceMetricReadiness,
      value: readiness ? String(readiness.score) : '--',
      detail: readinessStatus,
      tone: readiness?.status === 'ready' ? 'ok' : readiness?.status === 'blocked' ? 'fail' : 'warn',
    },
    {
      label: copy.evidenceMetricChecks,
      value: readiness ? `${readiness.summary.passed}/${readiness.summary.totalChecks}` : '--',
      detail: checksDetail,
      tone: !readiness || readiness.summary.failures > 0 ? 'fail' : readiness.summary.warnings > 0 ? 'warn' : 'ok',
    },
    {
      label: copy.evidenceMetricAudit,
      value: String(activeAuditIssues.total),
      detail: copy.evidenceAuditDetail(activeAuditIssues.blocked, activeAuditIssues.failed, successRate, auditTotal),
      tone: activeAuditIssues.failed > 0 ? 'fail' : activeAuditIssues.blocked > 0 ? 'warn' : 'ok',
    },
    {
      label: copy.evidenceMetricQueue,
      value: String(openEventCount),
      detail: copy.evidenceQueueDetail(openEventCount),
      tone: openEventCount > 0 ? 'warn' : 'ok',
    },
  ];
  const textLines = [
    `# ${copy.evidenceBriefTitle}`,
    copy.evidenceBriefGenerated(generatedLabel),
    `${copy.evidenceMetricReadiness}: ${metrics[0].value} (${metrics[0].detail})`,
    `${copy.evidenceMetricChecks}: ${metrics[1].value} (${metrics[1].detail})`,
    `${copy.evidenceMetricAudit}: ${metrics[2].value} (${metrics[2].detail})`,
    `${copy.evidenceMetricQueue}: ${metrics[3].value} (${metrics[3].detail})`,
    deployment ? `${copy.evidenceDeploymentTitle}: ${deployment.targetName} / ${deployment.gitCommit} / ${deployment.publicHost}` : '',
    `${copy.evidenceBriefBlockersTitle}: ${blockers.length > 0 ? blockers.join('; ') : copy.evidenceBriefNoBlockers}`,
    `${copy.evidenceBriefNextAction}: ${nextAction}`,
  ].filter(Boolean);

  return {
    generatedLabel,
    metrics,
    blockers,
    deployment,
    nextAction,
    text: textLines.join('\n'),
  };
}

function buildSshPerformanceSummary(
  diagnostic: DiagnosticExportResponse | null,
  copy: SshPerformanceCopy,
  locale: string,
): SshPerformanceSummary {
  const websocket = diagnostic?.sshTerminal?.websocket;
  const activeSessions = diagnostic?.sshTerminal?.activeSessions ?? 0;
  const inputEvents = websocket?.inputEvents ?? 0;
  const inputFlushes = websocket?.inputFlushes ?? 0;
  const outputEvents = websocket?.outputEvents ?? 0;
  const outputFlushes = websocket?.outputFlushes ?? 0;
  const errors = websocket?.errors ?? 0;
  const lastSelfTest = diagnostic?.sshTerminal?.lastSelfTest ?? null;
  const selfTestTrend = diagnostic?.sshTerminal?.selfTestTrend ?? null;
  const sessionReplays = diagnostic?.sshTerminal?.sessionReplays ?? [];
  const latestReplay = sessionReplays[0] ?? null;
  const activeReplayCount = sessionReplays.filter((item) => item.active).length;
  const inputRatio = calculateBatchRatio(inputEvents, inputFlushes);
  const outputRatio = calculateBatchRatio(outputEvents, outputFlushes);
  const hasEvidence = Boolean(websocket) && (inputEvents > 0 || outputEvents > 0 || activeSessions > 0 || Boolean(lastSelfTest) || sessionReplays.length > 0);
  const bottleneckTone: SshPerformanceMetric['tone'] = !lastSelfTest
    ? 'warn'
    : lastSelfTest.bottleneck === 'healthy'
      ? 'ok'
      : lastSelfTest.bottleneck === 'connection'
        ? 'fail'
        : 'warn';
  const lastSelfTestTone: SshPerformanceMetric['tone'] = lastSelfTest?.status === 'failed'
    ? 'fail'
    : lastSelfTest?.status === 'timeout'
      ? 'warn'
      : bottleneckTone;
  const tone: SshPerformanceSummary['tone'] = errors > 0 || lastSelfTestTone === 'fail'
    ? 'fail'
    : lastSelfTestTone === 'warn' || (hasEvidence && inputEvents >= 8 && inputRatio < 1.2)
      ? 'warn'
      : 'ok';
  const metrics: SshPerformanceMetric[] = [
    {
      id: 'active-sessions',
      label: copy.activeSessions,
      value: String(activeSessions),
      detail: copy.activeSessionsDetail(activeSessions),
      tone: activeSessions > 8 ? 'warn' : 'ok',
    },
    {
      id: 'input-batch',
      label: copy.inputBatch,
      value: inputFlushes > 0 ? `${formatBatchRatio(inputRatio)}x` : '--',
      detail: copy.inputBatchDetail(inputEvents, inputFlushes),
      tone: inputEvents >= 8 && inputRatio < 1.2 ? 'warn' : 'ok',
    },
    {
      id: 'output-batch',
      label: copy.outputBatch,
      value: outputFlushes > 0 ? `${formatBatchRatio(outputRatio)}x` : '--',
      detail: copy.outputBatchDetail(outputEvents, outputFlushes),
      tone: outputEvents >= 8 && outputRatio < 1.2 ? 'warn' : 'ok',
    },
    {
      id: 'last-self-test',
      label: copy.lastSelfTest,
      value: lastSelfTest ? `${lastSelfTest.lines}/${Math.round(lastSelfTest.durationMs)}ms` : '--',
      detail: lastSelfTest
        ? copy.lastSelfTestDetail(lastSelfTest.status, lastSelfTest.lines, lastSelfTest.durationMs, lastSelfTest.linesPerSecond, lastSelfTest.recordedAt)
        : copy.lastSelfTestNone,
      tone: lastSelfTest ? lastSelfTestTone : 'warn',
    },
    {
      id: 'response-split',
      label: copy.responseSplit,
      value: lastSelfTest ? `${Math.round(lastSelfTest.firstResponseMs)}/${Math.round(lastSelfTest.outputSpanMs)}ms` : '--',
      detail: lastSelfTest
        ? copy.responseSplitDetail(lastSelfTest.firstResponseMs, lastSelfTest.outputSpanMs)
        : copy.responseSplitNone,
      tone: lastSelfTest && (lastSelfTest.firstResponseMs >= 2000 || lastSelfTest.outputSpanMs >= 2500) ? 'warn' : lastSelfTest ? 'ok' : 'warn',
    },
    {
      id: 'self-test-trend',
      label: copy.selfTestTrend,
      value: selfTestTrend && selfTestTrend.samples > 0 ? copy.trendValue(selfTestTrend.direction, selfTestTrend.samples) : '--',
      detail: selfTestTrend && selfTestTrend.samples > 0
        ? copy.trendDetail(selfTestTrend.averageDurationMs, selfTestTrend.latestDurationMs, selfTestTrend.previousDurationMs)
        : copy.trendNone,
      tone: selfTestTrend?.direction === 'degrading' ? 'warn' : selfTestTrend?.direction === 'unknown' ? 'warn' : 'ok',
    },
    {
      id: 'likely-bottleneck',
      label: copy.likelyBottleneck,
      value: lastSelfTest ? copy.bottleneckValue(lastSelfTest.bottleneck) : '--',
      detail: lastSelfTest
        ? copy.bottleneckDetail(lastSelfTest.bottleneck, lastSelfTest.rttMs, lastSelfTest.throughputBytesPerSecond)
        : copy.bottleneckNone,
      tone: bottleneckTone,
    },
    {
      id: 'session-replay',
      label: copy.sessionReplay,
      value: sessionReplays.length > 0 ? copy.sessionReplayValue(sessionReplays.length, activeReplayCount) : '--',
      detail: latestReplay
        ? copy.sessionReplayDetail(latestReplay.inputSubmits, latestReplay.outputEvents, latestReplay.outputLines, latestReplay.durationMs, latestReplay.closeSignal)
        : copy.sessionReplayNone,
      tone: latestReplay?.errorCount ? 'warn' : sessionReplays.length > 0 ? 'ok' : 'warn',
    },
    {
      id: 'websocket-errors',
      label: copy.websocketErrors,
      value: String(errors),
      detail: copy.websocketErrorsDetail(errors),
      tone: errors > 0 ? 'fail' : 'ok',
    },
  ];
  const groups: SshPerformanceGroup[] = [
    {
      id: 'track',
      title: copy.groupTrack,
      metrics: metrics.slice(0, 3),
    },
    {
      id: 'latency',
      title: copy.groupLatency,
      metrics: metrics.slice(3, 7),
    },
    {
      id: 'audit',
      title: copy.groupAudit,
      metrics: metrics.slice(7),
    },
  ];
  const status = tone === 'fail' ? copy.statusFail : tone === 'warn' ? copy.statusWarn : copy.statusOk;
  const nextAction = !hasEvidence ? copy.nextActionNoEvidence : tone === 'fail' ? copy.nextActionFail : tone === 'warn' ? copy.nextActionWarn : copy.nextActionOk;
  const reportHeadline = copy.reportHeadline(status, hasEvidence);
  const reportFindings = [
    copy.reportFindingInput(inputEvents, inputFlushes, inputRatio),
    copy.reportFindingOutput(outputEvents, outputFlushes, outputRatio),
    copy.reportFindingLatency(
      lastSelfTest ? copy.bottleneckValue(lastSelfTest.bottleneck) : '--',
      lastSelfTest?.firstResponseMs ?? null,
      lastSelfTest?.outputSpanMs ?? null,
      errors,
    ),
  ];
  const reportGeneratedAt = new Date().toLocaleString(locale);
  const reportContext = [
    copy.reportGeneratedAt(reportGeneratedAt),
    copy.reportEvidenceLevel(hasEvidence, sessionReplays.length, Boolean(lastSelfTest)),
    copy.reportSanitizedBadge,
  ];
  const copyText = [
    `# ${copy.title}`,
    `${copy.summaryStatus}: ${status}`,
    ...groups.flatMap((group) => [
      `[${group.title}]`,
      ...group.metrics.map((metric) => `${metric.label}: ${metric.value} (${metric.detail})`),
    ]),
    `${copy.summaryNextAction}: ${nextAction}`,
  ].join('\n');
  const reportText = [
    `# ${copy.reportTitle}`,
    `${copy.summaryStatus}: ${status}`,
    `${copy.reportHeadlineLabel}: ${reportHeadline}`,
    `${copy.reportContextLabel}: ${reportContext.join(' / ')}`,
    `${copy.reportEvidenceLabel}:`,
    ...reportFindings.map((finding) => `- ${finding}`),
    `${copy.summaryNextAction}: ${nextAction}`,
    '',
    copy.reportSanitizedNote,
  ].join('\n');

  return {
    tone,
    status,
    nextAction,
    copyText,
    reportHeadline,
    reportFindings,
    reportContext,
    reportText,
    metrics,
    groups,
  };
}

function calculateBatchRatio(events: number, flushes: number) {
  if (events <= 0 || flushes <= 0) {
    return 0;
  }
  return events / flushes;
}

function createSshLagReportSnapshot(summary: SshPerformanceSummary): SshLagReportSnapshot {
  const createdAt = new Date().toISOString();
  return {
    id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt,
    tone: summary.tone,
    status: summary.status,
    headline: summary.reportHeadline,
    context: summary.reportContext,
    findings: summary.reportFindings,
    text: summary.reportText,
  };
}

function loadSshLagReportHistory(): SshLagReportSnapshot[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(sshLagReportHistoryStorageKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(isSshLagReportSnapshot)
      .filter((item) => !containsSensitiveReportText(item.text))
  } catch {
    return [];
  }
}

function saveSshLagReportHistory(history: SshLagReportSnapshot[]) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(sshLagReportHistoryStorageKey, JSON.stringify(history));
  } catch {
    // Keep the UI usable when browser storage is unavailable.
  }
}

function buildSshLagReportComparison(
  current: SshPerformanceSummary,
  baseline: SshLagReportSnapshot | null,
  copy: SshPerformanceCopy,
): SshLagReportComparison {
  if (!baseline) {
    return {
      tone: 'warn',
      title: copy.historyCompareEmptyTitle,
      detail: copy.historyCompareEmptyDetail,
      delta: copy.historyCompareEmptyDelta,
    };
  }

  const baselineTone = baseline.tone ?? inferSshSnapshotTone(baseline.status);
  if (!baselineTone) {
    return {
      tone: 'warn',
      title: copy.historyCompareUnknown,
      detail: copy.historyCompareDetail(current.status, baseline.status),
      delta: copy.historyCompareUnknownDelta,
    };
  }

  const toneDelta = getSshToneRank(current.tone) - getSshToneRank(baselineTone);
  const findingDelta = current.reportFindings.length - baseline.findings.length;
  if (toneDelta < 0) {
    return {
      tone: 'ok',
      title: copy.historyCompareBetter,
      detail: copy.historyCompareDetail(current.status, baseline.status),
      delta: copy.historyCompareDelta(findingDelta),
    };
  }
  if (toneDelta > 0) {
    return {
      tone: 'fail',
      title: copy.historyCompareWorse,
      detail: copy.historyCompareDetail(current.status, baseline.status),
      delta: copy.historyCompareDelta(findingDelta),
    };
  }
  return {
    tone: current.tone === 'fail' ? 'fail' : current.tone === 'warn' ? 'warn' : 'ok',
    title: copy.historyCompareSame,
    detail: copy.historyCompareDetail(current.status, baseline.status),
    delta: copy.historyCompareDelta(findingDelta),
  };
}

function getSshToneRank(tone: SshPerformanceSummary['tone']) {
  return tone === 'fail' ? 2 : tone === 'warn' ? 1 : 0;
}

function inferSshSnapshotTone(status: string): SshPerformanceSummary['tone'] | null {
  const normalized = status.toLowerCase();
  if (/error|fail|异常|エラー|異常/.test(normalized)) {
    return 'fail';
  }
  if (/watch|warn|观察|注意|監視/.test(normalized)) {
    return 'warn';
  }
  if (/healthy|ok|流畅|正常|健全/.test(normalized)) {
    return 'ok';
  }
  return null;
}

function isSshLagReportSnapshot(value: unknown): value is SshLagReportSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<SshLagReportSnapshot>;
  return typeof candidate.id === 'string'
    && typeof candidate.createdAt === 'string'
    && (candidate.tone === undefined || candidate.tone === 'ok' || candidate.tone === 'warn' || candidate.tone === 'fail')
    && typeof candidate.status === 'string'
    && typeof candidate.headline === 'string'
    && Array.isArray(candidate.context)
    && candidate.context.every((item) => typeof item === 'string')
    && Array.isArray(candidate.findings)
    && candidate.findings.every((item) => typeof item === 'string')
    && typeof candidate.text === 'string';
}

function containsSensitiveReportText(text: string) {
  return /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text)
    || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(text)
    || /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/.test(text);
}

function formatBatchRatio(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  return value >= 10 ? Math.round(value).toString() : value.toFixed(1);
}

function formatSelfTestRate(value: number, language: string) {
  const unit = language === 'en' ? 'lines/s' : '行/秒';
  if (!Number.isFinite(value) || value <= 0) {
    return `0 ${unit}`;
  }
  return value >= 100 ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`;
}

function formatDiagnosticRtt(value: number | null) {
  return value === null || !Number.isFinite(value) ? 'RTT --' : `RTT ${Math.round(value)}ms`;
}

function formatDiagnosticThroughput(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return '--';
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB/s`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB/s`;
  }
  return `${Math.round(value)} B/s`;
}

function formatBottleneckValue(bottleneck: SshSelfTestBottleneck, language: string) {
  const labels: Record<string, Record<SshSelfTestBottleneck, string>> = {
    zh: {
      healthy: '\u94fe\u8def\u5065\u5eb7',
      network: '\u7f51\u7edc\u5ef6\u8fdf',
      throughput: '\u8f93\u51fa\u541e\u5410',
      terminal: '\u7ec8\u7aef\u54cd\u5e94',
      connection: '\u8fde\u63a5\u94fe\u8def',
    },
    en: {
      healthy: 'Healthy path',
      network: 'Network latency',
      throughput: 'Output throughput',
      terminal: 'Terminal response',
      connection: 'Connection path',
    },
    ja: {
      healthy: '\u6b63\u5e38',
      network: '\u30cd\u30c3\u30c8\u9045\u5ef6',
      throughput: '\u51fa\u529b\u541e\u5410',
      terminal: '\u7aef\u672b\u5fdc\u7b54',
      connection: '\u63a5\u7d9a\u7d4c\u8def',
    },
  };
  return (labels[language] ?? labels.zh)[bottleneck];
}

function formatBottleneckDetail(
  bottleneck: SshSelfTestBottleneck,
  rttMs: number | null,
  throughputBytesPerSecond: number,
  language: string,
) {
  const evidence = `${formatDiagnosticRtt(rttMs)} / ${formatDiagnosticThroughput(throughputBytesPerSecond)}`;
  if (language === 'en') {
    return `${formatBottleneckValue(bottleneck, language)} from sanitized ${evidence}`;
  }
  return `${formatBottleneckValue(bottleneck, language)} / ${evidence}`;
}

function formatTrendValue(direction: DiagnosticExportResponse['sshTerminal']['selfTestTrend']['direction'], samples: number, language: string) {
  const labels: Record<string, Record<DiagnosticExportResponse['sshTerminal']['selfTestTrend']['direction'], string>> = {
    zh: {
      unknown: '\u5f85\u7d2f\u79ef',
      stable: '\u7a33\u5b9a',
      improving: '\u53d8\u5feb',
      degrading: '\u53d8\u6162',
    },
    en: {
      unknown: 'Collecting',
      stable: 'Stable',
      improving: 'Improving',
      degrading: 'Degrading',
    },
    ja: {
      unknown: '\u84c4\u7a4d\u4e2d',
      stable: '\u5b89\u5b9a',
      improving: '\u6539\u5584',
      degrading: '\u4f4e\u4e0b',
    },
  };
  const label = (labels[language] ?? labels.zh)[direction];
  return language === 'en' ? `${label} · ${samples}` : `${label} · ${samples}\u6b21`;
}

function parseDeploymentEvidence(value: string): ReleaseDeploymentEvidence | null {
  const fields = Object.fromEntries(
    value
      .split('/')
      .map((part) => part.trim().split('='))
      .filter((part): part is [string, string] => part.length === 2 && Boolean(part[0]) && Boolean(part[1]))
      .map(([key, fieldValue]) => [key, sanitizeEvidenceBriefText(fieldValue)]),
  );

  if (!fields.target && !fields.commit) {
    return null;
  }

  return {
    targetName: fields.target ?? 'unknown',
    channel: fields.channel ?? 'unknown',
    deploymentMode: fields.mode ?? 'unknown',
    publicHost: fields.host ?? 'not configured',
    gitCommit: fields.commit ?? 'unknown',
    artifactId: fields.artifact ?? 'not configured',
    deployedAt: fields.deployed ?? 'not configured',
    configured: fields.commit !== 'unknown' || fields.host !== 'not configured',
    evidence: sanitizeEvidenceBriefText(value),
  };
}

function sanitizeEvidenceBriefText(value: string) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-api-key]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]');
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
  operationTraceTitle: string;
  operationTracePreflight: string;
  operationTraceExecution: string;
  operationTraceExecuted: string;
  operationTraceExecutionRisk: string;
  operationTraceBlocked: string;
  operationTraceWaiting: string;
  operationTraceMissing: string;
  operationTraceNoPreflight: string;
  operationTraceNoExecution: string;
  operationTraceWindow: string;
  operationTraceCorrelation: (id: string) => string;
  viewTrace: string;
  clearTrace: string;
  copyTraceLink: string;
  traceLinkCopied: string;
  evidenceBriefTitle: string;
  evidenceBriefDescription: string;
  evidenceBriefCopy: string;
  evidenceBriefCopied: string;
  evidenceBriefNextAction: string;
  evidenceBriefBlockersTitle: string;
  evidenceBriefNoBlockers: string;
  evidenceMetricReadiness: string;
  evidenceMetricChecks: string;
  evidenceMetricAudit: string;
  evidenceMetricQueue: string;
  evidenceDeploymentTitle: string;
  releasePlaybookTitle: string;
  releasePlaybookDescription: string;
  releasePlaybookSignalLabel: string;
  releasePlaybookActionLabel: string;
  releasePlaybookItems: ReleaseFailurePlaybookItem[];
  traceApplied: (id: string, count: number) => string;
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
  operationTraceElapsed: (duration: string) => string;
  evidenceBriefGenerated: (time: string) => string;
  evidenceAuditDetail: (blocked: number, failed: number, successRate: number, total: number) => string;
  evidenceQueueDetail: (count: number) => string;
  evidenceDeploymentDetail: (channel: string, mode: string, host: string) => string;
  auditStatus: (status: AuditStatusFilter) => string;
}

interface SshPerformanceCopy {
  title: string;
  description: string;
  activeSessions: string;
  inputBatch: string;
  outputBatch: string;
  lastSelfTest: string;
  responseSplit: string;
  selfTestTrend: string;
  likelyBottleneck: string;
  sessionReplay: string;
  websocketErrors: string;
  groupTrack: string;
  groupLatency: string;
  groupAudit: string;
  detailTitle: string;
  reportTitle: string;
  reportDescription: string;
  copyReport: string;
  reportCopied: string;
  reportHeadlineLabel: string;
  reportContextLabel: string;
  reportEvidenceLabel: string;
  reportSanitizedBadge: string;
  reportSanitizedNote: string;
  historyTitle: string;
  historyDescription: string;
  historyEmpty: string;
  saveSnapshot: string;
  historySaved: string;
  historyCompareTitle: string;
  historyCompareEmptyTitle: string;
  historyCompareEmptyDetail: string;
  historyCompareEmptyDelta: string;
  historyCompareBetter: string;
  historyCompareSame: string;
  historyCompareWorse: string;
  historyCompareUnknown: string;
  historyCompareUnknownDelta: string;
  historyCompareDetail: (current: string, baseline: string) => string;
  historyCompareDelta: (findingDelta: number) => string;
  copySummary: string;
  copyCopied: string;
  summaryStatus: string;
  summaryNextAction: string;
  statusOk: string;
  statusWarn: string;
  statusFail: string;
  nextActionOk: string;
  nextActionWarn: string;
  nextActionFail: string;
  nextActionNoEvidence: string;
  reportHeadline: (status: string, hasEvidence: boolean) => string;
  reportFindingInput: (events: number, flushes: number, ratio: number) => string;
  reportFindingOutput: (events: number, flushes: number, ratio: number) => string;
  reportFindingLatency: (bottleneck: string, firstResponseMs: number | null, outputSpanMs: number | null, errors: number) => string;
  reportGeneratedAt: (time: string) => string;
  reportEvidenceLevel: (hasEvidence: boolean, replays: number, hasSelfTest: boolean) => string;
  activeSessionsDetail: (count: number) => string;
  inputBatchDetail: (events: number, flushes: number) => string;
  outputBatchDetail: (events: number, flushes: number) => string;
  lastSelfTestDetail: (status: string, lines: number, durationMs: number, rate: number, recordedAt: string) => string;
  lastSelfTestNone: string;
  responseSplitDetail: (firstResponseMs: number, outputSpanMs: number) => string;
  responseSplitNone: string;
  trendValue: (direction: DiagnosticExportResponse['sshTerminal']['selfTestTrend']['direction'], samples: number) => string;
  trendDetail: (averageDurationMs: number, latestDurationMs: number, previousDurationMs: number | null) => string;
  trendNone: string;
  bottleneckValue: (bottleneck: SshSelfTestBottleneck) => string;
  bottleneckDetail: (bottleneck: SshSelfTestBottleneck, rttMs: number | null, throughputBytesPerSecond: number) => string;
  bottleneckNone: string;
  sessionReplayValue: (sessions: number, active: number) => string;
  sessionReplayDetail: (inputSubmits: number, outputEvents: number, outputLines: number, durationMs: number, closeSignal: string | null) => string;
  sessionReplayNone: string;
  websocketErrorsDetail: (count: number) => string;
}

const sshPerformanceCopyByLanguage: Record<string, SshPerformanceCopy> = {
  zh: {
    title: 'SSH 终端性能',
    description: '用脱敏诊断数据观察终端输入合并、输出批次和连接错误，定位卡顿不暴露服务器信息。',
    activeSessions: '活跃会话',
    inputBatch: '输入合并',
    outputBatch: '输出合并',
    lastSelfTest: '\u6700\u8fd1\u6d4b\u901f',
    responseSplit: '\u54cd\u5e94\u5206\u6bb5',
    selfTestTrend: '\u6d4b\u901f\u8d8b\u52bf',
    likelyBottleneck: '\u7591\u4f3c\u74f6\u9888',
    sessionReplay: '会话回放',
    websocketErrors: '连接错误',
    groupTrack: '链路追踪',
    groupLatency: '延迟定位',
    groupAudit: '审计证据',
    detailTitle: '完整指标详情',
    reportTitle: 'SSH 卡顿诊断报告',
    reportDescription: '把输入、输出、延迟和错误聚合成可复制的脱敏排障报告。',
    copyReport: '复制诊断报告',
    reportCopied: 'SSH 卡顿诊断报告已复制',
    reportHeadlineLabel: '结论',
    reportContextLabel: '报告上下文',
    reportEvidenceLabel: '关键证据',
    reportSanitizedBadge: '已脱敏',
    reportSanitizedNote: '报告仅包含脱敏聚合指标，不包含服务器地址、命令正文、密钥或用户数据。',
    historyTitle: '本地诊断快照',
    historyDescription: '仅保存在当前浏览器，用于对比优化前后的脱敏报告。',
    historyEmpty: '暂无历史快照，保存一次当前报告后即可对比。',
    saveSnapshot: '保存快照',
    historySaved: 'SSH 诊断快照已保存在当前浏览器',
    historyCompareTitle: '与最近快照对比',
    historyCompareEmptyTitle: '等待基线',
    historyCompareEmptyDetail: '保存一次当前脱敏报告后，这里会显示当前 SSH 体验相对上一份快照的变化。',
    historyCompareEmptyDelta: '趋势只保存在当前浏览器，不上传服务器。',
    historyCompareBetter: '体验变好',
    historyCompareSame: '体验持平',
    historyCompareWorse: '体验变差',
    historyCompareUnknown: '基线待补充',
    historyCompareUnknownDelta: '旧快照缺少趋势等级，重新保存一次后即可精确比较。',
    historyCompareDetail: (current, baseline) => `当前 ${current} / 基线 ${baseline}`,
    historyCompareDelta: (findingDelta) => findingDelta === 0 ? '关键证据数量持平' : findingDelta > 0 ? `关键证据增加 ${findingDelta} 条` : `关键证据减少 ${Math.abs(findingDelta)} 条`,
    copySummary: '\u590d\u5236\u6458\u8981',
    copyCopied: 'SSH \u6027\u80fd\u6458\u8981\u5df2\u590d\u5236',
    summaryStatus: '\u72b6\u6001',
    summaryNextAction: '\u4e0b\u4e00\u6b65',
    statusOk: '链路流畅',
    statusWarn: '需要观察',
    statusFail: '存在异常',
    nextActionOk: '继续用实时终端测试真实命令；若用户反馈卡顿，优先对比输入合并率、RTT 和输出批次。',
    nextActionWarn: '输入合并率偏低，建议继续采集真实 SSH 粘贴、大输出和弱网场景的诊断包。',
    nextActionFail: 'WebSocket 错误非零，优先检查反向代理升级头、超时和终端会话关闭链路。',
    nextActionNoEvidence: '暂无终端交互证据；打开一次 SSH 终端并执行安全命令后刷新即可生成性能指标。',
    reportHeadline: (status, hasEvidence) => hasEvidence ? `当前 SSH 体验为「${status}」，建议按下方证据定位。` : '暂无 SSH 交互证据，先运行一次安全测速再生成报告。',
    reportFindingInput: (events, flushes, ratio) => `输入链路：${events} 次输入 / ${flushes} 次写入，合并率 ${flushes > 0 ? formatBatchRatio(ratio) : '--'}x。`,
    reportFindingOutput: (events, flushes, ratio) => `输出链路：${events} 次输出 / ${flushes} 次推送，合并率 ${flushes > 0 ? formatBatchRatio(ratio) : '--'}x。`,
    reportFindingLatency: (bottleneck, firstResponseMs, outputSpanMs, errors) => `延迟判断：${bottleneck}，首包 ${firstResponseMs === null ? '--' : `${Math.round(firstResponseMs)}ms`}，输出段 ${outputSpanMs === null ? '--' : `${Math.round(outputSpanMs)}ms`}，连接错误 ${errors}。`,
    reportGeneratedAt: (time) => `生成 ${time}`,
    reportEvidenceLevel: (hasEvidence, replays, hasSelfTest) => hasEvidence ? `证据 ${hasSelfTest ? '测速' : '实时'} / ${replays} 段回放` : '证据不足',
    activeSessionsDetail: (count) => `${count} 个实时 shell 保持在服务端`,
    inputBatchDetail: (events, flushes) => `${events} 次输入事件 / ${flushes} 次后端写入`,
    outputBatchDetail: (events, flushes) => `${events} 次输出事件 / ${flushes} 次前端推送`,
    lastSelfTestDetail: (status, lines, durationMs, rate, recordedAt) => `${status} / ${lines} \u884c / ${Math.round(durationMs)}ms / ${formatSelfTestRate(rate, 'zh')} / ${recordedAt}`,
    lastSelfTestNone: '\u6682\u65e0\u5b89\u5168\u6d4b\u901f\u7ed3\u679c\uff0c\u53ef\u5728 SSH \u7ec8\u7aef\u70b9\u51fb CPU \u56fe\u6807\u8fd0\u884c\u3002',
    responseSplitDetail: (firstResponseMs, outputSpanMs) => `\u9996\u5305 ${Math.round(firstResponseMs)}ms / \u8f93\u51fa ${Math.round(outputSpanMs)}ms`,
    responseSplitNone: '\u8fd0\u884c SSH \u5b89\u5168\u6d4b\u901f\u540e\u663e\u793a\u9996\u5305\u548c\u8f93\u51fa\u6bb5\u8017\u65f6\u3002',
    trendValue: (direction, samples) => formatTrendValue(direction, samples, 'zh'),
    trendDetail: (averageDurationMs, latestDurationMs, previousDurationMs) => `\u5e73\u5747 ${Math.round(averageDurationMs)}ms / \u6700\u8fd1 ${Math.round(latestDurationMs)}ms / \u4e0a\u6b21 ${previousDurationMs === null ? '--' : `${Math.round(previousDurationMs)}ms`}`,
    trendNone: '\u81f3\u5c11\u9700\u8981\u4e00\u6b21 SSH \u5b89\u5168\u6d4b\u901f\u624d\u80fd\u751f\u6210\u8d8b\u52bf\u3002',
    bottleneckValue: (bottleneck) => formatBottleneckValue(bottleneck, 'zh'),
    bottleneckDetail: (bottleneck, rttMs, throughputBytesPerSecond) => formatBottleneckDetail(bottleneck, rttMs, throughputBytesPerSecond, 'zh'),
    bottleneckNone: '\u5b8c\u6210 SSH \u5b89\u5168\u6d4b\u901f\u540e\u4f1a\u57fa\u4e8e RTT\u3001\u541e\u5410\u548c\u884c\u901f\u7387\u7ed9\u51fa\u5224\u65ad\u3002',
    sessionReplayValue: (sessions, active) => `${sessions} 段 / ${active} 活跃`,
    sessionReplayDetail: (inputSubmits, outputEvents, outputLines, durationMs, closeSignal) => `${inputSubmits} 次提交 / ${outputEvents} 次输出 / ${outputLines} 行 / ${Math.round(durationMs)}ms / ${closeSignal ?? '进行中'}`,
    sessionReplayNone: '暂无脱敏会话回放；打开 SSH 终端并执行一次命令后自动生成。',
    websocketErrorsDetail: (count) => count > 0 ? `${count} 次连接/解析错误` : '未记录连接错误',
  },
  en: {
    title: 'SSH terminal performance',
    description: 'Uses sanitized diagnostics to track input batching, output flushes, and socket errors without exposing server data.',
    activeSessions: 'Active sessions',
    inputBatch: 'Input batching',
    outputBatch: 'Output batching',
    lastSelfTest: 'Last safe test',
    responseSplit: 'Response split',
    selfTestTrend: 'Safe test trend',
    likelyBottleneck: 'Likely bottleneck',
    sessionReplay: 'Session replay',
    websocketErrors: 'Socket errors',
    groupTrack: 'Track',
    groupLatency: 'Latency',
    groupAudit: 'Audit',
    detailTitle: 'Full metric detail',
    reportTitle: 'SSH lag diagnosis report',
    reportDescription: 'Combines input, output, latency, and error evidence into one sanitized troubleshooting report.',
    copyReport: 'Copy diagnosis report',
    reportCopied: 'SSH lag diagnosis report copied',
    reportHeadlineLabel: 'Conclusion',
    reportContextLabel: 'Report context',
    reportEvidenceLabel: 'Key evidence',
    reportSanitizedBadge: 'Sanitized',
    reportSanitizedNote: 'This report only includes sanitized aggregate metrics. It excludes server addresses, command text, keys, and user data.',
    historyTitle: 'Local diagnosis snapshots',
    historyDescription: 'Stored only in this browser so you can compare sanitized reports before and after tuning.',
    historyEmpty: 'No snapshots yet. Save the current report once to start comparing.',
    saveSnapshot: 'Save snapshot',
    historySaved: 'SSH diagnosis snapshot saved in this browser',
    historyCompareTitle: 'Trend vs latest snapshot',
    historyCompareEmptyTitle: 'Waiting for baseline',
    historyCompareEmptyDetail: 'Save the current sanitized report once to compare the current SSH experience against the latest snapshot.',
    historyCompareEmptyDelta: 'The trend stays in this browser and is never uploaded.',
    historyCompareBetter: 'Experience improved',
    historyCompareSame: 'Experience unchanged',
    historyCompareWorse: 'Experience degraded',
    historyCompareUnknown: 'Baseline needs refresh',
    historyCompareUnknownDelta: 'The older snapshot lacks a trend score. Save one more snapshot for exact comparison.',
    historyCompareDetail: (current, baseline) => `Current ${current} / baseline ${baseline}`,
    historyCompareDelta: (findingDelta) => findingDelta === 0 ? 'Key evidence count unchanged' : findingDelta > 0 ? `Key evidence increased by ${findingDelta}` : `Key evidence decreased by ${Math.abs(findingDelta)}`,
    copySummary: 'Copy summary',
    copyCopied: 'SSH performance summary copied',
    summaryStatus: 'Status',
    summaryNextAction: 'Next action',
    statusOk: 'Healthy path',
    statusWarn: 'Watch closely',
    statusFail: 'Errors found',
    nextActionOk: 'Keep testing real terminal commands; compare input batching, RTT, and output flushes when users report lag.',
    nextActionWarn: 'Input batching is low. Capture diagnostics for paste bursts, large output, and weak-network SSH sessions.',
    nextActionFail: 'WebSocket errors are non-zero. Check proxy upgrade headers, timeouts, and terminal close cleanup first.',
    nextActionNoEvidence: 'No terminal interaction evidence yet. Open an SSH terminal, run a safe command, then refresh this panel.',
    reportHeadline: (status, hasEvidence) => hasEvidence ? `Current SSH experience is "${status}"; use the evidence below to isolate the lag path.` : 'No SSH interaction evidence yet. Run one safe speed test before sharing the report.',
    reportFindingInput: (events, flushes, ratio) => `Input path: ${events} input event(s) / ${flushes} backend write(s), batching ${flushes > 0 ? formatBatchRatio(ratio) : '--'}x.`,
    reportFindingOutput: (events, flushes, ratio) => `Output path: ${events} output event(s) / ${flushes} frontend flush(es), batching ${flushes > 0 ? formatBatchRatio(ratio) : '--'}x.`,
    reportFindingLatency: (bottleneck, firstResponseMs, outputSpanMs, errors) => `Latency call: ${bottleneck}, first response ${firstResponseMs === null ? '--' : `${Math.round(firstResponseMs)}ms`}, output span ${outputSpanMs === null ? '--' : `${Math.round(outputSpanMs)}ms`}, socket errors ${errors}.`,
    reportGeneratedAt: (time) => `Generated ${time}`,
    reportEvidenceLevel: (hasEvidence, replays, hasSelfTest) => hasEvidence ? `Evidence ${hasSelfTest ? 'safe test' : 'live'} / ${replays} replay(s)` : 'Evidence missing',
    activeSessionsDetail: (count) => `${count} live shell session(s) retained server-side`,
    inputBatchDetail: (events, flushes) => `${events} input event(s) / ${flushes} backend write(s)`,
    outputBatchDetail: (events, flushes) => `${events} output event(s) / ${flushes} frontend flush(es)`,
    lastSelfTestDetail: (status, lines, durationMs, rate, recordedAt) => `${status} / ${lines} lines / ${Math.round(durationMs)}ms / ${formatSelfTestRate(rate, 'en')} / ${recordedAt}`,
    lastSelfTestNone: 'No safe speed test result yet. Run it from the SSH terminal CPU button.',
    responseSplitDetail: (firstResponseMs, outputSpanMs) => `First response ${Math.round(firstResponseMs)}ms / output span ${Math.round(outputSpanMs)}ms`,
    responseSplitNone: 'Run the SSH safe speed test to split first-response and output timing.',
    trendValue: (direction, samples) => formatTrendValue(direction, samples, 'en'),
    trendDetail: (averageDurationMs, latestDurationMs, previousDurationMs) => `Average ${Math.round(averageDurationMs)}ms / latest ${Math.round(latestDurationMs)}ms / previous ${previousDurationMs === null ? '--' : `${Math.round(previousDurationMs)}ms`}`,
    trendNone: 'Run at least one SSH safe speed test to build the trend.',
    bottleneckValue: (bottleneck) => formatBottleneckValue(bottleneck, 'en'),
    bottleneckDetail: (bottleneck, rttMs, throughputBytesPerSecond) => formatBottleneckDetail(bottleneck, rttMs, throughputBytesPerSecond, 'en'),
    bottleneckNone: 'Run the SSH safe speed test to classify lag by RTT, throughput, and terminal line rate.',
    sessionReplayValue: (sessions, active) => `${sessions} trace(s) / ${active} active`,
    sessionReplayDetail: (inputSubmits, outputEvents, outputLines, durationMs, closeSignal) => `${inputSubmits} submit(s) / ${outputEvents} output event(s) / ${outputLines} line(s) / ${Math.round(durationMs)}ms / ${closeSignal ?? 'live'}`,
    sessionReplayNone: 'No sanitized session replay yet. Open SSH and run one command to generate it.',
    websocketErrorsDetail: (count) => count > 0 ? `${count} connection or parse error(s)` : 'No socket errors recorded',
  },
  ja: {
    title: 'SSH 端末パフォーマンス',
    description: '匿名化診断で入力バッチ、出力フラッシュ、ソケットエラーを確認し、サーバー情報は表示しません。',
    activeSessions: 'アクティブセッション',
    inputBatch: '入力バッチ',
    outputBatch: '出力バッチ',
    lastSelfTest: '\u6700\u8fd1\u306e\u901f\u5ea6\u30c6\u30b9\u30c8',
    responseSplit: '\u5fdc\u7b54\u5206\u5272',
    selfTestTrend: '\u901f\u5ea6\u30c8\u30ec\u30f3\u30c9',
    likelyBottleneck: '\u63a8\u5b9a\u30dc\u30c8\u30eb\u30cd\u30c3\u30af',
    sessionReplay: 'セッション再生',
    websocketErrors: '接続エラー',
    groupTrack: '追跡',
    groupLatency: '遅延',
    groupAudit: '監査',
    detailTitle: '指標の詳細',
    reportTitle: 'SSH 遅延診断レポート',
    reportDescription: '入力、出力、遅延、エラーを匿名化した排障レポートにまとめます。',
    copyReport: '診断レポートをコピー',
    reportCopied: 'SSH 遅延診断レポートをコピーしました',
    reportHeadlineLabel: '結論',
    reportContextLabel: 'レポート情報',
    reportEvidenceLabel: '主な証跡',
    reportSanitizedBadge: '匿名化済み',
    reportSanitizedNote: 'このレポートは匿名化された集計指標のみを含み、サーバーアドレス、コマンド本文、キー、ユーザーデータは含みません。',
    historyTitle: 'ローカル診断スナップショット',
    historyDescription: 'このブラウザだけに保存し、調整前後の匿名化レポートを比較します。',
    historyEmpty: 'スナップショットはまだありません。現在のレポートを保存すると比較できます。',
    saveSnapshot: 'スナップショット保存',
    historySaved: 'SSH 診断スナップショットをこのブラウザに保存しました',
    historyCompareTitle: '最新スナップショットとの比較',
    historyCompareEmptyTitle: '基準待ち',
    historyCompareEmptyDetail: '現在の匿名化レポートを一度保存すると、最新スナップショットとの差分を表示します。',
    historyCompareEmptyDelta: '比較結果はこのブラウザだけに保存され、サーバーへ送信されません。',
    historyCompareBetter: '体験が改善',
    historyCompareSame: '体験は同等',
    historyCompareWorse: '体験が悪化',
    historyCompareUnknown: '基準の更新が必要',
    historyCompareUnknownDelta: '古いスナップショットにトレンド評価がありません。もう一度保存すると比較できます。',
    historyCompareDetail: (current, baseline) => `現在 ${current} / 基準 ${baseline}`,
    historyCompareDelta: (findingDelta) => findingDelta === 0 ? '主要証跡数は同じ' : findingDelta > 0 ? `主要証跡が ${findingDelta} 件増加` : `主要証跡が ${Math.abs(findingDelta)} 件減少`,
    copySummary: '\u30b5\u30de\u30ea\u30fc\u3092\u30b3\u30d4\u30fc',
    copyCopied: 'SSH \u30d1\u30d5\u30a9\u30fc\u30de\u30f3\u30b9\u30b5\u30de\u30ea\u30fc\u3092\u30b3\u30d4\u30fc\u3057\u307e\u3057\u305f',
    summaryStatus: '\u72b6\u614b',
    summaryNextAction: '\u6b21\u306e\u5bfe\u5fdc',
    statusOk: '正常',
    statusWarn: '要観察',
    statusFail: '異常あり',
    nextActionOk: '実 SSH コマンドで継続検証し、遅延時は入力バッチ率、RTT、出力フラッシュを比較してください。',
    nextActionWarn: '入力バッチ率が低めです。貼り付け、大量出力、弱いネットワークの診断を追加取得してください。',
    nextActionFail: 'WebSocket エラーがあります。プロキシの Upgrade ヘッダー、タイムアウト、端末終了処理を優先確認してください。',
    nextActionNoEvidence: '端末操作の証跡がまだありません。SSH 端末で安全なコマンドを実行し、再読み込みしてください。',
    reportHeadline: (status, hasEvidence) => hasEvidence ? `現在の SSH 体験は「${status}」です。下の証跡で遅延箇所を切り分けてください。` : 'SSH 操作の証跡がまだありません。安全な速度テストを 1 回実行してから共有してください。',
    reportFindingInput: (events, flushes, ratio) => `入力経路：${events} 入力イベント / ${flushes} バックエンド書き込み、バッチ ${flushes > 0 ? formatBatchRatio(ratio) : '--'}x。`,
    reportFindingOutput: (events, flushes, ratio) => `出力経路：${events} 出力イベント / ${flushes} フロントエンド送信、バッチ ${flushes > 0 ? formatBatchRatio(ratio) : '--'}x。`,
    reportFindingLatency: (bottleneck, firstResponseMs, outputSpanMs, errors) => `遅延判定：${bottleneck}、初回応答 ${firstResponseMs === null ? '--' : `${Math.round(firstResponseMs)}ms`}、出力 ${outputSpanMs === null ? '--' : `${Math.round(outputSpanMs)}ms`}、接続エラー ${errors}。`,
    reportGeneratedAt: (time) => `生成 ${time}`,
    reportEvidenceLevel: (hasEvidence, replays, hasSelfTest) => hasEvidence ? `証跡 ${hasSelfTest ? '速度テスト' : 'ライブ'} / ${replays} 件再生` : '証跡不足',
    activeSessionsDetail: (count) => `${count} 件のライブ shell セッション`,
    inputBatchDetail: (events, flushes) => `${events} 入力イベント / ${flushes} バックエンド書き込み`,
    outputBatchDetail: (events, flushes) => `${events} 出力イベント / ${flushes} フロントエンド送信`,
    lastSelfTestDetail: (status, lines, durationMs, rate, recordedAt) => `${status} / ${lines} \u884c / ${Math.round(durationMs)}ms / ${formatSelfTestRate(rate, 'ja')} / ${recordedAt}`,
    lastSelfTestNone: '\u307e\u3060\u901f\u5ea6\u30c6\u30b9\u30c8\u7d50\u679c\u304c\u3042\u308a\u307e\u305b\u3093\u3002SSH \u7aef\u672b\u306e CPU \u30dc\u30bf\u30f3\u304b\u3089\u5b9f\u884c\u3067\u304d\u307e\u3059\u3002',
    responseSplitDetail: (firstResponseMs, outputSpanMs) => `\u521d\u56de\u5fdc\u7b54 ${Math.round(firstResponseMs)}ms / \u51fa\u529b ${Math.round(outputSpanMs)}ms`,
    responseSplitNone: 'SSH \u5b89\u5168\u901f\u5ea6\u30c6\u30b9\u30c8\u5f8c\u306b\u5fdc\u7b54\u3068\u51fa\u529b\u3092\u5206\u5272\u3057\u307e\u3059\u3002',
    trendValue: (direction, samples) => formatTrendValue(direction, samples, 'ja'),
    trendDetail: (averageDurationMs, latestDurationMs, previousDurationMs) => `\u5e73\u5747 ${Math.round(averageDurationMs)}ms / \u6700\u65b0 ${Math.round(latestDurationMs)}ms / \u524d\u56de ${previousDurationMs === null ? '--' : `${Math.round(previousDurationMs)}ms`}`,
    trendNone: 'SSH \u5b89\u5168\u901f\u5ea6\u30c6\u30b9\u30c8\u3092 1 \u56de\u4ee5\u4e0a\u5b9f\u884c\u3059\u308b\u3068\u30c8\u30ec\u30f3\u30c9\u3092\u751f\u6210\u3057\u307e\u3059\u3002',
    bottleneckValue: (bottleneck) => formatBottleneckValue(bottleneck, 'ja'),
    bottleneckDetail: (bottleneck, rttMs, throughputBytesPerSecond) => formatBottleneckDetail(bottleneck, rttMs, throughputBytesPerSecond, 'ja'),
    bottleneckNone: '\u5b89\u5168\u901f\u5ea6\u30c6\u30b9\u30c8\u5f8c\u306b RTT\u3001\u541e\u5410\u3001\u884c\u901f\u5ea6\u304b\u3089\u5224\u5b9a\u3057\u307e\u3059\u3002',
    sessionReplayValue: (sessions, active) => `${sessions} 件 / ${active} アクティブ`,
    sessionReplayDetail: (inputSubmits, outputEvents, outputLines, durationMs, closeSignal) => `${inputSubmits} 送信 / ${outputEvents} 出力 / ${outputLines} 行 / ${Math.round(durationMs)}ms / ${closeSignal ?? '実行中'}`,
    sessionReplayNone: '匿名化セッション再生はまだありません。SSH 端末で 1 回実行すると生成されます。',
    websocketErrorsDetail: (count) => count > 0 ? `${count} 件の接続/解析エラー` : '接続エラーは記録されていません',
  },
};

const diagnosticCopyByLanguage: Record<string, {
  export: string;
  exporting: string;
  exported: string;
  failed: string;
}> = {
  zh: {
    export: '导出诊断包',
    exporting: '导出中',
    exported: '脱敏诊断包已生成',
    failed: '诊断包导出失败',
  },
  en: {
    export: 'Export diagnostics',
    exporting: 'Exporting',
    exported: 'Sanitized diagnostics generated',
    failed: 'Diagnostics export failed',
  },
  ja: {
    export: '診断パックを書き出す',
    exporting: '書き出し中',
    exported: '匿名化診断パックを生成しました',
    failed: '診断パックの書き出しに失敗しました',
  },
};

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
    operationTraceTitle: '运维证据链',
    operationTracePreflight: '预检',
    operationTraceExecution: '执行',
    operationTraceExecuted: '已关联执行',
    operationTraceExecutionRisk: '执行存在风险',
    operationTraceBlocked: '预检已阻断',
    operationTraceWaiting: '等待执行证据',
    operationTraceMissing: '缺失',
    operationTraceNoPreflight: '未找到匹配预检',
    operationTraceNoExecution: '未找到匹配执行',
    operationTraceWindow: '按 15 分钟窗口匹配同类型、同目标记录',
    operationTraceCorrelation: (id) => `关联 ID ${id}`,
    viewTrace: '只看这条链',
    clearTrace: '清除链路筛选',
    copyTraceLink: '复制链路链接',
    traceLinkCopied: '审计链链接已复制',
    evidenceBriefTitle: '上线证据摘要',
    evidenceBriefDescription: '汇总当前评分、审计、事件队列和下一步动作，复制时自动脱敏。',
    evidenceBriefCopy: '复制证据摘要',
    evidenceBriefCopied: '上线证据摘要已复制',
    evidenceBriefNextAction: '下一步动作',
    evidenceBriefBlockersTitle: '主要阻断',
    evidenceBriefNoBlockers: '暂无阻断项',
    evidenceMetricReadiness: '就绪评分',
    evidenceMetricChecks: '检查覆盖',
    evidenceMetricAudit: '活跃审计问题',
    evidenceMetricQueue: '事件队列',
    evidenceDeploymentTitle: '部署证据',
    releasePlaybookTitle: '发布失败诊断词典',
    releasePlaybookDescription: '把发布日志中的典型信号映射为下一步处理动作，便于上线前快速判断是网络、认证还是远端脚本问题。',
    releasePlaybookSignalLabel: '信号：',
    releasePlaybookActionLabel: '处理：',
    releasePlaybookItems: [
      {
        id: 'ssh-refused',
        tone: 'fail',
        title: 'SSH 端口拒绝',
        signal: 'connection refused / exit code 255',
        action: '检查安全组、防火墙和 sshd 监听状态；若发布通道不可达，改用已授权的运维通道执行更新脚本。',
      },
      {
        id: 'ssh-auth',
        tone: 'warn',
        title: 'SSH 认证失败',
        signal: 'permission denied / publickey / too many authentication failures',
        action: '核对发布用户、部署密钥和 authorized_keys，确认没有把密码、私钥或真实凭据写入仓库。',
      },
      {
        id: 'remote-command',
        tone: 'warn',
        title: '远端脚本失败',
        signal: 'command not found / no such file or directory / non-255 exit',
        action: '确认远端更新脚本存在且可执行，查看服务日志后再重跑发布。',
      },
    ],
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
    traceApplied: (id, count) => `正在查看 trace ${id}，共 ${count} 条`,
    apiHostCount: (count) => `${count} 个允许域名`,
    corsOriginCount: (count) => `${count} 个来源`,
    timeoutMs: (ms) => `${ms} ms`,
    operationTraceElapsed: (duration) => `预检到执行间隔 ${duration}`,
    evidenceBriefGenerated: (time) => `证据生成：${time}`,
    evidenceAuditDetail: (blocked, failed, successRate, total) => `${blocked} 个阻断 / ${failed} 个失败，成功率 ${successRate}%（${total} 条）`,
    evidenceQueueDetail: (count) => count > 0 ? `${count} 个待处理事件需闭环` : '无待处理事件',
    evidenceDeploymentDetail: (channel, mode, host) => `${channel} / ${mode} / ${host}`,
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
    operationTraceTitle: 'Operation evidence chain',
    operationTracePreflight: 'Preflight',
    operationTraceExecution: 'Execution',
    operationTraceExecuted: 'Execution linked',
    operationTraceExecutionRisk: 'Execution risk',
    operationTraceBlocked: 'Preflight blocked',
    operationTraceWaiting: 'Waiting for execution',
    operationTraceMissing: 'Missing',
    operationTraceNoPreflight: 'No matching preflight',
    operationTraceNoExecution: 'No matching execution',
    operationTraceWindow: 'Matched by task type and target within a 15-minute window',
    operationTraceCorrelation: (id) => `Correlation ID ${id}`,
    viewTrace: 'View this trace',
    clearTrace: 'Clear trace',
    copyTraceLink: 'Copy trace link',
    traceLinkCopied: 'Audit trace link copied',
    evidenceBriefTitle: 'Release evidence brief',
    evidenceBriefDescription: 'Aggregates score, audits, event queue, and next action with secret-safe copy output.',
    evidenceBriefCopy: 'Copy evidence brief',
    evidenceBriefCopied: 'Release evidence brief copied',
    evidenceBriefNextAction: 'Next action',
    evidenceBriefBlockersTitle: 'Top blockers',
    evidenceBriefNoBlockers: 'No blockers',
    evidenceMetricReadiness: 'Readiness score',
    evidenceMetricChecks: 'Check coverage',
    evidenceMetricAudit: 'Active audit issues',
    evidenceMetricQueue: 'Event queue',
    evidenceDeploymentTitle: 'Deployment evidence',
    releasePlaybookTitle: 'Release failure playbook',
    releasePlaybookDescription: 'Maps common release log signals to the next safe action so operators can tell network, authentication, and remote-script failures apart before retrying.',
    releasePlaybookSignalLabel: 'Signal: ',
    releasePlaybookActionLabel: 'Action: ',
    releasePlaybookItems: [
      {
        id: 'ssh-refused',
        tone: 'fail',
        title: 'SSH port refused',
        signal: 'connection refused / exit code 255',
        action: 'Check security groups, firewall rules, and whether sshd is listening; if the release path is unreachable, use the authorized operations channel to run the updater.',
      },
      {
        id: 'ssh-auth',
        tone: 'warn',
        title: 'SSH authentication failed',
        signal: 'permission denied / publickey / too many authentication failures',
        action: 'Verify the deploy user, key, and authorized_keys without committing passwords, private keys, or real credentials.',
      },
      {
        id: 'remote-command',
        tone: 'warn',
        title: 'Remote script failed',
        signal: 'command not found / no such file or directory / non-255 exit',
        action: 'Confirm the remote updater exists and is executable, inspect service logs, then rerun the release.',
      },
    ],
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
    traceApplied: (id, count) => `Viewing trace ${id}, ${count} total`,
    apiHostCount: (count) => `${count} allowed hosts`,
    corsOriginCount: (count) => `${count} origins`,
    timeoutMs: (ms) => `${ms} ms`,
    operationTraceElapsed: (duration) => `Preflight-to-execution gap ${duration}`,
    evidenceBriefGenerated: (time) => `Evidence generated: ${time}`,
    evidenceAuditDetail: (blocked, failed, successRate, total) => `${blocked} blocked / ${failed} failed, ${successRate}% success across ${total} audits`,
    evidenceQueueDetail: (count) => count > 0 ? `${count} open events need closure` : 'No open events',
    evidenceDeploymentDetail: (channel, mode, host) => `${channel} / ${mode} / ${host}`,
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
    operationTraceTitle: '運用証跡チェーン',
    operationTracePreflight: '事前確認',
    operationTraceExecution: '実行',
    operationTraceExecuted: '実行に関連付け済み',
    operationTraceExecutionRisk: '実行リスクあり',
    operationTraceBlocked: '事前確認でブロック',
    operationTraceWaiting: '実行証跡待ち',
    operationTraceMissing: '未検出',
    operationTraceNoPreflight: '一致する事前確認なし',
    operationTraceNoExecution: '一致する実行なし',
    operationTraceWindow: '15分以内の同一タイプ、同一対象で照合',
    operationTraceCorrelation: (id) => `関連 ID ${id}`,
    viewTrace: 'この trace を表示',
    clearTrace: 'trace を解除',
    copyTraceLink: 'trace リンクをコピー',
    traceLinkCopied: '監査 trace リンクをコピーしました',
    evidenceBriefTitle: 'リリース証跡サマリー',
    evidenceBriefDescription: 'スコア、監査、イベントキュー、次の対応を集約し、コピー時に機密情報を伏せます。',
    evidenceBriefCopy: '証跡サマリーをコピー',
    evidenceBriefCopied: 'リリース証跡サマリーをコピーしました',
    evidenceBriefNextAction: '次の対応',
    evidenceBriefBlockersTitle: '主なブロッカー',
    evidenceBriefNoBlockers: 'ブロッカーなし',
    evidenceMetricReadiness: '準備スコア',
    evidenceMetricChecks: 'チェック範囲',
    evidenceMetricAudit: '有効な監査課題',
    evidenceMetricQueue: 'イベントキュー',
    evidenceDeploymentTitle: 'デプロイ証跡',
    releasePlaybookTitle: 'リリース失敗診断プレイブック',
    releasePlaybookDescription: 'リリースログの代表的なシグナルを次の安全な対応に対応付け、ネットワーク、認証、リモートスクリプトの失敗を切り分けます。',
    releasePlaybookSignalLabel: 'シグナル: ',
    releasePlaybookActionLabel: '対応: ',
    releasePlaybookItems: [
      {
        id: 'ssh-refused',
        tone: 'fail',
        title: 'SSH ポート拒否',
        signal: 'connection refused / exit code 255',
        action: 'セキュリティグループ、ファイアウォール、sshd の待受状態を確認し、通常のリリース経路が使えない場合は承認済みの運用経路で更新スクリプトを実行します。',
      },
      {
        id: 'ssh-auth',
        tone: 'warn',
        title: 'SSH 認証失敗',
        signal: 'permission denied / publickey / too many authentication failures',
        action: 'デプロイユーザー、鍵、authorized_keys を確認し、パスワード、秘密鍵、実認証情報をリポジトリに入れないことを確認します。',
      },
      {
        id: 'remote-command',
        tone: 'warn',
        title: 'リモートスクリプト失敗',
        signal: 'command not found / no such file or directory / non-255 exit',
        action: 'リモート更新スクリプトが存在し実行可能であることを確認し、サービスログを見てからリリースを再実行します。',
      },
    ],
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
    traceApplied: (id, count) => `trace ${id} を表示中、計 ${count} 件`,
    apiHostCount: (count) => `${count} 件の許可ホスト`,
    corsOriginCount: (count) => `${count} 件のオリジン`,
    timeoutMs: (ms) => `${ms} ms`,
    operationTraceElapsed: (duration) => `事前確認から実行まで ${duration}`,
    evidenceBriefGenerated: (time) => `証跡生成: ${time}`,
    evidenceAuditDetail: (blocked, failed, successRate, total) => `${blocked} 件ブロック / ${failed} 件失敗、${total} 件中成功率 ${successRate}%`,
    evidenceQueueDetail: (count) => count > 0 ? `${count} 件の未対応イベントを閉じる必要があります` : '未対応イベントなし',
    evidenceDeploymentDetail: (channel, mode, host) => `${channel} / ${mode} / ${host}`,
    auditStatus: (status) => ({
      all: 'すべて',
      success: '成功',
      blocked: 'ブロック',
      failed: '失敗',
    })[status],
  },
};
