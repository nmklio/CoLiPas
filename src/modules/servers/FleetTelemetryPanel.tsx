import { Activity, ArrowUpRight, Gauge } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { ServerNode } from '../../types';

interface FleetTelemetryPanelProps {
  servers: ServerNode[];
  onOpenHistory: (serverId: string) => void;
}

/**
 * Second view of the resources module: fleet-wide telemetry freshness plus the
 * per-server entry point into the metric history drawer. The inventory itself
 * stays in the first view, so this panel never repeats the server table.
 */
export function FleetTelemetryPanel({ servers, onOpenHistory }: FleetTelemetryPanelProps) {
  const { language, t } = useI18n();
  const locale = language === 'en' ? 'en-US' : language === 'ja' ? 'ja-JP' : 'zh-CN';
  const sampledCount = servers.filter((server) => Boolean(server.telemetry?.sampledAt)).length;
  const ordered = [...servers].sort((left, right) => right.cpu - left.cpu);

  return (
    <section className="module-section" aria-labelledby="fleet-telemetry-title" data-fleet-telemetry="true">
      <div className="section-header">
        <div>
          <p>{t('servers.fleetTelemetryEyebrow')}</p>
          <h2 id="fleet-telemetry-title">{t('servers.fleetTelemetryTitle')}</h2>
        </div>
        <div className="section-actions">
          <span className="fleet-telemetry-summary" data-fleet-telemetry-summary="true">
            <Activity size={15} aria-hidden="true" />
            {t('servers.fleetTelemetrySummary', { sampled: sampledCount, total: servers.length })}
          </span>
        </div>
      </div>

      {ordered.length === 0 ? (
        <p className="fleet-telemetry-empty" data-fleet-telemetry-empty="true">
          {t('servers.fleetTelemetryEmpty')}
        </p>
      ) : (
        <div className="fleet-telemetry-grid">
          {ordered.map((server) => {
            const sampledAt = server.telemetry?.sampledAt ?? '';
            const freshness = server.telemetry?.status ?? 'unavailable';
            return (
              <article
                key={server.id}
                className={`fleet-telemetry-card ${freshness}`}
                data-fleet-telemetry-card={server.id}
                data-fleet-telemetry-freshness={freshness}
              >
                <header>
                  <strong>{server.name}</strong>
                  <small>{server.region || t('servers.fleetTelemetryRegionUnknown')}</small>
                </header>
                <dl>
                  <div>
                    <dt>{t('servers.fleetTelemetryCpu')}</dt>
                    <dd>{Math.round(server.cpu)}%</dd>
                  </div>
                  <div>
                    <dt>{t('servers.fleetTelemetryMemory')}</dt>
                    <dd>{Math.round(server.memory)}%</dd>
                  </div>
                  <div>
                    <dt>{t('servers.fleetTelemetryDisk')}</dt>
                    <dd>{Math.round(server.disk)}%</dd>
                  </div>
                </dl>
                <footer>
                  <span>{sampledAt ? t('servers.fleetTelemetrySampledAt', { time: new Date(sampledAt).toLocaleString(locale) }) : t('servers.fleetTelemetryNoSample')}</span>
                  <button
                    type="button"
                    className="tool-button"
                    data-fleet-telemetry-history={server.id}
                    onClick={() => onOpenHistory(server.id)}
                  >
                    <Gauge size={15} aria-hidden="true" />
                    {t('servers.fleetTelemetryOpenHistory')}
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
