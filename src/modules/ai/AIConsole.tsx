import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Bot,
  ChevronDown,
  CircleStop,
  History,
  MessageCircle,
  PanelRightClose,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { defaultAIProvider } from '../../data/mockData';
import { useI18n } from '../../i18n';
import {
  streamAiAnalysis,
  AiAnalysisResponse,
  AiChatRequestMessage,
  fetchAiModels,
  fetchConfigSummary,
  testAiConnection,
  AiConnectionTestResponse,
} from '../../services/apiClient';
import { AIProviderConfig, OperationEvent, ServerNode } from '../../types';
import { buildOpsPrompt, validateAIProviderConfig } from './aiConfig';

interface AIConsoleProps {
  servers: ServerNode[];
  events: OperationEvent[];
  collapsed: boolean;
  seedQuestion: string;
  onCollapse: () => void;
  onExpand: () => void;
  onSeedQuestionConsumed: () => void;
}

type AiChatRole = 'user' | 'assistant';
type AiMessageStatus = 'done' | 'streaming' | 'cached' | 'error' | 'stopped';

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

const aiProviderStorageKey = 'colipas.aiProvider';
const aiStateStorageKey = 'colipas.aiConsoleState';
const aiResponseCacheStorageKey = 'colipas.aiResponseCache';
const aiResponseCacheTtlMs = 10 * 60 * 1000;
const aiResponseCacheMaxEntries = 60;
const fallbackModelOptions = ['gpt-5.5', 'gpt-5.4', 'gpt-4.1-mini', 'deepseek-chat', 'qwen-plus'];

export function AIConsole({ servers, events, collapsed, seedQuestion, onCollapse, onExpand, onSeedQuestionConsumed }: AIConsoleProps) {
  const { language, t } = useI18n();
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
  const [newChatReady, setNewChatReady] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const chatThreadRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const newChatTimerRef = useRef<number | null>(null);
  const modelRequestSeqRef = useRef(0);
  const aiStatePersistTimerRef = useRef<number | null>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const validation = useMemo(() => validateAIProviderConfig(provider, language), [language, provider]);
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const selectedServers = useMemo(
    () => (activeSession.selectedServerId === 'all' ? servers : servers.filter((server) => server.id === activeSession.selectedServerId)),
    [activeSession.selectedServerId, servers],
  );
  const prompt = useMemo(() => buildOpsPrompt(selectedServers, events), [selectedServers, events]);
  const running = runningSessionId === activeSession.id;
  const externalAiAvailable = Boolean(provider.apiKey.trim() || serverAiConfigured);
  const showSessionList = sessionsOpen && (sessions.length > 1 || activeSession.messages.length > 0);
  const lastUserQuestion = useMemo(() => findLastUserQuestion(activeSession.messages), [activeSession.messages]);
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
    persistStoredProvider(provider);
  }, [provider]);

  useEffect(() => {
    const validServerIds = new Set(servers.map((server) => server.id));
    setSessions((current) => current.map((session) => (
      session.selectedServerId !== 'all' && !validServerIds.has(session.selectedServerId)
        ? { ...session, selectedServerId: 'all', updatedAt: new Date().toISOString() }
        : session
    )));
  }, [servers]);

  useEffect(() => {
    fetchConfigSummary()
      .then((config) => {
        setServerAiConfigured(config.ai.configured);
        setProvider((current) => {
          const nextBaseUrl = current.baseUrl === defaultAIProvider.baseUrl && config.ai.baseUrl
            ? config.ai.baseUrl
            : current.baseUrl;
          const nextModel = current.model === defaultAIProvider.model && config.ai.model
            ? config.ai.model
            : current.model;

          if (nextBaseUrl === current.baseUrl && nextModel === current.model) {
            return current;
          }

          return {
            ...current,
            baseUrl: nextBaseUrl,
            model: nextModel,
          };
        });
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      refreshModels().catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [provider.baseUrl, provider.apiKey]);

  useEffect(() => () => {
    abortControllerRef.current?.abort();
    if (newChatTimerRef.current) {
      window.clearTimeout(newChatTimerRef.current);
    }
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
    const chatThread = chatThreadRef.current;
    if (chatThread) {
      chatThread.scrollTop = chatThread.scrollHeight;
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
        appendAssistantMessage(sessionId, assistantMessage.id, chunk, requestPrompt);
      }, { forceRefresh: requestForceRefresh, messages: requestHistory, signal: controller.signal });
      if (useLocalCache) {
        setCachedAiResponse(cacheKey, result);
      }
      updateAssistantMessage(sessionId, assistantMessage.id, {
        content: result.answer,
        status: 'done',
        meta: analysisToMessageMeta(result),
      }, result);
    } catch (requestError) {
      const stopped = controller.signal.aborted;
      updateAssistantMessage(sessionId, assistantMessage.id, {
        status: stopped ? 'stopped' : 'error',
        content: stopped ? t('ai.stopped') : (requestError instanceof Error ? requestError.message : t('ai.analysisFailed')),
      });
      if (!stopped && activeSessionId === sessionId) {
        setError(requestError instanceof Error ? requestError.message : t('ai.analysisFailed'));
      }
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

  if (collapsed) {
    return (
      <button type="button" className="ai-launcher" aria-label={t('ai.launch')} title={t('ai.launch')} onClick={onExpand}>
        <Bot size={18} />
        <span>AI</span>
      </button>
    );
  }

  return (
    <aside className="ai-dock" aria-labelledby="ai-title">
      <div className="ai-dock-header">
        <div>
          <strong id="ai-title"><MessageCircle size={17} /> {t('app.aiTitle')}</strong>
          <span className={runningSessionId ? 'stream-state active' : newChatReady ? 'stream-state ready' : 'stream-state'} aria-live="polite">
            {runningSessionId ? t('ai.streaming') : newChatReady ? t('ai.ready') : t('ai.unlimited', { model: provider.model })}
          </span>
        </div>
        <div className="ai-dock-actions">
          <button type="button" aria-label={t('ai.hide')} title={t('ai.hide')} onClick={onCollapse}>
            <PanelRightClose size={16} />
          </button>
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
          <form className="config-panel ai-dock-settings" onSubmit={(event) => event.preventDefault()}>
            <h3><Settings2 size={18} /> {t('ai.llmSettings')}</h3>
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
            <button type="button" className="tool-button wide" onClick={handleTestConnection} disabled={testing || !validation.valid}>
              <PlugZap size={16} />
              {testing ? t('ai.testingStreaming') : t('ai.testStreaming')}
            </button>
            <button type="button" className="tool-button wide" onClick={() => refreshModels()} disabled={modelsLoading || !validation.valid}>
              <RefreshCw size={16} />
              {modelsLoading ? t('common.processing') : t('ai.refreshModels')}
            </button>
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
                <div className="ai-empty-panel">
                  <Sparkles size={17} />
                  <span>{t('ai.emptyHint')}</span>
                </div>
              ) : (
                activeSession.messages.map((message) => (
                  <article key={message.id} className={`ai-message ${message.role} ${message.status}`}>
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
                    </div>
                  </article>
                ))
              )}
              <div ref={chatEndRef} />
            </div>

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
                    <button type="button" className="ai-composer-icon" aria-label={t('ai.refreshModels')} title={t('ai.refreshModels')} onClick={() => refreshModels()} disabled={modelsLoading || !validation.valid}>
                      <RefreshCw size={15} className={modelsLoading ? 'spin-icon' : ''} />
                    </button>
                    <button type="button" className="ai-composer-icon" aria-label={t('ai.testStreaming')} title={t('ai.testStreaming')} onClick={handleTestConnection} disabled={testing || !validation.valid}>
                      <PlugZap size={15} />
                    </button>
                    <button type="button" className="ai-composer-icon" aria-label={t('ai.forceRegenerate')} title={t('ai.forceRegenerate')} onClick={() => handleAnalyze(true)} disabled={Boolean(runningSessionId) || !activeSession.question.trim()}>
                      <RefreshCw size={15} />
                    </button>
                    <button type="button" className="ai-composer-icon" aria-label={t('ai.regenerateLast')} title={t('ai.regenerateLast')} onClick={handleRegenerateLast} disabled={Boolean(runningSessionId) || !lastUserQuestion}>
                      <RotateCcw size={15} />
                    </button>
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
            {(connectionTest || modelMessage || error) && (
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
                {error && <div className="error-box">{error}</div>}
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
    && typeof analysis.simulated === 'boolean';
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
