import { RuntimeConfig } from '../config.js';
import { getAiProviderStatus } from './aiSettingsService.js';

export function buildConfigSummary(config: RuntimeConfig) {
  const aiProvider = getAiProviderStatus(config);
  return {
    nodeEnv: config.nodeEnv,
    corsOrigins: config.corsOrigins,
    customApiAllowedHosts: config.customApiAllowedHosts,
    customApiTimeoutMs: config.customApiTimeoutMs,
    ai: {
      baseUrl: aiProvider.baseUrl,
      model: aiProvider.model,
      configured: aiProvider.configured,
      hasStoredApiKey: aiProvider.hasStoredApiKey,
      managedBy: aiProvider.managedBy,
    },
    security: config.security,
  };
}
