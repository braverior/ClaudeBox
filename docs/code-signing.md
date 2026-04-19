# macOS 代码签名与公证配置指南

本文说明如何为 ClaudeBox 的 GitHub Actions 构建流程配置 Apple 代码签名和公证（notarization），避免用户下载 DMG 后出现"已损坏"提示。

---

## 为什么需要签名+公证

| 状态 | 用户体验 |
|------|---------|
| 未签名 | macOS 报"已损坏，移到废纸篓"。需要用户手动执行 `xattr -d com.apple.quarantine /Applications/ClaudeBox.app` |
| 仅签名不公证 | 首次打开时系统弹出安全确认 |
| 签名+公证 ✅ | 直接双击打开，无任何警告 |

---

## 一、准备 Apple Developer 证书

### 1.1 加入 Apple Developer Program
- 注册地址：<https://developer.apple.com/programs/>
- 费用：$99/年
- 类型：选择 **Individual** 或 **Organization**

### 1.2 创建 Developer ID Application 证书

在 Mac 本机操作：

1. 打开 **Keychain Access** → **Certificate Assistant** → **Request a Certificate From a Certificate Authority**
2. 填写邮箱，选 **Saved to disk**，生成 `.certSigningRequest` 文件
3. 登录 <https://developer.apple.com/account/resources/certificates> → **+** → 选择 **Developer ID Application**
4. 上传 CSR，下载生成的 `.cer`
5. 双击 `.cer` 导入 Keychain

### 1.3 导出为 `.p12`

```bash
# Keychain Access → 找到 "Developer ID Application: Your Name (TEAMID)"
# 右键 → Export → 选 Personal Information Exchange (.p12) → 设一个密码
# 保存为 cert.p12
```

### 1.4 Base64 编码（供 GitHub Secrets 使用）

```bash
base64 -i cert.p12 | pbcopy
# 已复制到剪贴板
```

### 1.5 查看签名身份字符串

```bash
security find-identity -v -p codesigning
# 输出示例：
#   1) 1A2B3C4D5E6F... "Developer ID Application: Your Name (ABCD123456)"
# 完整字符串 "Developer ID Application: Your Name (ABCD123456)" 就是 APPLE_SIGNING_IDENTITY
```

### 1.6 生成 App-Specific Password（供公证使用）

1. 登录 <https://appleid.apple.com>
2. **Sign-In and Security** → **App-Specific Passwords** → **+**
3. 起名 "ClaudeBox CI"，生成形如 `abcd-efgh-ijkl-mnop` 的密码

### 1.7 查看 Team ID

<https://developer.apple.com/account> 右上角 **Membership details** 中的 10 位字符（形如 `ABCD123456`）。

---

## 二、配置 GitHub Secrets

进入仓库 **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，添加：

| Secret 名称 | 内容 | 来源 |
|-----------|------|------|
| `APPLE_CERTIFICATE` | base64 编码的 `.p12` 内容 | 1.4 步骤 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 | 1.3 步骤 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (ABCD123456)` | 1.5 步骤 |
| `APPLE_ID` | Apple ID 邮箱 | — |
| `APPLE_PASSWORD` | App-Specific Password | 1.6 步骤 |
| `APPLE_TEAM_ID` | 10 位 Team ID | 1.7 步骤 |
| `KEYCHAIN_PASSWORD` | 任意字符串（临时 keychain 密码，CI 内部使用） | 自拟，如 `openssl rand -hex 16` |

> **注意：** `APPLE_PASSWORD`（不是 `APPLE_ID_PASSWORD`）— `tauri-action` 规定的变量名。

---

## 三、已经配置好的仓库侧修改

本次提交已完成：

1. **`src-tauri/tauri.conf.json`** — 新增 `bundle.macOS` 段：
   - `entitlements: "entitlements.plist"`（挂载 hardened-runtime 入口）
   - `hardenedRuntime: true`（公证必需）
   - `minimumSystemVersion: "10.13"`

2. **`.github/workflows/release.yml`** — 修复了三个缺陷：
   - ✅ 为 `tauri-action` 步骤注入了 Apple 相关 env（之前虽然导入了证书，但 Tauri 读不到）
   - ✅ 变量名从 `APPLE_ID_PASSWORD` 改成 `APPLE_PASSWORD`（tauri-action 规定）
   - ✅ 证书导入使用临时 keychain（`RUNNER_TEMP`），构建后清理
   - ✅ 加了 `set-keychain-settings -lut 21600`（6 小时超时）避免 keychain 锁死
   - ✅ 显式把临时 keychain 加入搜索路径（`list-keychain -d user -s`）
   - ✅ 加入 `productbuild` 工具授权（公证可能需要）
   - ✅ 新增诊断步骤（`find-identity` 输出证书列表）
   - ✅ `always()` cleanup 步骤：无论构建成功失败都删除 keychain

3. **Homebrew Cask** — 新增 `auto_updates true`：
   - 告知 Homebrew 这个 App 自带更新机制（Tauri updater），避免 `brew upgrade` 和 App 内更新打架

---

## 四、发布新版本流程

```bash
# 1. 确认版本号（tauri.conf.json、package.json 同步）
# 2. 提交并打 tag
git tag v0.4.2
git push origin v0.4.2
```

GitHub Actions 会自动：
1. 在 macOS 上构建 aarch64 + x86_64
2. 用 Developer ID 签名 `.app`
3. 打包为 `.dmg`
4. 提交给 Apple 公证服务器（耗时 1-5 分钟）
5. 公证完成后 `stapler staple`（公证票据钉在 DMG 上，用户无需联网即可验证）
6. 推送到 GitHub Release（draft 状态）
7. 触发 `update-homebrew` job → 计算 SHA256 → 更新 `braverior/homebrew-tap`

---

## 五、验证签名结果

构建完成后，下载 DMG 在本地验证：

```bash
# 检查签名
codesign -dv --verbose=4 /Applications/ClaudeBox.app

# 检查是否符合 Gatekeeper
spctl --assess --verbose /Applications/ClaudeBox.app
# 期望输出：accepted  source=Notarized Developer ID

# 检查公证票据
xcrun stapler validate /Applications/ClaudeBox.app
# 期望输出：The validate action worked!
```

---

## 六、跳过签名（临时）

如果暂时没有 Apple Developer 账号，可以**不配置任何 APPLE_* secrets**，workflow 会跳过签名步骤，产出未签名 DMG。用户下载后需要手动：

```bash
xattr -cr /Applications/ClaudeBox.app
```

不推荐长期使用此方案，因为会严重影响用户体验。

---

## 七、故障排查

| 现象 | 原因 | 解决 |
|------|------|------|
| `errSecInternalComponent` | Keychain 未解锁或 partition-list 未设 | 检查 `set-key-partition-list` 步骤是否执行 |
| `No identity found` | 证书未正确导入 / 身份字符串不匹配 | 检查 `find-identity -v -p codesigning` 输出 |
| Notarize 提示 `Invalid credentials` | 用了 Apple ID 密码而非 App-Specific | 重新到 appleid.apple.com 生成 |
| Notarize 超时 | Apple 服务器排队 | 重试，或等待高峰时段过后 |
| 用户下载后仍提示"已损坏" | 没有 staple | 检查 tauri-action 日志中 `stapler staple` 是否执行 |

---

## 八、Windows 签名（未来扩展）

Windows EV Code Signing 证书较贵（~$300/年），且需要 HSM/USB Token。当前 workflow 未启用 Windows 签名。可选方案：

- **EV 证书 + Azure KeyVault**（推荐，可全自动）
- **SignPath.io** 免费方案（开源项目可申请）
- **不签名** — 用户首次运行会触发 SmartScreen 警告，但可以点 "More info → Run anyway"
