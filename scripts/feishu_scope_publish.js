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
  const patchRaw = `${d.getMonth() + 1}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  const patch = String(Number(patchRaw));
  return `1.${d.getFullYear() % 100}.${patch}`;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function tryClick(locator) {
  if (await locator.count()) {
    const target = locator.first();
    const visible = await target.isVisible().catch(() => false);
    if (!visible) return false;

    try {
      await target.scrollIntoViewIfNeeded().catch(() => {});
      await target.click({ timeout: 3000 });
      return true;
    } catch (_) {}

    try {
      await target.click({ force: true, timeout: 3000 });
      return true;
    } catch (_) {}

    try {
      await target.evaluate((el) => {
        if (typeof el.click === 'function') el.click();
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
      });
      return true;
    } catch (_) {}
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
    const count = await locator.count().catch(() => 0);
    if (count <= 0) continue;
    const limit = Math.min(count, 8);
    for (let i = 0; i < limit; i += 1) {
      const input = locator.nth(i);
      const visible = await input.isVisible().catch(() => false);
      if (!visible) continue;
      try {
        await input.click({ force: true });
        await input.fill(value);
        return true;
      } catch (_) {}
      try {
        await input.evaluate((node, val) => {
          const isTextarea = node instanceof HTMLTextAreaElement;
          const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(node, val);
          else node.value = val;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
        return true;
      } catch (_) {}
    }
  }
  return false;
}

async function fillReviewNoteField(page, reviewNote) {
  const note = String(reviewNote || '').trim();
  if (!note) return false;

  const directFilled = await fillFirstVisible(page, [
    page.getByRole('textbox', { name: /帮助审核人员|附加信息|Reason for request/i }),
    page.getByPlaceholder(/Business scenario|helps the approver|advanced scopes|帮助审核人员|附加信息|审核/i),
    page.locator('textarea[placeholder*="Business scenario"], textarea[placeholder*="approver"], textarea[placeholder*="advanced scopes"], textarea[placeholder*="审核"], textarea[placeholder*="附加信息"], textarea[placeholder*="approver know more"]').first(),
  ], note);
  if (directFilled) return true;

  const textareas = page.locator('textarea');
  const count = await textareas.count().catch(() => 0);
  if (count <= 0) return false;
  const target = count >= 2 ? textareas.nth(1) : textareas.first();
  const visible = await target.isVisible().catch(() => false);
  if (!visible) return false;

  await target.click({ force: true }).catch(() => {});
  await target.fill('').catch(() => {});
  await target.fill(note).catch(() => {});
  await target.dispatchEvent('input').catch(() => {});
  await target.dispatchEvent('change').catch(() => {});
  return true;
}

async function waitForQrReady(page, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const loadingVisible = await page.getByText(/Loading|加载中/i).first().isVisible().catch(() => false);
    const qrFrameVisible = await page.locator('canvas, img[alt*=\"QR\"], img[src*=\"qr\"], .qrcode').first().isVisible().catch(() => false);
    if (!loadingVisible && qrFrameVisible) return;
    await page.waitForTimeout(300);  // 更快轮询
  }
}

async function ensureTenantTab(root) {
  const ok = await clickOne(root, [
    root.getByRole('tab', { name: /Tenant token scopes/i }),
    root.getByText(/Tenant token scopes/i),
  ]);
  return ok;
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

async function hasPendingChangesBanner(page) {
  const patterns = [
    /The changes will take effect after the current version is published/i,
    /版本发布后，当前修改方可生效|当前修改方可生效/i,
    /To be published|待发布/i,
  ];
  for (const pattern of patterns) {
    if (await page.getByText(pattern).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

async function hasReleasedState(page) {
  if (await hasPendingChangesBanner(page)) return false;

  if (await hasNotRequestedState(page)) return false;
  if (await hasSubmitForReleaseButton(page)) return false;

  const patterns = [
    /Version Details\s*Released/i,
    /Released at/i,
    /Review result\s*Approved/i,
    /The current changes have been published/i,
    /版本详情.*已发布|审核结果.*通过|发布成功/i,
  ];
  for (const pattern of patterns) {
    if (await page.getByText(pattern).first().isVisible().catch(() => false)) return true;
  }

  const detailVisible = await page.getByText(/Version Details|版本详情/i).first().isVisible().catch(() => false);
  if (detailVisible) {
    const badgeVisible = await page.getByText(/^Released$|^已发布$|审核通过/i).first().isVisible().catch(() => false);
    if (badgeVisible) return true;
  }

  return false;
}

async function hasUnderReviewState(page) {
  if (await hasNotRequestedState(page)) return false;
  const withdrawVisible = await page.getByRole('button', { name: /Withdraw|撤回/i }).first().isVisible().catch(() => false);
  if (withdrawVisible) return true;
  const patterns = [
    /Under review|审核中|审批中|待审批/i,
    /Submitted|已提交/i,
    /Withdraw|撤回/i,
    /Launch Feishu Approval|去飞书审批/i,
  ];
  for (const pattern of patterns) {
    if (await page.getByText(pattern).count()) return true;
  }
  return false;
}

async function hasNotRequestedState(page) {
  const patterns = [
    /Not Requested|待申请/i,
  ];
  for (const pattern of patterns) {
    if (await page.getByText(pattern).count()) return true;
  }
  return false;
}

async function hasSubmitForReleaseButton(page) {
  const btn = page.getByRole('button', { name: /Submit for release|申请线上发布|提交发布|申请发布/i }).first();
  return (await btn.count().catch(() => 0)) > 0 && await btn.isVisible().catch(() => false);
}

async function waitVersionPostSaveState(page, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await hasReleasedState(page)) return 'released';
    if (await hasUnderReviewState(page)) return 'submitted_for_review';
    if (await hasNotRequestedState(page)) return 'created_new';
    if (await hasSubmitForReleaseButton(page)) return 'created_new';
    if (/\/version\/\d+/.test(page.url())) return 'created_new';
    await page.waitForTimeout(500);
  }
  return '';
}

async function waitPageReady(page, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const spinning = await page.locator('.ud__spin, [class*="loading"]').first().isVisible().catch(() => false);
    if (!spinning) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

async function ensureVersionDetailsVisible(page) {
  await waitPageReady(page, 15000);
  if (await hasReleasedState(page) || await hasUnderReviewState(page) || await hasNotRequestedState(page)) {
    return;
  }

  const entered = await clickOne(page, [
    page.getByText(/View Version Details|查看版本详情/i),
    page.getByRole('button', { name: /View Version Details|查看版本详情/i }),
    page.getByRole('link', { name: /View Version Details|查看版本详情/i }),
  ]);
  if (entered) {
    await page.waitForTimeout(1200);
    await waitPageReady(page, 15000);
  }
}

async function clickSubmitForRelease(page) {
  const regex = /Submit for release|申请线上发布|提交发布|申请发布/i;

  const submitBtn = page.getByRole('button', { name: regex }).first();
  if ((await submitBtn.count().catch(() => 0)) > 0) {
    const visible = await submitBtn.isVisible().catch(() => false);
    const enabled = await submitBtn.isEnabled().catch(() => false);
    if (visible && enabled) {
      await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
      await submitBtn.click({ force: true }).catch(() => {});
      return true;
    }
  }

  const clicked = await clickOne(page, [
    submitBtn,
    page.getByRole('link', { name: regex }),
    page.getByText(regex),
  ]);
  if (clicked) return true;

  const jsClicked = await page.evaluate(() => {
    const re = /Submit for release|申请线上发布|提交发布|申请发布/i;
    const nodes = Array.from(document.querySelectorAll('button, a, span, div'))
      .filter((el) => {
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt || txt.length > 40) return false;
        if (!re.test(txt)) return false;
        return el.getClientRects().length > 0;
      });
    const target = nodes[0];
    if (!target) return false;
    if (typeof target.click === 'function') target.click();
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    return true;
  }).catch(() => false);
  return jsClicked;
}

function parseApprovalFromRowText(scope, rowText) {
  if (!rowText) return 'unknown';
  const compact = String(rowText).replace(/\s+/g, '');
  const idx = compact.toLowerCase().indexOf(String(scope).toLowerCase());
  const tail = idx >= 0 ? compact.slice(idx + scope.length, idx + scope.length + 40) : compact;
  if (/Yes|需要|需审批|NeedApproval/i.test(tail)) return 'yes';
  if (/No|无需|免审批|NoApproval/i.test(tail)) return 'no';
  if (/Yes|需要|需审批|NeedApproval/i.test(compact)) return 'yes';
  if (/No|无需|免审批|NoApproval/i.test(compact)) return 'no';
  return 'unknown';
}

function parseScopeAddedStateFromRowText(rowText) {
  if (!rowText) return 'unknown';
  const text = String(rowText).replace(/\s+/g, ' ').trim();
  if (/To be published|待发布|待生效/i.test(text)) return 'to_be_published';
  if (/Not\s*Added|未添加|未开通|未启用/i.test(text)) return 'not_added';
  if (/\bAdded\b|已添加|已开通|已启用/i.test(text)) return 'added';
  return 'unknown';
}

async function inspectScopeApproval(page, scope) {
  const info = {
    scope,
    approvalRequired: 'unknown',
    rowText: '',
    tab: 'unknown',
  };

  const opened = await clickOne(page, [
    page.getByRole('button', { name: /开通权限|Add permission scopes to app/i }),
  ]);
  if (!opened) return info;

  const dialog = page.getByRole('dialog').first();
  const searchInCurrentTab = async () => {
    await waitAnyVisible([
      dialog.getByPlaceholder(/例如：获取群组信息|im:chat:readonly|scope|E\.g\./i),
      dialog.getByRole('textbox').first(),
    ], 6000);

    let filled = await fillFirstVisible(page, [
      dialog.getByPlaceholder(/例如：获取群组信息|im:chat:readonly|scope|E\.g\./i),
      dialog.getByRole('textbox').first(),
    ], scope);
    if (!filled) {
      const fallbackInput = dialog.locator('input.ud__native-input, input[placeholder], input').first();
      if (await fallbackInput.count()) {
        await fallbackInput.fill(scope).catch(() => {});
        filled = true;
      }
    }
    if (!filled) return false;

    for (let i = 0; i < 16; i += 1) {
      await page.waitForTimeout(300);
      const found = await dialog.getByText(new RegExp(escapeRegex(scope), 'i')).count();
      if (found > 0) break;
    }

    const row = dialog
      .locator('.virtual-table__row, tr, .ud__table-row')
      .filter({ hasText: new RegExp(escapeRegex(scope), 'i') })
      .first();
    if (!(await row.count())) {
      const dialogText = ((await dialog.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!new RegExp(escapeRegex(scope), 'i').test(dialogText)) return false;
      info.rowText = dialogText.slice(0, 800);
      info.approvalRequired = parseApprovalFromRowText(scope, dialogText);
      return true;
    }
    const rowText = ((await row.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    info.rowText = rowText.slice(0, 400);
    info.approvalRequired = parseApprovalFromRowText(scope, rowText);
    return true;
  };

  await ensureTenantTab(dialog);
  info.tab = 'tenant';
  let found = await searchInCurrentTab();

  if (!found) {
    let switched = false;
    const userTabByRole = dialog.getByRole('tab', { name: /User token scopes/i });
    if ((await userTabByRole.count()) > 0) {
      const last = userTabByRole.last();
      if (await last.isVisible().catch(() => false)) {
        await last.click({ force: true }).catch(() => {});
        switched = true;
      }
    }
    if (!switched) {
      const userTabByText = dialog.getByText(/User token scopes/i);
      if ((await userTabByText.count()) > 0) {
        const last = userTabByText.last();
        if (await last.isVisible().catch(() => false)) {
          await last.click({ force: true }).catch(() => {});
          switched = true;
        }
      }
    }
    if (switched) {
      info.tab = 'user';
      found = await searchInCurrentTab();
    }
  }

  await closeScopeDialogIfOpen(page);
  return info;
}

async function triggerPublishFromScopeRow(page, appId, scope) {
  const authUrl = `https://open.feishu.cn/app/${appId}/auth`;
  await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);
  await waitPageReady(page, 15000);

  await fillFirstVisible(page, [
    page.getByPlaceholder(/Search|E\.g\.|例如：获取群组信息|im:chat:readonly/i),
    page.locator('input[placeholder*="Search"], input[placeholder*="E.g"], input[placeholder*="例如"]').first(),
  ], scope);
  await page.waitForTimeout(1000);

  const row = page
    .locator('tr, .virtual-table__row, .ud__table-row')
    .filter({ hasText: new RegExp(escapeRegex(scope), 'i') })
    .first();
  if (!(await row.count().catch(() => 0))) {
    return { clicked: false, rowText: '' };
  }

  const rowText = ((await row.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const toBePublished = /To be published|待发布/i.test(rowText);
  if (!toBePublished) {
    return { clicked: false, rowText };
  }

  const clicked = await clickOne(page, [
    row.getByRole('button', { name: /^Publish$|^发布$/i }),
    row.getByRole('link', { name: /^Publish$|^发布$/i }),
    row.getByText(/^Publish$|^发布$/i),
  ]);
  if (!clicked) {
    return { clicked: false, rowText };
  }

  await page.waitForTimeout(1200);
  await waitPageReady(page, 15000);
  return { clicked: true, rowText };
}

async function addScope(page, scope) {
  const mainSearch = page.getByPlaceholder(/E\.g\.|例如：获取群组信息|im:chat:readonly/i).first();
  if (await mainSearch.count()) {
    await mainSearch.click({ force: true });
    await mainSearch.fill(scope);
    await page.waitForTimeout(700);
  }

  const readMainScopeState = async (loops = 10) => {
    for (let i = 0; i < loops; i += 1) {
      const rowText = await page
        .locator('tr, .virtual-table__row, .ud__table-row')
        .evaluateAll((rows, needle) => {
          const key = String(needle || '').toLowerCase();
          for (const row of rows) {
            const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.toLowerCase().includes(key)) return text;
          }
          return '';
        }, scope)
        .catch(() => '');
      const state = parseScopeAddedStateFromRowText(rowText);
      if (state !== 'unknown') return { state, rowText };
      await page.waitForTimeout(250);
    }
    return { state: 'unknown', rowText: '' };
  };

  const preState = await readMainScopeState(14);
  if (preState.state === 'added') return 'already_enabled';
  if (preState.state === 'to_be_published') return 'pending_publish';

  const opened = await clickOne(page, [
    page.getByRole('button', { name: /开通权限|Add permission scopes to app/i }),
  ]);

  if (!opened) {
    throw new Error('未找到“开通权限”按钮');
  }

  await ensureTenantTab(page.getByRole('dialog').first());

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
  const postState = await readMainScopeState(14);
  if (postState.state === 'to_be_published' || postState.state === 'added') {
    return 'added';
  }
  return 'added';
}

async function createVersion(page, version, changelog, options = {}) {
  const allowCreateNewVersion = options.allowCreateNewVersion !== false;
  const reviewNote = String(options.reviewNote || '');
  const appId = String(options.appId || '').trim();

  const enterVersionArea = async () => {
    if (/\/version(\/|$)/.test(page.url())) return true;
    const goRelease = await clickOne(page, [
      page.getByRole('link', { name: /版本管理与发布|Version management/i }),
      page.getByText(/版本管理与发布|Version management/i),
    ]);
    if (!goRelease) return false;
    await page.waitForTimeout(1200);
    return true;
  };

  if (!(await enterVersionArea())) {
    throw new Error('未找到“版本管理与发布”入口');
  }

  const createBtn = page.getByRole('button', { name: /创建版本|Create Version|Create a version/i }).first();
  const createLink = page.getByRole('link', { name: /创建版本|Create Version|Create a version/i }).first();
  const viewDetailsBtn = page.getByText(/View Version Details|查看版本详情/i).first();
  const saveBtn = page.getByRole('button', { name: /保存|Save/i }).first();
  const versionInputCandidates = [
    page.getByPlaceholder(/对用户展示的正式版本号|上一个版本号为|official app version number|last version number|version number|previous version/i),
    page.locator('input[placeholder*="版本号"], input[placeholder*="Version number"], input[placeholder*="version number"], input[placeholder*="previous version"], input[placeholder*="last version number"], input[placeholder*="Official app version"]').first(),
  ];

  if (await hasReleasedState(page)) return 'already_released';
  if (await hasUnderReviewState(page)) return 'submitted_for_review';

  const pendingChanges = await hasPendingChangesBanner(page);
  if (!allowCreateNewVersion && !pendingChanges) {
    if ((await viewDetailsBtn.count()) > 0 && await viewDetailsBtn.isVisible().catch(() => false)) {
      await viewDetailsBtn.click({ force: true });
      await page.waitForTimeout(2500);
      if (await hasReleasedState(page)) return 'already_released';
      return 'existing_version_detail';
    }
    if (await hasReleasedState(page)) return 'already_released';
    return 'no_changes_skip_create';
  }

  const createCandidates = [
    createBtn,
    createLink,
    page.getByText(/^Create Version$/i),
    page.getByText(/创建版本|Create Version|Create a version/i),
  ];
  let clickedCreate = await clickOne(page, createCandidates);
  if (!clickedCreate && appId) {
    await page.goto(`https://open.feishu.cn/app/${appId}/version/create`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    clickedCreate = true;
  }

  if (clickedCreate) {
    const entryReady = await waitAnyVisible([
      ...versionInputCandidates,
      page.getByPlaceholder(/该内容将展示在应用的更新日志中|This will appear in the app's changelog/i),
      saveBtn,
      page.getByRole('button', { name: /编辑|Edit/i }),
      page.getByRole('button', { name: /返回|Back/i }),
    ], 20000);
    if (!entryReady) {
      if (await hasReleasedState(page)) return 'already_released';
      if (await hasUnderReviewState(page)) return 'submitted_for_review';
      throw new Error('已点击创建版本，但未进入可编辑页面');
    }

    for (let i = 0; i < 20; i += 1) {
      const loadingVisible = await page.locator('.ud__spin, [class*="loading"]').first().isVisible().catch(() => false);
      if (!loadingVisible) break;
      await page.waitForTimeout(400);
    }

    const editorReady = await waitAnyVisible([
      ...versionInputCandidates,
      page.getByPlaceholder(/该内容将展示在应用的更新日志中|This will appear in the app's changelog/i),
      page.locator('textarea').first(),
    ], 12000);
    if (!editorReady) {
      throw new Error('创建版本页面尚未就绪，未找到可编辑输入框');
    }

    const versionFilled = await fillFirstVisible(page, versionInputCandidates, version);
    if (!versionFilled) {
      throw new Error(`未找到版本号输入框，version=${version}`);
    }

    const changelogFilled = await fillFirstVisible(page, [
      page.getByRole('textbox', { name: /更新日志|该内容将展示在应用的更新日志中|changelog/i }),
      page.getByPlaceholder(/该内容将展示在应用的更新日志中|This will appear in the app's changelog/i),
      page.locator('textarea[placeholder*="changelog"], textarea[placeholder*="更新日志"]').first(),
      page.locator('textarea').first(),
    ], changelog);
    if (!changelogFilled) {
      throw new Error('未找到更新日志输入框');
    }

    const reasonBoxCount = await page.locator('textarea').count().catch(() => 0);
    const reasonFilled = await fillReviewNoteField(page, reviewNote);
    if (reasonBoxCount >= 2 && !reasonFilled) {
      throw new Error('未找到审核说明输入框');
    }

    const saveVisible = (await saveBtn.count().catch(() => 0)) > 0 && await saveBtn.isVisible().catch(() => false);
    if (!saveVisible) {
      throw new Error('未找到“保存”按钮');
    }
    await saveBtn.scrollIntoViewIfNeeded().catch(() => {});
    const saveReady = await waitButtonReady(saveBtn, 12000);
    if (!saveReady) {
      throw new Error('保存按钮不可点击或处于 loading');
    }

    const beforeUrl = page.url();
    const saveRequestPromise = page.waitForResponse((res) => {
      const method = res.request().method();
      if (!['POST', 'PUT', 'PATCH'].includes(method)) return false;
      const url = res.url();
      return /app_version\/(create|update|save|submit)|developers\/v1\/app_version\//i.test(url);
    }, { timeout: 12000 }).catch(() => null);

    await saveBtn.click().catch(async () => {
      await saveBtn.click({ force: true });
    });

    const saveRequest = await saveRequestPromise;
    let saveCode = null;
    if (saveRequest) {
      saveCode = await saveRequest.json().then((j) => (typeof j?.code === 'number' ? j.code : null)).catch(() => null);
    }

    await page.waitForTimeout(1200);

    const duplicateVersion = await page.getByText(/版本号.*已存在|Version.*already exists|duplicate/i).first().isVisible().catch(() => false);
    if (duplicateVersion) {
      throw new Error(`保存版本失败：版本号已存在，version=${version}`);
    }

    const reasonRequiredOnCreate = await page.getByText(/Please fill in the reason for request|请填写.*原因|请补充.*理由/i).first().isVisible().catch(() => false);
    if (reasonRequiredOnCreate) {
      throw new Error('创建版本被拦截：审核说明未填写或未生效');
    }

    const postSaveState = await waitVersionPostSaveState(page, 15000);
    if (postSaveState === 'submitted_for_review') return 'submitted_for_review';
    if (postSaveState === 'released') return 'already_released';
    if (postSaveState === 'created_new') return 'created_new';

    if (saveCode === 0) return 'created_new';
    if (beforeUrl !== page.url()) return 'created_new';

    if (/\/version\/create/.test(page.url())) {
      const hints = await page
        .locator('[class*="error"], .ud__form-item-explain, .ud__form-error')
        .allTextContents()
        .catch(() => []);
      const compactHints = hints.map((t) => String(t).trim()).filter(Boolean).slice(0, 4).join(' | ');
      throw new Error(`保存后仍停留在创建页，疑似字段校验未通过。${compactHints ? `提示=${compactHints}` : ''}`);
    }

    const createAgainVisible =
      await page.getByRole('button', { name: /创建版本|Create Version|Create a version/i }).first().isVisible().catch(() => false) ||
      await page.getByRole('link', { name: /创建版本|Create Version|Create a version/i }).first().isVisible().catch(() => false);
    if (createAgainVisible) {
      return 'no_changes_skip_create';
    }

    return 'created_new';
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

async function scrollToBottom(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(300);
}

async function collectVisibleButtonTexts(page) {
  return page.locator('button').evaluateAll((buttons) => {
    const visible = buttons.filter((btn) => {
      const style = window.getComputedStyle(btn);
      const hidden = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
      return !hidden && btn.getClientRects().length > 0;
    });
    return visible
      .map((btn) => (btn.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 30);
  }).catch(() => []);
}

async function publishWithBranch(page, reviewNote) {
  if (await hasReleasedState(page)) return 'released';
  if (await hasUnderReviewState(page)) return 'submitted_for_review';

  await ensureVersionDetailsVisible(page);
  if (await hasReleasedState(page)) return 'released';
  if (await hasUnderReviewState(page)) return 'submitted_for_review';

  const waitPublishOutcome = async () => {
    for (let i = 0; i < 60; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await hasReleasedState(page)) return 'released';
      if (await hasUnderReviewState(page)) return 'submitted_for_review';
    }
    return '';
  };

  const clickAnyConfirm = async () => {
    for (let i = 0; i < 3; i += 1) {
      const clicked = await clickOne(page, [
        page.getByRole('dialog').getByRole('button', { name: /确认|Confirm|继续|提交|Submit|发布|Publish/i }),
        page.getByRole('button', { name: /确认|Confirm|继续|提交|Submit|发布|Publish/i }),
        page.getByText(/确认|Confirm|继续|提交|Submit/i),
      ]);
      if (!clicked) return;
      await page.waitForTimeout(500);
    }
  };

  const clickDirectPublish = async () => {
    const regex = /确认发布|立即发布|Confirm publish|Publish now|发布版本/i;
    return clickOne(page, [
      page.getByRole('button', { name: regex }),
      page.getByRole('link', { name: regex }),
      page.getByText(regex),
    ]);
  };

  await fillReviewNoteField(page, reviewNote);
  await scrollToBottom(page);

  let clicked = false;
  const hasSubmit = await hasSubmitForReleaseButton(page);
  if (hasSubmit) {
    clicked = await clickSubmitForRelease(page);
  } else {
    clicked = await clickDirectPublish();
  }

  if (!clicked) {
    await ensureVersionDetailsVisible(page);
    await fillReviewNoteField(page, reviewNote);
    await scrollToBottom(page);
    if (await hasSubmitForReleaseButton(page)) {
      clicked = await clickSubmitForRelease(page);
    } else {
      clicked = await clickDirectPublish();
    }
  }

  if (clicked) {
    await clickAnyConfirm();
    const outcome = await waitPublishOutcome();
    if (outcome) return outcome;
  }

  if (await hasSubmitForReleaseButton(page)) {
    clicked = await clickSubmitForRelease(page);
    if (clicked) {
      await clickAnyConfirm();
      const outcome = await waitPublishOutcome();
      if (outcome) return outcome;
    }
  }

  if (await hasReleasedState(page)) return 'released';
  if (await hasUnderReviewState(page)) return 'submitted_for_review';

  const reasonRequired = await page.getByText(/Please fill in the reason for request|请填写.*原因|请补充.*理由/i).first().isVisible().catch(() => false);
  if (reasonRequired) {
    throw new Error('发布被拦截：审核说明未填写或未生效，请检查 Reason for request 文本框');
  }

  const visibleButtons = await collectVisibleButtonTexts(page);
  const notRequested = await hasNotRequestedState(page);
  throw new Error(`发布后状态未变化：${notRequested ? '仍为待申请（申请线上发布未成功触发）' : '未进入 Released/Under review'}。可见按钮=${visibleButtons.join(' | ')}`);
}

async function run() {
  const args = parseArgs(process.argv);
  
  // 自动从 openclaw.json 读取 appId（如果未提供）
  let appId = args.appId || process.env.FEISHU_APP_ID;
  if (!appId) {
    const openclawConfigPath = path.join(process.env.HOME || '/home/q', '.openclaw', 'openclaw.json');
    try {
      if (fs.existsSync(openclawConfigPath)) {
        const config = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
        appId = config?.channels?.feishu?.appId;
        if (appId) {
          console.log(`AUTO_LOADED_APP_ID=${appId}`);
        }
      }
    } catch (e) {
      // ignore
    }
  }
  
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

  const outDir = path.join(
    process.cwd(),
    'artifacts',
    `feishu-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`
  );
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
    pendingScopes: [],
    skippedScopes: [],
    scopeChecks: [],
    versionFlow: null,
    versionCreated: false,
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

    // 输出登录状态
    console.log(`LOGIN_STATUS=${loginPage ? '需要登录' : '已登录'}`);

    if (loginPage) {
      result.loginRequired = true;
      await waitForQrReady(page, 10000);
      
      // 尝试只截取二维码区域
      const qrLocator = page.locator('canvas, img[alt*=\"QR\"], img[src*=\"qr\"], .qrcode, [class*=\"qr\"]').first();
      const qrVisible = await qrLocator.isVisible().catch(() => false);
      
      let shot;
      if (qrVisible) {
        // 截取二维码区域
        shot = path.join(outDir, 'login-required.png');
        await qrLocator.screenshot({ path: shot }).catch(async () => {
          // 如果截取二维码失败，回退到整个页面
          await page.screenshot({ path: shot, fullPage: true });
        });
      } else {
        // 没找到二维码元素，截取整个页面
        shot = path.join(outDir, 'login-required.png');
        await page.screenshot({ path: shot, fullPage: true });
      }
      
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
      const check = await inspectScopeApproval(page, scope);
      result.scopeChecks.push(check);
      const action = await addScope(page, scope);
      await closeScopeDialogIfOpen(page);
      if (action === 'added') result.addedScopes.push(scope);
      if (action === 'pending_publish') result.pendingScopes.push(scope);
      if (action === 'already_enabled') result.skippedScopes.push(scope);
    }

    const allowCreate = forceCreateVersion || result.addedScopes.length > 0 || result.pendingScopes.length > 0;
    const versionFlow = await createVersion(page, version, changelog, {
      allowCreateNewVersion: allowCreate,
      reviewNote,
      appId,
    });
    let finalVersionFlow = versionFlow;
    let finalStatus = '';
    const needPublishScopes = [...result.addedScopes, ...result.pendingScopes];

    if (versionFlow === 'no_changes_skip_create' && needPublishScopes.length > 0) {
      const fallback = await triggerPublishFromScopeRow(page, appId, needPublishScopes[0]);
      if (fallback.clicked) {
        const fallbackFlow = await createVersion(page, version, changelog, {
          allowCreateNewVersion: true,
          reviewNote,
          appId,
        });
        finalVersionFlow = `fallback:${fallbackFlow}`;
        if (fallbackFlow === 'submitted_for_review') {
          finalStatus = 'submitted_for_review';
        } else {
          finalStatus = await publishWithBranch(page, reviewNote);
        }
      } else {
        throw new Error(`权限待发布但未创建版本，且未找到可点击的发布入口。scope=${needPublishScopes[0]} row=${fallback.rowText}`);
      }
    }

    if (!finalStatus) {
      if (finalVersionFlow === 'submitted_for_review') {
        finalStatus = 'submitted_for_review';
      } else if (finalVersionFlow === 'no_changes_skip_create' && needPublishScopes.length === 0) {
        finalStatus = await hasPendingChangesBanner(page) ? await publishWithBranch(page, reviewNote) : 'released';
      } else {
        finalStatus = await publishWithBranch(page, reviewNote);
      }
    }

    result.versionFlow = finalVersionFlow;
    result.versionCreated = /created_new|submitted_for_review/i.test(finalVersionFlow);
    result.status = finalStatus;

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
