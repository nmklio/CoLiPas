import { RuntimeConfig } from '../config.js';

export function buildConfigSummary(config: RuntimeConfig) {
  return {
    nodeEnv: config.nodeEnv,
    corsOrigins: config.corsOrigins,
    customApiAllowedHosts: config.customApiAllowedHosts,
    customApiTimeoutMs: config.customApiTimeoutMs,
    ai: {
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
      configured: Boolean(config.ai.apiKey),
    },
    security: config.security,
  };
}
