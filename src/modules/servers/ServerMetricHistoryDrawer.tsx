import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Activity, ChartNoAxesCombined, Clock3, Database, LoaderCircle, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { useI18n } from '../../i18n';
import { fetchServerMetricHistory } from '../../services/apiClient';
import type {
  ServerMetricHistoryPoint,
  ServerMetricHistoryResponse,
  ServerMetricHistoryWindow,
  ServerMetricValues,
  ServerNode,
} from '../../types';

interface ServerMetricHistoryDrawerProps {
  open: boolean;
  server: ServerNode | null;
  onClose: () => void;
}

interface CachedHistory {
  data: ServerMetricHistoryResponse;
  fetchedAt: number;
  telemetrySampledAt: string | null;
}

const historyWindows: ServerMetricHistoryWindow[] = ['1h', '6h', '24h', '7d'];
const historyCacheTtlMs = 15_000;
const historyCacheEntryLimit = 96;
const historyResponseCache = new Map<string, CachedHistory>();
const chartWidth = 760;
const chartHeight = 292;
const chartInset = { top: 18, right: 18, bottom: 30, left: 38 };
const metricDefinitions = [
  { id: 'cpu', color: '#0f766e' },
  { id: 'memory', color: '#2563eb' },
  { id: 'disk', color: '#dc5a47' },
] as const;

export function ServerMetricHistoryDrawer({ open, server, onClose }: ServerMetricHistoryDrawerProps) {
  const { language, t } = useI18n();
  const [historyWindow, setHistoryWindow] = useState<ServerMetricHistoryWindow>('24h');
  const [history, setHistory] = useState<ServerMetricHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const requestSequenceRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const serverId = server?.id ?? '';
  const telemetrySampledAt = server?.telemetry?.sampledAt ?? null;
  const locale = language === 'en' ? 'en-US' : language === 'ja' ? 'ja-JP' : 'zh-CN';

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const loadHistory = useCallback(async (force = false) => {
    if (!serverId) {
      return;
    }

    const cacheKey = `${serverId}:${historyWindow}`;
    const cached = historyResponseCache.get(cacheKey);
    if (
      !force
      && cached
      && Date.now() - cached.fetchedAt < historyCacheTtlMs
      && cached.telemetrySampledAt === telemetrySampledAt
    ) {
      setHistory(cached.data);
      setHoverIndex(null);
      setError('');
      setLoading(false);
      return;
    }

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const requestSequence = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestSequence;
    setLoading(true);
    setError('');
    setHistory(null);
    try {
      const data = await fetchServerMetricHistory(serverId, historyWindow, {
        force,
        signal: controller.signal,
      });
      if (requestSequenceRef.current !== requestSequence) {
        return;
      }
      cacheHistoryResponse(cacheKey, {
        data,
        fetchedAt: Date.now(),
        telemetrySampledAt,
      });
      setHistory(data);
      setHoverIndex(null);
    } catch (loadError) {
      if (controller.signal.aborted || requestSequenceRef.current !== requestSequence) {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : t('servers.metricHistory.loadFailed'));
      setHistory(null);
    } finally {
      if (requestSequenceRef.current === requestSequence) {
        setLoading(false);
      }
    }
  }, [historyWindow, serverId, t, telemetrySampledAt]);

  useEffect(() => {
    if (!open || !serverId) {
      requestControllerRef.current?.abort();
      return undefined;
    }

    void loadHistory();
    return () => requestControllerRef.current?.abort();
  }, [loadHistory, open, serverId]);

  useEffect(() => {
    if (!open || !serverId) {
      return undefined;
    }

    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = globalThis.window.setTimeout(() => closeButtonRef.current?.focus(), 20);

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, serverId]);

  useEffect(() => {
    if (!open && returnFocusRef.current) {
      const returnFocus = returnFocusRef.current;
      returnFocusRef.current = null;
      if (returnFocus.isConnected) {
        returnFocus.focus();
      }
    }
  }, [open]);

  const selectedPoint = history?.points.length
    ? history.points[hoverIndex ?? history.points.length - 1]
    : null;
  const chartGeometry = useMemo(() => history ? buildChartGeometry(history) : null, [history]);

  if (!open || !server || typeof document === 'undefined') {
    return null;
  }

  return createPortal((
    <>
      <button
        type="button"
        className="server-metric-history-backdrop"
        data-server-metric-history-backdrop="true"
        aria-label={t('common.close')}
        onClick={onClose}
      />
      <aside
        className="server-metric-history-drawer"
        data-server-metric-history-drawer="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-metric-history-title"
      >
        <header className="server-metric-history-head">
          <span className="server-metric-history-signal"><ChartNoAxesCombined size={20} aria-hidden="true" /></span>
          <div>
            <small>{t('servers.metricHistory.eyebrow')}</small>
            <h2 id="server-metric-history-title">{server.name}</h2>
            <p>{t('servers.metricHistory.detail')}</p>
          </div>
          <div className="server-metric-history-head-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={t('servers.metricHistory.refresh')}
              title={t('servers.metricHistory.refresh')}
              disabled={loading}
              onClick={() => void loadHistory(true)}
            >
              <RefreshCw size={16} className={loading ? 'spin' : undefined} aria-hidden="true" />
            </button>
            <button ref={closeButtonRef} type="button" className="icon-button" aria-label={t('common.close')} onClick={onClose}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="server-metric-history-toolbar">
          <div className="segmented" role="group" aria-label={t('servers.metricHistory.windowLabel')}>
            {historyWindows.map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={historyWindow === candidate ? 'active' : ''}
                aria-pressed={historyWindow === candidate}
                onClick={() => setHistoryWindow(candidate)}
              >
                {candidate}
              </button>
            ))}
          </div>
          <span className={`server-metric-history-live ${server.telemetry?.status ?? 'unavailable'}`}>
            <i aria-hidden="true" />
            {formatTelemetryState(server, locale, t)}
          </span>
        </div>

        <div className="server-metric-history-body">
          {loading && !history ? (
            <div className="server-metric-history-state loading" role="status" data-server-metric-history-state="loading">
              <LoaderCircle size={22} className="spin" aria-hidden="true" />
              <strong>{t('servers.metricHistory.loading')}</strong>
            </div>
          ) : error ? (
            <div className="server-metric-history-state error" role="alert" data-server-metric-history-state="error">
              <TriangleAlert size={22} aria-hidden="true" />
              <strong>{t('servers.metricHistory.loadFailed')}</strong>
              <small>{error}</small>
              <button type="button" className="tool-button" onClick={() => void loadHistory(true)}>
                <RefreshCw size={14} aria-hidden="true" />
                {t('app.retryApi')}
              </button>
            </div>
          ) : history && history.points.length > 0 && chartGeometry ? (
            <>
              <section className="server-metric-history-chart-section" aria-labelledby="server-metric-history-chart-title">
                <div className="server-metric-history-section-head">
                  <div>
                    <span><Activity size={14} aria-hidden="true" /> {t('servers.metricHistory.chartTitle')}</span>
                    <strong id="server-metric-history-chart-title">{formatHistoryRange(history, locale)}</strong>
                  </div>
                  <HistorySourceLabel history={history} />
                </div>
                <MetricHistoryChart
                  history={history}
                  geometry={chartGeometry}
                  hoverIndex={hoverIndex}
                  selectedPoint={selectedPoint}
                  locale={locale}
                  onHoverIndexChange={setHoverIndex}
                  t={t}
                />
                <div className="server-metric-history-legend" aria-label={t('servers.metricHistory.legendLabel')}>
                  {metricDefinitions.map((metric) => (
                    <span key={metric.id}><i style={{ background: metric.color }} aria-hidden="true" />{metricLabel(metric.id, t)}</span>
                  ))}
                </div>
              </section>

              <MetricHistoryLedger history={history} t={t} />

              <footer className="server-metric-history-evidence">
                <span><Database size={14} aria-hidden="true" /> {t('servers.metricHistory.points', { count: history.summary.rawPoints })}</span>
                <span><Clock3 size={14} aria-hidden="true" /> {t('servers.metricHistory.interval', { minutes: history.summary.intervalMinutes })}</span>
                <span>{history.summary.continuityPercent === null
                  ? t('servers.metricHistory.continuityPending')
                  : t('servers.metricHistory.continuity', { percent: history.summary.continuityPercent })}</span>
              </footer>
            </>
          ) : (
            <div className="server-metric-history-state empty" data-server-metric-history-state="empty">
              <ChartNoAxesCombined size={24} aria-hidden="true" />
              <strong>{t('servers.metricHistory.emptyTitle')}</strong>
              <small>{t('servers.metricHistory.emptyDetail')}</small>
            </div>
          )}
        </div>
      </aside>
    </>
  ), document.body);
}

function cacheHistoryResponse(key: string, value: CachedHistory) {
  historyResponseCache.delete(key);
  historyResponseCache.set(key, value);
  while (historyResponseCache.size > historyCacheEntryLimit) {
    const oldestKey = historyResponseCache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    historyResponseCache.delete(oldestKey);
  }
}

interface ChartGeometry {
  from: number;
  to: number;
  polylines: Record<'cpu' | 'memory' | 'disk', string>;
  pointXs: number[];
}

function buildChartGeometry(history: ServerMetricHistoryResponse): ChartGeometry {
  const from = Date.parse(history.range.from);
  const to = Math.max(from + 1, Date.parse(history.range.to));
  const pointXs = history.points.map((point) => scaleTime(Date.parse(point.sampledAt), from, to));
  return {
    from,
    to,
    pointXs,
    polylines: {
      cpu: buildPolyline(history.points, pointXs, 'cpu'),
      memory: buildPolyline(history.points, pointXs, 'memory'),
      disk: buildPolyline(history.points, pointXs, 'disk'),
    },
  };
}

function MetricHistoryChart({
  history,
  geometry,
  hoverIndex,
  selectedPoint,
  locale,
  onHoverIndexChange,
  t,
}: {
  history: ServerMetricHistoryResponse;
  geometry: ChartGeometry;
  hoverIndex: number | null;
  selectedPoint: ServerMetricHistoryPoint | null;
  locale: string;
  onHoverIndexChange: (index: number | null) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const selectedIndex = hoverIndex ?? history.points.length - 1;
  const cursorX = geometry.pointXs[selectedIndex] ?? chartInset.left;
  const cursorPercent = ((cursorX - chartInset.left) / (chartWidth - chartInset.left - chartInset.right)) * 100;

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = bounds.width > 0 ? (event.clientX - bounds.left) / bounds.width : 0;
    const chartX = chartInset.left + Math.max(0, Math.min(1, ratio)) * (chartWidth - chartInset.left - chartInset.right);
    onHoverIndexChange(findNearestPointIndex(geometry.pointXs, chartX));
  }

  function handleChartKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const currentIndex = hoverIndex ?? history.points.length - 1;
    onHoverIndexChange(event.key === 'ArrowLeft'
      ? Math.max(0, currentIndex - 1)
      : Math.min(history.points.length - 1, currentIndex + 1));
  }

  return (
    <div
      className="server-metric-history-chart"
      style={{ '--history-cursor': `${cursorPercent}%` } as CSSProperties}
      tabIndex={0}
      role="img"
      aria-label={t('servers.metricHistory.chartAria', { count: history.points.length })}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => onHoverIndexChange(null)}
      onKeyDown={handleChartKeyDown}
    >
      <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" aria-hidden="true">
        <rect className="history-zone critical" x={chartInset.left} y={scaleMetric(100)} width={chartWidth - chartInset.left - chartInset.right} height={scaleMetric(85) - scaleMetric(100)} />
        <rect className="history-zone warning" x={chartInset.left} y={scaleMetric(85)} width={chartWidth - chartInset.left - chartInset.right} height={scaleMetric(70) - scaleMetric(85)} />
        <rect className="history-zone normal" x={chartInset.left} y={scaleMetric(70)} width={chartWidth - chartInset.left - chartInset.right} height={scaleMetric(0) - scaleMetric(70)} />
        {[0, 25, 50, 75, 100].map((value) => (
          <g key={value}>
            <line className="history-grid-line" x1={chartInset.left} x2={chartWidth - chartInset.right} y1={scaleMetric(value)} y2={scaleMetric(value)} />
            <text className="history-grid-label" x={chartInset.left - 8} y={scaleMetric(value) + 4}>{value}</text>
          </g>
        ))}
        {metricDefinitions.map((metric) => (
          <polyline
            key={metric.id}
            className={`history-metric-line ${metric.id}`}
            points={geometry.polylines[metric.id]}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <line className="history-cursor-line" x1={cursorX} x2={cursorX} y1={chartInset.top} y2={chartHeight - chartInset.bottom} vectorEffect="non-scaling-stroke" />
        {selectedPoint ? metricDefinitions.map((metric) => (
          <circle
            key={metric.id}
            className={`history-cursor-point ${metric.id}`}
            cx={cursorX}
            cy={scaleMetric(selectedPoint[metric.id])}
            r="4"
            vectorEffect="non-scaling-stroke"
          />
        )) : null}
      </svg>
      {selectedPoint ? (
        <div className="server-metric-history-tooltip" data-server-metric-history-tooltip="true">
          <strong>{new Date(selectedPoint.sampledAt).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong>
          <span>CPU {selectedPoint.cpu}%</span>
          <span>{t('servers.metricHistory.memory')} {selectedPoint.memory}%</span>
          <span>{t('servers.metricHistory.disk')} {selectedPoint.disk}%</span>
        </div>
      ) : null}
    </div>
  );
}

function MetricHistoryLedger({
  history,
  t,
}: {
  history: ServerMetricHistoryResponse;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <section className="server-metric-history-ledger" aria-label={t('servers.metricHistory.summaryLabel')}>
      <div className="server-metric-history-ledger-head">
        <span>{t('servers.metricHistory.metric')}</span>
        <span>{t('servers.metricHistory.latest')}</span>
        <span>{t('servers.metricHistory.average')}</span>
        <span>{t('servers.metricHistory.peak')}</span>
        <span>{t('servers.metricHistory.change')}</span>
      </div>
      {metricDefinitions.map((metric) => (
        <div key={metric.id} className="server-metric-history-ledger-row">
          <strong><i style={{ background: metric.color }} aria-hidden="true" />{metricLabel(metric.id, t)}</strong>
          <span>{formatMetricValue(history.summary.latest, metric.id)}</span>
          <span>{formatMetricValue(history.summary.average, metric.id)}</span>
          <span>{formatMetricValue(history.summary.peak, metric.id)}</span>
          <span className={formatChangeClass(history.summary.change, metric.id)}>{formatMetricChange(history.summary.change, metric.id, t)}</span>
        </div>
      ))}
    </section>
  );
}

function HistorySourceLabel({ history }: { history: ServerMetricHistoryResponse }) {
  const { t } = useI18n();
  const source = history.summary.sources.real > 0 && history.summary.sources.simulate > 0
    ? 'mixed'
    : history.summary.sources.simulate > 0
      ? 'simulate'
      : 'real';
  return <small className={`server-metric-history-source ${source}`}>{t(`servers.metricHistory.source.${source}`)}</small>;
}

function buildPolyline(
  points: ServerMetricHistoryPoint[],
  pointXs: number[],
  metric: keyof ServerMetricValues,
) {
  return points.map((point, index) => `${pointXs[index].toFixed(2)},${scaleMetric(point[metric]).toFixed(2)}`).join(' ');
}

function scaleTime(value: number, from: number, to: number) {
  const ratio = (value - from) / Math.max(1, to - from);
  return chartInset.left + Math.max(0, Math.min(1, ratio)) * (chartWidth - chartInset.left - chartInset.right);
}

function scaleMetric(value: number) {
  const ratio = Math.max(0, Math.min(100, value)) / 100;
  return chartHeight - chartInset.bottom - ratio * (chartHeight - chartInset.top - chartInset.bottom);
}

function findNearestPointIndex(pointXs: number[], target: number) {
  let low = 0;
  let high = pointXs.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (pointXs[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (low === 0) {
    return 0;
  }
  return Math.abs(pointXs[low] - target) < Math.abs(pointXs[low - 1] - target) ? low : low - 1;
}

function metricLabel(metric: keyof ServerMetricValues, t: (key: string) => string) {
  if (metric === 'cpu') {
    return 'CPU';
  }
  return t(`servers.metricHistory.${metric}`);
}

function formatMetricValue(values: ServerMetricValues | null, metric: keyof ServerMetricValues) {
  return values ? `${values[metric]}%` : '--';
}

function formatMetricChange(
  values: ServerMetricValues | null,
  metric: keyof ServerMetricValues,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  if (!values) {
    return '--';
  }
  const value = values[metric];
  return t('servers.metricHistory.changeValue', { value: `${value > 0 ? '+' : ''}${value}` });
}

function formatChangeClass(values: ServerMetricValues | null, metric: keyof ServerMetricValues) {
  if (!values || Math.abs(values[metric]) < 3) {
    return 'stable';
  }
  return values[metric] > 0 ? 'rising' : 'falling';
}

function formatHistoryRange(history: ServerMetricHistoryResponse, locale: string) {
  const from = new Date(history.range.from).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const to = new Date(history.range.to).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `${from} - ${to}`;
}

function formatTelemetryState(
  server: ServerNode,
  locale: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
) {
  const status = server.telemetry?.status ?? 'unavailable';
  if (!server.telemetry?.sampledAt) {
    return t(`servers.metricTelemetry.${status}`);
  }
  const sampledAt = new Date(server.telemetry.sampledAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return t(`servers.metricTelemetry.${status}`, { time: sampledAt });
}
