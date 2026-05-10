import { AIProviderConfig } from '../../types';
import { buildOpsPrompt } from '../../shared/aiPrompt';

export { buildOpsPrompt };

export type ValidationLanguage = 'zh' | 'en' | 'ja';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateAIProviderConfig(config: AIProviderConfig, language: ValidationLanguage = 'zh'): ValidationResult {
  const errors: string[] = [];
  const copy = validationCopy[language] ?? validationCopy.zh;

  if (config.name.trim().length < 2) {
    errors.push(copy.providerNameShort);
  }

  try {
    const url = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      errors.push(copy.baseUrlProtocol);
    }
    if (url.username || url.password || url.search || url.hash) {
      errors.push(copy.baseUrlClean);
    }
  } catch {
    errors.push(copy.baseUrlInvalid);
  }

  if (config.model.trim().length === 0) {
    errors.push(copy.modelRequired);
  }

  if (config.temperature < 0 || config.temperature > 2) {
    errors.push(copy.temperatureRange);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

const validationCopy: Record<ValidationLanguage, Record<string, string>> = {
  zh: {
    providerNameShort: '供应商名称至少需要 2 个字符',
    baseUrlProtocol: 'Base URL 必须使用 HTTP 或 HTTPS',
    baseUrlInvalid: 'Base URL 不是有效 URL',
    baseUrlClean: 'Base URL 不能包含账号、密码、查询参数或片段',
    modelRequired: '模型名称不能为空',
    temperatureRange: '随机性需要在 0 到 2 之间',
  },
  en: {
    providerNameShort: 'Provider name must be at least 2 characters',
    baseUrlProtocol: 'Base URL must use HTTP or HTTPS',
    baseUrlInvalid: 'Base URL is not a valid URL',
    baseUrlClean: 'Base URL must not include username, password, query parameters, or fragments',
    modelRequired: 'Model name is required',
    temperatureRange: 'Temperature must be between 0 and 2',
  },
  ja: {
    providerNameShort: 'プロバイダー名は 2 文字以上にしてください',
    baseUrlProtocol: 'Base URL は HTTP または HTTPS を使用してください',
    baseUrlInvalid: 'Base URL が正しい URL ではありません',
    baseUrlClean: 'Base URL にユーザー名、パスワード、クエリ、フラグメントは含められません',
    modelRequired: 'モデル名は必須です',
    temperatureRange: '温度は 0 から 2 の範囲で指定してください',
  },
};
