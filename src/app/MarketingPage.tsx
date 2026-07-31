import { FormEvent, useState } from 'react';
import {
  Activity,
  BookmarkCheck,
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  CloudCog,
  Command,
  Eye,
  EyeOff,
  FileUp,
  Github,
  Globe2,
  Inbox,
  KeyRound,
  Layers3,
  ListChecks,
  LockKeyhole,
  MapPinned,
  MonitorSmartphone,
  Network,
  PlayCircle,
  PlugZap,
  RefreshCw,
  ScrollText,
  Server,
  ShieldCheck,
  TerminalSquare,
  UserRoundCog,
  Workflow,
} from 'lucide-react';
import { languageOptions, useI18n } from '../i18n';
import { BrandIcon } from './BrandIcon';

interface MarketingPageProps {
  loading: boolean;
  error: string;
  onLogin: (username: string, password: string) => Promise<void>;
}

const featureCards = [
  {
    icon: CloudCog,
    title: '服务器资产接入',
    desc: '统一登记自建、海外、私有云和自定义云资源，保留云厂商、地域、系统和标签信息。',
    tags: ['自定义云', '资源同步'],
  },
  {
    icon: MapPinned,
    title: '全球小地图监控',
    desc: '按服务器地域聚合展示，支持悬停详情、缩放、地区跳转和移动端适配。',
    tags: ['地域识别', '可交互'],
  },
  {
    icon: ListChecks,
    title: '上下文上线检查',
    desc: '总览保留完整上线清单；进入服务器、AI、运维、API 和安全工作区后自动压缩为摘要，需要证据时再一键展开。',
    tags: ['渐进披露', '性能模式联动'],
  },
  {
    icon: TerminalSquare,
    title: '实时 SSH 面板',
    desc: '密码或私钥验证后接入，终端实时输出，支持中断命令、诊断和远程开关机。',
    tags: ['PTY 流式', '命令审计'],
  },
  {
    icon: BrainCircuit,
    title: '内嵌 AI 运维助手',
    desc: '支持自定义 OpenAI 兼容 API、自动拉取模型、流式回答、缓存读取和强制重新生成。',
    tags: ['stream:true', '上下文窗口'],
  },
  {
    icon: Workflow,
    title: '运维编排',
    desc: '对已接入 SSH 的服务器执行健康检查、脚本命令、重启、关机、开机等任务；维护窗口支持快捷时长，并通过预检明确高影响变更范围。',
    tags: ['快捷维护窗口', '二次确认'],
  },
  {
    icon: ShieldCheck,
    title: '安全审计闭环',
    desc: '登录、AI、API、服务器动作、编排任务全部进入审计队列，可定位风险并执行修复动作。',
    tags: ['事件关联', '风险修复'],
  },
  {
    icon: PlugZap,
    title: '自定义 API 接入',
    desc: '支持白名单代理、请求预览、响应查看和 SSRF 防护，方便对接已有资产系统。',
    tags: ['Allowlist', '响应测试'],
  },
  {
    icon: KeyRound,
    title: '密钥与密码接入',
    desc: '服务器可选择仅登记资产、模拟验证或真实 SSH 验证，不把敏感凭据写入浏览器缓存。',
    tags: ['密码', '私钥'],
  },
  {
    icon: Globe2,
    title: '多语言控制台',
    desc: '中文、英文、日文三种语言切换，适合跨地区团队在同一个面板里协作。',
    tags: ['中文', 'English', '日本語'],
  },
];

const fleetViewFeature = {
  icon: BookmarkCheck,
  title: '资产视图',
  desc: '把地域、厂商、状态和健康筛选保存为浏览器本地视图，排障时一键恢复常用工作范围。',
  tags: ['本机保存', '一键恢复'],
};

const bulkImportFeature = {
  icon: FileUp,
  title: '安全批量资产导入',
  desc: '支持 CSV、JSON、文件选择和粘贴预览，可下载带表格公式注入防护的本地校验报告；单次最多登记 500 台无凭据资产。',
  tags: ['批量迁移', '本地校验报告'],
  featureId: 'server-bulk-import',
};

const commandPaletteFeature = {
  icon: Command,
  title: '上下文命令面板',
  desc: '以当前最高优先级事项、最近使用和全部操作分层展示跨模块入口，减少重复搜索与页面跳转；最近操作只保存无敏感信息的操作 ID。',
  tags: ['当前优先级', '本机历史'],
};

const operationsInboxFeature = {
  icon: Inbox,
  title: '全局运维收件箱',
  desc: '把上线阻塞、SSH 覆盖缺口和开放事件汇总到同一个值班入口，按优先级跳转对应模块；审阅状态只保存安全的本机事项 ID 与时间。',
  tags: ['跨模块聚合', '本机审阅'],
};

const accountSessionFeature = {
  icon: MonitorSmartphone,
  title: '登录会话控制',
  desc: '只把令牌哈希和脱敏设备信息写入 SQLite，不保存原始 Cookie、IP 或 User-Agent；服务重启后会话仍保持且可撤销，并支持容量边界和最旧会话自动退出。页面仅在前台且在线时同步，隐藏或离线自动暂停。',
  tags: ['前台在线同步', '隐藏即暂停'],
  featureId: 'account-session-control',
};

const operatorControlsFeature = {
  icon: UserRoundCog,
  title: '自适应操作员控制',
  desc: '桌面和手机端把刷新、语言、账户与退出集中到同一个溢出面板，顶栏始终保留登录名称、同步状态和核心运维入口。',
  tags: ['单行顶栏', '键盘可关闭'],
  featureId: 'operator-controls',
};

const adaptiveRefreshFeature = {
  icon: RefreshCw,
  title: '智能刷新调度',
  desc: '根据标签页可见性、网络状态、性能模式和请求失败次数自动暂停、恢复或退避总览同步，减少后台请求与无效渲染。',
  tags: ['隐藏即暂停', '失败退避'],
  featureId: 'adaptive-refresh',
};

const securityItems = ['登录会话保护', 'SSH 命令边界', 'AI Base URL 校验', '自定义 API 白名单', '敏感信息脱敏'];

export function MarketingPage({ loading, error, onLogin }: MarketingPageProps) {
  const { language, setLanguage, t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onLogin(username.trim(), password);
  }

  function scrollToLogin() {
    document.getElementById('admin-login')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return (
    <main className="marketing-page">
      <header className="marketing-nav">
        <a className="marketing-brand" href="#top" aria-label="CoLiPas云服务器管理面板">
          <BrandIcon className="marketing-brand-mark" />
          <strong>CoLiPas云服务器管理面板</strong>
        </a>
        <nav aria-label="推广页导航">
          <a href="#product">产品</a>
          <a href="#features">功能</a>
          <a href="#security">安全</a>
          <a href="#deploy">部署</a>
          <a href="/docs.html">文档</a>
        </nav>
        <div className="marketing-actions">
          <label className="marketing-language">
            <Globe2 size={14} />
            <select value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}>
              {languageOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="marketing-link-button" onClick={scrollToLogin}>
            管理后台
          </button>
          <a className="marketing-secondary compact" href="https://github.com/nmklio/CoLiPas" target="_blank" rel="noreferrer">
            <Github size={16} />
            GitHub
          </a>
          <button type="button" className="marketing-primary small" onClick={scrollToLogin}>
            进入后台
          </button>
        </div>
      </header>

      <section id="top" className="marketing-hero">
        <div className="marketing-hero-copy">
          <p className="marketing-badge"><span /> CoLiPas云服务器管理面板 · AI 运维 · SSH 实时终端</p>
          <h1>
            CoLiPas云服务器管理面板
            <span>接入、监控、修复一体化</span>
          </h1>
          <p className="marketing-lead">
            面向自建服务器、海外节点、私有云和混合云环境。CoLiPas 把资产接入、地域地图、SSH 终端、AI 分析、运维编排和安全审计放在同一个后台里，减少来回切换工具的成本。
          </p>
          <div className="marketing-hero-buttons">
            <button type="button" className="marketing-primary" onClick={scrollToLogin}>
              <PlayCircle size={18} />
              进入管理后台
            </button>
            <a className="marketing-secondary" href="#features">
              查看功能
              <ChevronRight size={18} />
            </a>
          </div>
          <div className="marketing-stats" aria-label="产品指标">
            <div>
              <strong>3</strong>
              <span>语言切换</span>
            </div>
            <div>
              <strong>10min</strong>
              <span>AI 缓存窗口</span>
            </div>
            <div>
              <strong>8080</strong>
              <span>生产后台端口</span>
            </div>
          </div>
        </div>

        <div className="marketing-preview" aria-label="CoLiPas云服务器管理面板控制台预览">
          <div className="preview-window">
            <div className="preview-toolbar">
              <span />
              <span />
              <span />
              <small>colipas.local/admin/overview</small>
            </div>
            <img src="/colipas-dashboard-preview.png" alt="CoLiPas云服务器管理面板预览" />
          </div>
        </div>
      </section>

      <section id="product" className="marketing-section product-position">
        <div>
          <p className="section-kicker">产品定位</p>
          <h2>不是单纯看板，而是可接入、可执行、可审计的运维后台</h2>
        </div>
        <p>
          面板围绕服务器生命周期设计：先接入资产和地域，再验证 SSH，随后用 AI 和编排任务处理风险。所有远程命令、AI 分析、自定义 API 调用都会留下审计记录，方便上线前排查和后续复盘。
        </p>
      </section>

      <section id="features" className="marketing-section">
        <div className="section-heading">
          <p className="section-kicker">功能模块</p>
          <h2>围绕“服务器接入到修复”构建的完整后台</h2>
        </div>
        <div className="marketing-feature-grid">
          {[...featureCards, fleetViewFeature, bulkImportFeature, commandPaletteFeature, operationsInboxFeature, accountSessionFeature, operatorControlsFeature, adaptiveRefreshFeature].map((feature) => {
            const Icon = feature.icon;
            const featureId = 'featureId' in feature && typeof feature.featureId === 'string'
              ? feature.featureId
              : undefined;
            return (
              <article
                key={feature.title}
                className="marketing-feature-card"
                data-colipas-feature={featureId}
              >
                <span className="feature-icon"><Icon size={22} /></span>
                <h3>{feature.title}</h3>
                <p>{feature.desc}</p>
                <div>
                  {feature.tags.map((tag) => <span key={tag}>{tag}</span>)}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section id="security" className="marketing-band">
        <div className="marketing-security-copy">
          <p className="section-kicker">安全机制</p>
          <h2>从登录到命令执行，全链路留痕</h2>
          <p>
            CoLiPas云服务器管理面板默认保护管理后台和 API，远程动作要求明确目标和必要确认。AI 与自定义 API 都做输入边界校验，敏感内容不会进入前端持久化缓存。
          </p>
          <ul>
            <li><CheckCircle2 size={16} /> 会话登录与退出审计</li>
            <li><CheckCircle2 size={16} /> SSH 命令摘要脱敏</li>
            <li><CheckCircle2 size={16} /> 高风险动作二次确认</li>
            <li><CheckCircle2 size={16} /> 自定义 API SSRF 防护</li>
          </ul>
        </div>
        <div className="security-stack" aria-label="安全检查项">
          {securityItems.map((item, index) => (
            <div key={item} className={`security-strip tone-${index}`}>
              <span>{item}</span>
            </div>
          ))}
        </div>
      </section>

      <section id="deploy" className="marketing-section deploy-section">
        <div className="section-heading">
          <p className="section-kicker">部署落地</p>
          <h2>下载、配置、运行，Linux / Docker / 本机都能落地</h2>
        </div>
        <div className="deploy-flow" aria-label="部署步骤">
          <article>
            <b>1</b>
            <div>
              <h3>获取项目</h3>
              <p>从 GitHub 下载源码，安装依赖并执行生产构建。</p>
              <a className="deploy-inline-link" href="https://github.com/nmklio/CoLiPas" target="_blank" rel="noreferrer">
                <Github size={15} />
                打开 GitHub 仓库
              </a>
            </div>
          </article>
          <article>
            <b>2</b>
            <div>
              <h3>配置 .env</h3>
              <p>设置管理员、会话密钥、AI API、CORS、数据库和自定义 API 白名单。</p>
            </div>
          </article>
          <article>
            <b>3</b>
            <div>
              <h3>启动服务</h3>
              <p>后台监听 8080，前端页面和 API 由同一个生产服务提供。</p>
            </div>
          </article>
        </div>
        <div className="deploy-platform-grid">
          <article className="deploy-platform-card featured">
            <span className="platform-label">Linux 推荐</span>
            <TerminalSquare size={22} />
            <h3>Linux systemd</h3>
            <p>适合云服务器长期运行，内置重启策略，配合 Nginx 反向代理。</p>
            <code>sudo systemctl enable --now colipas</code>
          </article>
          <article className="deploy-platform-card">
            <span className="platform-label">源码运行</span>
            <Layers3 size={22} />
            <h3>Node 20+</h3>
            <p>本机或服务器直接构建运行，适合二次开发和私有化部署。</p>
            <code>npm ci && npm test && PORT=8080 npm start</code>
          </article>
          <article className="deploy-platform-card">
            <span className="platform-label">容器部署</span>
            <Network size={22} />
            <h3>Docker Compose</h3>
            <p>容器内运行生产服务，保留 .data 挂载即可持久化数据库和资产。</p>
            <code>docker compose up --build -d</code>
          </article>
          <article className="deploy-platform-card">
            <span className="platform-label">生产端口</span>
            <Activity size={22} />
            <h3>统一入口 8080</h3>
            <p>登录、前端资源、API、AI、SSH、审计都走同一个服务入口。</p>
            <code>http://127.0.0.1:8080</code>
          </article>
          <article className="deploy-platform-card">
            <span className="platform-label">数据持久化</span>
            <Server size={22} />
            <h3>SQLite / .data</h3>
            <p>默认 SQLite 免维护落地，后续可按业务规模扩展外部数据库。</p>
            <code>COLIPAS_DATA_DIR=.data</code>
          </article>
          <article className="deploy-platform-card">
            <span className="platform-label">文档</span>
            <ScrollText size={22} />
            <h3>README + deploy</h3>
            <p>仓库提供 Nginx、systemd 和环境变量示例，便于团队下载后部署。</p>
            <code>deploy/colipas.service</code>
          </article>
        </div>
      </section>

      <section id="admin-login" className="marketing-login-band">
        <div className="login-intro">
          <p className="section-kicker">管理入口</p>
          <h2>进入 CoLiPas云服务器管理面板后台</h2>
          <p>使用部署时配置的管理员账号登录后，可以查看服务器总览、小地图、AI 助手、SSH、运维编排、自定义 API 和安全审计。</p>
          <div className="demo-account">
            <Server size={18} />
            <span>安全登录</span>
            <strong>使用你部署时配置的管理员账号</strong>
          </div>
        </div>

        <form className="marketing-login-card" onSubmit={handleSubmit}>
          <div className="login-card-title">
            <LockKeyhole size={20} />
            <div>
              <span>{t('login.secureAccess')}</span>
              <h3>{t('login.formTitle')}</h3>
            </div>
          </div>
          <label className="login-field">
            <span>{t('login.username')}</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder={t('login.usernamePlaceholder')}
              required
            />
          </label>
          <label className="login-field">
            <span>{t('login.password')}</span>
            <div className="password-input">
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder={t('login.passwordPlaceholder')}
                required
              />
              <button
                type="button"
                className="icon-button"
                aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>
          {error && <div className="login-error" role="alert">{error}</div>}
          <button type="submit" className="login-submit" disabled={loading}>
            <LockKeyhole size={17} />
            {loading ? t('login.signingIn') : t('login.submit')}
          </button>
        </form>
      </section>

      <footer className="marketing-footer">
        <div className="footer-brand">
          <strong>CoLiPas云服务器管理面板</strong>
          <span>云服务器管理与 AI 运维后台</span>
          <p>面向自建机房、海外云、私有云和多云混合环境，统一资产、SSH、AI、编排和审计。</p>
        </div>
        <nav aria-label="产品">
          <strong>产品</strong>
          <a href="#features">功能模块</a>
          <a href="#security">安全审计</a>
          <a href="#product">产品定位</a>
        </nav>
        <nav aria-label="部署">
          <strong>部署</strong>
          <a href="#deploy">Linux systemd</a>
          <a href="#deploy">Docker Compose</a>
          <a href="#deploy">Nginx 反代</a>
        </nav>
        <nav aria-label="管理后台">
          <strong>管理后台</strong>
          <a href="#admin-login">后台登录</a>
          <a href="#top">控制台预览</a>
          <a href="#deploy">端口 8080</a>
        </nav>
        <nav aria-label="更多">
          <strong>更多</strong>
          <a href="/docs.html">安装文档</a>
          <a href="#security">API 防护</a>
          <a href="#features">AI 接入</a>
        </nav>
        <div className="footer-bottom">
          <span>CoLiPas云服务器管理面板 © 2026</span>
          <span>Production port 8080 · SQLite ready · Stream AI</span>
        </div>
      </footer>
    </main>
  );
}
