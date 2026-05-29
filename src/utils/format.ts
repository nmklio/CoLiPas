import { Language } from '../i18n';
import { CloudAccountStatus, ServerStatus } from '../types';

const unknownRegionLabels: Record<Language, string> = {
  zh: '未知地域',
  en: 'Unknown region',
  ja: '不明なリージョン',
};

const countryLabels: Record<Language, Record<string, string>> = {
  zh: {
    AU: '澳大利亚',
    BR: '巴西',
    CA: '加拿大',
    CN: '中国大陆',
    DE: '德国',
    FR: '法国',
    GB: '英国',
    HK: '香港',
    IN: '印度',
    JP: '日本',
    KR: '韩国',
    NL: '荷兰',
    SG: '新加坡',
    TW: '中国台湾',
    UK: '英国',
    US: '美国',
    USA: '美国',
  },
  en: {
    AU: 'Australia',
    BR: 'Brazil',
    CA: 'Canada',
    CN: 'Mainland China',
    DE: 'Germany',
    FR: 'France',
    GB: 'United Kingdom',
    HK: 'Hong Kong',
    IN: 'India',
    JP: 'Japan',
    KR: 'South Korea',
    NL: 'Netherlands',
    SG: 'Singapore',
    TW: 'Taiwan',
    UK: 'United Kingdom',
    US: 'United States',
    USA: 'United States',
  },
  ja: {
    AU: 'オーストラリア',
    BR: 'ブラジル',
    CA: 'カナダ',
    CN: '中国本土',
    DE: 'ドイツ',
    FR: 'フランス',
    GB: '英国',
    HK: '香港',
    IN: 'インド',
    JP: '日本',
    KR: '韓国',
    NL: 'オランダ',
    SG: 'シンガポール',
    TW: '台湾',
    UK: '英国',
    US: '米国',
    USA: '米国',
  },
};

const countryNameLabels: Record<Language, Record<string, string>> = {
  zh: {
    australia: '澳大利亚',
    brazil: '巴西',
    canada: '加拿大',
    china: '中国大陆',
    france: '法国',
    germany: '德国',
    india: '印度',
    japan: '日本',
    netherlands: '荷兰',
    singapore: '新加坡',
    'south korea': '韩国',
    taiwan: '中国台湾',
    'united kingdom': '英国',
    'united states': '美国',
    'united states of america': '美国',
  },
  en: {},
  ja: {
    australia: 'オーストラリア',
    brazil: 'ブラジル',
    canada: 'カナダ',
    china: '中国本土',
    france: 'フランス',
    germany: 'ドイツ',
    india: 'インド',
    japan: '日本',
    netherlands: 'オランダ',
    singapore: 'シンガポール',
    'south korea': '韓国',
    taiwan: '台湾',
    'united kingdom': '英国',
    'united states': '米国',
    'united states of america': '米国',
  },
};

const placeLabels: Record<Language, Record<string, string>> = {
  zh: {
    ashburn: '阿什本',
    beijing: '北京',
    california: '加州',
    frankfurt: '法兰克福',
    'hong kong': '香港',
    hongkong: '香港',
    london: '伦敦',
    'los angeles': '洛杉矶',
    'mong kok': '旺角',
    'new york': '纽约',
    newyork: '纽约',
    oregon: '俄勒冈',
    seattle: '西雅图',
    shanghai: '上海',
    singapore: '新加坡',
    tokyo: '东京',
    virginia: '弗吉尼亚',
    'yau tsim mong': '油尖旺',
    'yau tsim mong district': '油尖旺',
  },
  en: {
    'yau tsim mong district': 'Yau Tsim Mong',
  },
  ja: {
    ashburn: 'アッシュバーン',
    beijing: '北京',
    california: 'カリフォルニア',
    frankfurt: 'フランクフルト',
    'hong kong': '香港',
    hongkong: '香港',
    london: 'ロンドン',
    'los angeles': 'ロサンゼルス',
    'mong kok': '旺角',
    'new york': 'ニューヨーク',
    newyork: 'ニューヨーク',
    oregon: 'オレゴン',
    seattle: 'シアトル',
    shanghai: '上海',
    singapore: 'シンガポール',
    tokyo: '東京',
    virginia: 'バージニア',
    'yau tsim mong': '油尖旺',
    'yau tsim mong district': '油尖旺',
  },
};

const localizedFormatCacheLimit = 2048;
const countryNameCache = new Map<string, string>();
const regionNameCache = new Map<string, string>();

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

export function formatCountryName(country: string, language: Language = 'zh') {
  return cacheLocalizedFormat(countryNameCache, language, country, () => {
    const normalized = normalizeLocationToken(country);
    return countryNameLabels[language][normalized] ?? country;
  });
}

export function formatRegionName(region: string, language: Language = 'zh') {
  return cacheLocalizedFormat(regionNameCache, language, region, () => {
    const trimmed = region.trim();
    if (!trimmed || ['unknown', 'unknown region'].includes(normalizeLocationToken(trimmed))) {
      return unknownRegionLabels[language];
    }

    const directLabel = placeLabels[language][normalizeLocationToken(trimmed)];
    if (directLabel) {
      return directLabel;
    }

    const parts = trimmed
      .split(/\s*\/\s*/)
      .flatMap((part) => expandCountryRegionPart(part))
      .map((part) => formatRegionPart(part, language))
      .filter(Boolean);

    const uniqueParts = parts.filter((part, index) => parts.indexOf(part) === index);
    if (!uniqueParts.length) {
      return trimmed;
    }

    return uniqueParts.join(language === 'en' ? ' / ' : ' · ');
  });
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

function cacheLocalizedFormat(cache: Map<string, string>, language: Language, input: string, formatter: () => string) {
  const cacheKey = `${language}::${input}`;
  const cachedValue = cache.get(cacheKey);
  if (cachedValue !== undefined) {
    return cachedValue;
  }

  const value = formatter();
  if (cache.size >= localizedFormatCacheLimit) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(cacheKey, value);
  return value;
}

function expandCountryRegionPart(part: string) {
  const trimmed = part.trim();
  const match = trimmed.match(/^([a-z]{2,3})\s*[-–]\s*(.+)$/i);
  if (!match) {
    return [trimmed];
  }

  const code = match[1].toUpperCase();
  if (!countryLabels.en[code]) {
    return [trimmed];
  }

  return [code, match[2].trim()];
}

function formatRegionPart(part: string, language: Language) {
  const trimmed = part.trim();
  const normalized = normalizeLocationToken(trimmed);
  const code = normalized.toUpperCase();

  return countryLabels[language][code]
    ?? placeLabels[language][normalized]
    ?? toTitleLocationPart(trimmed);
}

function normalizeLocationToken(value: string) {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[']/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function toTitleLocationPart(value: string) {
  if (!/^[a-z][a-z\s_-]*$/i.test(value)) {
    return value;
  }

  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
