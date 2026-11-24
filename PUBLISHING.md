# 发布到 VS Code Marketplace

本插件采用 **GPL-3.0-or-later**：允许任何人使用与修改，但**再分发**时必须同样开源。
下面的流程既满足 Marketplace 的要求，也满足 copyleft 的要求。

> 微软推荐使用 **可信发布（Trusted Publishing）**：由 GitHub Actions 通过 OIDC
> 直接向 Marketplace 换取一次性凭据，仓库里不必保存任何长期密钥。

---

## 0. 前置条件

| 需要什么 | 说明 |
| --- | --- |
| Microsoft / Azure DevOps 账号 | 用来注册 Publisher 与发布扩展 |
| 一个 Publisher 名称 | 本项目用的是 `Aurumjin`（已注册）；**必须**与 `package.json` 里的 `publisher` 字段一致 |
| 一个 GitHub 仓库 | 仓库地址写在 `package.json` 的 `repository`；GPL 要求再分发时提供源码 |
| `vsce` 命令行 | `npm install -g @vscode/vsce`，或在项目里用 `npx @vscode/vsce` |

---

## 1. 本地打包（任何方案发布前都要做）

```bash
npm install          # 只装依赖
npm run typecheck    # 类型检查
npm run build        # 编译到 dist/
npm run test         # 四组自检：引擎 / 协议 / 宿主端 / 界面端
npm run package      # 生成 diff-compare-<version>.vsix
```

`package.json` 的 `scripts.package` 已经是：

```json
"package": "vsce package --no-dependencies --allow-missing-repository"
```

> 扩展本身**零运行时依赖**（没有 `dependencies`），`--no-dependencies` 只是为了避开
> 离线/沙箱环境下 npm 枚举依赖时的失败。
>
> `vscode:prepublish` 已经配成 `npm run build`，所以 `vsce publish` 会自动重新编译 `dist/`。
>
> `media/` 下的 `compare.js`、`compare.css` 是 webview 资源，必须一起打进 `.vsix`；
> `.vscodeignore` 里不要排除 `media/**`。

---

## 2. 扩展名与显示名的唯一性

Marketplace 上**扩展名（`name`）全局唯一**，`displayName` 也建议唯一：

- `name`：`diff-compare`
- `displayName`：`Diff Compare`
- 商店地址：<https://marketplace.visualstudio.com/items?itemName=Aurumjin.diff-compare>

---

## 3. 方案 A（推荐）：GitHub Actions + 可信发布

### 3.1 建仓库并推送源码

仓库地址：<https://github.com/Aujin/diff-compare>

```bash
cd D:\Workspace\DiffCompare
git init
git add .
git commit -m "Initial release: Diff Compare for VS Code"
git branch -M main
git remote add origin https://github.com/Aujin/diff-compare.git
git push -u origin main
```

仓库建议设为 **Public**（GPL 强调提供完整源码；Trusted Publishing 对私有仓库还有
"创建策略后 48 小时内必须跑一次工作流" 的额外要求）。

### 3.2 在 Marketplace 上创建可信发布策略

打开 <https://marketplace.visualstudio.com/manage/publishers/aurumjin> →
**Trusted Publishing** → **Create**，按下表填写（大小写敏感）：

| 表单字段 | 填写内容 |
| --- | --- |
| Policy name | `Release workflow` |
| Provider | `GitHub Actions` |
| Repository owner | `Aujin`（**GitHub** 登录名；注意它和 Marketplace 发布者 `Aurumjin` 不是同一个字符串） |
| Repository | `diff-compare`（不含 owner） |
| Workflow | `publish.yml`（`.github/workflows/` 下的文件名） |
| Environment | **留空**（本工作流不使用 GitHub environment） |

点 **Create**。

### 3.3 激活策略并发布

策略创建后，**必须至少成功跑一次**工作流，策略才会被激活
（私有仓库须在创建策略后 48 小时内完成；第一次成功换取令牌后永久生效）。

- 仓库页 → **Actions** → 左侧 **Publish** → 右侧 **Run workflow**；
- 或者推送一个 tag：`git tag v0.1.0 && git push origin v0.1.0`。

工作流会执行 `npm ci → typecheck → build → test → npm run package →
npx @vscode/vsce publish --oidc`，凭据由 GitHub 的 OIDC 令牌换取，
**仓库里不需要保存 PAT**。

打 tag 触发时，工作流还会把打包好的 `.vsix` 传到一个 **GitHub Release**
（仓库页右侧的 *Releases*），可以直接下载安装，不用等 Marketplace 审核。

> ⚠️ `--oidc` 需要 **@vscode/vsce 4.x**（3.x 没有这个参数，工作流会报
> `error: unknown option '--oidc'`）。仓库里的 `devDependencies` 固定为
> `@vscode/vsce: ^4.1.1`，`npm ci` 会装上它；升级 vsce 后记得一起提交
> `package-lock.json`。

### 3.4 之后的每次发布

```bash
# 1) 提升版本号（Marketplace 不允许覆盖同一版本）
npm version patch        # 0.1.0 -> 0.1.1
# 2) 提交并打 tag，tag 会触发工作流
git add package.json package-lock.json
git commit -m "Release 0.1.1"
git tag v0.1.1
git push origin main --tags
```

发布成功后扩展地址为：

```
https://marketplace.visualstudio.com/items?itemName=Aurumjin.diff-compare
```

---

## 4. 方案 B（备选）：本机用 PAT 发布

1. 在 Azure DevOps 打开 <https://dev.azure.com/> → 右上角头像 →
   **Personal Access Tokens** → **+ New PAT**。
2. 作用域：**All accessible organizations**；权限勾选 **Manage**
   （Marketplace 发布所需）。
3. 发布：

```bash
set VSCE_PAT=<你的 PAT>
npx @vscode/vsce publish --allow-missing-repository
```

> 仅在暂时还没配置 GitHub Actions 时使用。Azure DevOps 的全局 PAT 将于
> 2026-12-01 停用，之后只能用方案 A。

---

## 5. 开源与 copyleft 的落实

- `package.json` 的 `license` 必须是 `GPL-3.0-or-later`；
- `.vsix` 里必须包含 `LICENSE`（本仓库根目录的 `LICENSE` 会被打进去，
  别在 `.vscodeignore` 里排除它）；
- 仓库设为 **Public**，源码完整可见。

---

## 6. 打包前的自检清单

- [ ] `npm run typecheck` 无错误
- [ ] `npm run build` 产出 `dist/extension.js` 等
- [ ] `npm run test` 全部通过
- [ ] `npm run package` 成功生成 `.vsix`
- [ ] `.vsix` 里包含 `media/compare.js`、`media/compare.css`、`media/icon.png`、
      `media/diff-compare.svg`、`LICENSE`
- [ ] `package.json` 的 `publisher` / `version` / `license` 正确
- [ ] 在 VS Code 里装上 `.vsix` 手工点一遍：打开面板、拖入两侧、比较、
      逐处同步、目录同步、十六进制视图、`Ctrl+F` 查找
