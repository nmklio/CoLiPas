import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const baseUrl = normalizeBaseUrl(process.env.PUBLIC_PAGES_BASE_URL ?? process.env.E2E_BASE_URL ?? process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:18080');
const mode = process.env.PUBLIC_PAGES_MODE ?? (isLocalhost(baseUrl) ? 'admin' : 'public');
const executablePath = process.env.PUBLIC_PAGES_BROWSER_PATH ?? process.env.E2E_BROWSER_PATH ?? findSystemBrowser();
const evidenceDir = path.resolve('output', 'public-pages-check');
const viewports = [
  { name: 'desktop', width: 1440, height: 1000, isMobile: false },
  { name: 'mobile', width: 390, height: 844, isMobile: true },
];
const pages = mode === 'admin'
  ? [buildAdminCheck()]
  : mode === 'landing'
    ? [buildLandingCheck()]
    : [buildLandingCheck(), buildDocsCheck(), buildAdminCheck()];

fs.rmSync(evidenceDir, { recursive: true, force: true });
fs.mkdirSync(evidenceDir, { recursive: true });

const browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { headless: true });
const failures = [];

try {
  for (const viewport of viewports) {
    for (const pageSpec of pages) {
      await validatePage(pageSpec, viewport);
    }
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  throw new Error(`Public page browser validation failed:\n${failures.join('\n')}`);
}

console.log(`ok public page browser validation ${mode} ${baseUrl}`);

async function validatePage(pageSpec, viewport) {
  const pageErrors = [];
  const failedRequests = [];
  const badResponses = [];
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.isMobile,
  });

  page.on('console', (message) => {
    if (message.type() === 'error') {
      if (message.text().startsWith('Failed to load resource:')) {
        return;
      }
      pageErrors.push(`console error: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(`pageerror: ${error.message}`);
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (!isIgnorableResource(url)) {
      failedRequests.push(`${request.method()} ${url} ${request.failure()?.errorText ?? 'failed'}`);
    }
  });
  page.on('response', (response) => {
    const status = response.status();
    const url = response.url();
    if (status >= 400 && !isIgnorableResource(url)) {
      badResponses.push(`${status} ${url}`);
    }
  });

  try {
    const targetUrl = new URL(pageSpec.path, baseUrl).toString();
    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 35000,
    });
    if (!response?.ok()) {
      throw new Error(`${pageSpec.name} ${viewport.name} returned HTTP ${response?.status() ?? 'none'}`);
    }

    await pageSpec.assert(page, viewport);
    await assertFaviconResponse(page);
    await assertNoHorizontalOverflow(page, `${pageSpec.name} ${viewport.name}`);
    await assertNoBadBoxes(page, pageSpec.name, viewport.name);
    await captureVisualEvidence(page, `${pageSpec.name}-${viewport.name}`);

    if (pageErrors.length || failedRequests.length || badResponses.length) {
      throw new Error([
        ...pageErrors,
        ...failedRequests.map((item) => `request failed: ${item}`),
        ...badResponses.map((item) => `bad response: ${item}`),
      ].join('\n'));
    }

    console.log(`ok public page ${pageSpec.name} ${viewport.name}`);
  } catch (error) {
    failures.push(`${pageSpec.name} ${viewport.name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await page.close();
  }
}

function buildLandingCheck() {
  return {
    name: 'landing',
    path: '/',
    assert: async (page) => {
      await expectTitle(page, /CoLiPas云服务器管理面板/);
      await expectTitleAbsent(page, /CoLiPas - 多云服务器管理面板|多云服务器管理面板/);
      await expectText(page.locator('h1').first(), /CoLiPas\s*云服务器管理面板|CoLiPas Cloud Server Management Panel|multi-cloud/i, 'landing h1');
      await expectText(page.locator('body'), /云服务器管理与 AI 运维后台|cloud server management/i, 'landing footer product description');
      await expectTextAbsent(page, /多云服务器管理与 AI 运维后台/, 'landing legacy footer product description');
      await expectTextAbsent(page, /CoLiPas Console|本页只负责介绍项目能力|真正的服务器接入、账号设置、命令执行和 AI 对话都放在受保护后台|服务器管理、SSH、AI 和审计都在后台完成|\u4e91\u7ef4\u7f16\u6392/, 'landing awkward closing copy');
      await expectLocatorCountAtLeast(page.locator('link[rel="icon"][href="/colipas-icon.svg?v=20260530-brand3"]'), 1, 'landing versioned favicon');
      await expectLink(page, /GitHub/i, 'https://github.com/nmklio/CoLiPas');
      await expectLinkTarget(page.locator('a[href="/docs.html"]').first(), '/docs.html', 'landing docs link');
      await expectLink(page, /后台|登录|Admin|进入/i, '/admin/');
      await expectLocatorCount(page.locator('.hero .product-preview img[src^="/colipas-dashboard-preview.svg"]'), 1, 'landing product-stage preview');
      await expectLocatorCount(page.locator('.feature-card.feature-card-wide'), 2, 'landing primary capability cards');
      await assertLandingProductStage(page);
      await expectLocatorCountAtLeast(page.locator('section, article, .feature-card, .position-card, .deploy-card'), 6, 'landing content sections');
      await expectLocatorCount(page.locator('[data-colipas-feature="contextual-launch-summary"]'), 1, 'landing contextual launch guide feature card');
      await expectText(page.locator('[data-colipas-feature="contextual-launch-summary"]'), /上线检查|release checklist|workspace summary/i, 'landing contextual launch guide copy');
      await expectLocatorCount(page.locator('[data-colipas-feature="fleet-views"]'), 1, 'landing fleet views feature card');
      await expectText(page.locator('[data-colipas-feature="fleet-views"]'), /资产视图|fleet views|browser/i, 'landing fleet views copy');
      await expectLocatorCount(page.locator('[data-colipas-feature="server-bulk-import"]'), 1, 'landing server bulk import feature card');
      await expectText(page.locator('[data-colipas-feature="server-bulk-import"]'), /批量资产导入|bulk import|500|CSV|JSON|校验报告|validation report/i, 'landing server bulk import copy');
      await expectLocatorCount(page.locator('[data-colipas-feature="command-palette-context"]'), 1, 'landing contextual command palette feature card');
      await expectText(page.locator('[data-colipas-feature="command-palette-context"]'), /上下文命令面板|command palette|最近使用/i, 'landing contextual command palette copy');
      await expectLocatorCount(page.locator('[data-colipas-feature="operations-inbox"]'), 1, 'landing operations inbox feature card');
      await expectText(page.locator('[data-colipas-feature="operations-inbox"]'), /运维收件箱|operations inbox|资源越线|再次提醒|跨模块/i, 'landing operations inbox copy');
      await expectLocatorCount(page.locator('[data-colipas-feature="resource-alert-policy"]'), 1, 'landing resource alert policy feature card');
      await expectText(page.locator('[data-colipas-feature="resource-alert-policy"]'), /资源告警策略|CPU|内存|磁盘|SQLite|周期提醒/i, 'landing resource alert policy copy');
      await expectLocatorCount(page.locator('[data-colipas-feature="server-metric-history"]'), 1, 'landing server metric history feature card');
      await expectText(page.locator('[data-colipas-feature="server-metric-history"]'), /可信资源历史|CPU|内存|磁盘|7 天|有界历史|来源可辨/i, 'landing server metric history copy');
      await expectLocatorCount(page.locator('[data-colipas-feature="account-session-control"]'), 1, 'landing account session control feature card');
      await expectText(page.locator('[data-colipas-feature="account-session-control"]'), /登录会话控制|令牌哈希|SQLite|原始 Cookie|重启后|最旧会话/i, 'landing account session control copy');
      await expectLocatorCount(page.locator('[data-colipas-feature="operator-controls"]'), 1, 'landing adaptive operator controls feature card');
      await expectText(page.locator('[data-colipas-feature="operator-controls"]'), /自适应操作员控制|登录名称|同步状态|单行顶栏|键盘可关闭/i, 'landing adaptive operator controls copy');
      await expectLocatorCount(page.locator('[data-colipas-feature="adaptive-refresh"]'), 1, 'landing adaptive refresh feature card');
      await expectText(page.locator('[data-colipas-feature="adaptive-refresh"]'), /智能刷新调度|15 秒|30 秒|隐藏|离线|120 秒|backoff/i, 'landing adaptive refresh copy');
      await expectLocatorCount(page.locator('[data-colipas-feature="intent-ready-navigation"]'), 1, 'landing intent-ready navigation feature card');
      await expectText(page.locator('[data-colipas-feature="intent-ready-navigation"]'), /意图就绪导航|目标工作区|最后一次选择|竞态保护/i, 'landing intent-ready navigation copy');
      await expectLocatorCountAtLeast(page.locator('.feature-card .feature-icon svg'), 8, 'landing feature SVG icons');
      await expectLocatorCountAtLeast(page.locator('.position-card.position-flow-card'), 4, 'landing redesigned flow position cards');
      await expectLocatorCount(page.locator('.position-card .position-step'), 4, 'landing position flow step numbers');
      await expectLocatorCount(page.locator('.position-card .position-state'), 4, 'landing position flow state pills');
      await expectLocatorCount(page.locator('.position-card .position-visual, .position-card svg'), 0, 'landing legacy position icon blocks');
      await expectLocatorCount(page.locator('.position-card small'), 0, 'landing legacy numbered position badges');
      await expectLocatorCount(page.locator('.position-card .shape-fill, .position-card .shape-line, .position-card .shape-dot'), 0, 'landing legacy bulky position icon shapes');
      await expectLocatorCountAtLeast(page.locator('.deploy-card .deploy-icon svg'), 3, 'landing deploy SVG icons');
      await expectLocatorCountAtLeast(page.locator('.brand img.brand-mark[src="/colipas-icon.svg"]'), 1, 'landing brand icon image');
      await expectLocatorCount(page.locator('.brand .brand-mark').filter({ hasText: /^CP$/ }), 0, 'landing legacy CP brand mark');
      await assertSensitiveTextAbsent(page, 'landing');
    },
  };
}

function buildDocsCheck() {
  return {
    name: 'docs',
    path: '/docs.html',
    assert: async (page) => {
      await expectTitle(page, /CoLiPas/);
      await expectText(page.locator('h1').first(), /CoLiPas 上线与使用手册|下载、配置、运行|Linux|Docker|CoLiPas云服务器管理面板/i, 'docs h1');
      await expectLocatorCountAtLeast(page.locator('link[rel="icon"][href="/colipas-icon.svg?v=20260530-brand3"]'), 1, 'docs versioned favicon');
      await expectLocatorCountAtLeast(page.locator('h2'), 6, 'docs h2 sections');
      await expectLink(page, /GitHub/i, 'https://github.com/nmklio/CoLiPas');
      await expectLink(page, /体验测试地址/i, '/admin/');
      await expectLocatorCount(page.locator('.nav-actions a'), 2, 'docs top navigation actions');
      await expectLightweightDocsTrialLink(page);
      await expectTextAbsent(page.locator('.nav-actions'), /进入后台|管理后台/, 'docs top navigation legacy admin wording');
      await expectText(page.locator('body'), /Docker|systemd|SSH|AI|安全|SQLite/i, 'docs body');
      await expectText(page.locator('body'), /受保护的环境变量注入公网地址和初始密码|不会在结束时回显已提供的密码/, 'docs unattended deployment wording');
      await expectText(page.locator('body'), /未验证的服务器不会显示已接入|不要将 Vite 5173 作为生产入口/, 'docs polished operational wording');
      await expectTextAbsent(page, /不要把真实密码写进公开仓库或截图|公开仓库或截图|ChangeThisStrongPassword123|NewStrongPassword123|admin123456|乱填|类 VNC|\u4e91\u7ef4|截图里的真实资产|当作正式服务|开发者改代码后再上线|演示后台|演示登录|默认演示密码|是不是固定/, 'docs awkward wording');
      await expectLocatorCount(page.locator('#launch-checklist'), 1, 'docs contextual launch guide section');
      await expectText(page.locator('#launch-checklist'), /上线检查|workspace summary|release checklist/i, 'docs contextual launch guide copy');
      await expectLocatorCount(page.locator('#operations-inbox'), 1, 'docs operations inbox section');
      await expectText(page.locator('#operations-inbox'), /运维收件箱|稳定事项 ID|值班入口|资源越线|策略周期/i, 'docs operations inbox copy');
      await expectLocatorCount(page.locator('#resource-alerts[data-colipas-docs-feature="resource-alert-policy"]'), 1, 'docs resource alert policy section');
      await expectText(page.locator('#resource-alerts'), /资源告警策略|50%|95%|15 分钟|24 小时|P0|SQLite/i, 'docs resource alert policy copy');
      await expectText(page.locator('body'), /GET \/api\/monitoring\/resource-alert-policy|PUT \/api\/monitoring\/resource-alert-policy/i, 'docs resource alert policy API copy');
      await expectLocatorCount(page.locator('#metric-history[data-colipas-docs-feature="server-metric-history"]'), 1, 'docs server metric history section');
      await expectText(page.locator('#metric-history'), /可信资源历史|1 小时|6 小时|24 小时|7 天|2016|240|SSH/i, 'docs server metric history copy');
      await expectText(page.locator('body'), /GET \/api\/servers\/:serverId\/metric-history/i, 'docs server metric history API copy');
      await expectLocatorCount(page.locator('[data-colipas-docs-fleet-views="true"]'), 1, 'docs fleet views section');
      await expectText(page.locator('[data-colipas-docs-fleet-views="true"]'), /资产视图|fleet views|browser/i, 'docs fleet views copy');
      await expectLocatorCount(page.locator('[data-colipas-docs-feature="server-bulk-import"]'), 1, 'docs server bulk import section');
      await expectText(page.locator('[data-colipas-docs-feature="server-bulk-import"]'), /批量导入|bulk import|500|2 MB|CSV|JSON|校验报告|公式注入|validation report/i, 'docs server bulk import copy');
      await expectLocatorCount(page.locator('[data-colipas-docs-feature="account-session-control"]'), 1, 'docs account session control section');
      await expectText(page.locator('[data-colipas-docs-feature="account-session-control"]'), /当前会话|15 秒|SESSION_MAX_ACTIVE|SHA-256|令牌哈希|原始 Cookie|重启后|最旧会话/i, 'docs account session control copy');
      await expectText(page.locator('body'), /SESSION_MAX_ACTIVE|2–64|默认 12|最旧会话/i, 'docs account session capacity configuration');
      await expectLocatorCount(page.locator('[data-colipas-docs-operator-controls="true"]'), 1, 'docs adaptive operator controls section');
      await expectText(page.locator('[data-colipas-docs-operator-controls="true"]'), /自适应操作员控制|登录名称|同步状态|桌面端保持单行|移动端自动压缩|Escape/i, 'docs adaptive operator controls copy');
      await expectLocatorCount(page.locator('[data-colipas-docs-adaptive-refresh="true"]'), 1, 'docs adaptive refresh section');
      await expectText(page.locator('[data-colipas-docs-adaptive-refresh="true"]'), /智能刷新|15 秒|30 秒|标签页隐藏|网络离线|120 秒|退避/i, 'docs adaptive refresh copy');
      await expectLocatorCount(page.locator('[data-colipas-docs-intent-navigation="true"]'), 1, 'docs intent-ready navigation section');
      await expectText(page.locator('[data-colipas-docs-intent-navigation="true"]'), /意图就绪导航|当前工作区保持可用|最后一次选择|Save-Data|2G|性能模式/i, 'docs intent-ready navigation copy');
      await expectLocatorCount(page.locator('[data-colipas-docs-command-palette="true"]'), 1, 'docs contextual command palette section');
      await expectText(page.locator('[data-colipas-docs-command-palette="true"]'), /上下文命令面板|command palette|最近使用/i, 'docs contextual command palette copy');
      await expectLocatorCount(page.locator('[data-colipas-docs-ai-starters="true"]'), 1, 'docs safe AI starter section');
      await expectText(page.locator('[data-colipas-docs-ai-starters="true"]'), /三个安全起步入口|只会填充输入框|不会自动发送或执行/i, 'docs safe AI starter copy');
      await expectLocatorCount(page.locator('[data-colipas-docs-avatar-guard="true"]'), 1, 'docs avatar decode guard');
      await expectText(page.locator('[data-colipas-docs-avatar-guard="true"]'), /头像保存前会验证图片可正常解码|自动回退到 CoLiPas 品牌图标/i, 'docs avatar decode guard copy');
      await assertSensitiveTextAbsent(page, 'docs');
    },
  };
}

function buildAdminCheck() {
  return {
    name: 'admin',
    path: '/admin/',
    assert: async (page) => {
      await expectTitle(page, /CoLiPas/);
      await page.locator('input[autocomplete="username"]').waitFor({ timeout: 15000 });
      await page.locator('input[autocomplete="current-password"]').waitFor({ timeout: 15000 });
      await page.locator('[data-login-health-strip="true"]').waitFor({ timeout: 15000 });
      await expectText(page.locator('h1').first(), /CoLiPas|管理后台|console|安全/i, 'admin login h1');
      await expectLink(page, /^GitHub$/i, 'https://github.com/nmklio/CoLiPas');
      await expectText(page.locator('[data-login-health-strip="true"]'), /Deployment status|上线状态|デプロイ状態|Service|服务|サービス|Access protection|访问保护|アクセス保護|Last check|最近检查|最終確認/i, 'admin login public status strip');
      await expectLocatorCount(page.locator('[data-login-health-card]'), 3, 'admin login health cards');
      const healthText = await page.locator('[data-login-health-strip="true"]').innerText();
      if (/\b(?:\d{1,3}\.){3}\d{1,3}\b|sk-[A-Za-z0-9_-]{12,}|BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY|password=|passphrase=/i.test(healthText)) {
        throw new Error('admin login health strip leaked a raw IP address or secret');
      }
      if (/\bcolipas\.sqlite\b|primary-systemd|secondary-docker|\b(?:systemd|docker)\b|\b[a-f0-9]{7,12}\b/i.test(healthText)) {
        throw new Error('admin login public status strip leaked runtime or release internals');
      }
      const usernameValue = await page.locator('input[autocomplete="username"]').inputValue();
      if (usernameValue.trim()) {
        throw new Error('admin login must not prefill the username');
      }
      await assertSensitiveTextAbsent(page, 'admin login');
    },
  };
}

async function expectTitle(page, pattern) {
  const title = await page.title();
  if (!pattern.test(title)) {
    throw new Error(`page title "${title}" did not match ${pattern}`);
  }
}

async function expectTitleAbsent(page, pattern) {
  const title = await page.title();
  if (pattern.test(title)) {
    throw new Error(`page title "${title}" still matched legacy pattern ${pattern}`);
  }
}

async function expectText(locator, pattern, label) {
  await locator.waitFor({ timeout: 10000 });
  const text = (await locator.innerText({ timeout: 5000 })).trim();
  if (!pattern.test(text)) {
    throw new Error(`${label} text "${text.slice(0, 160)}" did not match ${pattern}`);
  }
}

async function expectTextAbsent(target, pattern, label) {
  const locator = typeof target.content === 'function' ? target.locator('body') : target;
  const text = await locator.innerText({ timeout: 10000 });
  if (pattern.test(text)) {
    throw new Error(`${label} still rendered`);
  }
}

async function expectLink(page, namePattern, hrefFragment) {
  const link = page.getByRole('link', { name: namePattern }).first();
  await link.waitFor({ timeout: 10000 });
  const href = await link.getAttribute('href');
  if (!href || !href.includes(hrefFragment)) {
    throw new Error(`link ${namePattern} href "${href}" did not include ${hrefFragment}`);
  }
}

async function expectLinkTarget(locator, hrefFragment, label) {
  await locator.waitFor({ state: 'attached', timeout: 10000 });
  const href = await locator.getAttribute('href');
  if (!href || !href.includes(hrefFragment)) {
    throw new Error(`${label} href "${href}" did not include ${hrefFragment}`);
  }
}

async function expectLocatorCountAtLeast(locator, minimum, label) {
  const count = await locator.count();
  if (count < minimum) {
    throw new Error(`${label} expected at least ${minimum}, got ${count}`);
  }
}

async function expectLocatorCount(locator, expected, label) {
  const count = await locator.count();
  if (count !== expected) {
    throw new Error(`${label} expected ${expected}, got ${count}`);
  }
}

async function expectLightweightDocsTrialLink(page) {
  const style = await page.locator('.nav-action, .docs-trial-link').filter({ hasText: /体验测试地址/i }).first().evaluate((element) => {
    const computed = window.getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return {
      backgroundColor: computed.backgroundColor,
      color: computed.color,
      boxShadow: computed.boxShadow,
      borderRadius: computed.borderRadius,
      height: Math.round(box.height),
    };
  });
  if (/rgb\(37,\s*99,\s*235\)/.test(style.backgroundColor) || style.color === 'rgb(255, 255, 255)' || style.boxShadow !== 'none' || style.height > 38) {
    throw new Error(`docs trial link must stay a lightweight top-nav link, got ${JSON.stringify(style)}`);
  }
}

async function assertSensitiveTextAbsent(page, label) {
  const text = await page.locator('body').innerText({ timeout: 10000 });
  const redFlags = [
    /\bsk-[A-Za-z0-9_-]{12,}\b/,
    /BEGIN (?:OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY/,
    /Ymz\d{6,}/i,
  ];
  const matches = redFlags.filter((pattern) => pattern.test(text));
  if (matches.length > 0) {
    throw new Error(`${label} rendered sensitive-looking text`);
  }
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  if (metrics.scrollWidth > metrics.viewportWidth + 1) {
    throw new Error(`${label} has horizontal document overflow: ${metrics.scrollWidth}px > ${metrics.viewportWidth}px`);
  }
}

async function assertNoBadBoxes(page, pageName, viewportName) {
  const badBoxes = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const selector = [
      'a',
      'button',
      'input',
      'select',
      'h1',
      'h2',
      '.nav',
      '.marketing-nav',
      '.product-preview',
      '.feature-card-wide',
      '.docs-hero',
      '.docs-section',
      '.docs-quick-card',
      '.login-card',
      '.login-panel',
      '.quick-card',
      '.doc-card',
      '.terminal-card',
    ].join(',');
    return Array.from(document.querySelectorAll(selector))
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === 'string' ? element.className : '',
          text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      })
      .filter((box) => {
        const isVisible = box.width > 0 && box.height > 0 && box.y < viewportHeight + 200;
        const horizontallyOutside = box.x < -2 || box.x + box.width > viewportWidth + 2;
        const clippedText = box.clientWidth > 0 && box.scrollWidth > box.clientWidth + 2 && !['pre', 'code'].includes(box.tag);
        return isVisible && (horizontallyOutside || clippedText);
      });
  });

  if (badBoxes.length > 0) {
    throw new Error(`${pageName} ${viewportName} has overflowing elements: ${JSON.stringify(badBoxes.slice(0, 6))}`);
  }
}

async function assertLandingProductStage(page) {
  const stage = await page.evaluate(() => {
    const hero = document.querySelector('.hero');
    const heading = hero?.querySelector('h1');
    const preview = hero?.querySelector('.product-preview');
    const image = preview?.querySelector('img');
    const primary = hero?.querySelector('.hero-primary');
    const securityItem = document.querySelector('.security-list > div');
    if (!(hero instanceof HTMLElement) || !(heading instanceof HTMLElement) || !(preview instanceof HTMLElement) || !(image instanceof HTMLImageElement)) {
      return null;
    }

    const heroStyle = window.getComputedStyle(hero, '::before');
    const headingStyle = window.getComputedStyle(heading);
    const previewBox = preview.getBoundingClientRect();
    const imageBox = image.getBoundingClientRect();
    const securityStyle = securityItem instanceof HTMLElement ? window.getComputedStyle(securityItem) : null;
    return {
      heroBackground: heroStyle.backgroundColor,
      headingAlign: headingStyle.textAlign,
      previewWidth: Math.round(previewBox.width),
      imageTop: Math.round(imageBox.top),
      imageBottom: Math.round(imageBox.bottom),
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      primaryHref: primary instanceof HTMLAnchorElement ? primary.getAttribute('href') : '',
      securityBackground: securityStyle?.backgroundColor ?? '',
      securityColor: securityStyle?.color ?? '',
    };
  });

  if (!stage) {
    throw new Error('landing immersive product stage is missing');
  }
  if (!/^rgba?\((?:9|8|10),\s*(?:13|12|14),\s*(?:15|14|16)/.test(stage.heroBackground)) {
    throw new Error(`landing hero must keep a quiet dark product stage, got ${stage.heroBackground}`);
  }
  if (stage.headingAlign !== 'center') {
    throw new Error(`landing hero heading must be centered, got ${stage.headingAlign}`);
  }
  if (stage.previewWidth < stage.viewportWidth * (stage.viewportWidth <= 640 ? 0.9 : 0.62)) {
    throw new Error(`landing product preview is undersized: ${stage.previewWidth}px in ${stage.viewportWidth}px viewport`);
  }
  if (stage.imageTop >= stage.viewportHeight || stage.imageBottom <= 0) {
    throw new Error(`landing product preview is not hinted in the first viewport: ${JSON.stringify(stage)}`);
  }
  if (stage.naturalWidth < 1200 || stage.naturalHeight < 700) {
    throw new Error(`landing product preview asset did not load at inspection quality: ${stage.naturalWidth}x${stage.naturalHeight}`);
  }
  if (stage.primaryHref !== '/admin/') {
    throw new Error(`landing primary action must open the protected admin console, got ${stage.primaryHref}`);
  }
  if (stage.securityBackground === 'rgb(255, 255, 255)' || stage.securityBackground === 'rgba(255, 255, 255, 1)') {
    throw new Error(`landing security list inherited an unreadable light card background: ${JSON.stringify(stage)}`);
  }
  if (!stage.securityColor || stage.securityColor === 'rgb(255, 255, 255)') {
    throw new Error(`landing security list text color is not explicitly integrated with the dark band: ${JSON.stringify(stage)}`);
  }
}

async function captureVisualEvidence(page, name) {
  const filePath = path.join(evidenceDir, `${name}.png`);
  const buffer = await captureScreenshotBuffer(page, filePath);
  if (buffer.length < 12000) {
    throw new Error(`public page screenshot ${name} looks too small or blank: ${buffer.length} bytes`);
  }
  const uniqueByteCount = new Set(buffer).size;
  if (uniqueByteCount < 24) {
    throw new Error(`public page screenshot ${name} has too little pixel entropy: ${uniqueByteCount} unique bytes`);
  }
}

async function captureScreenshotBuffer(page, filePath) {
  try {
    return await page.screenshot({ path: filePath, fullPage: true, timeout: 12000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Timeout|screenshot|fonts/i.test(message)) {
      throw error;
    }

    const buffer = await captureScreenshotViaCdp(page);
    fs.writeFileSync(filePath, buffer);
    return buffer;
  }
}

async function captureScreenshotViaCdp(page) {
  const client = await page.context().newCDPSession(page);
  try {
    const metrics = await client.send('Page.getLayoutMetrics');
    const contentSize = metrics.cssContentSize ?? metrics.contentSize ?? { width: 1, height: 1 };
    const width = Math.max(1, Math.ceil(Number(contentSize.width) || 1));
    const height = Math.max(1, Math.ceil(Number(contentSize.height) || 1));
    const result = await client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    return Buffer.from(result.data, 'base64');
  } finally {
    await client.detach().catch(() => undefined);
  }
}

function normalizeBaseUrl(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function isLocalhost(value) {
  const url = new URL(value);
  return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
}

function isIgnorableResource(value) {
  try {
    const url = new URL(value);
    return url.hostname === 'static.cloudflareinsights.com' && url.pathname.includes('/beacon.min.js');
  } catch {
    return false;
  }
}

async function assertFaviconResponse(page) {
  const response = await page.request.get(new URL('/favicon.ico', baseUrl).toString(), {
    headers: { Accept: 'image/svg+xml,image/*,*/*;q=0.8' },
    timeout: 10000,
  });
  if (!response.ok()) {
    throw new Error(`/favicon.ico returned HTTP ${response.status()}`);
  }
  const contentType = response.headers()['content-type'] ?? '';
  const body = await response.text();
  if (!contentType.includes('image/svg+xml') || !body.includes('<svg') || !body.includes('CoLiPas') || body.includes('<html')) {
    throw new Error(`/favicon.ico must return the CoLiPas SVG icon, got content-type ${contentType}`);
  }
}

function findSystemBrowser() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? '';
}
