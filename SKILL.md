---
name: feishu-permission-setup
description: 通过浏览器自动化为飞书自建应用开通 Tenant token 权限并发布版本以使权限生效。用于飞书 API 返回 99991672 权限不足、用户要求"开通/申请飞书权限"、或需要新增 Feishu scope（如 docx/drive/im/base）时。自动判断并处理两种发布路径：免审核直接发布与需线上审核提交。
---

# 飞书权限开通与发布（Tenant Token）

## ⚠️ 核心原则：直接运行脚本

**脚本已经封装了所有自动化操作**，AI 只需要：
1. 确定 scope 名称
2. 运行脚本
3. 向用户报告结果

**不要**：
- ❌ 自己写临时 Playwright 脚本
- ❌ 自己操作浏览器
- ❌ 重复实现脚本已经封装的逻辑

## 快速执行

```bash
cd ~/.agents/skills/feishu-permission-setup-skill && \
  node scripts/feishu_scope_publish.js \
    --scopes bitable:app \
    --headless true \
    --waitForScanMs 180000
```

**参数说明**：
- `--scopes`：要开通的权限，多个用逗号分隔
- `--headless true`：无界面模式（推荐）
- `--waitForScanMs 180000`：等待扫码的超时时间（毫秒）
- `appId` 会自动从 `~/.openclaw/openclaw.json` 读取，无需提供

## 执行流程

脚本会自动完成：
1. **预检测登录状态** → 输出 `LOGIN_STATUS=已登录/需要登录`
2. 如果需要登录 → 截图二维码 → 输出 `SCAN_QR=<路径>`
3. 开通权限
4. 创建版本
5. 发布（自动判断免审核/需审核）
6. 返回结果 JSON

## 输出结果

脚本会输出 JSON 结果：

```json
{
  "appId": "cli_xxx",
  "scopes": ["bitable:app"],
  "status": "released",  // 或 submitted_for_review, blocked_login_required
  "addedScopes": ["bitable:app"],
  "skippedScopes": [],
  "versionCreated": true,
  "error": null
}
```

**status 含义**：
- `released`：权限已开通并发布
- `submitted_for_review`：已提交审核，等待审批
- `blocked_login_required`：需要扫码登录（已截图二维码）
- `failed`：执行失败

## AI 操作指南

### 当用户要求开通权限

1. **确定 scope 名称**：
   - 如果用户提供 → 直接使用
   - 如果 API 返回 99991672 → 从错误信息中提取 scope

2. **直接运行脚本**：
   ```bash
   cd ~/.agents/skills/feishu-permission-setup-skill && \
     node scripts/feishu_scope_publish.js --scopes <scope> --headless true --waitForScanMs 180000
   ```

3. **关注输出**：
   - `LOGIN_STATUS=已登录` → 继续执行，不需要扫码
   - `LOGIN_STATUS=需要登录` + `SCAN_QR=<路径>` → 发送二维码给用户扫码
   - `RESULT_JSON=<路径>` → 执行完成，查看结果

4. **快速发送二维码流程**：
   ```bash
   # 运行脚本（后台）
   cd ~/.agents/skills/feishu-permission-setup-skill && \
     node scripts/feishu_scope_publish.js --scopes <权限> --headless true --waitForScanMs 180000 > /tmp/feishu-output.txt 2>&1 &
   
   # 快速轮询检测 SCAN_QR（每 0.5 秒检测一次）
   for i in {1..30}; do
     sleep 0.5
     SCAN_QR=$(grep "SCAN_QR=" /tmp/feishu-output.txt 2>/dev/null | tail -1 | cut -d= -f2)
     [ -n "$SCAN_QR" ] && [ -f "$SCAN_QR" ] && break
   done
   
   # 立即发送（见下方命令）
   ```

5. **如果检测到 `SCAN_QR=<路径>`**：
   - 脚本检测到需要登录
   - **立即**用飞书 API 发送截图给用户：
     ```bash
     # 获取 token
     APP_ID=$(jq -r '.channels.feishu.appId' ~/.openclaw/openclaw.json)
     APP_SECRET=$(jq -r '.channels.feishu.appSecret' ~/.openclaw/openclaw.json)
     TOKEN=$(curl -s -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
       -H "Content-Type: application/json" \
       -d "{\"app_id\":\"$APP_ID\",\"app_secret\":\"$APP_SECRET\"}" | jq -r '.tenant_access_token')
     
     # 上传图片
     IMG_KEY=$(curl -s -X POST "https://open.feishu.cn/open-apis/im/v1/images" \
       -H "Authorization: Bearer $TOKEN" \
       -F "image_type=message" \
       -F "image=@<SCAN_QR路径>" | jq -r '.data.image_key')
     
     # 发送图片消息
     curl -s -X POST "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id" \
       -H "Authorization: Bearer $TOKEN" \
       -H "Content-Type: application/json" \
       -d "{\"receive_id\":\"用户open_id\",\"msg_type\":\"image\",\"content\":\"{\\\"image_key\\\":\\\"$IMG_KEY\\\"}\"}"
     ```
   - 告诉用户扫码登录
   - 脚本会自动等待扫码完成（最长 180 秒）

6. **向用户报告结果**

## 登录态保持

脚本使用 **持久化浏览器 Profile**：
- Profile 目录：`.pw-feishu-profile/`
- 登录态会保存在这个目录中
- **短期内不需要每次都扫码登录**

⚠️ **登录态会过期**：
- 飞书登录态有时效性（通常几天到几周）
- 过期后脚本会自动检测并输出 `SCAN_QR=<路径>`
- 按上面的流程发送二维码给用户扫码即可

## 截图实现

使用 **Playwright 截图**：
- 优先截取二维码区域（canvas/img.qrcode 元素）
- 如果找不到二维码元素，回退到整个页面截图
- 截图前会等待二维码渲染完成（`waitForQrReady`）

```javascript
// 截取二维码区域
const qrLocator = page.locator('canvas, img[alt*="QR"], .qrcode').first();
await qrLocator.screenshot({ path: 'qr.png' });
```

## 常见问题

| 情况 | 解决方案 |
|------|---------|
| Playwright 未安装 | `cd ~/.agents/skills/feishu-permission-setup-skill && npm i playwright` |
| Chromium 未下载 | `HTTP_PROXY=http://127.0.0.1:7890 npx playwright install chromium` |
| Git 需要代理 | `git config --global http.proxy http://127.0.0.1:7890` |


