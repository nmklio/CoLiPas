import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Ban,
  Bot,
  ChevronDown,
  CheckCircle2,
  CircleStop,
  History,
  AlertTriangle,
  MessageCircle,
  MoreHorizontal,
  PlayCircle,
  PanelRightClose,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Settings2,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { defaultAIProvider } from '../../data/mockData';
import { useI18n } from '../../i18n';
import {
  streamAiAnalysis,
  AiAnalysisResponse,
  AiChatRequestMessage,
  createOperationTask,
  fetchAiProviderSettings,
  fetchAiModels,
  fetchConfigSummary,
  preflightOperationTask,
  saveAiProviderSettings,
  testAiConnection,
  AiConnectionTestResponse,
} from '../../services/apiClient';
import { AIProviderConfig, OperationEvent, OperationTaskRequest, OperationTaskResponse, ServerNode } from '../../types';
import { buildOpsPrompt, validateAIProviderConfig } from './aiConfig';

interface AIConsoleProps {
  servers: ServerNode[];
  events: OperationEvent[];
  collapsed: boolean;
  mode?: 'dock' | 'workspace';
  seedQuestion: string;
  onCollapse: () => void;
  onExpand: () => void;
  onSeedQuestionConsumed: () => void;
  onTaskFinished?: () => Promise<void> | void;
  releaseFocusAnchor?: string;
}

type AiChatRole = 'user' | 'assistant';
type AiMessageStatus = 'done' | 'streaming' | 'cached' | 'error' | 'stopped';
type AiProviderManagedBy = 'database' | 'environment' | 'none';

interface AiChatMessage {
  id: string;
  role: AiChatRole;
  content: string;
  createdAt: string;
  status: AiMessageStatus;
  meta?: {
    provider: string;
    model: string;
    simulated: boolean;
    cached?: boolean;
    generatedAt?: string;
  };
}

interface AiChatSession {
  id: string;
  title: string;
  question: string;
  selectedServerId: string;
  messages: AiChatMessage[];
  analysis: AiAnalysisResponse | null;
  createdAt: string;
  updatedAt: string;
}

interface StoredAIConsoleState {
  sessions: AiChatSession[];
  activeSessionId: string;
  connectionTest: AiConnectionTestResponse | null;
}

interface AiProviderCustodyState {
  managedBy: AiProviderManagedBy;
  hasStoredApiKey: boolean;
  updatedAt: string | null;
}

const aiProviderStorageKey = 'colipas.aiProvider';
const aiStateStorageKey = 'colipas.aiConsoleState';
const aiResponseCacheStorageKey = 'colipas.aiResponseCache';
const aiResponseCacheTtlMs = 10 * 60 * 1000;
const aiResponseCacheMaxEntries = 60;
const aiStreamFlushIntervalMs = 48;
const aiTransientStatusTtlMs = 7200;
const fallbackModelOptions = ['gpt-5.5', 'gpt-5.4', 'gpt-4.1-mini', 'deepseek-chat', 'qwen-plus'];
const aiExecutionCopyByLanguage: Record<string, {
  plan: string;
  target: string;
  command: string;
  executionMode: string;
  allow: string;
  cancel: string;
  reason: string;
  reasonPlaceholder: string;
  submit: string;
  confirmationRequired?: string;
  confirmationReasonLabel?: string;
  cancelHint: string;
  allowHint: string;
  decisionTitle: string;
  run: string;
  running: string;
  blocked: string;
  failed: string;
  success: string;
  failedShort: string;
  noOutput: string;
  allConnected: string;
  allServers: string;
  selectedServers: string;
  cancelled: string;
  queued: string;
}> = {
  zh: {
    plan: 'AI 执行计划',
    target: '目标',
    command: '即将执行的命令',
    executionMode: '前台执行',
    allow: '1. 允许执行',
    cancel: '2. 取消',
    reason: '3.',
    reasonPlaceholder: '输入拒绝原因',
    submit: '提交',
    cancelHint: '取消后不会触发 operations 执行，仅保留本地提示。',
    allowHint: '允许后会先经过 preflight，再进入 operations/SSH 审计链。',
    decisionTitle: '执行确认',
    run: '预检并执行',
    running: '执行中',
    blocked: '执行预检未通过',
    failed: '执行失败',
    success: '成功',
    failedShort: '失败',
    noOutput: '暂无输出',
    allConnected: '全部已连接',
    allServers: '全部服务器',
    selectedServers: '指定服务器',
    cancelled: '已取消执行',
    queued: '待确认',
  },
  en: {
    plan: 'AI execution plan',
    target: 'Target',
    command: 'Command to run',
    executionMode: 'Foreground execution',
    allow: '1. Allow execution',
    cancel: '2. Cancel',
    reason: '3.',
    reasonPlaceholder: 'Rejection reason',
    submit: 'Submit',
    cancelHint: 'Canceling will not trigger operations execution. The note stays local.',
    allowHint: 'Allowing will go through preflight first, then the operations/SSH audit chain.',
    decisionTitle: 'Execution confirmation',
    run: 'Preflight and run',
    running: 'Running',
    blocked: 'Execution blocked by preflight',
    failed: 'Execution failed',
    success: 'Success',
    failedShort: 'Failed',
    noOutput: 'No output yet',
    allConnected: 'all connected',
    allServers: 'all servers',
    selectedServers: 'selected servers',
    cancelled: 'Execution canceled',
    queued: 'Awaiting confirmation',
  },
  ja: {
    plan: 'AI 実行プラン',
    target: '対象',
    command: '実行予定のコマンド',
    executionMode: 'フロント実行',
    allow: '1. 実行を許可',
    cancel: '2. キャンセル',
    reason: '3.',
    reasonPlaceholder: '拒否理由を入力',
    submit: '送信',
    cancelHint: 'キャンセルしても operations は実行されず、注記のみローカルに残ります。',
    allowHint: '許可すると preflight の後で operations/SSH 監査チェーンに進みます。',
    decisionTitle: '実行確認',
    run: '事前確認して実行',
    running: '実行中',
    blocked: '事前確認で実行がブロックされました',
    failed: '実行に失敗しました',
    success: '成功',
    failedShort: '失敗',
    noOutput: '出力はまだありません',
    allConnected: '接続済みすべて',
    allServers: 'すべてのサーバー',
    selectedServers: '選択したサーバー',
    cancelled: '実行をキャンセルしました',
    queued: '確認待ち',
  },
};

export function AIConsole({ servers, events, collapsed, mode = 'dock', seedQuestion, onCollapse, onExpand, onSeedQuestionConsumed, onTaskFinished, releaseFocusAnchor }: AIConsoleProps) {
  const { language, t } = useI18n();
  const workspaceMode = mode === 'workspace';
  const [initialState] = useState(() => loadStoredConsoleState(t('ai.newChatTitle')));
  const [initialProvider] = useState(() => loadStoredProvider());
  const [provider, setProvider] = useState<AIProviderConfig>(() => initialProvider);
  const [sessions, setSessions] = useState<AiChatSession[]>(() => initialState.sessions);
  const [activeSessionId, setActiveSessionId] = useState(() => initialState.activeSessionId);
  const [connectionTest, setConnectionTest] = useState<AiConnectionTestResponse | null>(initialState.connectionTest);
  const [serverAiConfigured, setServerAiConfigured] = useState(false);
  const [error, setError] = useState('');
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>(() => uniqueModels([initialProvider.model, ...fallbackModelOptions]));
  const [modelMessage, setModelMessage] = useState('');
  const [modelSource, setModelSource] = useState<'upstream' | 'fallback'>('fallback');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerSavedMessage, setProviderSavedMessage] = useState('');
  const [providerCustody, setProviderCustody] = useState<AiProviderCustodyState>({
    managedBy: 'none',
    hasStoredApiKey: false,
    updatedAt: null,
  });
  const [newChatReady, setNewChatReady] = useState(false);
  const [aiTaskRunning, setAiTaskRunning] = useState(false);
  const [aiTaskDecision, setAiTaskDecision] = useState<'allow' | 'cancel'>('cancel');
  const [aiTaskReason, setAiTaskReason] = useState('');
  const [aiTaskMessage, setAiTaskMessage] = useState('');
  const [aiTaskResult, setAiTaskResult] = useState<OperationTaskResponse | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const chatThreadRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const newChatTimerRef = useRef<number | null>(null);
  const providerSavedTimerRef = useRef<number | null>(null);
  const transientStatusTimerRef = useRef<number | null>(null);
  const streamFlushTimerRef = useRef<number | null>(null);
  const streamChunkBufferRef = useRef(new Map<string, { sessionId: string; messageId: string; content: string; fallbackPrompt: string }>());
  const modelRequestSeqRef = useRef(0);
  const aiStatePersistTimerRef = useRef<number | null>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const validation = useMemo(() => validateAIProviderConfig(provider, language), [language, provider]);
  const executionCopy = aiExecutionCopyByLanguage[language] ?? aiExecutionCopyByLanguage.zh;
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const serverById = useMemo(() => new Map(servers.map((server) => [server.id, server])), [servers]);
  const selectedServers = useMemo(
    () => {
      if (collapsed) {
        return [];
      }
      if (activeSession.selectedServerId === 'all') {
        return servers;
      }
      const selectedServer = serverById.get(activeSession.selectedServerId);
      return selectedServer ? [selectedServer] : [];
    },
    [activeSession.selectedServerId, collapsed, serverById, servers],
  );
  const prompt = useMemo(() => (collapsed ? '' : buildOpsPrompt(selectedServers, events)), [collapsed, selectedServers, events]);
  const running = runningSessionId === activeSession.id;
  const externalAiAvailable = Boolean(provider.apiKey.trim() || serverAiConfigured);
  const showSessionList = sessionsOpen && (sessions.length > 1 || activeSession.messages.length > 0);
  const aiProviderReleaseFocusActive = releaseFocusAnchor === 'ai-provider';
  const lastUserQuestion = useMemo(() => findLastUserQuestion(activeSession.messages), [activeSession.messages]);
  const executionPlan = activeSession.analysis?.executionPlan ?? null;
  const executionPlanKey = executionPlan
    ? `${executionPlan.operation}|${executionPlan.targetMode}|${executionPlan.serverIds.length}|${executionPlan.serverIds[0] ?? ''}|${executionPlan.command ?? ''}|${executionPlan.title}|${executionPlan.requiresConfirmation ? 'confirm' : 'safe'}|${executionPlan.confirmationReason ?? ''}`
    : '';
  const scopeLabel = activeSession.selectedServerId === 'all'
    ? t('ai.allServers')
    : selectedServers[0]?.name ?? t('ai.allServers');
  const availableModelOptions = useMemo(
    () => (modelSource === 'upstream' && modelOptions.length > 0
      ? modelOptions
      : uniqueModels([provider.model, ...modelOptions])),
    [modelOptions, modelSource, provider.model],
  );

  useEffect(() => {
    if (releaseFocusAnchor !== 'ai-provider') {
      return;
    }
    onExpand();
    setSessionsOpen(false);
    setSettingsOpen(true);
  }, [releaseFocusAnchor]);

  useEffect(() => {
    persistStoredProvider(provider);
  }, [provider.name, provider.baseUrl, provider.model, provider.temperature]);

  useEffect(() => {
    if (collapsed) {
      return;
    }

    setSessions((current) => {
      let changed = false;
      const next = current.map((session) => {
        if (session.selectedServerId === 'all' || serverById.has(session.selectedServerId)) {
          return session;
        }
        changed = true;
        return { ...session, selectedServerId: 'all', updatedAt: new Date().toISOString() };
      });
      return changed ? next : current;
    });
  }, [collapsed, serverById]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchConfigSummary(), fetchAiProviderSettings()])
      .then(([config, settings]) => {
        if (cancelled) {
          return;
        }
        setServerAiConfigured(settings.configured || config.ai.configured);
        setProviderCustody({
          managedBy: settings.managedBy ?? config.ai.managedBy ?? (settings.configured || config.ai.configured ? 'environment' : 'none'),
          hasStoredApiKey: settings.hasStoredApiKey ?? config.ai.hasStoredApiKey ?? false,
          updatedAt: settings.updatedAt ?? null,
        });
        setProvider((current) => ({
          ...current,
          name: settings.provider.name || current.name,
          baseUrl: settings.provider.baseUrl || config.ai.baseUrl || current.baseUrl,
          model: settings.provider.model || config.ai.model || current.model,
          apiKey: '',
          temperature: settings.provider.temperature,
        }));
        setModelOptions((current) => uniqueModels([settings.provider.model, ...current, ...fallbackModelOptions]));
      })
      .catch(() => fetchConfigSummary()
        .then((config) => {
          if (cancelled) {
            return;
          }
          setServerAiConfigured(config.ai.configured);
          setProviderCustody({
            managedBy: config.ai.managedBy ?? (config.ai.configured ? 'environment' : 'none'),
            hasStoredApiKey: config.ai.hasStoredApiKey ?? false,
            updatedAt: null,
          });
          setProvider((current) => ({
            ...current,
            baseUrl: current.baseUrl === defaultAIProvider.baseUrl && config.ai.baseUrl ? config.ai.baseUrl : current.baseUrl,
            model: current.model === defaultAIProvider.model && config.ai.model ? config.ai.model : current.model,
          }));
        })
        .catch(() => undefined));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      refreshModels().catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [provider.baseUrl]);

  useEffect(() => () => {
    abortControllerRef.current?.abort();
    if (newChatTimerRef.current) {
      window.clearTimeout(newChatTimerRef.current);
    }
    if (providerSavedTimerRef.current) {
      window.clearTimeout(providerSavedTimerRef.current);
    }
    if (transientStatusTimerRef.current) {
      window.clearTimeout(transientStatusTimerRef.current);
    }
    if (streamFlushTimerRef.current) {
      window.clearTimeout(streamFlushTimerRef.current);
    }
    streamChunkBufferRef.current.clear();
    if (aiStatePersistTimerRef.current) {
      window.clearTimeout(aiStatePersistTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (aiStatePersistTimerRef.current) {
      window.clearTimeout(aiStatePersistTimerRef.current);
      aiStatePersistTimerRef.current = null;
    }
  }, [activeSessionId, connectionTest, sessions]);

  useEffect(() => {
    if (transientStatusTimerRef.current) {
      window.clearTimeout(transientStatusTimerRef.current);
      transientStatusTimerRef.current = null;
    }

    if (!connectionTest && !modelMessage) {
      return undefined;
    }

    transientStatusTimerRef.current = window.setTimeout(() => {
      setConnectionTest(null);
      setModelMessage('');
      transientStatusTimerRef.current = null;
    }, aiTransientStatusTtlMs);

    return () => {
      if (transientStatusTimerRef.current) {
        window.clearTimeout(transientStatusTimerRef.current);
        transientStatusTimerRef.current = null;
      }
    };
  }, [connectionTest, modelMessage]);

  useEffect(() => {
    setAiTaskDecision(executionPlan?.requiresConfirmation ? 'cancel' : 'allow');
    setAiTaskReason('');
    setAiTaskMessage('');
    setAiTaskResult(null);
  }, [activeSession.id, executionPlanKey]);

  useEffect(() => {
    const chatThread = chatThreadRef.current;
    if (chatThread) {
      chatThread.scrollTop = activeSession.messages.length === 0 ? 0 : chatThread.scrollHeight;
    }
  }, [activeSession.messages, runningSessionId]);

  useEffect(() => {
    const question = seedQuestion.trim();
    if (!question) {
      return;
    }

    const session = isBlankSession(activeSession)
      ? { ...activeSession, question, title: buildSessionTitle(question, t('ai.newChatTitle')), updatedAt: new Date().toISOString() }
      : {
        ...createSession(t('ai.newChatTitle')),
        question,
        title: buildSessionTitle(question, t('ai.newChatTitle')),
      };

    setSessions((current) => {
      if (isBlankSession(activeSession)) {
        return current.map((item) => (item.id === activeSession.id ? session : item));
      }
      return [session, ...current];
    });
    setActiveSessionId(session.id);
    setError('');
    setSettingsOpen(false);
    onExpand();
    onSeedQuestionConsumed();
    window.setTimeout(() => questionRef.current?.focus(), 0);
  }, [activeSession, onExpand, onSeedQuestionConsumed, seedQuestion, t]);

  async function handleAnalyze(forceRefresh = false, overrideQuestion?: string, overrideMessages?: AiChatMessage[]) {
    const requestQuestion = (overrideQuestion ?? activeSession.question).trim();
    if (!requestQuestion) {
      setError(t('ai.inputRequired'));
      questionRef.current?.focus();
      return;
    }

    const sessionId = activeSession.id;
    const requestServerId = activeSession.selectedServerId;
    const requestPrompt = prompt;
    const baseMessages = overrideMessages ?? activeSession.messages;
    const requestHistory = toRequestHistory(baseMessages);
    const cacheKey = buildAiResponseCacheKey(provider, requestServerId, requestQuestion, requestPrompt, requestHistory);
    const useLocalCache = !externalAiAvailable;
    const requestForceRefresh = forceRefresh || !useLocalCache;
    const cachedResult = requestForceRefresh ? null : getCachedAiResponse(cacheKey);
    const userMessage = createMessage('user', requestQuestion);

    if (cachedResult) {
      updateSession(sessionId, {
        question: '',
        title: buildSessionTitle(requestQuestion, t('ai.newChatTitle')),
        messages: [
          ...baseMessages,
          userMessage,
          createAssistantMessage(cachedResult.answer, cachedResult, 'cached'),
        ],
        analysis: {
          ...cachedResult,
          cached: true,
        },
      });
      setError('');
      return;
    }

    const assistantMessage = createAssistantMessage('', {
      provider: publicProviderEndpoint(provider.baseUrl),
      model: provider.model,
      prompt: requestPrompt,
      answer: '',
      simulated: !externalAiAvailable,
      cached: false,
    }, 'streaming');
    const controller = new AbortController();
    abortControllerRef.current?.abort();
    abortControllerRef.current = controller;
    setRunningSessionId(sessionId);
    setError('');
    updateSession(sessionId, {
      question: '',
      title: buildSessionTitle(requestQuestion, t('ai.newChatTitle')),
      messages: [...baseMessages, userMessage, assistantMessage],
      analysis: assistantMessageToAnalysis(assistantMessage, requestPrompt),
    });

    try {
      const result = await streamAiAnalysis(requestQuestion, provider, requestServerId, (chunk) => {
        queueAssistantMessageChunk(sessionId, assistantMessage.id, chunk, requestPrompt);
      }, { forceRefresh: requestForceRefresh, messages: requestHistory, signal: controller.signal });
      flushAssistantMessageChunks();
      if (useLocalCache) {
        setCachedAiResponse(cacheKey, result);
      }
      updateAssistantMessage(sessionId, assistantMessage.id, {
        content: result.answer,
        status: 'done',
        meta: analysisToMessageMeta(result),
      }, result);
    } catch (requestError) {
      flushAssistantMessageChunks();
      const stopped = controller.signal.aborted;
      const failureMessage = formatAiRequestFailure(requestError, t);
      updateAssistantMessage(sessionId, assistantMessage.id, {
        status: stopped ? 'stopped' : 'error',
        content: stopped ? t('ai.stopped') : failureMessage,
      });
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setRunningSessionId((current) => (current === sessionId ? null : current));
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setError('');
    setConnectionTest(null);
    try {
      setConnectionTest(await testAiConnection(provider));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('ai.testFailed'));
    } finally {
      setTesting(false);
    }
  }

  async function refreshModels() {
    const requestSeq = modelRequestSeqRef.current + 1;
    modelRequestSeqRef.current = requestSeq;
    setModelsLoading(true);
    setModelMessage('');
    try {
      const result = await fetchAiModels(provider);
      if (modelRequestSeqRef.current !== requestSeq) {
        return;
      }
      const upstreamModels = uniqueModels(result.models);
      const nextModels = result.source === 'upstream' ? upstreamModels : uniqueModels([provider.model, ...upstreamModels, ...fallbackModelOptions]);
      if (result.source === 'upstream' && upstreamModels.length > 0 && !upstreamModels.includes(provider.model)) {
        setProvider((current) => ({ ...current, model: upstreamModels[0] }));
      }
      setModelOptions(nextModels);
      setModelSource(result.source);
      setModelMessage(result.source === 'upstream'
        ? `${formatModelStatusMessage(result.message, t)} / ${result.provider}`
        : formatModelStatusMessage(result.message, t));
    } catch (requestError) {
      if (modelRequestSeqRef.current !== requestSeq) {
        return;
      }
      setModelOptions((current) => uniqueModels([provider.model, ...current, ...fallbackModelOptions]));
      setModelSource('fallback');
      setModelMessage(requestError instanceof Error ? formatModelStatusMessage(requestError.message, t) : t('ai.modelsLoadFailed'));
    } finally {
      if (modelRequestSeqRef.current === requestSeq) {
        setModelsLoading(false);
      }
    }
  }

  async function handleSaveProvider() {
    setProviderSaving(true);
    setProviderSavedMessage('');
    setError('');
    try {
      const settings = await saveAiProviderSettings(provider);
      setServerAiConfigured(settings.configured);
      setProviderCustody({
        managedBy: settings.managedBy,
        hasStoredApiKey: settings.hasStoredApiKey,
        updatedAt: settings.updatedAt,
      });
      setProvider((current) => ({
        ...current,
        name: settings.provider.name,
        baseUrl: settings.provider.baseUrl,
        model: settings.provider.model,
        apiKey: '',
        temperature: settings.provider.temperature,
      }));
      setModelOptions((current) => uniqueModels([settings.provider.model, ...current, ...fallbackModelOptions]));
      setProviderSavedMessage(t('ai.providerSaved'));
      if (providerSavedTimerRef.current) {
        window.clearTimeout(providerSavedTimerRef.current);
      }
      providerSavedTimerRef.current = window.setTimeout(() => {
        setProviderSavedMessage('');
        providerSavedTimerRef.current = null;
      }, 2600);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : t('account.saveFailed'));
    } finally {
      setProviderSaving(false);
    }
  }

  function handleNewChat() {
    const session = createSession(t('ai.newChatTitle'));
    setSessions((current) => [session, ...current.filter((item) => !isBlankSession(item))]);
    setActiveSessionId(session.id);
    setError('');
    setSettingsOpen(false);
    setSessionsOpen(false);
    setNewChatReady(true);
    if (newChatTimerRef.current) {
      window.clearTimeout(newChatTimerRef.current);
    }
    newChatTimerRef.current = window.setTimeout(() => setNewChatReady(false), 1100);
    window.setTimeout(() => questionRef.current?.focus(), 0);
  }

  function handleDeleteSession(sessionId: string) {
    setSessions((current) => {
      if (current.length <= 1) {
        const replacement = createSession(t('ai.newChatTitle'));
        setActiveSessionId(replacement.id);
        return [replacement];
      }

      const next = current.filter((session) => session.id !== sessionId);
      if (activeSessionId === sessionId) {
        setActiveSessionId(next[0].id);
      }
      return next;
    });
    setError('');
  }

  function handleSessionQuestionChange(value: string) {
    updateSession(activeSession.id, {
      question: value,
      title: buildSessionTitle(value, activeSession.messages.length ? activeSession.title : t('ai.newChatTitle')),
    });
  }

  function handleSessionServerChange(value: string) {
    updateSession(activeSession.id, { selectedServerId: value });
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    if (!runningSessionId && activeSession.question.trim()) {
      handleAnalyze().catch(() => undefined);
    }
  }

  function handleStopStream() {
    abortControllerRef.current?.abort();
  }

  function handleRegenerateLast() {
    if (runningSessionId || !lastUserQuestion) {
      return;
    }

    const lastUserIndex = findLastUserMessageIndex(activeSession.messages);
    if (lastUserIndex < 0) {
      return;
    }

    handleAnalyze(true, activeSession.messages[lastUserIndex].content, activeSession.messages.slice(0, lastUserIndex))
      .catch(() => undefined);
  }

  async function handleExecuteAiPlan() {
    const plan = executionPlan;
    const sessionId = activeSession.id;
    if (!plan || aiTaskRunning) {
      return;
    }

    if (aiTaskDecision === 'cancel') {
      setAiTaskResult(null);
      setAiTaskMessage(aiTaskReason.trim() ? `${executionCopy.cancelled}: ${aiTaskReason.trim()}` : executionCopy.cancelled);
      return;
    }

    if (plan.requiresConfirmation && aiTaskDecision !== 'allow') {
      setAiTaskResult(null);
      setAiTaskMessage(executionCopy.cancelled);
      return;
    }

    setAiTaskRunning(true);
    setAiTaskMessage('');
    setAiTaskResult(null);
    try {
      const payload: OperationTaskRequest = {
        type: plan.operation,
        targetMode: plan.targetMode,
        serverIds: plan.targetMode === 'selected' ? plan.serverIds : [],
        command: plan.operation === 'sshCommand' ? plan.command : undefined,
        reason: plan.reason,
        confirmed: Boolean(plan.confirmed),
      };
      const preflight = await preflightOperationTask(payload);
      if (!preflight.ok) {
        setAiTaskMessage(preflight.issues[0]?.message ?? executionCopy.blocked);
        return;
      }
      const confirmedPayload = preflight.requiresConfirmation
        ? { ...payload, confirmed: true }
        : payload;

      const result = await createOperationTask({
        ...confirmedPayload,
        correlationId: preflight.correlationId,
      });
      setAiTaskResult(result);
      setAiTaskMessage(result.message);
      appendExecutionEvidenceMessage(sessionId, result, executionCopy.noOutput);
      await onTaskFinished?.();
    } catch (requestError) {
      setAiTaskMessage(requestError instanceof Error ? requestError.message : executionCopy.failed);
    } finally {
      setAiTaskRunning(false);
    }
  }

  function handleStarterPrompt(question: string) {
    handleSessionQuestionChange(question);
    window.requestAnimationFrame(() => questionRef.current?.focus());
  }

  function handleRetryFailedMessage(messageId: string) {
    if (runningSessionId) {
      return;
    }
    const failedIndex = activeSession.messages.findIndex((message) => message.id === messageId && message.status === 'error');
    if (failedIndex < 0) {
      return;
    }
    let userIndex = failedIndex - 1;
    while (userIndex >= 0 && activeSession.messages[userIndex]?.role !== 'user') {
      userIndex -= 1;
    }
    const retryQuestion = userIndex >= 0 ? activeSession.messages[userIndex]?.content.trim() : '';
    if (!retryQuestion) {
      return;
    }
    setError('');
    void handleAnalyze(true, retryQuestion, activeSession.messages.slice(0, userIndex));
  }

  if (!workspaceMode && collapsed) {
    return (
      <button type="button" className="ai-launcher" aria-label={t('ai.launch')} title={t('ai.launch')} onClick={onExpand}>
        <Bot size={18} />
        <span>AI</span>
      </button>
    );
  }

  return (
    <aside
      className={workspaceMode ? 'ai-dock ai-dock-workspace' : 'ai-dock'}
      data-ai-console-mode={mode}
      aria-labelledby="ai-title"
    >
      <div className="ai-dock-header">
        <div>
          <strong id="ai-title"><MessageCircle size={17} /> {workspaceMode ? t('ai.currentConversation') : t('app.aiTitle')}</strong>
          <span className={runningSessionId ? 'stream-state active' : newChatReady ? 'stream-state ready' : 'stream-state'} aria-live="polite">
            {runningSessionId ? t('ai.streaming') : newChatReady ? t('ai.ready') : t('ai.unlimited', { model: provider.model })}
          </span>
        </div>
        <div className="ai-dock-actions">
          {!workspaceMode && (
            <button type="button" aria-label={t('ai.hide')} title={t('ai.hide')} onClick={onCollapse}>
              <PanelRightClose size={16} />
            </button>
          )}
          <button
            type="button"
            className={sessionsOpen ? 'active' : ''}
            aria-label={t('ai.sessions')}
            title={t('ai.sessions')}
            onClick={() => setSessionsOpen((value) => !value)}
          >
            <History size={16} />
          </button>
          <button type="button" aria-label={t('ai.settings')} title={t('ai.settings')} onClick={() => setSettingsOpen((value) => !value)}>
            {settingsOpen ? <X size={16} /> : <Settings2 size={16} />}
          </button>
          <button type="button" aria-label={t('ai.newChat')} title={t('ai.newChat')} onClick={handleNewChat}>
            <Plus size={16} />
          </button>
        </div>
      </div>

      <div className={settingsOpen ? 'ai-dock-body settings-mode' : 'ai-dock-body chat-mode'}>
        {settingsOpen ? (
          <form
            className={aiProviderReleaseFocusActive ? 'config-panel ai-dock-settings release-focus-anchor active' : 'config-panel ai-dock-settings'}
            data-release-focus-anchor="ai-provider"
            tabIndex={-1}
            onSubmit={(event) => event.preventDefault()}
          >
            <h3><Settings2 size={18} /> {t('ai.llmSettings')}</h3>
            <div className={providerCustody.managedBy === 'none' ? 'ai-provider-custody empty' : 'ai-provider-custody ok'}>
              <ShieldCheck size={16} />
              <span>{t('ai.keyCustody')}</span>
              <strong>{formatProviderCustodyLabel(providerCustody.managedBy, t)}</strong>
              <small>{formatProviderCustodyDetail(providerCustody, t, language)}</small>
            </div>
            <label className="field-block">
              {t('ai.providerName')}
              <input value={provider.name} onChange={(event) => setProvider({ ...provider, name: event.target.value })} />
            </label>
            <label className="field-block">
              {t('ai.baseUrl')}
              <input value={provider.baseUrl} onChange={(event) => setProvider({ ...provider, baseUrl: event.target.value })} />
            </label>
            <label className="field-block">
              {t('ai.model')}
              <select value={provider.model} onChange={(event) => setProvider({ ...provider, model: event.target.value })}>
                {availableModelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-block">
              {t('ai.apiKey')}
              <input
                type="password"
                autoComplete="new-password"
                placeholder={serverAiConfigured ? t('ai.useServerKey') : 'sk-...'}
                value={provider.apiKey}
                onChange={(event) => setProvider({ ...provider, apiKey: event.target.value })}
              />
              <small className="field-hint">{t('ai.apiKeyEphemeral')}</small>
            </label>
            <label className="field-block">
              {t('ai.temperature')}: {provider.temperature.toFixed(1)}
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={provider.temperature}
                onChange={(event) => setProvider({ ...provider, temperature: Number(event.target.value) })}
              />
            </label>
            <div className="ai-dock-settings-actions">
              <button type="button" className="tool-button wide primary" onClick={handleSaveProvider} disabled={providerSaving || !validation.valid}>
                <ShieldCheck size={16} />
                {providerSaving ? t('common.processing') : t('common.save')}
              </button>
              <button type="button" className="tool-button wide" onClick={handleTestConnection} disabled={testing || !validation.valid}>
                <PlugZap size={16} />
                {testing ? t('ai.testingStreaming') : t('ai.testStreaming')}
              </button>
              <button type="button" className="tool-button wide" onClick={() => refreshModels()} disabled={modelsLoading || !validation.valid}>
                <RefreshCw size={16} />
                {modelsLoading ? t('common.processing') : t('ai.refreshModels')}
              </button>
            </div>
            {providerSavedMessage && <div className="validation-box">{providerSavedMessage}</div>}
            {connectionTest && (
              <div className="ping-card">
                <span>{t('ai.ping')}</span>
                <strong>{connectionTest.latencyMs} ms</strong>
                <p>{connectionTest.message} / {connectionTest.model}</p>
              </div>
            )}
            <div className="validation-box">
              <Sparkles size={16} />
              <span>
                {validation.valid ? (modelMessage || t('ai.allCallsStreaming')) : validation.errors.join(' / ')}
              </span>
            </div>
            {error && <div className="error-box">{error}</div>}
          </form>
        ) : (
          <>
            <div className="ai-live-strip">
              <div className="ai-live-copy">
                <span>{externalAiAvailable ? t('ai.realtimeChat') : t('ai.localRuleResult')}</span>
                <strong>{provider.model}</strong>
              </div>
              <label className="ai-server-picker" htmlFor="ai-server-select">
                <span>{t('ai.analyzeServer')}</span>
                <select id="ai-server-select" value={activeSession.selectedServerId} onChange={(event) => handleSessionServerChange(event.target.value)}>
                  <option value="all">{t('ai.allServers')}</option>
                  {servers.map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.name} / {server.publicIp}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {showSessionList && (
              <div className="ai-session-list" aria-label={t('ai.sessions')}>
                <div className="ai-session-list-header">
                  <span>
                    <History size={15} />
                    <strong>{t('ai.sessions')}</strong>
                  </span>
                  <small>{sessions.length}</small>
                </div>
                {sessions.map((session) => (
                  <div key={session.id} className={session.id === activeSession.id ? 'ai-session-item active' : 'ai-session-item'}>
                    <button
                      type="button"
                      className="ai-session-select"
                      onClick={() => {
                        setActiveSessionId(session.id);
                        setError('');
                        setSettingsOpen(false);
                      }}
                    >
                      <span>{session.title}</span>
                      <small>{formatRelativeSessionTime(session.updatedAt, t)}</small>
                    </button>
                    <button
                      type="button"
                      className="ai-session-delete"
                      aria-label={`${t('common.delete')} ${session.title}`}
                      title={t('common.delete')}
                      onClick={() => handleDeleteSession(session.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="ai-chat-thread" aria-live="polite" ref={chatThreadRef}>
              {activeSession.messages.length === 0 ? (
                <div className="ai-empty-panel ai-empty-guidance" data-ai-starter-prompts="true">
                  <div className="ai-empty-copy">
                    <span className="ai-empty-eyebrow"><Sparkles size={15} /> {t('ai.starterEyebrow')}</span>
                    <strong>{t('ai.starterTitle')}</strong>
                    <p>{t('ai.emptyHint')}</p>
                  </div>
                  <div className="ai-starter-actions" aria-label={t('ai.starterTitle')}>
                    <button
                      type="button"
                      data-ai-starter-prompt="risk"
                      onClick={() => handleStarterPrompt(t('ai.starterRiskPrompt'))}
                      title={t('ai.starterRiskDetail')}
                    >
                      <ShieldCheck size={16} />
                      <span className="ai-starter-copy">
                        <strong>{t('ai.starterRisk')}</strong>
                        <small>{t('ai.starterRiskDetail')}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      data-ai-starter-prompt="ssh"
                      onClick={() => handleStarterPrompt(t('ai.starterSshPrompt'))}
                      title={t('ai.starterSshDetail')}
                    >
                      <Terminal size={16} />
                      <span className="ai-starter-copy">
                        <strong>{t('ai.starterSsh')}</strong>
                        <small>{t('ai.starterSshDetail')}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      data-ai-starter-prompt="priority"
                      onClick={() => handleStarterPrompt(t('ai.starterPriorityPrompt'))}
                      title={t('ai.starterPriorityDetail')}
                    >
                      <Sparkles size={16} />
                      <span className="ai-starter-copy">
                        <strong>{t('ai.starterPriority')}</strong>
                        <small>{t('ai.starterPriorityDetail')}</small>
                      </span>
                    </button>
                  </div>
                </div>
              ) : (
                activeSession.messages.map((message) => (
                  <article
                    key={message.id}
                    className={`ai-message ${message.role} ${message.status}`}
                    data-ai-message-error={message.status === 'error' ? 'true' : undefined}
                  >
                    <div className="ai-message-avatar" aria-hidden="true">
                      {message.role === 'assistant' ? <Bot size={14} /> : t('ai.you').slice(0, 1)}
                    </div>
                    <div className="ai-bubble">
                      <div className="ai-message-meta">
                        <span>{message.role === 'assistant' ? t('ai.assistant') : t('ai.you')}</span>
                        <small>{formatMessageMeta(message, provider.model, t, language)}</small>
                      </div>
                      <div className="ai-message-content">
                        {message.content || (message.status === 'streaming' ? t('ai.waitingStream') : '')}
                      </div>
                      {message.role === 'assistant' && message.status === 'error' && (
                        <div className="ai-message-recovery">
                          <span><AlertTriangle size={14} /> {t('ai.failureRecovery')}</span>
                          <div>
                            <button type="button" onClick={() => handleRetryFailedMessage(message.id)} disabled={Boolean(runningSessionId)}>
                              <RefreshCw size={14} />
                              {t('ai.retryMessage')}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setError('');
                                setConnectionTest(null);
                                setSettingsOpen(true);
                              }}
                            >
                              <Settings2 size={14} />
                              {t('ai.checkConnection')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </article>
                ))
              )}
              <div ref={chatEndRef} />
            </div>

            {executionPlan && (
              <div className="ai-execution-card" aria-label={executionCopy.plan}>
                <div className="ai-execution-head">
                  <span><Terminal size={15} /> {executionCopy.plan}</span>
                  <strong>{executionCopy.queued}</strong>
                </div>
                <div className="ai-execution-command">
                  <strong>{executionPlan.title}</strong>
                  <span>{executionCopy.command}</span>
                  <code>{formatExecutionCommand(executionPlan)}</code>
                </div>
                <div className="ai-execution-tags" aria-label={executionCopy.target}>
                  <span><Terminal size={13} /> {formatExecutionTargets(executionPlan.serverIds, executionPlan.targetMode, servers, serverById, executionCopy)}</span>
                  <span>{executionPlan.operation}</span>
                  <span>{executionCopy.executionMode}</span>
                  {executionPlan.requiresConfirmation && (
                    <span className="risk">
                      <AlertTriangle size={13} />
                      {executionCopy.confirmationRequired ?? 'Confirmation required'}
                      {executionPlan.confirmationReason ? ` · ${executionCopy.confirmationReasonLabel ?? 'Reason'}: ${executionPlan.confirmationReason}` : ''}
                    </span>
                  )}
                </div>
                <small><ShieldCheck size={13} /> {executionPlan.safetyNote}</small>
                <div className="ai-execution-choice-group" aria-label={executionCopy.decisionTitle}>
                  <button
                    type="button"
                    className={aiTaskDecision === 'allow' ? 'ai-execution-choice active' : 'ai-execution-choice'}
                    onClick={() => setAiTaskDecision('allow')}
                    disabled={aiTaskRunning}
                  >
                    <CheckCircle2 size={14} />
                    {executionCopy.allow}
                  </button>
                  <button
                    type="button"
                    className={aiTaskDecision === 'cancel' ? 'ai-execution-choice active danger' : 'ai-execution-choice'}
                    onClick={() => setAiTaskDecision('cancel')}
                    disabled={aiTaskRunning}
                  >
                    <Ban size={14} />
                    {executionCopy.cancel}
                  </button>
                  <div className="ai-execution-reason">
                    <span>{executionCopy.reason}</span>
                    <input
                      value={aiTaskReason}
                      onChange={(event) => setAiTaskReason(event.target.value)}
                      disabled={aiTaskRunning}
                      placeholder={executionCopy.reasonPlaceholder}
                    />
                    <button type="button" onClick={handleExecuteAiPlan} disabled={aiTaskRunning || Boolean(runningSessionId)}>
                      {aiTaskRunning ? executionCopy.running : executionCopy.submit}
                    </button>
                  </div>
                </div>
                {aiTaskMessage && <div className={aiTaskResult?.status === 'failed' ? 'error-box' : 'validation-box'}>{aiTaskMessage}</div>}
                {aiTaskResult && (
                  <div className="ai-execution-result">
                    <span>{aiTaskResult.summary.success} {executionCopy.success} / {aiTaskResult.summary.failed} {executionCopy.failedShort}</span>
                    {aiTaskResult.outputs.slice(0, 2).map((output) => (
                      <pre key={`${aiTaskResult.id}-${output.serverId}`}>{output.serverName}: {output.output || output.error || executionCopy.noOutput}</pre>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="ai-composer" aria-label={t('ai.chatInput')}>
              <textarea
                ref={questionRef}
                value={activeSession.question}
                placeholder={t('ai.defaultQuestion')}
                aria-label={t('ai.question')}
                onChange={(event) => handleSessionQuestionChange(event.target.value)}
                onKeyDown={handleComposerKeyDown}
              />
              <div className="ai-composer-toolbar">
                <div className="ai-composer-toolbar-main">
                  <label className="ai-model-select">
                    <select value={provider.model} onChange={(event) => setProvider({ ...provider, model: event.target.value })} aria-label={t('ai.model')}>
                      {availableModelOptions.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={13} aria-hidden="true" />
                  </label>
                  <div className="ai-composer-tools">
                    <button type="button" className="ai-composer-icon" aria-label={t('ai.testStreaming')} title={t('ai.testStreaming')} onClick={handleTestConnection} disabled={testing || !validation.valid}>
                      <PlugZap size={15} />
                    </button>
                    <button type="button" className="ai-composer-icon" aria-label={t('ai.regenerateLast')} title={t('ai.regenerateLast')} onClick={handleRegenerateLast} disabled={Boolean(runningSessionId) || !lastUserQuestion}>
                      <RotateCcw size={15} />
                    </button>
                    <details className="ai-composer-more">
                      <summary aria-label={t('ai.moreTools')} title={t('ai.moreTools')}>
                        <MoreHorizontal size={16} />
                      </summary>
                      <div className="ai-composer-more-menu">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.currentTarget.closest('details')?.removeAttribute('open');
                            void refreshModels();
                          }}
                          disabled={modelsLoading || !validation.valid}
                        >
                          <RefreshCw size={15} className={modelsLoading ? 'spin-icon' : ''} />
                          <span>{t('ai.refreshModels')}</span>
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.currentTarget.closest('details')?.removeAttribute('open');
                            void handleAnalyze(true);
                          }}
                          disabled={Boolean(runningSessionId) || !activeSession.question.trim()}
                        >
                          <RefreshCw size={15} />
                          <span>{t('ai.forceRegenerate')}</span>
                        </button>
                      </div>
                    </details>
                  </div>
                </div>
                <div className="ai-composer-actions">
                  {running ? (
                    <button type="button" className="ai-send-orb stop" aria-label={t('ai.stop')} title={t('ai.stop')} onClick={handleStopStream}>
                      <CircleStop size={17} />
                      <span>{t('ai.stop')}</span>
                    </button>
                  ) : (
                    <button type="button" className="ai-send-orb" aria-label={t('ai.send')} title={t('ai.send')} onClick={() => handleAnalyze()} disabled={Boolean(runningSessionId) || !activeSession.question.trim()}>
                      <Send size={17} />
                      <span>{t('ai.send')}</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
            {(connectionTest || modelMessage) && (
              <div className="ai-status-stack">
                {connectionTest && (
                  <div className={connectionTest.ok ? 'ai-connection-chip ok' : 'ai-connection-chip'}>
                    <PlugZap size={14} />
                    <span>{connectionTest.latencyMs} ms / {connectionTest.model}</span>
                  </div>
                )}
                {modelMessage && (
                  <div className={modelSource === 'upstream' ? 'ai-connection-chip ok' : 'ai-connection-chip'}>
                    <RefreshCw size={14} />
                    <span>{modelMessage}</span>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );

  function updateSession(sessionId: string, patch: Partial<AiChatSession>) {
    setSessions((current) => current.map((session) => (
      session.id === sessionId
        ? { ...session, ...patch, updatedAt: new Date().toISOString() }
        : session
    )));
  }

  function appendAssistantMessage(sessionId: string, messageId: string, chunk: string, fallbackPrompt: string) {
    setSessions((current) => current.map((session) => {
      if (session.id !== sessionId) {
        return session;
      }

      const messages = session.messages.map((message) => (
        message.id === messageId
          ? {
            ...message,
            content: `${message.content}${chunk}`,
            meta: message.meta ?? {
              provider: publicProviderEndpoint(provider.baseUrl),
              model: provider.model,
              simulated: !externalAiAvailable,
              cached: false,
            },
          }
          : message
      ));
      const assistant = messages.find((message) => message.id === messageId);
      return {
        ...session,
        messages,
        analysis: assistant ? assistantMessageToAnalysis(assistant, fallbackPrompt) : session.analysis,
        updatedAt: new Date().toISOString(),
      };
    }));
  }

  function updateAssistantMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<AiChatMessage>,
    finalResult?: AiAnalysisResponse,
  ) {
    setSessions((current) => current.map((session) => {
      if (session.id !== sessionId) {
        return session;
      }

      const messages = session.messages.map((message) => (
        message.id === messageId ? { ...message, ...patch } : message
      ));
      const assistant = messages.find((message) => message.id === messageId);
      return {
        ...session,
        messages,
        analysis: finalResult ?? (assistant ? assistantMessageToAnalysis(assistant, session.analysis?.prompt ?? prompt) : session.analysis),
        updatedAt: new Date().toISOString(),
      };
    }));
  }

  function queueAssistantMessageChunk(sessionId: string, messageId: string, chunk: string, fallbackPrompt: string) {
    const bufferKey = `${sessionId}:${messageId}`;
    const buffered = streamChunkBufferRef.current.get(bufferKey);
    if (buffered) {
      buffered.content += chunk;
    } else {
      streamChunkBufferRef.current.set(bufferKey, { sessionId, messageId, content: chunk, fallbackPrompt });
    }

    if (streamFlushTimerRef.current === null) {
      streamFlushTimerRef.current = window.setTimeout(flushAssistantMessageChunks, aiStreamFlushIntervalMs);
    }
  }

  function flushAssistantMessageChunks() {
    if (streamFlushTimerRef.current !== null) {
      window.clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }

    const bufferedChunks = Array.from(streamChunkBufferRef.current.values());
    streamChunkBufferRef.current.clear();
    bufferedChunks.forEach((item) => {
      appendAssistantMessage(item.sessionId, item.messageId, item.content, item.fallbackPrompt);
    });
  }

  function appendExecutionEvidenceMessage(sessionId: string, result: OperationTaskResponse, noOutputLabel: string) {
    const evidenceMessage = createAssistantMessage(
      buildExecutionEvidenceMessage(result, noOutputLabel),
      {
        provider: 'CoLiPas云服务器管理面板 operations',
        model: 'execution-evidence',
        prompt: 'Guarded AI operation execution result',
        answer: '',
        simulated: true,
        cached: false,
        generatedAt: result.finishedAt,
      },
      'done',
    );

    setSessions((current) => current.map((session) => {
      if (session.id !== sessionId) {
        return session;
      }

      return {
        ...session,
        messages: [...session.messages, evidenceMessage],
        updatedAt: new Date().toISOString(),
      };
    }));
  }
}

function formatAiRequestFailure(error: unknown, translate: (key: string) => string) {
  const message = error instanceof Error ? error.message.trim() : '';
  if (!message) {
    return translate('ai.analysisFailed');
  }
  if (/timed?\s*out|timeout|aborterror/i.test(message)) {
    return translate('ai.timeoutFailure');
  }
  if (/network error|failed to fetch|fetch failed|connection (?:was )?interrupted|socket|terminated|econn|enotfound|eai_again/i.test(message)) {
    return translate('ai.networkFailure');
  }
  if (/\b(?:401|403)\b|unauthori[sz]ed|authentication|api key/i.test(message)) {
    return translate('ai.authFailure');
  }
  if (/\b404\b|model.+(?:not found|unavailable)|unknown model/i.test(message)) {
    return translate('ai.modelFailure');
  }
  return message;
}

function createSession(title: string): AiChatSession {
  const now = new Date().toISOString();
  return {
    id: `chat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    title,
    question: '',
    selectedServerId: 'all',
    messages: [],
    analysis: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createMessage(role: AiChatRole, content: string): AiChatMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    status: 'done',
  };
}

function createAssistantMessage(content: string, analysis: AiAnalysisResponse, status: AiMessageStatus): AiChatMessage {
  return {
    ...createMessage('assistant', content),
    status,
    meta: analysisToMessageMeta(analysis),
  };
}

function analysisToMessageMeta(analysis: AiAnalysisResponse): AiChatMessage['meta'] {
  return {
    provider: analysis.provider,
    model: analysis.model,
    simulated: analysis.simulated,
    cached: analysis.cached,
    generatedAt: analysis.generatedAt,
  };
}

function assistantMessageToAnalysis(message: AiChatMessage, prompt: string): AiAnalysisResponse {
  return {
    provider: message.meta?.provider ?? 'unknown',
    model: message.meta?.model ?? 'unknown',
    prompt,
    answer: message.content,
    simulated: message.meta?.simulated ?? false,
    cached: message.meta?.cached,
    generatedAt: message.meta?.generatedAt,
  };
}

function formatProviderCustodyLabel(managedBy: AiProviderManagedBy, t: (key: string, vars?: Record<string, string | number>) => string) {
  if (managedBy === 'database') {
    return t('ai.keyCustodyDatabase');
  }
  if (managedBy === 'environment') {
    return t('ai.keyCustodyEnvironment');
  }
  return t('ai.keyCustodyNone');
}

function formatProviderCustodyDetail(
  custody: AiProviderCustodyState,
  t: (key: string, vars?: Record<string, string | number>) => string,
  language: string,
) {
  if (custody.managedBy === 'database' && custody.updatedAt) {
    return t('ai.keyCustodyUpdated', { time: formatDateTime(custody.updatedAt, language) });
  }
  if (custody.managedBy === 'database' || custody.hasStoredApiKey) {
    return t('ai.keyCustodyEncrypted');
  }
  if (custody.managedBy === 'environment') {
    return t('ai.keyCustodyEnvDetail');
  }
  return t('ai.keyCustodyNoneDetail');
}

function formatExecutionTargets(
  serverIds: string[],
  targetMode: string,
  servers: ServerNode[],
  serverById: Map<string, ServerNode>,
  copy: (typeof aiExecutionCopyByLanguage)[string],
) {
  if (targetMode === 'allConnected') {
    return `${copy.allConnected} (${servers.filter((server) => server.ssh?.connected).length})`;
  }
  if (targetMode === 'allServers') {
    return `${copy.allServers} (${servers.length})`;
  }

  const serverNames = serverIds
    .map((serverId) => serverById.get(serverId)?.name ?? serverId)
    .slice(0, 3);
  return serverNames.length > 0 ? serverNames.join(', ') : copy.selectedServers;
}

function formatExecutionCommand(plan: NonNullable<AiAnalysisResponse['executionPlan']>) {
  if (plan.command?.trim()) {
    return plan.command.trim();
  }

  if (plan.operation === 'healthCheck') {
    return 'hostname && date && free -h && df -h / && uptime';
  }

  if (plan.operation === 'shutdown') {
    return 'systemctl poweroff';
  }

  if (plan.operation === 'reboot') {
    return 'systemctl reboot';
  }

  if (plan.operation === 'powerOn') {
    return 'cloud lifecycle power-on';
  }

  return plan.summary;
}

function buildExecutionEvidenceMessage(result: OperationTaskResponse, noOutputLabel: string) {
  const outputLines = result.outputs.slice(0, 5).map((output, index) => {
    const status = output.error ? `${output.status}: ${output.error}` : output.status;
    const command = output.command?.trim() ? `command=${output.command.trim()}\n` : '';
    const outputText = (output.output || output.error || noOutputLabel).trim().slice(0, 2200);
    return [
      `${index + 1}. ${output.serverName} (${output.serverId})`,
      `status=${status}`,
      command ? command.trimEnd() : '',
      `output:\n${outputText}`,
    ].filter(Boolean).join('\n');
  });

  return [
    'Execution evidence:',
    `task=${result.id}`,
    `trace=${result.correlationId}`,
    `type=${result.type}`,
    `status=${result.status}`,
    `summary=${result.summary.success}/${result.summary.total} succeeded, ${result.summary.failed} failed, ${result.summary.skipped} skipped`,
    result.outputsTruncated
      ? `outputs=showing ${result.outputs.length}/${result.summary.total}; omitted=${result.omittedOutputs ?? Math.max(result.summary.total - result.outputs.length, 0)}`
      : `outputs=${result.outputs.length}/${result.summary.total}`,
    `finishedAt=${result.finishedAt}`,
    '',
    ...outputLines,
  ].join('\n');
}

function loadStoredProvider(): AIProviderConfig {
  if (typeof window === 'undefined') {
    return { ...defaultAIProvider };
  }

  try {
    const rawProvider = window.localStorage.getItem(aiProviderStorageKey);
    if (!rawProvider) {
      return { ...defaultAIProvider };
    }

    const storedProvider = JSON.parse(rawProvider) as Partial<AIProviderConfig>;
    return {
      name: typeof storedProvider.name === 'string' && storedProvider.name.trim() ? storedProvider.name : defaultAIProvider.name,
      baseUrl: typeof storedProvider.baseUrl === 'string' && storedProvider.baseUrl.trim() ? storedProvider.baseUrl : defaultAIProvider.baseUrl,
      model: typeof storedProvider.model === 'string' && storedProvider.model.trim() ? storedProvider.model : defaultAIProvider.model,
      apiKey: defaultAIProvider.apiKey,
      temperature: typeof storedProvider.temperature === 'number' && Number.isFinite(storedProvider.temperature)
        ? storedProvider.temperature
        : defaultAIProvider.temperature,
    };
  } catch {
    return { ...defaultAIProvider };
  }
}

function toStoredProvider(provider: AIProviderConfig): Omit<AIProviderConfig, 'apiKey'> {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    temperature: provider.temperature,
  };
}

function persistStoredProvider(provider: AIProviderConfig) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(aiProviderStorageKey, JSON.stringify(toStoredProvider(provider)));
}

function persistConsoleState(state: StoredAIConsoleState) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(aiStateStorageKey);
}

function loadStoredConsoleState(newChatTitle: string): StoredAIConsoleState {
  const fallbackSession = createSession(newChatTitle);
  const fallbackState: StoredAIConsoleState = {
    sessions: [fallbackSession],
    activeSessionId: fallbackSession.id,
    connectionTest: null,
  };

  if (typeof window === 'undefined') {
    return fallbackState;
  }

  try {
    window.localStorage.removeItem(aiStateStorageKey);
    return fallbackState;
  } catch {
    return fallbackState;
  }
}

function isRecoverableChatSession(value: unknown): value is Partial<AiChatSession> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const session = value as Partial<AiChatSession>;
  return typeof session.id === 'string'
    && typeof session.title === 'string'
    && typeof session.question === 'string'
    && typeof session.selectedServerId === 'string'
    && typeof session.createdAt === 'string'
    && typeof session.updatedAt === 'string'
    && (session.analysis === undefined || session.analysis === null || isValidAiAnalysis(session.analysis));
}

function isValidChatMessage(value: unknown): value is AiChatMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const message = value as Partial<AiChatMessage>;
  return (message.role === 'user' || message.role === 'assistant')
    && typeof message.id === 'string'
    && typeof message.content === 'string'
    && typeof message.createdAt === 'string'
    && (message.status === 'done' || message.status === 'streaming' || message.status === 'cached' || message.status === 'error' || message.status === 'stopped');
}

function isValidAiAnalysis(value: unknown): value is AiAnalysisResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const analysis = value as Partial<AiAnalysisResponse>;
  return typeof analysis.provider === 'string'
    && typeof analysis.model === 'string'
    && typeof analysis.prompt === 'string'
    && typeof analysis.answer === 'string'
    && typeof analysis.simulated === 'boolean'
    && (analysis.executionPlan === undefined || isValidAiExecutionPlan(analysis.executionPlan));
}

function isValidAiExecutionPlan(value: unknown): value is NonNullable<AiAnalysisResponse['executionPlan']> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const plan = value as Partial<NonNullable<AiAnalysisResponse['executionPlan']>>;
  return typeof plan.title === 'string'
    && typeof plan.summary === 'string'
    && (plan.targetMode === 'allServers' || plan.targetMode === 'allConnected' || plan.targetMode === 'selected')
    && Array.isArray(plan.serverIds)
    && plan.serverIds.every((serverId) => typeof serverId === 'string')
    && (plan.operation === 'assetSync' || plan.operation === 'healthCheck' || plan.operation === 'sshCommand' || plan.operation === 'powerOn' || plan.operation === 'shutdown' || plan.operation === 'reboot')
    && (plan.command === undefined || typeof plan.command === 'string')
    && typeof plan.reason === 'string'
    && (plan.requiresConfirmation === undefined || typeof plan.requiresConfirmation === 'boolean')
    && (plan.confirmationReason === undefined || typeof plan.confirmationReason === 'string')
    && typeof plan.safetyNote === 'string';
}

function isValidConnectionTest(value: unknown): value is AiConnectionTestResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const result = value as Partial<AiConnectionTestResponse>;
  return typeof result.ok === 'boolean'
    && typeof result.provider === 'string'
    && typeof result.model === 'string'
    && typeof result.latencyMs === 'number'
    && typeof result.checkedAt === 'string'
    && typeof result.message === 'string';
}

function normalizeStoredSessions(sessions: Partial<AiChatSession>[], newChatTitle: string) {
  let blankKept = false;
  return sessions
    .map((session) => {
      const normalized: AiChatSession = {
        id: session.id ?? createSession(newChatTitle).id,
        title: session.title === 'New Chat' || session.title === '閺傞绱扮拠?' ? newChatTitle : session.title ?? newChatTitle,
        question: session.question ?? '',
        selectedServerId: session.selectedServerId ?? 'all',
        messages: normalizeStoredMessages(session),
        analysis: session.analysis && isValidAiAnalysis(session.analysis) ? session.analysis : null,
        createdAt: session.createdAt ?? new Date().toISOString(),
        updatedAt: session.updatedAt ?? new Date().toISOString(),
      };
      return normalized;
    })
    .filter((session) => {
      if (!isBlankSession(session)) {
        return true;
      }

      if (blankKept) {
        return false;
      }

      blankKept = true;
      return true;
    });
}

function normalizeStoredMessages(session: Partial<AiChatSession>) {
  if (Array.isArray(session.messages)) {
    return session.messages.filter(isValidChatMessage).map((message) => ({
      ...message,
      status: message.status === 'streaming' ? 'stopped' : message.status,
    }));
  }

  if (session.analysis && isValidAiAnalysis(session.analysis) && session.analysis.answer) {
    const createdAt = session.createdAt ?? new Date().toISOString();
    return [
      {
        id: `migrated-user-${createdAt}`,
        role: 'user' as const,
        content: session.question || session.analysis.prompt,
        createdAt,
        status: 'done' as const,
      },
      createAssistantMessage(session.analysis.answer, session.analysis, session.analysis.cached ? 'cached' : 'done'),
    ];
  }

  return [];
}

function buildSessionTitle(question: string, fallbackTitle: string) {
  const title = question.trim().replace(/\s+/g, ' ').slice(0, 24);
  return title || fallbackTitle;
}

function isBlankSession(session: AiChatSession) {
  return !session.analysis && !session.question.trim() && session.messages.length === 0;
}

function toRequestHistory(messages: AiChatMessage[]): AiChatRequestMessage[] {
  return messages
    .filter((message) => message.status !== 'error' && message.status !== 'stopped' && message.content.trim())
    .map((message) => ({ role: message.role, content: message.content.trim() }))
    .slice(-12);
}

function findLastUserQuestion(messages: AiChatMessage[]) {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user' && message.content.trim());
  return lastUser?.content.trim() ?? '';
}

function findLastUserMessageIndex(messages: AiChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user' && messages[index].content.trim()) {
      return index;
    }
  }
  return -1;
}

function formatRelativeSessionTime(isoDate: string, t: (key: string, vars?: Record<string, string | number>) => string) {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.max(0, Math.round(diffMs / 60000));
  if (minutes < 1) {
    return t('ai.justNow');
  }
  if (minutes < 60) {
    return t('ai.minutesAgo', { count: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return t('ai.hoursAgo', { count: hours });
  }
  return t('ai.daysAgo', { count: Math.round(hours / 24) });
}

function formatMessageMeta(
  message: AiChatMessage,
  fallbackModel: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
  language: string,
) {
  if (message.role === 'user') {
    return formatDateTime(message.createdAt, language);
  }
  if (message.status === 'streaming') {
    return t('ai.liveReply');
  }
  if (message.status === 'cached') {
    return `${t('ai.cachedResult')} / ${t('ai.cacheHit')}`;
  }
  if (message.status === 'stopped') {
    return t('ai.stopped');
  }
  if (message.status === 'error') {
    return t('ai.analysisFailed');
  }

  const model = message.meta?.model ?? fallbackModel;
  if (message.meta?.simulated) {
    if (message.meta.model === 'execution-evidence') {
      return 'CoLiPas云服务器管理面板 operations';
    }
    return `${model} / ${t('ai.localRuleResult')}`;
  }
  if (message.meta?.generatedAt) {
    return `${model} / ${t('ai.generatedAt', { time: formatDateTime(message.meta.generatedAt, language) })}`;
  }
  return model;
}

function buildAiResponseCacheKey(
  provider: AIProviderConfig,
  serverId: string,
  question: string,
  prompt: string,
  messages: AiChatRequestMessage[],
) {
  return `ai-cache:${stableHash(JSON.stringify({
    provider: publicProviderEndpoint(provider.baseUrl),
    model: provider.model,
    temperature: provider.temperature,
    serverId,
    question: question.trim(),
    prompt,
    messages,
  }))}`;
}

function getCachedAiResponse(cacheKey: string): AiAnalysisResponse | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const cache = readAiResponseCache();
    const now = Date.now();
    const entry = cache.find((item) => item.key === cacheKey);
    if (!entry || now - entry.cachedAt > aiResponseCacheTtlMs) {
      if (entry) {
        writeAiResponseCache(cache.filter((item) => item.key !== cacheKey));
      }
      return null;
    }
    return {
      ...entry.result,
      cached: true,
    };
  } catch {
    return null;
  }
}

function setCachedAiResponse(cacheKey: string, result: AiAnalysisResponse) {
  if (typeof window === 'undefined' || !isValidAiAnalysis(result)) {
    return;
  }

  try {
    const now = Date.now();
    const cache = readAiResponseCache()
      .filter((entry) => entry.key !== cacheKey && now - entry.cachedAt <= aiResponseCacheTtlMs);
    cache.unshift({
      key: cacheKey,
      cachedAt: now,
      result: {
        ...result,
        cached: false,
        generatedAt: result.generatedAt ?? new Date().toISOString(),
      },
    });
    writeAiResponseCache(cache.slice(0, aiResponseCacheMaxEntries));
  } catch {
    // Cache is an optimization; failed writes must not block chat.
  }
}

function readAiResponseCache(): Array<{ key: string; cachedAt: number; result: AiAnalysisResponse }> {
  const rawCache = window.localStorage.getItem(aiResponseCacheStorageKey);
  if (!rawCache) {
    return [];
  }

  const parsed = JSON.parse(rawCache) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter(isValidAiCacheEntry);
}

function writeAiResponseCache(cache: Array<{ key: string; cachedAt: number; result: AiAnalysisResponse }>) {
  window.localStorage.setItem(aiResponseCacheStorageKey, JSON.stringify(cache));
}

function isValidAiCacheEntry(value: unknown): value is { key: string; cachedAt: number; result: AiAnalysisResponse } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const entry = value as { key?: unknown; cachedAt?: unknown; result?: unknown };
  return typeof entry.key === 'string'
    && typeof entry.cachedAt === 'number'
    && isValidAiAnalysis(entry.result);
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

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function formatDateTime(isoDate: string, language: string) {
  try {
    return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : language === 'ja' ? 'ja-JP' : 'zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(isoDate));
  } catch {
    return isoDate;
  }
}

function formatModelStatusMessage(message: string, t: (key: string, vars?: Record<string, string | number>) => string) {
  const loaded = message.match(/^Loaded\s+(\d+)\s+models from upstream API$/i);
  if (loaded) {
    return t('ai.modelsLoaded', { count: Number(loaded[1]) });
  }
  if (/API key is not configured/i.test(message)) {
    return t('ai.modelsNoKey');
  }
  if (/No upstream models found/i.test(message)) {
    return t('ai.modelsFallback');
  }
  if (/Failed to load models/i.test(message)) {
    return t('ai.modelsLoadFailed');
  }
  return message;
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
