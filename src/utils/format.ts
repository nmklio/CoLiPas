import { Language } from '../i18n';
import { CloudAccountStatus, ServerStatus } from '../types';

export function formatCurrency(value: number, language: Language = 'zh') {
  const locale = language === 'en' ? 'en-US' : language === 'ja' ? 'ja-JP' : 'zh-CN';
  const currency = language === 'en' ? 'USD' : language === 'ja' ? 'JPY' : 'CNY';

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export function statusLabel(status: CloudAccountStatus | ServerStatus | 'open' | 'closed' | 'missing', language: Language = 'zh') {
  const labels: Record<Language, Record<string, string>> = {
    zh: {
      connected: '已连接',
      disconnected: '已断开',
      warning: '告警',
      running: '运行中',
      stopped: '已停止',
      provisioning: '创建中',
      unconnected: '未接入',
      missing: '不存在',
      open: '待处理',
      closed: '已关闭',
    },
    en: {
      connected: 'Connected',
      disconnected: 'Disconnected',
      warning: 'Warning',
      running: 'Running',
      stopped: 'Stopped',
      provisioning: 'Provisioning',
      unconnected: 'Unconnected',
      missing: 'Missing',
      open: 'Open',
      closed: 'Closed',
    },
    ja: {
      connected: '接続済み',
      disconnected: '切断済み',
      warning: '警告',
      running: '稼働中',
      stopped: '停止済み',
      provisioning: '作成中',
      unconnected: '未接続',
      missing: '見つかりません',
      open: '対応待ち',
      closed: 'クローズ済み',
    },
  };

  return labels[language][status] ?? status;
}

export function percentClass(value: number) {
  if (value >= 85) {
    return 'danger';
  }
  if (value >= 70) {
    return 'warning';
  }
  return 'normal';
}
