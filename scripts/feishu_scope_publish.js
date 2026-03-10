#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_) {
    try {
      const cwdRequire = createRequire(path.join(process.cwd(), 'codex-require-proxy.js'));
      return cwdRequire('playwright');
    } catch (err) {
      throw new Error(
        '未找到 playwright 依赖。请先执行: npm i -D playwright && npx playwright install chromium'
      );
    }
  }
}

const { chromium } = loadPlaywright();

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    args[k] = v;
  }
  return args;
}

function parseScopesInput(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseScopesFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) return [];
    return arr.map((s) => String(s).trim()).filter(Boolean);
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .flatMap((line) => parseScopesInput(line));
}

function parseBool(v) {
  if (v == null) return false;
  return /^(1|true|yes|y)$/i.test(String(v).trim());
}

function nowVersion() {
  const d = new Date();
  return `1.${d.getFullYear() % 100}.${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function tryClick(locator) {
  if (await locator.count()) {
    const target = locator.first();
    if (await target.isVisible()) {
      await target.click({ force: true });
      return true;
    }
  }
  return false;
}

async function waitAnyVisible(locators, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const locator of locators) {
      if ((await locator.count()) > 0 && await locator.first().isVisible().catch(() => false)) {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function clickOne(page, candidates) {
  for (const candidate of candidates) {
    const ok = await tryClick(candidate);
    if (ok) return true;
  }
  return false;
}

async function fillFirstVisible(page, locators, value) {
  for (const locator of locators) {
    if ((await locator.count()) > 0) {
      const input = locator.first();
      if (await input.isVisible()) {
        await input.click({ force: true });
        await input.fill(value);
        return true;
      }
    }
  }
  return false;
}

async function waitForQrReady(page, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const loadingVisible = await page.getByText(/Loading|加载中/i).first().isVisible().catch(() => false);
    const qrFrameVisible = await page.locator('canvas, img[alt*=\"QR\"], img[src*=\"qr\"], .qrcode').first().isVisible().catch(() => false);
    if (!loadingVisible && qrFrameVisible) return;
    await page.waitForTimeout(500);
  }
}

async function ensureTenantTab(page) {
  await clickOne(page, [
    page.getByRole('tab', { name: /Tenant token scopes/i }),
    page.getByText(/Tenant token scopes/i),
  ]);
}

async function closeScopeDialogIfOpen(page) {
  const dialog = page.getByRole('dialog').first();
  const visible = (await dialog.count()) > 0 && await dialog.isVisible().catch(() => false);
  if (!visible) return;

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  const stillVisible = await dialog.isVisible().catch(() => false);
  if (!stillVisible) return;

  await clickOne(page, [
    page.getByRole('button', { name: /Cancel|取消/i }),
    dialog.locator('button').filter({ hasText: /Cancel|取消/i }),
  ]);
  await page.waitForTimeout(300);
}

async function waitButtonReady(buttonLocator, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const visible = (await buttonLocator.count()) > 0 && await buttonLocator.isVisible().catch(() => false);
    if (visible) {
      const enabled = await buttonLocator.isEnabled().catch(() => false);
      const cls = await buttonLocator.getAttribute('class').catch(() => '');
      const loading = /loading/i.test(cls || '');
      if (enabled && !loading) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function hasReleasedState(page) {
  const patterns = [
    /Version Details\s*Released/i,
    /Released at/i,
    /Review result\s*Approved/i,
    /The current changes have been published/i,
    /已发布|审核通过/,
  ];
  for (const pattern of patterns) {
    if (await page.getByText(pattern).count()) return true;
  }
  return false;
}

async function hasUnderReviewState(page) {
  const patterns = [
    /Under review|审核中|审批中/i,
    /Requested|已提交/i,
    /Launch Feishu Approval|去飞书审批/i,
  ];
  for (const pattern of patterns) {
    if (await page.getByText(pattern).count()) return true;
  }
  return false;
}

async function addScope(page, scope) {
  const mainSearch = page.getByPlaceholder(/E\\.g\\.|例如：获取群组信息|im:chat:readonly/i).first();
  if (await mainSearch.count()) {
    await mainSearch.click({ force: true });
    await mainSearch.fill(scope);
    await page.waitForTimeout(700);
  }

  const mainAddedRow = page
    .locator('tr, .virtual-table__row, .ud__table-row')
    .filter({ hasText: new RegExp(escapeRegex(scope), 'i') })
    .filter({ hasText: /Added|已添加/i })
    .first();
  for (let i = 0; i < 16; i += 1) {
    if (await mainAddedRow.count() && await mainAddedRow.isVisible().catch(() => false)) {
      return 'already_enabled';
    }
    await page.waitForTimeout(300);
  }

  const opened = await clickOne(page, [
    page.getByRole('button', { name: /开通权限|Add permission scopes to app/i }),
  ]);

  if (!opened) {
    throw new Error('未找到“开通权限”按钮');
  }

  await ensureTenantTab(page);

  const filled = await fillFirstVisible(page, [
    page.getByRole('dialog').getByPlaceholder(/例如：获取群组信息|im:chat:readonly|scope/i),
    page.getByPlaceholder(/例如：获取群组信息|im:chat:readonly|scope/i),
    page.getByRole('dialog').getByRole('textbox').first(),
  ], scope);

  if (!filled) {
    throw new Error(`未找到权限搜索输入框，scope=${scope}`);
  }

  const dialog = page.getByRole('dialog');
  let ready = false;
  let hasScopeText = 0;
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(500);
    const enabledCheckboxes = await dialog.locator('input[role="checkbox"]:not([disabled])').count();
    hasScopeText = await dialog.getByText(new RegExp(escapeRegex(scope), 'i')).count();
    if (enabledCheckboxes > 0 && hasScopeText > 0) {
      ready = true;
      break;
    }
  }

  if (!ready) {
    throw new Error(`权限结果未就绪或不可选择，请确认账号权限与 scope 是否可申请，scope=${scope}`);
  }

  const rows = dialog.locator('.virtual-table__row, tr, .ud__table-row');
  const rowIndex = await rows.evaluateAll((els, s) => {
    const needle = String(s || '').toLowerCase();
    return els.findIndex((el) => (el.textContent || '').toLowerCase().includes(needle));
  }, scope);

  if (rowIndex >= 0) {
    const row = rows.nth(rowIndex);
    const checkboxClickable = row.locator('label.ud__checkbox__wrapper, span.ud__checkbox, input[type="checkbox"]').first();
    await checkboxClickable.click({ force: true });
  } else {
    const fallback = dialog.locator('.virtual-table__row label.ud__checkbox__wrapper, .virtual-table__row span.ud__checkbox').first();
    if (await fallback.count()) {
      await fallback.click({ force: true });
    } else {
      throw new Error(`未找到 scope 行或可勾选项，scope=${scope}`);
    }
  }

  const confirmBtn = page.getByRole('button', { name: /确认开通权限|Add Scopes/i }).first();
  const confirmEnabled = await confirmBtn.isEnabled().catch(() => false);
  if (!confirmEnabled) {
    const disabledInRows = await dialog.locator('.virtual-table__row input[role="checkbox"][disabled], .virtual-table__row input[disabled]').count();
    if (disabledInRows > 0) {
      await closeScopeDialogIfOpen(page);
      return 'already_enabled';
    }
    throw new Error(`scope 已搜索到但未成功勾选，Add Scopes 仍不可点击，scope=${scope}`);
  }
  await confirmBtn.click();

  await page.waitForTimeout(1200);
  return 'added';
}

async function createVersion(page, version, changelog, options = {}) {
  const allowCreateNewVersion = options.allowCreateNewVersion !== false;
  const goRelease = await clickOne(page, [
    page.getByRole('link', { name: /版本管理与发布|Version management/i }),
    page.getByText(/版本管理与发布|Version management/i),
  ]);

  if (!goRelease) {
    throw new Error('未找到“版本管理与发布”入口');
  }

  await page.waitForTimeout(1200);
  const createBtn = page.getByRole('button', { name: /创建版本|Create Version|Create a version/i }).first();
  const viewDetailsBtn = page.getByText(/View Version Details|查看版本详情/i).first();

  if (!allowCreateNewVersion) {
    if ((await viewDetailsBtn.count()) > 0 && await viewDetailsBtn.isVisible().catch(() => false)) {
      await viewDetailsBtn.click({ force: true });
      await page.waitForTimeout(2500);
      if (await hasReleasedState(page)) return 'already_released';
      return 'existing_version_detail';
    }
    if (await hasReleasedState(page)) return 'already_released';
    return 'no_changes_skip_create';
  }

  if ((await createBtn.count()) > 0 && await createBtn.isVisible().catch(() => false)) {
    const createEnabled = await createBtn.isEnabled().catch(() => false);
    if (createEnabled) {
      const created = await clickOne(page, [
        createBtn,
        page.getByText(/创建版本|Create Version|Create a version/i),
      ]);

      if (!created) {
        throw new Error('未找到“创建版本”按钮');
      }

      const formReady = await waitAnyVisible([
        page.getByPlaceholder(/对用户展示的正式版本号|Version/i),
        page.getByRole('textbox', { name: /版本号|Version/i }),
      ], 8000);
      if (!formReady) {
        if (await hasReleasedState(page)) return 'already_released';
        if (await hasUnderReviewState(page)) return 'submitted_for_review';
        throw new Error('已点击创建版本，但未出现版本表单');
      }

      await fillFirstVisible(page, [
        page.getByPlaceholder(/对用户展示的正式版本号|Version/i),
        page.getByRole('textbox', { name: /版本号|Version/i }),
      ], version);

      await fillFirstVisible(page, [
        page.getByRole('textbox', { name: /更新日志|该内容将展示在应用的更新日志中/i }),
        page.getByRole('textbox').nth(1),
      ], changelog);

      const saved = await clickOne(page, [
        page.getByRole('button', { name: /保存|Save/i }),
      ]);

      if (!saved) {
        throw new Error('未找到“保存”按钮');
      }

      await page.waitForTimeout(1000);
      return 'created_new';
    }
  }

  if ((await viewDetailsBtn.count()) > 0 && await viewDetailsBtn.isVisible().catch(() => false)) {
    await viewDetailsBtn.click({ force: true });
    await page.waitForTimeout(2500);
    if (await hasReleasedState(page)) {
      return 'already_released';
    }
    return 'existing_version_detail';
  }

  if ((await createBtn.count()) > 0 && await createBtn.isVisible().catch(() => false)) {
    const createEnabled = await createBtn.isEnabled().catch(() => false);
    if (!createEnabled) {
      throw new Error('创建版本按钮不可点击，请确认当前账号具备版本发布权限，或应用当前状态允许创建版本');
    }
  }

  throw new Error('无法进入版本发布流程：既不能创建版本，也找不到版本详情入口');
}

async function publishWithBranch(page, reviewNote) {
  if (await hasReleasedState(page)) {
    return 'released';
  }

  const submitBtn = page.getByRole('button', { name: /Submit for release|提交发布|申请线上发布/i }).first();
  if ((await submitBtn.count()) > 0 && await submitBtn.isVisible().catch(() => false)) {
    const ready = await waitButtonReady(submitBtn, 30000);
    if (!ready) {
      throw new Error('提交发布按钮长时间处于 loading 或不可点击状态');
    }
    await submitBtn.click({ force: true });

    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await hasReleasedState(page)) return 'released';
      if (await hasUnderReviewState(page)) return 'submitted_for_review';
    }

    if (await hasReleasedState(page)) return 'released';
    if (await hasUnderReviewState(page)) return 'submitted_for_review';
    throw new Error('点击“提交发布”后状态未变化，请人工检查版本详情页状态');
  }

  const directBtn = page.getByRole('button', { name: /确认发布|Publish/i });
  const reviewBtn = page.getByRole('button', { name: /申请线上发布/i });

  if ((await directBtn.count()) && (await directBtn.first().isVisible())) {
    await directBtn.first().click();
    return 'released';
  }

  if ((await reviewBtn.count()) && (await reviewBtn.first().isVisible())) {
    await fillFirstVisible(page, [
      page.getByRole('textbox', { name: /帮助审核人员|附加信息/i }),
      page.getByRole('textbox').last(),
    ], reviewNote);
    await reviewBtn.first().click();
    return 'submitted_for_review';
  }

  throw new Error('未找到发布按钮：既没有“确认发布”也没有“申请线上发布”');
}

async function run() {
  const args = parseArgs(process.argv);
  const appId = args.appId || process.env.FEISHU_APP_ID;
  const scopesFileArg = args.scopesFile || process.env.FEISHU_SCOPES_FILE;
  const scopesFile = scopesFileArg ? path.resolve(scopesFileArg) : '';
  const scopesFromArg = parseScopesInput(args.scopes || process.env.FEISHU_SCOPES || '');
  const scopesFromFile = scopesFile && fs.existsSync(scopesFile) ? parseScopesFile(scopesFile) : [];
  const scopes = [...new Set([...scopesFromArg, ...scopesFromFile])];
  const forceCreateVersion = parseBool(args.forceCreateVersion || process.env.FEISHU_FORCE_CREATE_VERSION);
  const headless = args.headless !== 'false';
  const version = args.version || nowVersion();
  const changelog = args.changelog || `add scopes: ${scopes.join(', ')}`;
  const reviewNote = args.reviewNote || `[业务场景描述和必要性说明]\n自动化验证权限开通流程\n\n[功能描述（可附需求文档）]\n验证飞书权限开通与发布分支\n\n[权限申请理由]\n${scopes.map((s) => `${s}: 业务接口调用需要`).join('\n')}`;
  const waitForScanMs = Number(args.waitForScanMs || process.env.FEISHU_WAIT_FOR_SCAN_MS || 0);
  const userDataDir = args.userDataDir || process.env.FEISHU_USER_DATA_DIR || path.join(process.cwd(), '.pw-feishu-profile');

  if (!appId) throw new Error('缺少 appId，请用 --appId 传入');
  if (!scopes.length) throw new Error('缺少 scopes，请用 --scopes 或 --scopesFile 传入');

  const outDir = path.join(process.cwd(), 'artifacts', `feishu-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });

  fs.mkdirSync(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    viewport: { width: 1600, height: 1000 },
  });
  const page = context.pages()[0] || await context.newPage();
  const baseInfoUrl = `https://open.feishu.cn/app/${appId}/baseinfo`;

  const result = {
    appId,
    scopes,
    scopesFile: scopesFile || null,
    version,
    status: 'unknown',
    loginRequired: false,
    rateLimited: false,
    currentUrl: '',
    pageTitle: '',
    addedScopes: [],
    skippedScopes: [],
    screenshots: [],
    error: null,
  };

  try {
    await page.goto(baseInfoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 3; i += 1) {
      const rateLimited = await page.getByText(/ratelimit triggered/i).first().isVisible().catch(() => false);
      if (!rateLimited) break;
      result.rateLimited = true;
      if (i === 2) {
        const shot = path.join(outDir, 'rate-limited.png');
        await page.screenshot({ path: shot, fullPage: true });
        result.screenshots.push(shot);
        result.status = 'blocked_rate_limited';
        result.currentUrl = page.url();
        result.pageTitle = await page.title();
        return result;
      }
      await page.waitForTimeout(15000);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    result.currentUrl = page.url();
    result.pageTitle = await page.title();

    const isLoginUrl = () => /accounts\.feishu\.cn/.test(page.url()) || /\/accounts\/page\/login/.test(page.url());
    const loginHints = [
      /扫码登录|登录飞书|Log In With QR Code|Scan the QR code|切换至Lark登录/i,
      /Sign up now|No account yet/i,
    ];
    let loginPage = page.url().includes('/auth') || isLoginUrl();
    if (!loginPage) {
      for (const pattern of loginHints) {
        if (await page.getByText(pattern).first().isVisible().catch(() => false)) {
          loginPage = true;
          break;
        }
      }
    }

    if (loginPage) {
      result.loginRequired = true;
      await waitForQrReady(page, 25000);
      const shot = path.join(outDir, 'login-required.png');
      await page.screenshot({ path: shot, fullPage: true });
      result.screenshots.push(shot);
      console.log(`SCAN_QR=${shot}`);
      if (waitForScanMs > 0) {
        console.log(`WAITING_FOR_SCAN_MS=${waitForScanMs}`);
        const deadline = Date.now() + waitForScanMs;
        while (Date.now() < deadline) {
          await page.waitForTimeout(2000);
          const stillLogin =
            page.url().includes('/auth') ||
            isLoginUrl() ||
            (await page.getByText(/Log In With QR Code|扫码登录|Scan the QR code/i).first().isVisible().catch(() => false));
          if (!stillLogin) break;
        }
      }
      const stillLoginAfterWait =
        page.url().includes('/auth') ||
        isLoginUrl() ||
        (await page.getByText(/Log In With QR Code|扫码登录|Scan the QR code/i).first().isVisible().catch(() => false));
      if (stillLoginAfterWait) {
        result.currentUrl = page.url();
        result.pageTitle = await page.title();
        result.status = 'blocked_login_required';
        return result;
      }

      await page.goto(baseInfoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
    }

    await page.waitForTimeout(2000);
    const navReady = await waitAnyVisible([
      page.getByRole('link', { name: /权限管理|Permission/i }),
      page.getByRole('button', { name: /权限管理|Permission/i }),
      page.getByText(/权限管理|Permission/i),
    ], 35000);
    if (!navReady) {
      throw new Error(`页面未就绪：找不到权限管理入口，当前URL=${page.url()}`);
    }

    await clickOne(page, [
      page.getByRole('link', { name: /权限管理|Permission/i }),
      page.getByRole('button', { name: /权限管理|Permission/i }),
      page.getByText(/权限管理|Permission/i),
    ]);

    await clickOne(page, [
      page.getByRole('button', { name: /Got It|知道了/i }),
    ]);

    for (const scope of scopes) {
      const action = await addScope(page, scope);
      await closeScopeDialogIfOpen(page);
      if (action === 'added') result.addedScopes.push(scope);
      if (action === 'already_enabled') result.skippedScopes.push(scope);
    }

    const allowCreate = forceCreateVersion || result.addedScopes.length > 0;
    const versionFlow = await createVersion(page, version, changelog, { allowCreateNewVersion: allowCreate });
    if (versionFlow === 'already_released' || versionFlow === 'no_changes_skip_create') {
      result.status = 'released';
    } else {
      result.status = await publishWithBranch(page, reviewNote);
    }

    const shot = path.join(outDir, 'result.png');
    await page.screenshot({ path: shot, fullPage: true });
    result.screenshots.push(shot);
    return result;
  } catch (err) {
    const shot = path.join(outDir, 'error.png');
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    result.screenshots.push(shot);
    const message = err?.stack || String(err);
    if (/权限条目不可选择（全部 disabled）|权限结果未就绪或不可选择/.test(message)) {
      result.status = 'blocked_scope_unselectable';
    } else if (/创建版本按钮不可点击/.test(message)) {
      result.status = 'blocked_version_create_disabled';
    } else if (/提交发布按钮长时间处于 loading/.test(message)) {
      result.status = 'blocked_submit_loading';
    } else {
      result.status = 'failed';
    }
    result.error = message;
    return result;
  } finally {
    const out = path.join(outDir, 'result.json');
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
    await context.close();
    console.log(`RESULT_JSON=${out}`);
    console.log(JSON.stringify(result, null, 2));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
