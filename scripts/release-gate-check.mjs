import { loadConfig } from '../build/server/config.js';
import { evaluateReleaseGatePolicy, getReleaseGatePolicy } from '../build/server/services/releaseReadinessService.js';

const options = parseArgs(process.argv.slice(2));
const config = loadConfig(process.env);
const runtimePolicy = getReleaseGatePolicy(config);
const pipelinePolicy = evaluateReleaseGatePolicy(
  {
    enabled: runtimePolicy.enabled,
    minScore: runtimePolicy.minScore,
    maxWarnings: runtimePolicy.maxWarnings,
    requireZeroFailures: runtimePolicy.requireZeroFailures,
    requireConnectedSsh: runtimePolicy.requireConnectedSsh,
    requireAiProvider: runtimePolicy.requireAiProvider,
    updatedAt: runtimePolicy.updatedAt,
    updatedBy: runtimePolicy.updatedBy,
  },
  {
    score: options.score,
    warnings: options.warnings,
    failures: options.failures,
    connectedSsh: options.targetCount,
    aiConfigured: runtimePolicy.observed.aiConfigured,
  },
);

const payload = {
  ok: pipelinePolicy.allowedToRelease,
  mode: 'pipeline-grey',
  targetCount: options.targetCount,
  runtimeAiConfigured: runtimePolicy.observed.aiConfigured,
  policy: pipelinePolicy,
};

if (options.json) {
  console.log(JSON.stringify(payload));
} else {
  const reasons = payload.policy.reasons.length > 0 ? payload.policy.reasons.join(' | ') : 'gate satisfied';
  console.log(
    [
      `Release gate (${payload.mode})`,
      `status=${payload.policy.status}`,
      `score=${payload.policy.observed.score}`,
      `warnings=${payload.policy.observed.warnings}`,
      `failures=${payload.policy.observed.failures}`,
      `targets=${payload.targetCount}`,
      `aiConfigured=${payload.policy.observed.aiConfigured ? 'yes' : 'no'}`,
      `enabled=${payload.policy.enabled ? 'yes' : 'no'}`,
      `allowed=${payload.policy.allowedToRelease ? 'yes' : 'no'}`,
      `reasons=${reasons}`,
    ].join('\n'),
  );
}

function parseArgs(args) {
  const options = {
    targetCount: 0,
    score: 100,
    warnings: 0,
    failures: 0,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }

    const next = args[index + 1];
    if (arg === '--target-count') {
      options.targetCount = parseIntegerOption(arg, next);
      index += 1;
      continue;
    }
    if (arg === '--score') {
      options.score = parseIntegerOption(arg, next);
      index += 1;
      continue;
    }
    if (arg === '--warnings') {
      options.warnings = parseIntegerOption(arg, next);
      index += 1;
      continue;
    }
    if (arg === '--failures') {
      options.failures = parseIntegerOption(arg, next);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.targetCount < 0) {
    throw new Error('--target-count must be 0 or greater');
  }
  if (options.score < 0 || options.score > 100) {
    throw new Error('--score must be between 0 and 100');
  }
  if (options.warnings < 0 || options.failures < 0) {
    throw new Error('--warnings and --failures must be 0 or greater');
  }

  return options;
}

function parseIntegerOption(name, value) {
  if (typeof value !== 'string') {
    throw new Error(`${name} requires an integer value`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} requires an integer value`);
  }

  return parsed;
}
