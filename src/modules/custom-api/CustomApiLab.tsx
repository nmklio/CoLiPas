import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  BellRing,
  CheckCircle2,
  Clipboard,
  CloudCog,
  DatabaseZap,
  Globe2,
  KeyRound,
  Play,
  ReceiptText,
  Save,
  ServerCog,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { testCustomApi, CustomApiTestResponse } from '../../services/apiClient';
import { ApiMethod, CustomApiConfig } from '../../types';
import { prepareApiRequest, toCurl } from './apiRequest';

const methods: ApiMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const storageKey = 'colipas.customApiConfig';
const savedIntegrationsKey = 'colipas.customApiIntegrations';

type IntegrationTemplateId = 'assetSync' | 'alertWebhook' | 'billingUsage';
type IntegrationStatus = 'draft' | 'tested' | 'blocked';

interface IntegrationTemplate {
  id: IntegrationTemplateId;
  icon: typeof CloudCog;
  config: CustomApiConfig;
  linkage: string[];
}

interface SavedIntegration {
  id: string;
  name: string;
  method: ApiMethod;
  url: string;
  host: string;
  templateId: IntegrationTemplateId;
  status: IntegrationStatus;
  savedAt: string;
  lastStatus?: number;
  lastLatencyMs?: number;
}

interface ConfigSummary {
  customApiAllowedHosts: string[];
  customApiTimeoutMs: number;
}

const initialConfig: CustomApiConfig = {
  name: 'Asset inventory sync',
  method: 'GET',
  url: 'https://httpbin.org/get?provider=all',
  headersText: 'Accept: application/json\nX-Source: CoLiPas',
  bodyText: '',
  authToken: '',
};

export function CustomApiLab() {
  const { language, t } = useI18n();
  const copy = apiCopyByLanguage[language] ?? apiCopyByLanguage.zh;
  const templates = useMemo(() => buildTemplates(copy), [copy]);
  const [activeTemplateId, setActiveTemplateId] = useState<IntegrationTemplateId>('assetSync');
  const [config, setConfig] = useState<CustomApiConfig>(() => loadStoredConfig());
  const [integrations, setIntegrations] = useState<SavedIntegration[]>(() => loadSavedIntegrations());
  const [result, setResult] = useState<CustomApiTestResponse | { error: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<ConfigSummary | null>(null);
  const activeTemplate = templates.find((template) => template.id === activeTemplateId) ?? templates[0];
  const requestState = useMemo(() => {
    try {
      const request = prepareApiRequest(config);
      const url = new URL(request.url);
      return { ok: true as const, request, curl: toCurl(request), url };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : t('api.invalidConfig') };
    }
  }, [config, t]);

  const hostAllowed = requestState.ok
    ? runtimeConfig?.customApiAllowedHosts.includes(requestState.url.hostname.toLowerCase())
    : false;
  const resultOk = result ? !isExecutionError(result) && result.ok : false;
  const resultFailed = result ? isExecutionError(result) || !result.ok : false;
  const activeIntegration = integrations.find((item) => item.name === config.name);

  useEffect(() => {
    let mounted = true;
    fetch('/api/config')
      .then((response) => response.json())
      .then((body) => {
        if (mounted) {
          setRuntimeConfig(body as ConfigSummary);
        }
      })
      .catch(() => {
        if (mounted) {
          setRuntimeConfig(null);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  function applyTemplate(template: IntegrationTemplate) {
    setActiveTemplateId(template.id);
    setConfig(template.config);
    setResult(null);
  }

  async function handleTestCall() {
    if (!requestState.ok) {
      return;
    }

    setRunning(true);
    setResult(null);
    try {
      const nextResult = await testCustomApi(config);
      setResult(nextResult);
      upsertIntegration(nextResult.ok ? 'tested' : 'blocked', nextResult);
    } catch (error) {
      setResult({ error: error instanceof Error ? error.message : t('api.callFailed') });
      upsertIntegration('blocked');
    } finally {
      setRunning(false);
    }
  }

  function handleSave() {
    window.localStorage.setItem(storageKey, JSON.stringify(toStoredConfig(config)));
    const latestResult = result && !isExecutionError(result) ? result : undefined;
    upsertIntegration(resultOk ? 'tested' : resultFailed ? 'blocked' : 'draft', latestResult);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  async function handleCopyCurl() {
    if (!requestState.ok) {
      return;
    }

    await window.navigator.clipboard?.writeText(requestState.curl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function upsertIntegration(status: IntegrationStatus, nextResult?: CustomApiTestResponse) {
    if (!requestState.ok) {
      return;
    }

    const integration: SavedIntegration = {
      id: activeIntegration?.id ?? `api-${Date.now()}`,
      name: config.name.trim() || copy.unnamedIntegration,
      method: config.method,
      url: requestState.request.url,
      host: requestState.url.hostname,
      templateId: activeTemplateId,
      status,
      savedAt: new Date().toISOString(),
      lastStatus: nextResult?.status ?? activeIntegration?.lastStatus,
      lastLatencyMs: nextResult?.durationMs ?? activeIntegration?.lastLatencyMs,
    };
    setIntegrations((current) => {
      const next = [integration, ...current.filter((item) => item.id !== integration.id && item.name !== integration.name)].slice(0, 6);
      window.localStorage.setItem(savedIntegrationsKey, JSON.stringify(next));
      return next;
    });
  }

  return (
    <section className="module-section custom-api-workbench" aria-labelledby="api-title">
      <div className="section-header api-header">
        <div>
          <p>{t('api.eyebrow')}</p>
          <h2 id="api-title">{t('api.title')}</h2>
        </div>
        <div className="section-actions">
          <button type="button" className="tool-button" onClick={handleSave}>
            <Save size={16} />
            {saved ? copy.saved : t('common.save')}
          </button>
          <button type="button" className="tool-button primary" disabled={!requestState.ok || running} onClick={handleTestCall}>
            <Play size={16} />
            {running ? t('api.testing') : t('api.test')}
          </button>
        </div>
      </div>

      <div className="api-status-strip">
        <article>
          <span><Workflow size={16} /> {copy.integrationType}</span>
          <strong>{templateTitle(activeTemplate.id, copy)}</strong>
          <small>{copy.integrationTypeHint}</small>
        </article>
        <article>
          <span><Globe2 size={16} /> {copy.targetHost}</span>
          <strong>{requestState.ok ? requestState.url.hostname : '-'}</strong>
          <small>{hostAllowed ? copy.allowlistReady : copy.checkAllowlist}</small>
        </article>
        <article>
          <span><ShieldCheck size={16} /> {copy.serverProxy}</span>
          <strong>{runtimeConfig ? `${runtimeConfig.customApiTimeoutMs}ms` : copy.loading}</strong>
          <small>{runtimeConfig?.customApiAllowedHosts.join(', ') || copy.noAllowlist}</small>
        </article>
        <article className={resultOk ? 'ok' : resultFailed ? 'failed' : ''}>
          <span>{resultOk ? <CheckCircle2 size={16} /> : resultFailed ? <AlertCircle size={16} /> : <ServerCog size={16} />} {copy.lastTest}</span>
          <strong>{formatResultStatus(result, copy)}</strong>
          <small>{formatResultHint(result, copy)}</small>
        </article>
      </div>

      <div className="api-template-grid" aria-label={copy.templates}>
        {templates.map((template) => {
          const TemplateIcon = template.icon;
          return (
            <button
              key={template.id}
              type="button"
              className={template.id === activeTemplateId ? 'api-template-card active' : 'api-template-card'}
              onClick={() => applyTemplate(template)}
            >
              <TemplateIcon size={18} />
              <strong>{templateTitle(template.id, copy)}</strong>
              <span>{templateDescription(template.id, copy)}</span>
            </button>
          );
        })}
      </div>

      <div className="api-layout api-workbench-layout">
        <form className="api-form api-config-panel" autoComplete="off" onSubmit={(event) => event.preventDefault()}>
          <div className="api-panel-title">
            <strong><KeyRound size={17} /> {copy.requestConfig}</strong>
            <span>{requestState.ok ? requestState.request.method : copy.invalid}</span>
          </div>
          <label className="field-block">
            {t('api.name')}
            <input autoComplete="off" value={config.name} onChange={(event) => setConfig({ ...config, name: event.target.value })} />
          </label>
          <label className="field-block">
            {t('api.method')}
            <select value={config.method} onChange={(event) => setConfig({ ...config, method: event.target.value as ApiMethod })}>
              {methods.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
          </label>
          <label className="field-block api-wide-field">
            URL
            <input autoComplete="off" value={config.url} onChange={(event) => setConfig({ ...config, url: event.target.value })} />
          </label>
          <label className="field-block">
            {copy.bearerToken}
            <input
              type="password"
              autoComplete="new-password"
              placeholder={copy.optionalProxy}
              value={config.authToken}
              onChange={(event) => setConfig({ ...config, authToken: event.target.value })}
            />
          </label>
          <label className="field-block">
            {copy.headers}
            <textarea value={config.headersText} onChange={(event) => setConfig({ ...config, headersText: event.target.value })} />
          </label>
          <label className="field-block api-wide-field">
            {copy.body}
            <textarea value={config.bodyText} onChange={(event) => setConfig({ ...config, bodyText: event.target.value })} />
          </label>
        </form>

        <div className="api-preview api-debug-panel">
          <div className="api-panel-title">
            <strong><ServerCog size={18} /> {copy.integrationPreview}</strong>
            <span>{requestState.ok ? requestState.url.protocol.replace(':', '').toUpperCase() : 'URL'}</span>
          </div>
          {requestState.ok ? (
            <>
              <dl className="request-summary api-request-summary">
                <div>
                  <dt>{copy.method}</dt>
                  <dd>{requestState.request.method}</dd>
                </div>
                <div>
                  <dt>URL</dt>
                  <dd>{requestState.request.url}</dd>
                </div>
                <div>
                  <dt>{copy.headers}</dt>
                  <dd>{Object.keys(requestState.request.headers).length}</dd>
                </div>
                <div>
                  <dt>{copy.allowlist}</dt>
                  <dd>{hostAllowed ? copy.ready : copy.blockedUntilConfigured}</dd>
                </div>
              </dl>
              <div className="api-linkage-panel">
                <strong>{copy.linkageTitle}</strong>
                <ul>
                  {activeTemplate.linkage.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div className="curl-box api-curl-box">
                <button type="button" aria-label={t('api.copyCurl')} title={t('api.copyCurl')} onClick={handleCopyCurl}>
                  <Clipboard size={15} />
                </button>
                <code>{requestState.curl}</code>
              </div>
              {copied && <div className="validation-box">{copy.curlCopied}</div>}
              {result && <ApiResult result={result} copy={copy} />}
            </>
          ) : (
            <div className="error-box">{requestState.error}</div>
          )}
        </div>
      </div>

      <div className="api-integration-list">
        <div className="api-panel-title">
          <strong><DatabaseZap size={18} /> {copy.savedIntegrations}</strong>
          <span>{copy.maxSaved}</span>
        </div>
        {integrations.length > 0 ? integrations.map((integration) => (
          <button key={integration.id} type="button" className="api-integration-row" onClick={() => restoreIntegration(integration, setConfig, setActiveTemplateId, setResult)}>
            <div>
              <strong>{integration.name}</strong>
              <span>{integration.method} / {integration.host}</span>
            </div>
            <div>
              <b>{statusLabel(integration.status, copy)}</b>
              <small>{integration.lastStatus ? `HTTP ${integration.lastStatus} / ${integration.lastLatencyMs ?? '-'}ms` : copy.notTestedYet}</small>
            </div>
          </button>
        )) : (
          <div className="quiet-state">{copy.noIntegrations}</div>
        )}
      </div>
    </section>
  );
}

function ApiResult({ result, copy }: { result: CustomApiTestResponse | { error: string }; copy: ApiCopy }) {
  if (isExecutionError(result)) {
    return (
      <div className="api-result error api-response-panel">
        <strong>{copy.proxyFailed}</strong>
        <pre>{result.error}</pre>
      </div>
    );
  }

  const headerEntries = Object.entries(result.headers).slice(0, 5);
  return (
    <div className={result.ok ? 'api-result api-response-panel' : 'api-result error api-response-panel'}>
      <strong>HTTP {result.status} / {result.durationMs}ms</strong>
      {headerEntries.length > 0 && (
        <dl className="api-response-headers">
          {headerEntries.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <pre>{result.bodyText.slice(0, 1200) || copy.emptyResponse}</pre>
    </div>
  );
}

function buildTemplates(copy: ApiCopy): IntegrationTemplate[] {
  return [
    {
      id: 'assetSync',
      icon: CloudCog,
      config: {
        name: copy.assetSyncName,
        method: 'GET',
        url: 'https://httpbin.org/get?provider=all',
        headersText: 'Accept: application/json\nX-Source: CoLiPas\nX-Integration: asset-sync',
        bodyText: '',
        authToken: '',
      },
      linkage: [copy.linkAssetInventory, copy.linkOverviewMap, copy.linkSecurityAudit],
    },
    {
      id: 'alertWebhook',
      icon: BellRing,
      config: {
        name: copy.alertWebhookName,
        method: 'POST',
        url: 'https://httpbin.org/post',
        headersText: 'Content-Type: application/json\nX-Source: CoLiPas\nX-Integration: alert-webhook',
        bodyText: JSON.stringify({ event: 'cpu_warning', severity: 'warning', server: 'prod-api-01' }, null, 2),
        authToken: '',
      },
      linkage: [copy.linkEventQueue, copy.linkOpsTask, copy.linkSecurityAudit],
    },
    {
      id: 'billingUsage',
      icon: ReceiptText,
      config: {
        name: copy.billingUsageName,
        method: 'GET',
        url: 'https://httpbin.org/get?scope=billing&range=30d',
        headersText: 'Accept: application/json\nX-Source: CoLiPas\nX-Integration: billing-usage',
        bodyText: '',
        authToken: '',
      },
      linkage: [copy.linkProviderCost, copy.linkCapacityPlan, copy.linkSecurityAudit],
    },
  ];
}

function restoreIntegration(
  integration: SavedIntegration,
  setConfig: (config: CustomApiConfig) => void,
  setActiveTemplateId: (id: IntegrationTemplateId) => void,
  setResult: (result: CustomApiTestResponse | { error: string } | null) => void,
) {
  setActiveTemplateId(integration.templateId);
  setConfig({
    name: integration.name,
    method: integration.method,
    url: integration.url,
    headersText: 'Accept: application/json\nX-Source: CoLiPas',
    bodyText: '',
    authToken: '',
  });
  setResult(null);
}

function loadStoredConfig() {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return stored ? { ...initialConfig, ...JSON.parse(stored), authToken: '' } as CustomApiConfig : initialConfig;
  } catch {
    return initialConfig;
  }
}

function loadSavedIntegrations(): SavedIntegration[] {
  try {
    const stored = window.localStorage.getItem(savedIntegrationsKey);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 6) as SavedIntegration[] : [];
  } catch {
    return [];
  }
}

function toStoredConfig(config: CustomApiConfig): CustomApiConfig {
  return {
    ...config,
    authToken: '',
  };
}

function isExecutionError(result: CustomApiTestResponse | { error: string }): result is { error: string } {
  return 'error' in result;
}

function formatResultStatus(result: CustomApiTestResponse | { error: string } | null, copy: ApiCopy) {
  if (!result) {
    return copy.notRun;
  }

  if (isExecutionError(result)) {
    return copy.blocked;
  }

  return `HTTP ${result.status}`;
}

function formatResultHint(result: CustomApiTestResponse | { error: string } | null, copy: ApiCopy) {
  if (!result) {
    return copy.runProxyTest;
  }

  if (isExecutionError(result)) {
    return result.error;
  }

  return `${result.durationMs}ms / ${result.ok ? copy.success : copy.non2xx}`;
}

function templateTitle(id: IntegrationTemplateId, copy: ApiCopy) {
  return {
    assetSync: copy.assetSyncTitle,
    alertWebhook: copy.alertWebhookTitle,
    billingUsage: copy.billingUsageTitle,
  }[id];
}

function templateDescription(id: IntegrationTemplateId, copy: ApiCopy) {
  return {
    assetSync: copy.assetSyncDesc,
    alertWebhook: copy.alertWebhookDesc,
    billingUsage: copy.billingUsageDesc,
  }[id];
}

function statusLabel(status: IntegrationStatus, copy: ApiCopy) {
  return {
    draft: copy.statusDraft,
    tested: copy.statusTested,
    blocked: copy.statusBlocked,
  }[status];
}

interface ApiCopy {
  saved: string;
  integrationType: string;
  integrationTypeHint: string;
  targetHost: string;
  allowlistReady: string;
  checkAllowlist: string;
  serverProxy: string;
  loading: string;
  noAllowlist: string;
  lastTest: string;
  requestConfig: string;
  invalid: string;
  bearerToken: string;
  optionalProxy: string;
  headers: string;
  body: string;
  method: string;
  allowlist: string;
  ready: string;
  blockedUntilConfigured: string;
  curlCopied: string;
  proxyFailed: string;
  emptyResponse: string;
  notRun: string;
  blocked: string;
  runProxyTest: string;
  success: string;
  non2xx: string;
  templates: string;
  integrationPreview: string;
  linkageTitle: string;
  savedIntegrations: string;
  maxSaved: string;
  noIntegrations: string;
  unnamedIntegration: string;
  notTestedYet: string;
  statusDraft: string;
  statusTested: string;
  statusBlocked: string;
  assetSyncTitle: string;
  alertWebhookTitle: string;
  billingUsageTitle: string;
  assetSyncDesc: string;
  alertWebhookDesc: string;
  billingUsageDesc: string;
  assetSyncName: string;
  alertWebhookName: string;
  billingUsageName: string;
  linkAssetInventory: string;
  linkOverviewMap: string;
  linkSecurityAudit: string;
  linkEventQueue: string;
  linkOpsTask: string;
  linkProviderCost: string;
  linkCapacityPlan: string;
}

const apiCopyByLanguage: Record<string, ApiCopy> = {
  zh: {
    saved: '已保存',
    integrationType: '集成类型',
    integrationTypeHint: '选择模板后自动带出运维用途',
    targetHost: '目标域名',
    allowlistReady: '白名单已放行',
    checkAllowlist: '调用前请检查白名单',
    serverProxy: '服务端代理',
    loading: '加载中',
    noAllowlist: '未加载白名单',
    lastTest: '最近测试',
    requestConfig: '请求配置',
    invalid: '无效',
    bearerToken: 'Bearer Token',
    optionalProxy: '可选，由服务端代理转发',
    headers: '请求头',
    body: '请求体',
    method: '方法',
    allowlist: '白名单',
    ready: '已就绪',
    blockedUntilConfigured: '配置后可调用',
    curlCopied: 'cURL 已复制',
    proxyFailed: '代理阻断或上游失败',
    emptyResponse: '空响应',
    notRun: '未测试',
    blocked: '已阻断',
    runProxyTest: '执行一次后端代理测试',
    success: '成功',
    non2xx: '非 2xx 响应',
    templates: '集成模板',
    integrationPreview: '联动预览',
    linkageTitle: '测试通过后可联动',
    savedIntegrations: '已保存集成',
    maxSaved: '最多显示 6 个',
    noIntegrations: '暂无保存的集成，选择模板并保存后会显示在这里。',
    unnamedIntegration: '未命名集成',
    notTestedYet: '未执行测试',
    statusDraft: '草稿',
    statusTested: '可用',
    statusBlocked: '阻断',
    assetSyncTitle: '资产同步',
    alertWebhookTitle: '告警推送',
    billingUsageTitle: '账单用量',
    assetSyncDesc: '从第三方 API 拉取服务器或云资源清单。',
    alertWebhookDesc: '把告警事件推送到工单、IM 或自建平台。',
    billingUsageDesc: '查询云厂商账单、流量和容量使用情况。',
    assetSyncName: '资产同步接口',
    alertWebhookName: '告警推送 Webhook',
    billingUsageName: '账单用量查询',
    linkAssetInventory: '服务器清单：映射实例 ID、公网 IP、地域、标签。',
    linkOverviewMap: '总览地图：按返回地域刷新节点分布。',
    linkSecurityAudit: '安全审计：记录测试、阻断、失败和敏感参数脱敏。',
    linkEventQueue: '事件队列：把外部告警转换为待处理事件。',
    linkOpsTask: '运维编排：告警命中后可触发健康检查或 SSH 命令。',
    linkProviderCost: '云厂商视图：补充成本、流量、配额和余额数据。',
    linkCapacityPlan: '容量分析：给 AI 和总览提供用量趋势上下文。',
  },
  en: {
    saved: 'Saved',
    integrationType: 'Integration type',
    integrationTypeHint: 'Templates carry the operations purpose',
    targetHost: 'Target host',
    allowlistReady: 'Allowlist ready',
    checkAllowlist: 'Check allowlist before calling',
    serverProxy: 'Server proxy',
    loading: 'Loading',
    noAllowlist: 'No allowlist loaded',
    lastTest: 'Last test',
    requestConfig: 'Request config',
    invalid: 'Invalid',
    bearerToken: 'Bearer token',
    optionalProxy: 'optional, proxied by server',
    headers: 'Headers',
    body: 'Body',
    method: 'Method',
    allowlist: 'Allowlist',
    ready: 'Ready',
    blockedUntilConfigured: 'Blocked until configured',
    curlCopied: 'cURL copied',
    proxyFailed: 'Proxy blocked or upstream failed',
    emptyResponse: 'Empty response',
    notRun: 'Not run',
    blocked: 'Blocked',
    runProxyTest: 'Run a backend proxy test',
    success: 'success',
    non2xx: 'non-2xx response',
    templates: 'Integration templates',
    integrationPreview: 'Linkage preview',
    linkageTitle: 'Available linkage after a passing test',
    savedIntegrations: 'Saved integrations',
    maxSaved: 'Latest 6',
    noIntegrations: 'No saved integrations yet. Pick a template and save it.',
    unnamedIntegration: 'Unnamed integration',
    notTestedYet: 'Not tested',
    statusDraft: 'Draft',
    statusTested: 'Ready',
    statusBlocked: 'Blocked',
    assetSyncTitle: 'Asset sync',
    alertWebhookTitle: 'Alert webhook',
    billingUsageTitle: 'Billing usage',
    assetSyncDesc: 'Pull server or cloud-resource inventory from an external API.',
    alertWebhookDesc: 'Forward incidents to tickets, chatops, or an internal platform.',
    billingUsageDesc: 'Query cloud billing, traffic, and capacity usage.',
    assetSyncName: 'Asset sync API',
    alertWebhookName: 'Alert webhook',
    billingUsageName: 'Billing usage query',
    linkAssetInventory: 'Server inventory: map instance IDs, public IPs, regions, and tags.',
    linkOverviewMap: 'Overview map: refresh node distribution from returned regions.',
    linkSecurityAudit: 'Security audit: record tests, blocks, failures, and redacted secrets.',
    linkEventQueue: 'Event queue: convert external alerts into open events.',
    linkOpsTask: 'Operations: trigger health checks or SSH commands after alert matches.',
    linkProviderCost: 'Provider view: enrich costs, traffic, quotas, and balance.',
    linkCapacityPlan: 'Capacity analysis: provide usage trends to AI and overview context.',
  },
  ja: {
    saved: '保存済み',
    integrationType: '連携タイプ',
    integrationTypeHint: 'テンプレートに運用目的を含めます',
    targetHost: '対象ホスト',
    allowlistReady: '許可リスト済み',
    checkAllowlist: '呼び出し前に許可リストを確認',
    serverProxy: 'サーバープロキシ',
    loading: '読み込み中',
    noAllowlist: '許可リスト未読込',
    lastTest: '直近テスト',
    requestConfig: 'リクエスト設定',
    invalid: '無効',
    bearerToken: 'Bearer Token',
    optionalProxy: '任意、サーバー側で転送',
    headers: 'ヘッダー',
    body: 'Body',
    method: 'メソッド',
    allowlist: '許可リスト',
    ready: '準備完了',
    blockedUntilConfigured: '設定後に呼び出し可能',
    curlCopied: 'cURL をコピーしました',
    proxyFailed: 'プロキシでブロックまたは上流失敗',
    emptyResponse: '空の応答',
    notRun: '未実行',
    blocked: 'ブロック',
    runProxyTest: 'バックエンドプロキシテストを実行',
    success: '成功',
    non2xx: '2xx 以外の応答',
    templates: '連携テンプレート',
    integrationPreview: '連動プレビュー',
    linkageTitle: 'テスト成功後に連動可能',
    savedIntegrations: '保存済み連携',
    maxSaved: '最大 6 件',
    noIntegrations: '保存済み連携はありません。テンプレートを選んで保存してください。',
    unnamedIntegration: '無名連携',
    notTestedYet: '未テスト',
    statusDraft: '下書き',
    statusTested: '利用可能',
    statusBlocked: 'ブロック',
    assetSyncTitle: '資産同期',
    alertWebhookTitle: 'アラート送信',
    billingUsageTitle: '請求と使用量',
    assetSyncDesc: '外部 API からサーバーやクラウド資産を取得します。',
    alertWebhookDesc: 'インシデントをチケット、ChatOps、社内基盤へ転送します。',
    billingUsageDesc: 'クラウド請求、トラフィック、容量使用量を照会します。',
    assetSyncName: '資産同期 API',
    alertWebhookName: 'アラート Webhook',
    billingUsageName: '請求使用量クエリ',
    linkAssetInventory: 'サーバー一覧: インスタンス ID、公開 IP、リージョン、タグを対応付けます。',
    linkOverviewMap: '概要マップ: 返却リージョンでノード分布を更新します。',
    linkSecurityAudit: 'セキュリティ監査: テスト、ブロック、失敗、秘匿値を記録します。',
    linkEventQueue: 'イベントキュー: 外部アラートを対応待ちイベントへ変換します。',
    linkOpsTask: '運用編成: アラート条件からヘルスチェックや SSH コマンドを起動します。',
    linkProviderCost: 'クラウド表示: コスト、通信量、クォータ、残高を補完します。',
    linkCapacityPlan: '容量分析: AI と概要に使用量トレンドを提供します。',
  },
};
