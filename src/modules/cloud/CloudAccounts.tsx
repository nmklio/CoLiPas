import { Cloud, CloudOff, DollarSign, PlugZap, RefreshCw } from 'lucide-react';
import { useI18n } from '../../i18n';
import { CloudAccount, ServerNode } from '../../types';
import { formatCurrency, statusLabel } from '../../utils/format';

interface CloudAccountsProps {
  accounts: CloudAccount[];
  servers: ServerNode[];
}

export function CloudAccounts({ accounts, servers }: CloudAccountsProps) {
  const { language, t } = useI18n();

  return (
    <section className="module-section" aria-labelledby="cloud-title">
      <div className="section-header">
        <div>
          <p>{t('cloud.eyebrow')}</p>
          <h2 id="cloud-title">{t('cloud.title')}</h2>
        </div>
        <button type="button" className="tool-button">
          <RefreshCw size={16} />
          {t('cloud.syncAssets')}
        </button>
      </div>

      {accounts.length === 0 ? (
        <div className="empty-state">
          <PlugZap size={26} />
          <h3>{t('cloud.emptyTitle')}</h3>
          <p>{t('cloud.emptyDesc')}</p>
        </div>
      ) : (
        <div className="cloud-grid">
          {accounts.map((account) => {
            const serverCount = servers.filter((server) => server.provider === account.provider).length;
            const connected = account.status !== 'disconnected';
            return (
              <article className="cloud-card" key={account.id}>
                <div className="cloud-card-top">
                  <span className={`provider-logo ${account.status}`}>
                    {connected ? <Cloud size={20} /> : <CloudOff size={20} />}
                  </span>
                  <span className={`status-pill ${account.status}`}>{statusLabel(account.status, language)}</span>
                </div>
                <h3>{account.name}</h3>
                <p>{t('cloud.accountMeta', { provider: account.provider, regions: account.regionCount, servers: serverCount })}</p>
                <div className="metric-line">
                  <span>
                    <DollarSign size={15} />
                    {t('cloud.monthlyCost')}
                  </span>
                  <strong>{formatCurrency(account.monthlyCost, language)}</strong>
                </div>
                <div className="metric-line">
                  <span>{t('cloud.lastSync')}</span>
                  <strong>{account.lastSync}</strong>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
