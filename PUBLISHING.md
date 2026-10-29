# 发布到 magpie 的社区通道

这是 **magpie 插件**（Agent 插件 + Bun 同步器），不是 Snow App 的面板插件，所以发布到 magpie 的发现页，而不是 Snow App 的插件市场。

## 一、GitHub topic（当前选择的路线）

Magpie 的「插件 → 发现 → 非官方插件 · GitHub」按 GitHub topic 检索，不需要 registry PR。

需要满足：

- 仓库 **公开**、**不是 fork**、**没有 archived**（当前满足）；
- 仓库根目录有 `package.json`（当前满足）；
- `agent.mjs`、`hooks.mjs`、`sync.mjs` 等入口文件 **已提交到默认分支**（不能只在本地或发布时才构建）。

### 1. 提交并推送

```bash
git add .
git commit -m "feat: add Snow App magpie agent plugin"
git push origin main
```

### 2. 打 topic

网页：仓库首页右侧 **About → 齿轮 → Topics**，添加：

```text
magpie-plugin
```

或 CLI：

```bash
gh repo edit MayDay-wpf/snowapp-magpie-plugin --add-topic magpie-plugin
```

### 3. 等 Magpie 拉取

Magpie 最多每 **10 分钟** 查一次 GitHub。打开 **插件 → 发现 → 非官方插件 · GitHub**，看不到就点 **刷新 / Try again**。

卡片会显示 `package.json` 的版本、`magpie.icon`，并按下面规则分类：

- 没有 `main` / `exports`，且有 `magpie.agent` → `kind: "agent"`，归到 Agent；
- 有 `main` / `exports` → 普通插件，不再是 Agent 分类。

本包现在是 `magpie.agent` + `magpie.hooks`，没有 `main` / `exports`，所以会归到 Agent。

### 4. 安装与更新

- npm 上 **没有** 这个包时，Magpie 用 `github:MayDay-wpf/snowapp-magpie-plugin` 安装默认分支当前代码；
- npm 上 **有** 这个包，且 `repository` 指向本仓库时，Magpie 从 npm 安装；
- 更新按默认分支的提交比较，push 新提交后 Magpie 会显示更新。GitHub 通道没有 semver 固定，也没有 Release 要求。

### 5. 注意事项

- GitHub 通道的卡片标注为「非官方插件 · GitHub」，**未经审核**；这是正常的。
- 仓库的 GitHub **Description** 会显示在卡片上，建议改成一句真实描述，而不是仓库名。
- 如果以后为了其他功能加回 `main` / `exports`，这个包会从 Agent 分类变成普通插件；需要继续保持 Agent 分类时，把 Bun 侧的入口留在 `magpie.hooks`。

## 二、可选：发布到 npm

```bash
npm publish --access public
```

之后用户可以直接：

```bash
magpie plugin add snowapp-magpie-agent
```

npm 上有包时 GitHub 卡片也会优先从 npm 安装（前提是 `package.json` 的 `repository` 指向本仓库）。

## 三、可选：官方推荐列表（registry PR）

这不是 GitHub topic 通道的必需项。`magpie-community/plugins` 的 `registry.json` 是 Magpie 内置的推荐列表；条目示例：

```json
{
  "package": "@magpie-community/agent-snowapp",
  "name": "Snow App",
  "kind": "agent",
  "community": true,
  "icon": "snow",
  "summary": {
    "en": "Snow App on magpie's Agents page: pick one of magpie's models and the plugin writes it into Snow App's SQLite API profile; switch it off to restore the original.",
    "zh": "把 Snow App 加到 magpie 的 Agent 页：选一个 magpie 模型，插件会把模型与网关写进 Snow App 的 SQLite API 档案；关掉即恢复原配置。"
  }
}
```

注意：

- registry 里的 `community: true` 条目实际是给社区仓库自己维护的包用的；外部 npm 包通常走 GitHub topic 就够了。
- 社区 Agent 模板要求 `package.json` **没有 `main`**、Agent 文件单文件且不 import 其他文件；本包用 `magpie.hooks` + `sync.mjs` 是为了访问 Snow App 的 SQLite，和模板不完全一致。要进社区仓库的 `packages/`，需要在 PR 里解释这一点，或接受改名为 `@magpie-community/agent-snowapp`。
