import type { AIProviderConfig, CloudAccount, OperationEvent, ServerNode } from '../types.js';

export const cloudAccounts: CloudAccount[] = [];

export const servers: ServerNode[] = [];

export const operationEvents: OperationEvent[] = [];

export const defaultAIProvider: AIProviderConfig = {
  name: 'OpenAI Compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
  apiKey: '',
  temperature: 0.2,
};
