---
name: feishu-permission-setup
description: 通过浏览器自动化为飞书自建应用开通 Tenant token 权限并发布版本以使权限生效。用于飞书 API 返回 99991672 权限不足、用户要求“开通/申请飞书权限”、或需要新增 Feishu scope（如 docx/drive/im/base）时。自动判断并处理两种发布路径：免审核直接发布与需线上审核提交。
---

# 飞书权限开通与发布（Tenant Token）

## 目标

- 开通缺失的 Tenant token scopes。
- 创建新版本并完成发布流程。
- 自动分流到“确认发布（免审核）”或“申请线上发布（需审核）”。
- 仅在 session 失效时请求人工扫码。

## 输入

- 必填：`app_id`（例如 `cli_xxx`）。
- 选填：`required_scopes`（如 `docx:document:create`）。
- 选填：`version`、`changelog`、`review_note`。
- 禁止：记录或输出 `app_secret`；若用户在对话中泄露，提醒立即轮换。

## 脚本优先模式（推荐）

已知 scope 列表时，默认直接运行脚本，不做 AI 推断。脚本路径：

- `scripts/feishu_scope_publish.js`

执行方式：

```bash
node scripts/feishu_scope_publish.js \
  --appId cli_xxx \
  --scopes attendance:task:readonly,attendance:rule:readonly \
  --waitForScanMs 240000
```

或使用文件输入 scope（每行一个，支持 `#` 注释）：

```bash
node scripts/feishu_scope_publish.js \
  --appId cli_xxx \
  --scopesFile scripts/scopes.example.txt \
  --waitForScanMs 240000
```

脚本输出：

- 终端输出 `RESULT_JSON=<path>`。
- JSON 内包含 `addedScopes`、`skippedScopes`、`status`、`error`、截图路径。
- `status` 常见值：`released`、`submitted_for_review`、`blocked_login_required`。
- 默认策略：仅当存在 `addedScopes` 时才创建新版本；若全部是 `skippedScopes`，只校验当前版本发布状态，不强制新建版本。
- 如需每次都强制创建新版本，可显式传 `--forceCreateVersion true`。

## 决策树

1. 若已知权限列表，直接进入 Step 2。
2. 若未知权限，先调用目标 API；从 `99991672` 的报错中提取 `[...]` 内 scope。
3. 打开 `https://open.feishu.cn/app/{app_id}/baseinfo`。
4. 若落在登录页（常见为 `https://accounts.feishu.cn/accounts/page/login...`，也可能是 `/auth`），则执行扫码登录；否则复用现有 session。
5. 在“权限管理”里只操作 `Tenant token scopes`。
6. 创建版本并保存。
7. 发布分支：
- 若存在 `确认发布` 或 `Publish`，执行直接发布。
- 否则若存在 `申请线上发布`，填写审核说明并提交审核。
8. 重新调用 API 验证权限是否生效。

## 稳定性规范（必须遵守）

- 只使用原始 URL：`page.goto('https://...')`，不要传 Markdown 链接文本。
- 优先 `getByRole`、`getByPlaceholder`、`getByText`；禁止用 `div:nth-child(...)` 定位核心动作。
- 勾选权限时，先按 scope 文本定位行，再在该行内找 checkbox，不使用固定 `nth(4)` 或第 N 行。
- 每个关键步骤后等待明确信号（对话框消失、toast 成功、按钮状态变化、URL 变化）。
- 中文和英文按钮都做兼容匹配。
- 登录二维码截图前先等待 `Loading` 消失，避免用户扫到无效码。
- 发现页面文案为 `ratelimit triggered` 时停止点击，退避后重试，避免被限流放大。
- 使用持久化浏览器 profile，避免每次重跑都要重新扫码。
- 创建版本页不要额外点击 `Edit`，按“创建版本 -> 填写 -> 保存”直通路径执行，避免触发额外必填导致保存失败。
- 版本号使用 `x.y.z` 数字格式，第三段不要以 `0` 开头（如 `1.26.3136959731`），否则会被页面校验拦截。

## 标准流程

### Step 1：提取缺失权限

- 调用失败 API。
- 匹配：`/\[(.*?)\]/`，得到 scopes。
- 若提取为空，停止自动化并让用户确认具体权限名。

### Step 2：进入控制台并判断登录状态（实测强化）

- 打开：`https://open.feishu.cn/app/{app_id}/baseinfo`。
- 若 URL 跳转到 `accounts.feishu.cn/accounts/page/login`（或 `/auth`）：
- 等待二维码不再显示 `Loading` 后再截图。
- 截图二维码并请求用户扫码。
- 等待页面回到应用控制台后继续。
- 扫码成功后再次 `goto(baseinfo)`，确保进入目标应用页而不是首页骨架屏。

### Step 3：开通 Tenant token scopes

1. 点击“权限管理”。
2. 若有引导弹窗，点击 `Got It` / `知道了`。
3. 点击“开通权限”（或英文同义按钮）。
4. 明确切到 `Tenant token scopes` 标签。
5. 对每个 scope：
- 在搜索框输入 scope。
- 在包含该 scope 文本的行里勾选 checkbox。
6. 点击“确认开通权限”/`Add Scopes`。

实测必加预检：

- 若弹窗内所有 checkbox 均为 disabled，立即停止并提示：
- 当前登录账号可能不是该 App 管理员，或该应用当前状态不允许编辑权限。
- 这类场景不应继续盲点 `Add Scopes`，否则只会稳定失败。
- 先在主表格搜索 scope；若状态已经是 `Added`，直接标记为已存在并跳过，不重复加。
- 实测示例：`admin:app.category:update` 显示 `Approval required = Yes`，说明“能申请”与“需审核”是两个阶段，不是 app_id 错误。

### Step 4：创建版本

1. 点击“版本管理与发布”。
2. 点击“创建版本”。
3. 填写版本号与更新日志（版本号需符合 `1.0.0` 格式且建议单调递增）。
4. 点击“保存”。

发布权限预检（实测必加）：

- 若 `Create a version` 按钮是 disabled，直接中止并提示用户：
- 当前账号缺少版本发布权限，或应用状态暂不允许创建版本。
- 这一步与 scope 是否已添加无关；scope 已添加后仍可能卡在这里。
- 若 `Create a version` 按钮 disabled 但页面存在 `View Version Details`，优先进入版本详情页继续流程，不要直接报错。
- 若版本详情出现 `Released` 或顶部提示 `The current changes have been published`，直接判定为已发布成功，无需重复提交。

输入框对 `fill` 不响应时，使用原生 setter 回退：

```javascript
(() => {
  const iSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const tSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  const versionInput = document.querySelector('input[placeholder*="版本号"], input[placeholder*="Version"]');
  const logInput = document.querySelector('textarea');
  iSet.call(versionInput, '1.0.0');
  versionInput.dispatchEvent(new Event('input', { bubbles: true }));
  tSet.call(logInput, 'Add scopes');
  logInput.dispatchEvent(new Event('input', { bubbles: true }));
})();
```

### Step 5：发布分流（关键）

保存成功后按下面顺序判断：

1. 若可见 `确认发布` 或 `Publish`：点击并完成直接发布。
2. 否则若可见 `申请线上发布`：
- 填写审核补充说明（`review_note`）。
- 点击“申请线上发布”。
3. 两者都不存在：报错并截图当前页面给用户。

审核说明建议模板：

```text
[业务场景描述和必要性说明]
<场景说明>

[功能描述（可附需求文档）]
<功能说明>

[权限申请理由]
<scope1>: <理由>
<scope2>: <理由>
```

### Step 6：验证

- 直接发布路径：检查版本状态是否 `Released`，然后重试 API。
- 线上审核路径：提示“已提交审核，待审批后生效”；可定时轮询状态。
- 若仍报 `99991672`：
- 确认 scope 在 Tenant token 下而非 User token。
- 确认最新版本已保存并成功提交发布。
- 若自动化中途出现 `ratelimit triggered`，等待后重试一次再判断结果。
- 若无法创建版本（按钮 disabled），先让具备发布权限的管理员完成版本创建/发布，再进行 API 验证。

## Playwright 实现要点

- 用统一 helper 做“多候选按钮点击”，兼容中英文文案。
- 用 `expect(locator).toBeVisible()` 作为关键断言。
- 每次页面跳转后先 `waitForLoadState('domcontentloaded')`。
- 在权限表格中定位 scope 时，使用 `row.filter({ hasText: scope })`。
- 对搜索结果不稳定页面，允许降级为 `textContent includes(scope)` 的 DOM 匹配。
- 在点击确认前先断言 `Add Scopes` 已 enabled；否则输出“不可勾选”原因并中止。

发布分流示例：

```ts
const directBtn = page.getByRole('button', { name: /确认发布|Publish/i });
const reviewBtn = page.getByRole('button', { name: /申请线上发布/i });

if (await directBtn.isVisible()) {
  await directBtn.click();
} else if (await reviewBtn.isVisible()) {
  await page.getByRole('textbox', { name: /帮助审核人员|附加信息/i }).fill(reviewNote);
  await reviewBtn.click();
} else {
  throw new Error('未找到发布按钮：既不是直接发布，也不是线上审核');
}
```

## 输出要求

最终向用户返回：

- 本次新增的 scopes 列表。
- 创建的版本号。
- 发布结果：`Released` 或 `Submitted for review`。
- 验证结果：目标 API 是否恢复正常。
