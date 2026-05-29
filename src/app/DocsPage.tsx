import {
  ArrowRight,
  Bot,
  CheckCircle2,
  CloudCog,
  Code2,
  Database,
  FileText,
  Globe2,
  KeyRound,
  Layers3,
  LifeBuoy,
  LockKeyhole,
  MapPinned,
  PlayCircle,
  Server,
  ShieldCheck,
  TerminalSquare,
  Workflow,
} from 'lucide-react';
import { languageOptions, useI18n } from '../i18n';
import { BrandIcon } from './BrandIcon';

interface DocsPageProps {
  onLogin: () => void;
}

const quickNav = [
  { href: '#install', label: '安装部署' },
  { href: '#server-access', label: '接入服务器' },
  { href: '#ai', label: 'AI 设置' },
  { href: '#ssh', label: 'SSH 终端' },
  { href: '#security', label: '安全审计' },
  { href: '#faq', label: '常见问题' },
];

const installSteps = [
  {
    title: '获取项目',
    body: '从 GitHub 克隆 CoLiPas云服务器管理面板，安装依赖，并准备生产环境变量。',
    command: 'git clone https://github.com/nmklio/CoLiPas.git && cd CoLiPas && npm ci',
  },
  {
    title: '配置环境变量',
    body: '复制 .env.example，设置管理员密码、会话密钥、AI API、自定义 API 白名单和凭据加密密钥。',
    command: 'cp .env.example .env',
  },
  {
    title: '构建并验证',
    body: '运行完整生产烟测，确认登录、AI、SSH、地图、数据库和安全审计都能联动。',
    command: 'npm test',
  },
  {
    title: '启动生产服务',
    body: '生产服务只需要一个端口，前端资源和 /api/* 都由同一个 Node 服务提供。',
    command: 'PORT=8080 npm start',
  },
];

const configRows = [
  ['PORT', '生产 HTTP 端口，推荐保持 8080。'],
  ['ADMIN_USERNAME / ADMIN_PASSWORD', '初始管理员账号，首次部署后立即修改密码。'],
  ['SESSION_SECRET', '会话签名密钥，必须使用长随机字符串。'],
  ['AI_BASE_URL / AI_API_KEY / AI_MODEL', 'OpenAI 兼容 API 地址、密钥和默认模型。'],
  ['CUSTOM_API_ALLOWED_HOSTS', '自定义 API 代理允许访问的域名白名单。'],
  ['COLIPAS_DATA_DIR / COLIPAS_DB_PATH', 'SQLite 数据库和运行数据存储位置。'],
  ['CREDENTIAL_ENCRYPTION_KEY', 'SSH 密码和私钥加密密钥。'],
];

const usageBlocks = [
  {
    icon: Server,
    title: '1. 接入服务器',
    body: '进入服务器模块，填写名称、IP、云厂商、地域、操作系统和标签。若选择真实 SSH 验证，后台会先握手成功再标记为运行。',
    points: ['乱填 IP 不会通过真实 SSH 验证', '未接入资产显示为未接入', '关机后显示已停止'],
  },
  {
    icon: MapPinned,
    title: '2. 查看小地图',
    body: '总览会按地域聚合服务器。鼠标悬停显示地区、节点数量和状态，点击地区可以跳到服务器列表筛选。',
    points: ['支持美国、新加坡、日本等常见地区识别', '支持缩放和平移', '移动端自动收敛 tooltip'],
  },
  {
    icon: TerminalSquare,
    title: '3. 打开 SSH 终端',
    body: '已验证 SSH 的服务器可以打开类 VNC 的弹窗终端。命令实时输出，输入框不会因为命令执行中而锁死。',
    points: ['支持 Ctrl+C 中断', '支持实时 PTY 输出', '命令摘要会脱敏进入审计'],
  },
  {
    icon: Bot,
    title: '4. 使用 AI 运维助手',
    body: '填写 OpenAI 兼容 API 地址和密钥，加载模型后先点连通性测试，再开始流式对话。',
    points: ['后端使用 stream:true', '支持上下文和缓存读取', '可强制重新生成'],
  },
  {
    icon: Workflow,
    title: '5. 执行云维编排',
    body: '对单台或选中的已接入服务器执行健康检查、脚本命令、重启、关机等任务。',
    points: ['SSH 类任务会过滤未接入目标', '高风险动作需要二次确认', '结果回写事件队列'],
  },
  {
    icon: ShieldCheck,
    title: '6. 处理安全审计',
    body: '安全模块会把登录、AI、API、SSH、服务器动作和编排任务关联到风险卡片，可直接执行修复或确认。',
    points: ['查看 blocked/failed 事件', '按风险进入对应模块', '修复动作也会留下审计'],
  },
];

const apiRows = [
  ['GET /api/health', '服务健康状态、SQLite 驱动和运行时间。'],
  ['POST /api/auth/login', '管理员登录并写入会话 cookie。'],
  ['GET /api/overview', '云账号、服务器、事件和总览指标。'],
  ['POST /api/servers', '新增资产或执行真实 SSH 验证接入。'],
  ['POST /api/servers/shells', '创建实时 SSH shell 会话。'],
  ['POST /api/ai/test', '测试 AI 供应商是否支持流式调用。'],
  ['POST /api/ai/stream', '流式 AI 对话接口。'],
  ['POST /api/custom-apis/test', '通过白名单代理测试自定义 API。'],
  ['POST /api/audit/remediate', '执行安全审计修复动作。'],
];

const faqItems = [
  ['后台地址在哪里？', '生产环境统一访问 http://127.0.0.1:8080/，反代后访问你自己的域名。不要把 Vite 5173 当生产入口。'],
  ['为什么服务器乱填也不能接入？', '真实接入必须通过 SSH 握手。库存模式只登记资产，不会显示为已接入。'],
  ['AI 回答是不是固定的？', '未配置有效 API key 时会走本地模拟；配置 OpenAI 兼容 API 并通过测试后，会使用真实流式模型。'],
  ['数据存在哪里？', '默认保存在 .data/colipas.sqlite，SSH 凭据加密后存储。部署时要备份 .data，并保护 .env。'],
  ['可以直接暴露公网吗？', '可以，但必须先改管理员密码、SESSION_SECRET、CREDENTIAL_ENCRYPTION_KEY、CORS_ORIGIN，并启用 HTTPS 和防火墙。'],
];

export function DocsPage({ onLogin }: DocsPageProps) {
  const { language, setLanguage } = useI18n();

  return (
    <main className="docs-page">
      <header className="marketing-nav docs-nav">
        <a className="marketing-brand" href="/" aria-label="CoLiPas云服务器管理面板">
          <BrandIcon className="marketing-brand-mark" />
          <strong>CoLiPas云服务器管理面板</strong>
        </a>
        <nav aria-label="文档导航">
          <a href="/">产品</a>
          <a href="/#features">功能</a>
          <a href="/#security">安全</a>
          <a href="/#deploy">部署</a>
          <a className="active" href="/docs.html">文档</a>
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
          <button type="button" className="marketing-link-button" onClick={onLogin}>
            演示后台
          </button>
          <button type="button" className="marketing-primary small" onClick={onLogin}>
            立即体验
          </button>
        </div>
      </header>

      <section className="docs-hero">
        <div>
          <p className="section-kicker">使用文档</p>
          <h1>下载、配置、运行，Linux / Docker / 本地完整落地</h1>
          <p>
            这份文档按上线使用顺序整理：先部署服务，再接入服务器，最后配置 AI、SSH、编排、安全审计和自定义 API。你可以把它当作交付给运维同事的快速手册。
          </p>
          <div className="docs-hero-actions">
            <a className="marketing-primary" href="#install">
              <PlayCircle size={18} />
              开始部署
            </a>
            <a className="marketing-secondary" href="https://github.com/nmklio/CoLiPas" target="_blank" rel="noreferrer">
              <FileText size={18} />
              GitHub 仓库
            </a>
          </div>
        </div>
        <aside className="docs-quick-card" aria-label="快速导航">
          <strong>快速导航</strong>
          {quickNav.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
              <ArrowRight size={15} />
            </a>
          ))}
        </aside>
      </section>

      <div className="docs-layout">
        <aside className="docs-sidebar" aria-label="页面目录">
          <a href="#install">安装部署</a>
          <a href="#config">环境变量</a>
          <a href="#server-access">服务器接入</a>
          <a href="#ai">AI 助手</a>
          <a href="#ssh">SSH 与编排</a>
          <a href="#api">API 与代理</a>
          <a href="#security">安全上线</a>
          <a href="#faq">常见问题</a>
        </aside>

        <article className="docs-content">
          <section id="install" className="docs-section">
            <div className="docs-section-heading">
              <span><Layers3 size={18} /> 安装部署</span>
              <h2>从仓库到 8080 生产服务</h2>
              <p>CoLiPas云服务器管理面板是一个单体 Node 生产服务，构建后同时提供前端页面和后端 API。</p>
            </div>
            <div className="docs-step-grid">
              {installSteps.map((step, index) => (
                <div key={step.title} className="docs-step">
                  <b>{index + 1}</b>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                  <code>{step.command}</code>
                </div>
              ))}
            </div>
            <div className="docs-callout">
              <CheckCircle2 size={18} />
              <span>生产入口是 8080。5173 只属于 Vite 开发服务器，正式部署不要启动。</span>
            </div>
          </section>

          <section id="config" className="docs-section">
            <div className="docs-section-heading">
              <span><KeyRound size={18} /> 环境变量</span>
              <h2>上线前必须改掉默认值</h2>
            </div>
            <div className="docs-table">
              {configRows.map(([name, desc]) => (
                <div key={name}>
                  <code>{name}</code>
                  <p>{desc}</p>
                </div>
              ))}
            </div>
          </section>

          <section id="server-access" className="docs-section">
            <div className="docs-section-heading">
              <span><CloudCog size={18} /> 后台使用流程</span>
              <h2>按服务器生命周期操作</h2>
              <p>下面是推荐使用顺序。每个模块都不是摆设，动作会和资产、事件、审计、AI 上下文联动。</p>
            </div>
            <div className="docs-usage-grid">
              {usageBlocks.map((block) => {
                const Icon = block.icon;
                return (
                  <article key={block.title} className="docs-usage-card">
                    <div className="feature-icon"><Icon size={22} /></div>
                    <h3>{block.title}</h3>
                    <p>{block.body}</p>
                    <ul>
                      {block.points.map((point) => (
                        <li key={point}><CheckCircle2 size={14} /> {point}</li>
                      ))}
                    </ul>
                  </article>
                );
              })}
            </div>
          </section>

          <section id="ai" className="docs-section docs-split-section">
            <div>
              <div className="docs-section-heading">
                <span><Bot size={18} /> AI 助手</span>
                <h2>配置 OpenAI 兼容 API 后使用真实流式对话</h2>
                <p>AI 面板会先读取模型列表，再通过测试接口确认上游支持流式响应。未配置密钥时，只会返回本地模拟分析。</p>
              </div>
              <ol className="docs-ordered">
                <li>填写 API Base URL，例如 https://api.example.com/v1。</li>
                <li>填写 API Key，不要写进 README、截图或 Git。</li>
                <li>点击加载模型，确认模型列表来自上游。</li>
                <li>点击测试连接，确认服务端使用 stream:true。</li>
                <li>开始对话，切换模块后对话不会丢失。</li>
              </ol>
            </div>
            <div className="docs-terminal-card">
              <span>AI request contract</span>
              <code>{'POST /api/ai/stream'}</code>
              <pre>{'{\n  "provider": {\n    "baseUrl": "https://.../v1",\n    "model": "model-name",\n    "apiKey": "sk-***"\n  },\n  "messages": [...],\n  "forceRefresh": false\n}'}</pre>
            </div>
          </section>

          <section id="ssh" className="docs-section docs-split-section">
            <div>
              <div className="docs-section-heading">
                <span><TerminalSquare size={18} /> SSH 与云维编排</span>
                <h2>先验证 SSH，再执行命令和任务</h2>
                <p>真实 SSH 接入支持密码和私钥。只有已验证的服务器才能打开实时终端和执行远程动作。</p>
              </div>
              <div className="docs-check-list">
                <p><CheckCircle2 size={16} /> 开机、关机、重启会更新服务器生命周期状态。</p>
                <p><CheckCircle2 size={16} /> 实时终端使用 PTY 流式输出，不需要回车两次。</p>
                <p><CheckCircle2 size={16} /> 编排任务会拒绝未接入或不存在的目标。</p>
              </div>
            </div>
            <div className="docs-terminal-card">
              <span>常用诊断命令</span>
              <pre>{'uptime\nwhoami\ndf -h\nfree -m\nsystemctl status ssh --no-pager'}</pre>
            </div>
          </section>

          <section id="api" className="docs-section">
            <div className="docs-section-heading">
              <span><Code2 size={18} /> API 与自定义代理</span>
              <h2>常用接口和联动点</h2>
              <p>除健康检查和登录外，所有业务接口都要求登录会话。自定义 API 只能访问白名单域名。</p>
            </div>
            <div className="docs-api-list">
              {apiRows.map(([route, desc]) => (
                <div key={route}>
                  <code>{route}</code>
                  <span>{desc}</span>
                </div>
              ))}
            </div>
          </section>

          <section id="security" className="docs-section docs-split-section">
            <div>
              <div className="docs-section-heading">
                <span><LockKeyhole size={18} /> 安全上线清单</span>
                <h2>公网部署前逐项确认</h2>
              </div>
              <div className="docs-check-list">
                <p><ShieldCheck size={16} /> 修改管理员密码，不使用默认演示密码。</p>
                <p><ShieldCheck size={16} /> 使用强随机 SESSION_SECRET 和 CREDENTIAL_ENCRYPTION_KEY。</p>
                <p><ShieldCheck size={16} /> 配置 HTTPS、反向代理和防火墙。</p>
                <p><ShieldCheck size={16} /> 限制 CUSTOM_API_ALLOWED_HOSTS，避免代理被滥用。</p>
                <p><ShieldCheck size={16} /> 备份 .data/colipas.sqlite，不要提交 .env 或 .data。</p>
              </div>
            </div>
            <div className="docs-data-card">
              <Database size={28} />
              <strong>SQLite 默认落地</strong>
              <p>资产、审计、账号配置会写入本地 SQLite。SSH 凭据单独加密存储，健康轮询不会制造无意义写入。</p>
            </div>
          </section>

          <section id="faq" className="docs-section">
            <div className="docs-section-heading">
              <span><LifeBuoy size={18} /> 常见问题</span>
              <h2>排障时先看这里</h2>
            </div>
            <div className="docs-faq-list">
              {faqItems.map(([question, answer]) => (
                <details key={question} open={question === '后台地址在哪里？'}>
                  <summary>{question}</summary>
                  <p>{answer}</p>
                </details>
              ))}
            </div>
          </section>
        </article>
      </div>
    </main>
  );
}
