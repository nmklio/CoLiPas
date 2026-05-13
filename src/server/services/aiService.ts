import { createHash } from 'node:crypto';
import { buildOpsPrompt } from '../../shared/aiPrompt.js';
import { getSshCommandConfirmationReason } from '../../shared/sshCommandRisk.js';
import { AIProviderConfig, OperationEvent, ServerNode } from '../../types.js';
import { RuntimeConfig } from '../config.js';
import { HttpError } from '../httpErrors.js';
import type { SshShellEvidenceSummary } from './sshAccessService.js';
import { resolveAiProvider, type AiProviderInput } from './aiSettingsService.js';

export interface AiAnalysisRequest {
  question: string;
  prompt?: string;
  provider?: Partial<AIProviderConfig>;
  name?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  serverId?: string;
  forceRefresh?: boolean;
  messages?: AiChatMessage[];
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiAnalysisResponse {
  provider: string;
  model: string;
  prompt: string;
  answer: string;
  simulated: boolean;
  cached?: boolean;
  generatedAt?: string;
  executionPlan?: AiExecutionPlan;
}

export interface AiExecutionPlan {
  title: string;
  summary: string;
  targetMode: 'allServers' | 'allConnected' | 'selected';
  serverIds: string[];
  operation: 'assetSync' | 'healthCheck' | 'sshCommand' | 'powerOn' | 'shutdown' | 'reboot';
  command?: string;
  reason: string;
  confirmed?: boolean;
  requiresConfirmation?: boolean;
  confirmationReason?: string;
  safetyNote: string;
}

export interface AiConnectionTestResponse {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  checkedAt: string;
  message: string;
}

export interface AiModelsResponse {
  models: string[];
  provider: string;
  source: 'upstream' | 'fallback';
  message: string;
}

const fallbackModelOptions = ['gpt-5.5', 'gpt-5.4', 'gpt-4.1-mini', 'deepseek-chat', 'qwen-plus'];
const aiResponseCacheTtlMs = 10 * 60 * 1000;
const aiResponseCacheMaxEntries = 80;
const aiResponseCache = new Map<string, AiAnalysisResponse & { cachedAt: number }>();

export async function streamAiAnalysis(
  input: AiAnalysisRequest,
  context: { servers: ServerNode[]; events: OperationEvent[]; shellEvidence?: SshShellEvidenceSummary[] },
  config: RuntimeConfig,
  send: (chunk: string) => void,
): Promise<AiAnalysisResponse> {
  const question = (input.question || input.prompt || '').trim();
  if (!question) {
    throw new HttpError(400, 'AI question is required', 'INVALID_AI_QUESTION');
  }

  const selectedServers = input.serverId && input.serverId !== 'all'
    ? context.servers.filter((server) => server.id === input.serverId)
    : context.servers;
  const selectedServer = input.serverId && input.serverId !== 'all'
    ? context.servers.find((server) => server.id === input.serverId)
    : undefined;
  if (input.serverId && input.serverId !== 'all' && !selectedServer) {
    throw new HttpError(404, 'Server does not exist', 'SERVER_NOT_FOUND');
  }

  const aiProvider = resolveAiProvider(input, config);
  const chatHistory = normalizeChatHistory(input.messages);
  const includeOperationsContext = shouldUseOperationsContext(question, selectedServer);
  const prompt = buildAnalysisPrompt(selectedServers, context.events, question, selectedServer, chatHistory, includeOperationsContext, context.shellEvidence ?? []);
  const cacheKey = buildAiCacheKey(aiProvider, input.serverId ?? 'all', question, prompt, chatHistory);
  const cached = input.forceRefresh ? undefined : getCachedAiResponse(cacheKey);
  if (cached) {
    sendCachedAnswer(cached.answer, send);
    return { ...cached, cached: true };
  }

  const localResult = buildSimulatedAnswer(selectedServers, context.events, question, selectedServer, includeOperationsContext, chatHistory, context.shellEvidence ?? []);
  if (isLocalEvidenceBoundaryAnswer(localResult.answer)) {
    const { answer, executionPlan } = localResult;
    await sendAnswerInChunks(answer, send, 18);
    const result = withGeneratedAt({
      provider: publicProviderEndpoint(aiProvider.baseUrl),
      model: aiProvider.model,
      prompt,
      answer,
      simulated: true,
      cached: false,
      executionPlan,
    });
    setCachedAiResponse(cacheKey, result);
    return result;
  }

  if (!aiProvider.apiKey) {
    const { answer, executionPlan } = localResult;
    await sendAnswerInChunks(answer, send, 18);
    const result = withGeneratedAt({
      provider: publicProviderEndpoint(aiProvider.baseUrl),
      model: aiProvider.model,
      prompt,
      answer,
      simulated: true,
      cached: false,
      executionPlan,
    });
    setCachedAiResponse(cacheKey, result);
    return result;
  }

  const response = await fetch(`${aiProvider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${aiProvider.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: aiProvider.model,
      temperature: aiProvider.temperature,
      stream: true,
      messages: [
        {
          role: 'system',
          content: [
            'You are CoLiPas AI, a real-time chat assistant embedded in a multi-cloud server management panel.',
            'Answer the user question directly and naturally.',
            'Use the provided asset inventory, events, and SSH state only when the question is about operations, servers, cloud assets, troubleshooting, security, or orchestration.',
            'For casual, meta, or general questions, do not force an operations-risk template.',
            'Continue the conversation naturally. Use the prior chat messages only as conversational context.',
            'Do not fabricate servers, execution results, cloud resources, credentials, or hidden context.',
            'When the user asks for operations analysis, return concise prioritized risks, cause analysis, and executable next steps.',
          ].join(' '),
        },
        ...chatHistory,
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError(502, `AI service returned HTTP ${response.status}`, 'AI_UPSTREAM_ERROR');
  }

  const answer = await readChatCompletionStream(response, send);
  const finalAnswer = answer || 'AI service returned an empty response.';
  if (!answer) {
    send(finalAnswer);
  }
  const result = withGeneratedAt({
    provider: publicProviderEndpoint(aiProvider.baseUrl),
    model: aiProvider.model,
    prompt,
    answer: finalAnswer,
    simulated: false,
    cached: false,
    executionPlan: buildExecutionPlan(selectedServers, selectedServer, question, includeOperationsContext),
  });
  setCachedAiResponse(cacheKey, result);

  return result;
}

export async function listAiModels(input: { provider?: Partial<AIProviderConfig> }, config: RuntimeConfig): Promise<AiModelsResponse> {
  const aiProvider = resolveAiProvider(input, config);
  const fallbackModels = uniqueModels([aiProvider.model, ...fallbackModelOptions]);
  if (!aiProvider.apiKey) {
    return {
      models: fallbackModels,
      provider: publicProviderEndpoint(aiProvider.baseUrl),
      source: 'fallback',
      message: 'API key is not configured; using local fallback models',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(`${aiProvider.baseUrl.replace(/\/$/, '')}/models`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${aiProvider.apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError(502, `AI models endpoint returned HTTP ${response.status}`, 'AI_MODELS_FAILED');
    }

    const body = await response.json() as unknown;
    const upstreamModels = parseModelIds(body);
    const loadedModels = uniqueModels(upstreamModels);
    return {
      models: loadedModels.length > 0 ? loadedModels : fallbackModels,
      provider: publicProviderEndpoint(aiProvider.baseUrl),
      source: loadedModels.length > 0 ? 'upstream' : 'fallback',
      message: loadedModels.length > 0
        ? `Loaded ${loadedModels.length} models from upstream API`
        : 'No upstream models found; using fallback models',
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    const message = error instanceof Error && error.name === 'AbortError'
      ? 'AI models endpoint timed out'
      : `AI models endpoint failed: ${error instanceof Error ? error.message : 'unknown error'}`;
    throw new HttpError(502, message, 'AI_MODELS_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzeOperations(
  input: AiAnalysisRequest,
  context: { servers: ServerNode[]; events: OperationEvent[]; shellEvidence?: SshShellEvidenceSummary[] },
  config: RuntimeConfig,
): Promise<AiAnalysisResponse> {
  return streamAiAnalysis(input, context, config, () => undefined);
}

export async function testAiConnection(input: { provider?: Partial<AIProviderConfig> }, config: RuntimeConfig): Promise<AiConnectionTestResponse> {
  const aiProvider = resolveAiProvider(input, config);
  if (!aiProvider.apiKey) {
    throw new HttpError(400, 'Please enter an API Key before testing AI connectivity.', 'AI_API_KEY_REQUIRED');
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(`${aiProvider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${aiProvider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: aiProvider.model,
        temperature: 0,
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError(502, `AI connectivity failed: HTTP ${response.status}`, 'AI_CONNECTION_FAILED');
    }
    if (!response.body) {
      throw new HttpError(502, 'AI connectivity failed: upstream did not return a streaming response body.', 'AI_CONNECTION_FAILED');
    }

    await readChatCompletionStream(response, () => undefined);

    return {
      ok: true,
      provider: publicProviderEndpoint(aiProvider.baseUrl),
      model: aiProvider.model,
      latencyMs,
      checkedAt: new Date().toISOString(),
      message: 'AI service is reachable with stream:true.',
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'AI connectivity test timed out.'
      : `AI connectivity failed: ${error instanceof Error ? error.message : 'unknown error'}`;
    throw new HttpError(502, message, 'AI_CONNECTION_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

function parseModelIds(body: unknown) {
  if (!body || typeof body !== 'object') {
    return [];
  }

  const data = (body as { data?: unknown }).data;
  if (Array.isArray(data)) {
    return data
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
          return (item as { id: string }).id;
        }
        return '';
      })
      .filter(Boolean);
  }

  const models = (body as { models?: unknown }).models;
  if (Array.isArray(models)) {
    return models
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
          return (item as { id: string }).id;
        }
        return '';
      })
      .filter(Boolean);
  }

  return [];
}

function uniqueModels(models: string[]) {
  const seen = new Set<string>();
  return models
    .map((model) => model.trim())
    .filter((model) => {
      if (!model || seen.has(model)) {
        return false;
      }
      seen.add(model);
      return true;
    });
}

function publicProviderEndpoint(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return 'unknown';
  }
}

async function readChatCompletionStream(response: Response, onContent: (content: string) => void) {
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';

  const consumeEvent = (event: string) => {
    const dataLines = event
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());

    for (const dataLine of dataLines) {
      if (!dataLine || dataLine === '[DONE]') {
        continue;
      }

      try {
        const parsed = JSON.parse(dataLine) as {
          choices?: Array<{
            delta?: { content?: string };
            message?: { content?: string };
            text?: string;
          }>;
          response?: string;
          content?: string;
        };
        const choice = parsed.choices?.[0];
        const content = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? parsed.response ?? parsed.content ?? '';
        if (content) {
          answer += content;
          onContent(content);
        }
      } catch {
        // Ignore malformed stream events from upstream.
      }
    }
  };

  for await (const rawChunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(rawChunk, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) {
      consumeEvent(event);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    consumeEvent(buffer);
  }

  return answer;
}

function normalizeChatHistory(messages: AiChatMessage[] | undefined) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .filter((message) => (
      message
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string'
      && message.content.trim()
    ))
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 6000),
    }));
}

function shouldUseOperationsContext(question: string, selectedServer?: ServerNode) {
  if (selectedServer) {
    return true;
  }

  if (questionRequestsDirectSshExecution(question) || questionNeedsLiveSshEvidence(question)) {
    return true;
  }

  const normalized = question.toLowerCase();
  const operationsKeywords = [
    'server',
    'cloud',
    'ssh',
    'cpu',
    'memory',
    'disk',
    'traffic',
    'latency',
    'error',
    'audit',
    'security',
    'deploy',
    'restart',
    'reboot',
    'shutdown',
    'power',
    'orchestration',
    'diagnostic',
    '服务器',
    '云',
    '接入',
    '运维',
    '告警',
    '安全',
    '审计',
    '编排',
    '诊断',
    '资源',
    '负载',
    '内存',
    '磁盘',
    '重启',
    '开机',
    '关机',
  ];

  return operationsKeywords.some((keyword) => normalized.includes(keyword));
}

function buildAnalysisPrompt(
  servers: ServerNode[],
  events: OperationEvent[],
  question: string,
  selectedServer?: ServerNode,
  chatHistory: AiChatMessage[] = [],
  includeOperationsContext = true,
  shellEvidence: SshShellEvidenceSummary[] = [],
) {
  if (!includeOperationsContext) {
    return question;
  }

  const shellEvidenceText = formatShellEvidenceForPrompt(shellEvidence);
  const hasPriorExecutionEvidence = extractPriorExecutionEvidence(chatHistory).length > 0;
  const hasShellEvidence = Boolean(shellEvidenceText.trim());
  return [
    buildOpsPrompt(servers, events),
    '',
    `Analysis scope: ${selectedServer ? `${selectedServer.name} (${selectedServer.publicIp || 'no public IP'})` : 'all servers'}`,
    chatHistory.length ? `Prior conversation turns available: ${chatHistory.length}` : 'Prior conversation turns available: 0',
    chatHistory.length ? 'Use prior assistant messages that begin with "Execution evidence:" as factual SSH/operations output evidence.' : '',
    'Factual SSH command output is available only from prior assistant messages that begin with "Execution evidence:" or from non-empty Recent sanitized SSH terminal evidence.',
    hasPriorExecutionEvidence || hasShellEvidence
      ? 'When answering about current users, IP addresses, routes, or command output, cite only explicit command output present in the evidence. Shell prompts such as root@host are context only and do not prove command results.'
      : 'No factual SSH execution evidence is available. Do not state the current user, IP address, route table, command output, or claim a command ran; tell the operator to run the guarded execution card or live SSH terminal first.',
    shellEvidenceText ? `Recent sanitized SSH terminal evidence:\n${shellEvidenceText}` : 'Recent sanitized SSH terminal evidence: none',
    `User question: ${question}`,
  ].filter(Boolean).join('\n');
}

function buildSimulatedAnswer(
  servers: ServerNode[],
  events: OperationEvent[],
  question: string,
  selectedServer?: ServerNode,
  includeOperationsContext = true,
  chatHistory: AiChatMessage[] = [],
  shellEvidence: SshShellEvidenceSummary[] = [],
) {
  const priorEvidence = extractPriorExecutionEvidence(chatHistory);
  const latestShellEvidence = shellEvidence.filter((item) => item.transcript.trim()).slice(0, 3);
  const executionPlan = buildExecutionPlan(servers, selectedServer, question, includeOperationsContext);
  const combinedEvidenceText = [
    ...priorEvidence,
    ...latestShellEvidence.map((item) => item.transcript),
  ].join('\n');
  const directExecutionRequest = questionRequestsDirectSshExecution(question);
  if (
    includeOperationsContext
    && questionNeedsLiveSshEvidence(question)
    && !evidenceAppearsRelevantToQuestion(question, combinedEvidenceText)
  ) {
    return {
      answer: directExecutionRequest
        ? [
          'Local guarded execution plan. CoLiPas prepared a safe SSH command card for this request.',
          `Question: ${question}`,
          executionPlan?.command ? `Command: ${executionPlan.command}` : 'Command: unavailable',
          '',
          'Next action:',
          '- Review the guarded action card below, then click Submit to run it through operations preflight and audit logging.',
          '- I will not claim command output until the execution card returns evidence.',
        ].join('\n')
        : [
          'Local evidence boundary. CoLiPas has not captured relevant SSH command output for this question yet.',
          `Question: ${question}`,
          '',
          'What this means:',
          '- I cannot state the current user, IP address, route table, or command output until a guarded SSH command or live terminal output provides that evidence.',
          '- A shell prompt such as root@host is only terminal context; it is not enough to prove the result of whoami, ip addr, or ip route.',
          '',
          'Next action:',
          executionPlan?.command
            ? `- Use the guarded action card below to run: ${executionPlan.command}`
            : '- Open the live SSH terminal, run the needed command, then ask again with the captured output.',
        ].join('\n'),
      executionPlan,
    };
  }
  if (includeOperationsContext && (priorEvidence.length > 0 || latestShellEvidence.length > 0)) {
    const evidenceLines = [
      ...priorEvidence.slice(-3).map((content, index) => `${index + 1}. Prior AI-run operation:\n${content}`),
      ...latestShellEvidence.map((item, index) => `${priorEvidence.slice(-3).length + index + 1}. Recent SSH terminal on ${item.serverName} (${item.active ? 'active' : 'closed'}, ${item.mode}, ${item.updatedAt}):\n${item.transcript}`),
    ];
    return {
      answer: [
        'Local evidence analysis. CoLiPas found recent SSH/operations output in this conversation or active terminal context.',
        `Question: ${question}`,
        '',
        'Available execution evidence:',
        ...evidenceLines,
        '',
        'Conclusion:',
        '- The answer above is based on the captured, sanitized execution output. If you need deeper diagnosis, run the next guarded SSH check and ask again.',
      ].join('\n'),
      executionPlan,
    };
  }

  if (!includeOperationsContext) {
    return {
      answer: [
        'Local fallback reply. No external AI API key is configured for this request.',
        `Question: ${question}`,
        '',
        'The realtime chat pipeline is available, but external model output needs a valid API key or server-side AI_API_KEY.',
      ].join('\n'),
    };
  }

  const openEvents = events.filter((event) => event.status === 'open');
  const risks = servers
    .map((server) => ({
      server,
      score: riskScore(server, openEvents),
      reasons: riskReasons(server, openEvents),
    }))
    .filter((item) => item.score > 0 || item.server.status !== 'running' || !item.server.ssh?.connected)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (!servers.length) {
    return {
      answer: [
        'Local rule analysis. No API key is configured, so CoLiPas did not call an external model.',
        `Question: ${question}`,
        '',
        'No server assets are available in the selected scope.',
        'Next actions:',
        '1. Register servers with name, public IP, region, and operating system.',
        '2. Add SSH password or private key only when remote diagnosis or repair is needed.',
        '3. Ask again after assets are connected; the answer will use inventory, events, and SSH state.',
      ].join('\n'),
    };
  }

  const scopeText = selectedServer
    ? `${selectedServer.name} / ${selectedServer.publicIp || 'no public IP'}`
    : `${servers.length} servers`;
  const connectedCount = servers.filter((server) => server.ssh?.connected).length;
  const stoppedCount = servers.filter((server) => server.status === 'stopped').length;
  const unconnectedCount = servers.filter((server) => server.status === 'unconnected' || !server.ssh?.connected).length;

  const riskLines = risks.length
    ? risks.map((item, index) => {
      const server = item.server;
      const reason = item.reasons.join('; ') || 'no obvious threshold breach';
      return `${index + 1}. ${server.name} (${server.publicIp || 'no public IP'}, ${server.region || 'unknown'}): ${reason}.`;
    })
    : ['1. No server in scope exceeds CPU 75%, memory 80%, or disk 85%.'];

  const actionLines = [
    unconnectedCount > 0
      ? `Fix SSH access for ${unconnectedCount} unconnected server(s), then rerun connectivity verification.`
      : 'SSH access is available for the selected scope; diagnostics and orchestration can run directly.',
    stoppedCount > 0
      ? `Confirm whether ${stoppedCount} stopped server(s) are intentionally powered off. If not, power them on and recheck services.`
      : 'No stopped servers need immediate power-on action.',
    openEvents.length > 0
      ? `Process ${openEvents.length} open event(s) in critical -> warning -> info order, then close the audit loop.`
      : 'No open events are present; continue watching resource and SSH availability trends.',
  ];

  return {
    answer: [
      'Local rule analysis. No API key is configured, so CoLiPas did not call an external model.',
      `Question: ${question}`,
      `Scope: ${scopeText}. SSH connected ${connectedCount}/${servers.length}, unconnected ${unconnectedCount}, stopped ${stoppedCount}.`,
      '',
      'Prioritized risks:',
      ...riskLines,
      '',
      'Why:',
      '- The rule engine uses only the current inventory snapshot, SSH state, CPU/memory/disk thresholds, and open events.',
      `- Open events: ${openEvents.length ? openEvents.map((event) => `${event.severity}:${event.title}`).join('; ') : 'none'}.`,
      '',
      'Next actions:',
      ...actionLines.map((line, index) => `${index + 1}. ${line}`),
      '',
      'Executable card:',
      '- Use the guarded action card below to run a preflighted SSH check through the operations service.',
    ].join('\n'),
    executionPlan,
  };
}

function riskScore(server: ServerNode, events: OperationEvent[]) {
  const loadScore = Math.max(server.cpu - 75, 0) + Math.max(server.memory - 80, 0) + Math.max(server.disk - 85, 0);
  const statusScore = server.status === 'running' ? 0 : server.status === 'stopped' ? 18 : 12;
  const sshScore = server.ssh?.connected ? 0 : 10;
  const eventScore = events.reduce((score, event) => score + (event.severity === 'critical' ? 10 : event.severity === 'warning' ? 5 : 1), 0);
  return loadScore + statusScore + sshScore + Math.min(eventScore, 20);
}

function riskReasons(server: ServerNode, events: OperationEvent[]) {
  const reasons: string[] = [];
  if (server.cpu > 75) {
    reasons.push(`CPU ${server.cpu}% exceeds 75%`);
  }
  if (server.memory > 80) {
    reasons.push(`memory ${server.memory}% exceeds 80%`);
  }
  if (server.disk > 85) {
    reasons.push(`disk ${server.disk}% exceeds 85%`);
  }
  if (server.status === 'stopped') {
    reasons.push('server is stopped');
  } else if (server.status === 'unconnected' || !server.ssh?.connected) {
    reasons.push('SSH is not verified');
  }
  if (events.some((event) => event.severity === 'critical')) {
    reasons.push('critical open event exists');
  }
  return reasons;
}

function extractPriorExecutionEvidence(chatHistory: AiChatMessage[]) {
  return chatHistory
    .filter((message) => message.role === 'assistant' && message.content.includes('Execution evidence:'))
    .map((message) => message.content.trim().slice(0, 3000));
}

function questionNeedsLiveSshEvidence(question: string) {
  return Boolean(extractExplicitRequestedSshCommand(question))
    || /ip\s+addr|ip\s+-brief|ip\s+route|route\s+-n|ifconfig|whoami|\bid\b|current\s+user|command\s+output|ssh\s+output|公网|内网|当前用户|当前\s*用户|命令输出|执行结果|输出|路由|网络|网卡|地址/i.test(question);
}

function questionRequestsDirectSshExecution(question: string) {
  return Boolean(extractExplicitRequestedSshCommand(question))
    || (
      Boolean(extractSafeRequestedSshCommand(question))
      && /run|execute|exec|执行|运行|查看|检查|查一下|命令/i.test(question)
    );
}

function questionNeedsNetworkEvidence(question: string) {
  return /ip\s+addr|ip\s+-brief|ip\s+route|route\s+-n|ifconfig|\bip\b|公网|内网|路由|网络|网卡|地址/i.test(question);
}

function questionNeedsUserEvidence(question: string) {
  return /whoami|\bid\b|current\s+user|当前用户|当前\s*用户/i.test(question);
}

function isLocalEvidenceBoundaryAnswer(answer: string) {
  return answer.startsWith('Local evidence boundary.') || answer.startsWith('Local guarded execution plan.');
}

function evidenceAppearsRelevantToQuestion(question: string, evidenceText: string) {
  if (!evidenceText.trim()) {
    return false;
  }

  const wantsNetwork = /ip\s+addr|ip\s+-brief|ip\s+route|route\s+-n|ifconfig|\bip\b|公网|内网|路由|网络|网卡|地址/i.test(question);
  const wantsUser = /whoami|\bid\b|current\s+user|当前用户|当前\s*用户/i.test(question);
  const wantsCommandOutput = /command\s+output|ssh\s+output|命令输出|执行结果|输出/i.test(question);

  if (wantsNetwork && !/(ip\s+(?:addr|-brief|route)|route\s+-n|ifconfig|\binet\s+\d|\bdefault\s+via\b)/i.test(evidenceText)) {
    return false;
  }

  if (wantsUser && !/(^|\n|\r)(?:stdout:\s*)?(?:whoami|id)\b|uid=\d+/i.test(evidenceText)) {
    return false;
  }

  if (wantsCommandOutput && !/(Execution evidence:|stdout:|stderr:|command=|simulated\$|\$ |# )/i.test(evidenceText)) {
    return false;
  }

  return true;
}

function formatShellEvidenceForPrompt(shellEvidence: SshShellEvidenceSummary[]) {
  return shellEvidence
    .filter((item) => item.transcript.trim())
    .slice(0, 3)
    .map((item, index) => [
      `${index + 1}. server=${item.serverName}`,
      `mode=${item.mode}`,
      `active=${item.active}`,
      `updatedAt=${item.updatedAt}`,
      'note=Terminal prompts are context only. Treat current user, IP, route, and command-output claims as factual only when explicit command output is present below.',
      `transcript:\n${item.transcript.slice(-3000)}`,
    ].join('\n'))
    .join('\n\n');
}

function buildExecutionPlan(
  servers: ServerNode[],
  selectedServer: ServerNode | undefined,
  question: string,
  includeOperationsContext: boolean,
): AiExecutionPlan | undefined {
  if (!includeOperationsContext) {
    return undefined;
  }

  const targetServers = selectedServer ? [selectedServer] : servers;
  if (targetServers.length === 0) {
    return undefined;
  }

  const connectedTargets = targetServers.filter((server) => server.ssh?.connected);
  if (connectedTargets.length === 0) {
    return undefined;
  }

  const primaryServer = connectedTargets[0];
  const normalizedQuestion = question.toLowerCase();
  const targetMode = selectedServer ? 'selected' : 'allConnected';
  const serverIds = selectedServer ? [selectedServer.id] : connectedTargets.map((server) => server.id);
  const requestedCommand = extractSafeRequestedSshCommand(question);
  const wantsShutdown = !requestedCommand && /shutdown|power\s*off|halt|关机|停机|关闭/i.test(question);
  const wantsReboot = !requestedCommand && /restart|reboot|重启|重新启动/i.test(question);
  const wantsHealth = /health|diagnostic|diag|status|cpu|memory|disk|load|uptime|状态|诊断|健康|负载|内存|磁盘/i.test(normalizedQuestion);

  if (wantsShutdown || wantsReboot) {
    const operation = wantsShutdown ? 'shutdown' : 'reboot';
    return {
      title: `${operation === 'shutdown' ? 'Shutdown' : 'Reboot'} ${selectedServer ? primaryServer.name : 'connected servers'}`,
      summary: `AI prepared a guarded ${operation} task for ${serverIds.length} SSH-connected server(s).`,
      targetMode,
      serverIds,
      operation,
      reason: `AI suggested ${operation} after operator question: ${question.slice(0, 120)}`,
      confirmed: false,
      requiresConfirmation: true,
      confirmationReason: operation,
      safetyNote: 'This is a high-impact lifecycle action and still runs through operations preflight and audit logging.',
    };
  }

  const command = requestedCommand ?? (questionNeedsNetworkEvidence(question)
    ? 'hostname && whoami && ip -brief addr && ip route'
    : questionNeedsUserEvidence(question)
      ? 'whoami && id && hostname'
      : wantsHealth
        ? 'hostname && uptime && df -h /'
        : 'uname -a && uptime && whoami');
  const operation = requestedCommand ? 'sshCommand' : wantsHealth ? 'healthCheck' : 'sshCommand';
  const confirmationReason = operation === 'sshCommand' ? getSshCommandConfirmationReason(command) : '';

  return {
    title: requestedCommand
      ? `Run SSH command on ${selectedServer ? primaryServer.name : 'connected servers'}`
      : `Run SSH check on ${selectedServer ? primaryServer.name : 'connected servers'}`,
    summary: requestedCommand
      ? `AI prepared an operator-requested SSH command for ${serverIds.length} SSH-connected server(s).`
      : `AI prepared a safe SSH inspection for ${serverIds.length} SSH-connected server(s).`,
    targetMode,
    serverIds,
    operation,
    command,
    reason: `AI guided server inspection after operator question: ${question.slice(0, 120)}`,
    confirmed: false,
    requiresConfirmation: Boolean(confirmationReason),
    confirmationReason: confirmationReason || undefined,
    safetyNote: requestedCommand
      ? 'This operator-provided command is submitted through operations preflight and audit logging before SSH execution.'
      : 'This command is submitted through operations preflight first, then executed by the existing SSH service.',
  };
}

function extractSafeRequestedSshCommand(question: string) {
  const explicitCommand = extractExplicitRequestedSshCommand(question);
  if (explicitCommand) {
    return explicitCommand;
  }

  const normalized = question.toLowerCase().replace(/\s+/g, ' ').trim();
  const compact = normalized.replace(/\s+/g, '');

  if (/\bip\s+-brief\s+addr\b/.test(normalized) || compact.includes('ip-briefaddr')) {
    return 'ip -brief addr';
  }
  if (/\bip\s+addr\b/.test(normalized) || compact.includes('ipaddr')) {
    return 'ip addr';
  }
  if (/\bip\s+route\b/.test(normalized) || compact.includes('iproute')) {
    return 'ip route';
  }
  if (/\bifconfig\b/.test(normalized)) {
    return 'ifconfig';
  }
  if (/\bwhoami\b/.test(normalized)) {
    return 'whoami';
  }
  if (/(^|[^\w-])id($|[^\w-])/.test(normalized)) {
    return 'id';
  }
  if (/\bhostname\b/.test(normalized)) {
    return 'hostname';
  }
  if (/\buptime\b/.test(normalized)) {
    return 'uptime';
  }
  if (/\bdf\s+-h\b/.test(normalized)) {
    return 'df -h /';
  }
  if (/\bfree\s+-h\b/.test(normalized)) {
    return 'free -h';
  }
  if (/\buname\s+-a\b/.test(normalized)) {
    return 'uname -a';
  }
  if (/\bdocker\s+ps\b/.test(normalized)) {
    return 'docker ps';
  }

  return undefined;
}

function extractExplicitRequestedSshCommand(question: string) {
  const trimmed = question.trim();
  if (!hasExplicitCommandIntent(trimmed)) {
    return undefined;
  }

  const fenced = trimmed.match(/```(?:bash|sh|shell)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return normalizeRequestedSshCommand(fenced[1]);
  }

  const backticked = trimmed.match(/`([^`]+)`/);
  if (backticked?.[1]) {
    return normalizeRequestedSshCommand(backticked[1]);
  }

  const commandWords = '(?:command|cmd|shell|ssh|命令|指令)';
  const chineseRunWords = '(?:执行|运行|跑|输入)';
  const chinesePolitePrefix = '(?:请|帮我|麻烦|麻烦你|给我|替我|帮忙)?';
  const chineseTargetContext = '(?:在(?:服务器|主机|目标机器|远端|远程)(?:上|里)?)?';
  const chineseSoftener = '(?:一下|下|一下子)?';
  const patterns = [
    new RegExp(`(?:^|[\\s,;])(?:please\\s+)?(?:run|execute|exec)(?:\\s+(?:this|the))?(?:\\s+(?:on|in)\\s+(?:the\\s+)?(?:server|servers|selected\\s+server|target|host|machine|remote)(?:\\s+side)?)?(?:\\s+${commandWords})?\\s*(?:(?:[:=]|：)\\s*|\\s+)([\\s\\S]+)$`, 'i'),
    new RegExp(`(?:^|[\\s,;])${commandWords}\\s*(?:[:=]|：)\\s*([\\s\\S]+)$`, 'i'),
    new RegExp(`(?:^|[\\s,，。；;])${chinesePolitePrefix}\\s*${chineseTargetContext}\\s*${chineseRunWords}${chineseSoftener}(?:\\s*${commandWords})?\\s*(?:[:=]|：)?\\s*([\\s\\S]+)$`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    const command = match?.[1] ? normalizeRequestedSshCommand(match[1]) : undefined;
    if (command) {
      return command;
    }
  }

  return undefined;
}

function hasExplicitCommandIntent(question: string) {
  return /run|execute|exec|cmd|command|shell|ssh|执行|运行|命令|指令|跑|输入/i.test(question);
}

function normalizeRequestedSshCommand(candidate: string) {
  const command = stripWrappingQuotes(candidate)
    .replace(/[\s\u3000]+$/g, '')
    .replace(/[。；]+$/g, '')
    .trim()
    .slice(0, 2000);

  return isPlausibleShellCommand(command) ? command : undefined;
}

function stripWrappingQuotes(value: string) {
  let result = value.trim();
  const quotePairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['“', '”'],
    ['‘', '’'],
  ];

  let changed = true;
  while (changed && result.length >= 2) {
    changed = false;
    for (const [open, close] of quotePairs) {
      if (result.startsWith(open) && result.endsWith(close)) {
        result = result.slice(open.length, -close.length).trim();
        changed = true;
      }
    }
  }

  return result;
}

function isPlausibleShellCommand(command: string) {
  if (!command || command.length > 2000) {
    return false;
  }

  const firstToken = command.split(/\s+/)[0]?.toLowerCase().replace(/^[\s"'`]+|[\s"'`]+$/g, '') ?? '';
  if (!firstToken || /^(?:a|an|the|safe|ssh|server|servers|health|diagnostic|check|inspection|current|what|which|how|please|can|could|should)$/i.test(firstToken)) {
    return false;
  }

  return /^[A-Za-z0-9_./~$({[+-]/.test(command);
}

async function sendAnswerInChunks(answer: string, send: (chunk: string) => void, delayMs: number) {
  for (const chunk of answer.match(/.{1,28}/gs) ?? [answer]) {
    send(chunk);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function sendCachedAnswer(answer: string, send: (chunk: string) => void) {
  for (const chunk of answer.match(/.{1,48}/gs) ?? [answer]) {
    send(chunk);
  }
}

function buildAiCacheKey(
  provider: AIProviderConfig,
  serverId: string,
  question: string,
  prompt: string,
  messages: AiChatMessage[] = [],
) {
  const hash = createHash('sha256')
    .update(JSON.stringify({
      provider: publicProviderEndpoint(provider.baseUrl),
      model: provider.model,
      temperature: provider.temperature,
      serverId,
      question: question.trim(),
      prompt,
      messages,
    }))
    .digest('hex');
  return `ai:${hash}`;
}

function getCachedAiResponse(cacheKey: string) {
  const cached = aiResponseCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }

  if (Date.now() - cached.cachedAt > aiResponseCacheTtlMs) {
    aiResponseCache.delete(cacheKey);
    return undefined;
  }

  const { cachedAt: _cachedAt, ...result } = cached;
  return result;
}

function setCachedAiResponse(cacheKey: string, result: AiAnalysisResponse) {
  const { cached: _cached, ...cacheableResult } = result;
  aiResponseCache.set(cacheKey, {
    ...cacheableResult,
    cached: false,
    cachedAt: Date.now(),
  });

  while (aiResponseCache.size > aiResponseCacheMaxEntries) {
    const oldestKey = aiResponseCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    aiResponseCache.delete(oldestKey);
  }
}

function withGeneratedAt(result: AiAnalysisResponse): AiAnalysisResponse {
  return {
    ...result,
    generatedAt: result.generatedAt ?? new Date().toISOString(),
  };
}
