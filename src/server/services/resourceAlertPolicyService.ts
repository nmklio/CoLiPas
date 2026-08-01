import { z } from 'zod';
import type { ResourceAlertPolicy, ResourceAlertPolicyResponse } from '../../types.js';
import {
  defaultResourceAlertPolicy,
  resourceAlertReminderOptions,
  resourceAlertThresholdMaximum,
  resourceAlertThresholdMinimum,
} from '../../shared/resourceAlerts.js';
import { readAppSetting, writeAppSetting } from './database.js';

const resourceAlertPolicySettingId = 'monitoring-resource-alert-policy.v1';

const resourceAlertPolicyInputSchema = z.object({
  enabled: z.boolean(),
  cpuThreshold: z.number().int().min(resourceAlertThresholdMinimum).max(resourceAlertThresholdMaximum),
  memoryThreshold: z.number().int().min(resourceAlertThresholdMinimum).max(resourceAlertThresholdMaximum),
  diskThreshold: z.number().int().min(resourceAlertThresholdMinimum).max(resourceAlertThresholdMaximum),
  reminderMinutes: z.number().int().refine(
    (value) => (resourceAlertReminderOptions as readonly number[]).includes(value),
    'Resource alert reminder interval is invalid',
  ),
}).strict();

const storedResourceAlertPolicySchema = resourceAlertPolicyInputSchema.extend({
  updatedAt: z.string().datetime({ offset: true }),
});

const storedResourceAlertPolicyRecordSchema = z.object({
  version: z.literal(1),
  policy: storedResourceAlertPolicySchema,
});

export function getResourceAlertPolicy(): ResourceAlertPolicyResponse {
  return { policy: readStoredResourceAlertPolicy() };
}

export function updateResourceAlertPolicy(input: unknown): ResourceAlertPolicyResponse {
  const parsed = resourceAlertPolicyInputSchema.parse(input);
  const policy: ResourceAlertPolicy = {
    ...parsed,
    updatedAt: new Date().toISOString(),
  };
  writeAppSetting(resourceAlertPolicySettingId, {
    version: 1,
    policy,
  });
  return { policy };
}

function readStoredResourceAlertPolicy(): ResourceAlertPolicy {
  const row = readAppSetting(resourceAlertPolicySettingId);
  if (!row) {
    return { ...defaultResourceAlertPolicy };
  }

  try {
    return storedResourceAlertPolicyRecordSchema.parse(JSON.parse(row.payload)).policy;
  } catch {
    return { ...defaultResourceAlertPolicy };
  }
}
