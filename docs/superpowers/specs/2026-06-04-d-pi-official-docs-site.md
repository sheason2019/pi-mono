# d-pi 官方文档站 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 `packages/d-pi-official/` 起一个 Docusaurus 文档站，按设计文档 `docs/superpowers/specs/2026-06-04-d-pi-official-docs-site-design.md` 覆盖 d-pi 全部已实现功能（28 篇 markdown + 1 个 logo placeholder + 1 份 v0.6 快照）。

**Architecture:** 独立 monorepo 子包 `packages/d-pi-official/`，不进 pi-mono 根 `npm run check` 链。Sidebar 手写（feature-grouped，6 个 section），locale 单 `zh-CN` 干净 URL，本地搜索，不部署。

**Tech Stack:** Docusaurus 3.10.x (classic preset) + TypeScript config + `@easyops-cn/docusaurus-search-local` + Node 18+。

**Reference:**
- 设计文档: `docs/superpowers/specs/2026-06-04-d-pi-official-docs-site-design.md`
- 上游 d-pi 源码: `packages/d-pi/src/`（命令清单、工具清单、slash 命令、auth 都从这里对照）
- AGENTS.md（仓库根）: 提交规范、`npm run check` 不进 d-pi-official

---

## Task 1: Scaffold `packages/d-pi-official/`

**Files:**
- Create: `packages/d-pi-official/package.json`
- Create: `packages/d-pi-official/tsconfig.json`
- Create: `packages/d-pi-official/babel.config.js`
- Create: `packages/d-pi-official/.gitignore`
- Create: `packages/d-pi-official/README.md`

**Step 1: 创建 `package.json`**

```json
{
  "name": "@sheason/d-pi-official",
  "version": "0.6.0-alpha.1",
  "private": true,
  "description": "D-Pi Agent Teams documentation site",
  "scripts": {
    "start": "docusaurus start --port 3000",
    "build": "docusaurus build",
    "serve": "docusaurus serve --port 3000",
    "clear": "docusaurus clear",
    "typecheck": "tsc --noEmit",
    "check": "npm run typecheck && npm run build"
  },
  "devDependencies": {
    "@docusaurus/core": "^3.10.1",
    "@docusaurus/preset-classic": "^3.10.1",
    "@docusaurus/types": "^3.10.1",
    "@easyops-cn/docusaurus-search-local": "^0.51.0",
    "typescript": "^5.6.0"
  }
}
```

**Step 2: 创建 `tsconfig.json`**

```json
{
  "extends": "@docusaurus/tsconfig",
  "compilerOptions": {
    "baseUrl": ".",
    "jsx": "react-jsx"
  },
  "include": ["docusaurus.config.ts", "sidebars.ts", "src/**/*"]
}
```

**Step 3: 创建 `babel.config.js`**

```js
module.exports = {
  presets: [require.resolve("@docusaurus/core/lib/babel/preset")],
};
```

**Step 4: 创建 `.gitignore`**

```
node_modules/
build/
.docusaurus/
i18n/
.DS_Store
.env.local
.env.*.local
npm-debug.log*
yarn-debug.log*
yarn-error.log*
```

**Step 5: 创建 `README.md`**

```markdown
# d-pi 官方文档站

Docusaurus 站点源码，部署后供 d-pi 终端用户查阅。

## 开发

```bash
npm install
npm run start    # http://localhost:3000
```

## 构建

```bash
npm run build
npm run serve    # 本地预览 build 产物
```

## 写新页面

1. 在 `docs/<section>/` 下新增 `xxx.md`
2. 在 `sidebars.ts` 对应 section 的 `items` 加一项
3. `npm run start` 浏览器热重载验证
4. `npm run build` 验 broken link
5. 单独 `git add docs/<新文件> sidebars.ts` 提交
```

**Step 6: 安装依赖**

Run: `cd packages/d-pi-official && npm install`
Expected: 装好 `@docusaurus/core`、`@docusaurus/preset-classic`、`@docusaurus/types`、`@easyops-cn/docusaurus-search-local`、`typescript` 五个 devDep；生成 `node_modules/`。**不**生成 `package-lock.json`（d-pi-official 自身不进根 lockfile，AGENTS.md 已说明）。

如果 npm 报错 lockfile 与现有 root 冲突，验证是 monorepo 根 `package-lock.json` 没引入 d-pi-official（应该没有），继续。

**Step 7: 提交 scaffold**

Run:
```bash
git add packages/d-pi-official/package.json packages/d-pi-official/tsconfig.json packages/d-pi-official/babel.config.js packages/d-pi-official/.gitignore packages/d-pi-official/README.md
git commit -m "chore(d-pi-official): scaffold docusaurus sub-package"
```

Expected: 一次 commit 落地，5 个新文件。


---

## Task 2: Write `docusaurus.config.ts`

**Files:**
- Create: `packages/d-pi-official/docusaurus.config.ts`

**Step 1: 写配置**

完整文件内容（复制即用）：

```ts
import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "D-Pi Agent Teams",
  tagline: "轻松编排具有你个人特色的 Agent 团队",
  favicon: "img/favicon.ico",

  url: "http://localhost:3000",
  baseUrl: "/",

  organizationName: "sheason2019",
  projectName: "pi-mono",

  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "throw",

  i18n: {
    defaultLocale: "zh-CN",
    locales: ["zh-CN"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "/",
          versions: {
            current: { label: "0.6 (current)" },
          },
        },
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/social-card.png",
    colorMode: {
      defaultMode: "light",
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "D-Pi Agent Teams",
      logo: {
        alt: "D-Pi",
        src: "img/logo.svg",
      },
      items: [
        { type: "docsVersionDropdown", position: "right" },
        {
          href: "https://github.com/sheason2019/pi-mono",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "文档",
          items: [
            { label: "快速上手", to: "/getting-started/install" },
            { label: "多 Agent 编排", to: "/multi-agent/overview" },
          ],
        },
        {
          title: "项目",
          items: [
            { label: "GitHub", href: "https://github.com/sheason2019/pi-mono" },
            { label: "上游 pi", href: "https://github.com/earendil-works/pi-mono" },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} d-pi contributors. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json"],
    },
  } satisfies Preset.ThemeConfig,

  themes: [
    [
      require.resolve("@easyops-cn/docusaurus-search-local"),
      {
        hashed: true,
        indexDocs: true,
        indexBlog: false,
        indexPages: true,
        docsRouteBasePath: "/",
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],
};

export default config;
```

**Step 2: 验证**

Run: `cd packages/d-pi-official && npx tsc --noEmit 2>&1 | head -20`
Expected: 无错误（也可能报 `prism-react-renderer` 找不到——是 docusaurus 的 transitive 依赖，无害，build 时会拿到）。

**Step 3: 提交**

Run:
```bash
git add packages/d-pi-official/docusaurus.config.ts
git commit -m "feat(d-pi-official): add docusaurus config with zh-CN locale and local search"
```

---

## Task 3: Write `sidebars.ts` (skeleton) + `src/css/custom.css`

**Files:**
- Create: `packages/d-pi-official/sidebars.ts`
- Create: `packages/d-pi-official/src/css/custom.css`
- Create: `packages/d-pi-official/static/img/favicon.ico`（占位，可选）

**Step 1: 写 `sidebars.ts`**（完整 6 section 结构）

```ts
import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "intro",
    {
      type: "category",
      label: "快速上手",
      collapsed: false,
      items: [
        "getting-started/install",
        "getting-started/init",
        "getting-started/serve",
        "getting-started/connect",
        "getting-started/first-session",
      ],
    },
    {
      type: "category",
      label: "多 Agent 编排",
      items: [
        "multi-agent/overview",
        "multi-agent/create-agent",
        "multi-agent/send-message",
        "multi-agent/agent-network",
        "multi-agent/destroy-agent",
        "multi-agent/meta-connect",
      ],
    },
    {
      type: "category",
      label: "数据源（Sources）",
      items: [
        "sources/overview",
        "sources/create-source",
        "sources/subscribe-source",
        "sources/unsubscribe-source",
        "sources/list-sources",
        "sources/slash-sources",
      ],
    },
    {
      type: "category",
      label: "远程执行（Remote Execution）",
      items: [
        "remote-execution/overview",
        "remote-execution/executor-lifecycle",
        "remote-execution/remote-tools",
        "remote-execution/slash-agents",
      ],
    },
    {
      type: "category",
      label: "用户与认证",
      items: [
        "auth/users",
        "auth/allow-user",
        "auth/dpi-auth-token",
      ],
    },
    {
      type: "category",
      label: "参考",
      items: [
        "reference/cli",
        "reference/tools",
        "reference/slash-commands",
      ],
    },
  ],
};

export default sidebars;
```

**Step 2: 写 `src/css/custom.css`**（微调，不改主题色）

```css
/**
 * D-Pi Agent Teams 自定义样式
 * 只动 code 字体和 toc 颜色，不改主题色。
 */

:root {
  --ifm-code-font-size: 0.9em;
  --ifm-toc-border-color: rgba(0, 0, 0, 0.08);
}

code {
  font-family: var(--ifm-font-family-monospace);
}

.theme-doc-sidebar-container {
  border-right: 1px solid var(--ifm-toc-border-color);
}

/* 让中文段落在长行下也能合理折行 */
.markdown p {
  line-height: 1.7;
}

/* 代码块内的中文注释不撞 italic */
.prism-code .token.comment {
  font-style: normal;
}

**Step 3: 提交**

Run:
```bash
git add packages/d-pi-official/sidebars.ts packages/d-pi-official/src/css/custom.css
git commit -m "feat(d-pi-official): add sidebar layout and custom css"
```

---

## Task 4: Logo placeholder + intro page (smoke test)

**Files:**
- Create: `packages/d-pi-official/static/img/logo.svg`
- Create: `packages/d-pi-official/static/img/favicon.ico`（占位 1×1 透明）
- Create: `packages/d-pi-official/docs/intro.md`

**Step 1: 写 `logo.svg`**（占位，1×1 透明）

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="6" fill="#1f2937"/>
  <text x="16" y="22" font-family="ui-monospace, monospace" font-size="16" font-weight="700" fill="#f3f4f6" text-anchor="middle">π</text>
</svg>
```

**Step 2: 写 `favicon.ico`**

不需要真的 ICO——Docusaurus 找不到会 fallback。可以用 `static/img/favicon.ico` 放任何 1 字节占位文件（`touch` 即可），或者复制 logo.svg 改名为 favicon.ico。

Run: `touch packages/d-pi-official/static/img/favicon.ico`

**Step 3: 写 `docs/intro.md`**（完整文件）

```markdown
---
slug: /
---

# D-Pi Agent Teams

轻松编排具有你个人特色的 Agent 团队。

## d-pi 是什么

d-pi 是基于 [pi](https://github.com/earendil-works/pi-mono) serve 模式的多 agent 树形编排器，
在你已有的 pi coding-agent 之上加一层 hub-spoke 拓扑：

- **Hub** (`d-pi serve`)：一个常驻进程，调度所有 agent worker，持有拓扑和状态
- **Client** (`d-pi connect`)：你面前的 TUI，连到 hub 拿任务，agent 在你机器上跑工具
- **Agent worker**：hub 拉起的子进程，跟 pi agent 一样的 LLM 循环，但能调 d-pi 注册的额外工具

## d-pi 能解决什么问题

1. **多 agent 树形编排**：root agent 派生子 agent，子 agent 再派孙子 agent，
   天然适合「拆任务、并行做、汇总结果」的场景。工具: `create_agent` / `send_message` / `agent_network` / `destroy_agent`。
2. **远程执行**：agent worker 跑在 hub 上，但工具执行（read / bash / write / ...）可以路由回 client 本机，
   透明的本地访问——工具: `remote_bash` / `remote_read` / `remote_ls` / `remote_grep` / `remote_find` / `remote_write` / `remote_edit`。
3. **跨 agent 寻址**：在 client TUI 输入 `connect <id>` 即可把消息定向派给指定 agent，
   不打断当前对话的上下文。
4. **数据源 (Sources)**：把外部命令（`tail -f logs` / `ps aux` / 自定义脚本）的输出订阅为 agent 上下文流。
5. **认证**：hub 自带 bearer token，多用户共享一个 hub 时按 allowed-users 白名单控制。

## 下一步

先看 [快速上手 → 安装](./getting-started/install) 5 分钟跑起来。

想直接查工具列表，跳到 [参考 → Agent 工具](./reference/tools)。

```

**Step 4: 验证 smoke test**

Run: `cd packages/d-pi-official && timeout 10 npm run start 2>&1 | head -30`
Expected: 看到 `D-Pi Agent Teams` / `localhost:3000` 等启动信息，没有 module 找不到 / 解析错误。被 timeout 杀掉是预期的（后台启服务不阻塞）。

**Step 5: 提交**

Run:
```bash
git add packages/d-pi-official/static/img/logo.svg packages/d-pi-official/static/img/favicon.ico packages/d-pi-official/docs/intro.md
git commit -m "feat(d-pi-official): add intro page, logo placeholder, favicon"
```

---

## Task 5: Getting-started — `install.md`

**Files:**
- Create: `packages/d-pi-official/docs/getting-started/install.md`

**Step 1: 写文件**

完整内容：

```markdown
---
title: 安装
sidebar_position: 1
---

# 安装 d-pi

一句话：通过 npm 全局安装 d-pi CLI。

## 用法

```bash
npm install -g @sheason/d-pi
```

装好后 `d-pi --version` 验证：

```bash
$ d-pi --version
0.6.0-alpha.1
```

## 系统要求

- Node.js 18+（d-pi 跟 pi 一样要求 Node 18 LTS 或更高）
- macOS / Linux / WSL（Windows native 未测试）
- 一台 LLM provider 的 API key（Anthropic / OpenAI / ...）

## 相关

- [初始化 workspace](./init)
- [启动 hub](./serve)

```

**Step 2: 提交**

Run:
```bash
git add packages/d-pi-official/docs/getting-started/install.md
git commit -m "docs(d-pi-official): add getting-started/install page"
```

---

## Task 6: Getting-started — `init.md` + `serve.md`

**Files:**
- Create: `packages/d-pi-official/docs/getting-started/init.md`
- Create: `packages/d-pi-official/docs/getting-started/serve.md`

**Step 1: 写 `init.md`**

完整内容：

```markdown
---
title: 初始化 workspace
sidebar_position: 2
---

# d-pi init

一句话：在当前目录创建一个 d-pi workspace。

## 用法

在你想作为 d-pi 根的目录跑：

```bash
cd ~/my-project
d-pi init
```

预期输出：

```
[d-pi] Workspace initialized in current directory
[d-pi]   .dpi/config.json        — workspace configuration
[d-pi]   AGENTS.md               — shared context for all agents
[d-pi]   APPEND_SYSTEM.md        — shared system prompt for all agents
[d-pi]   agents/root/            — root agent working directory
[d-pi]   agents/root/AGENTS.md   — root agent specific context
[d-pi]   agents/root/.pi/APPEND_SYSTEM.md — root agent system prompt
[d-pi] Run 'd-pi serve' to start the hub.
```

## 它做了什么

在当前目录生成：

- `.dpi/config.json`：workspace 配置（agent 树结构、默认模型等）
- `AGENTS.md`：所有 agent 共享的上下文
- `APPEND_SYSTEM.md`：所有 agent 共享的 system prompt 补充
- `agents/<name>/`：每个 agent 的工作目录、专属 AGENTS.md、`.pi/APPEND_SYSTEM.md`

## 相关

- [启动 hub](./serve)
- [连接 client](./connect)

## 注意事项

- 必须在空目录（或仅含已有 workspace 的目录）跑，否则可能覆盖
- `init` 是幂等的：重复跑不会破坏已有 workspace

```

**Step 2: 写 `serve.md`**

完整内容：

```markdown
---
title: 启动 hub
sidebar_position: 3
---

# d-pi serve

一句话：启动 d-pi hub（中心节点），在后台跑直到 Ctrl+C 杀掉。

## 用法

在已 `d-pi init` 的目录跑：

```bash
d-pi serve
```

默认监听 `http://localhost:39090`。自定义端口：

```bash
d-pi serve --port 39100
```

指定默认模型：

```bash
d-pi serve --model claude-sonnet-4-20250514
```

## 预期输出

```
[d-pi hub] Workspace: /Users/me/my-project
[d-pi hub] Auth: enabled (use `d-pi allow-user add` to grant access)
[d-pi hub] Listening on http://localhost:39090
[d-pi hub] Hub started. Press Ctrl+C to stop.
```

## 参数

| 标志 | 说明 | 默认 |
|---|---|---|
| `--port` | 监听端口 | `39090` |
| `--model` | agent 默认 model 规格 | 从 settings 读 |

## 相关

- [连接 client](./connect)
- [用户与认证 → 用户白名单](../auth/allow-user)
- [用户与认证 → DPI_AUTH_TOKEN](../auth/dpi-auth-token)

## 注意事项

- hub 启动后会在 `.dpi/hub-state.json` 持久化拓扑和 agent 状态；下次启动自动恢复
- 当前 hub 默认开启 auth，client 必须带正确的 `DPI_AUTH_TOKEN` 才能连上

```

**Step 3: 验证**

Run: `cd packages/d-pi-official && timeout 8 npm run start 2>&1 | grep -E "error|Error|cannot" | head -10`
Expected: 退出码非零（被 timeout 杀），但 stderr 出现 build error 时才报。这里应该**没有** error 输出（仅有 timeout 自己的退出信息）。

**Step 4: 提交**

Run:
```bash
git add packages/d-pi-official/docs/getting-started/init.md packages/d-pi-official/docs/getting-started/serve.md
git commit -m "docs(d-pi-official): add getting-started init and serve pages"
```

---

## Task 7: Getting-started — `connect.md` + `first-session.md`

**Files:**
- Create: `packages/d-pi-official/docs/getting-started/connect.md`
- Create: `packages/d-pi-official/docs/getting-started/first-session.md`

**Step 1: 写 `connect.md`**

完整内容：

```markdown
---
title: 连接 hub
sidebar_position: 4
---

# d-pi connect

一句话：从你的终端连到一个 d-pi hub，进入 TUI 操作 agent。

## 用法

默认连本地 hub：

```bash
d-pi connect
```

连远程 hub：

```bash
d-pi connect --url http://192.168.1.10:39090
```

指定默认 agent（省略则用 hub 上的 root agent）：

```bash
d-pi connect --agent researcher
```

带 auth token（hub 默认开 auth）：

```bash
DPI_AUTH_TOKEN=<token> d-pi connect --url http://hub.example.com:39090
```

## 参数

| 标志 | 说明 | 默认 |
|---|---|---|
| `--url` | hub URL | `http://localhost:39090` |
| `--agent` | 启动后进入的 agent id 或 name | hub 的 root |

## 行为

1. 跟 hub 建立 HTTP 通道
2. 拉起两个子进程：pi TUI（`pi` connect 模式）+ d-pi executor（跑本机 native 工具）
3. 进入 pi TUI 界面，可以开始跟 agent 对话

## 退出

- 在 TUI 里 `Ctrl+C` 退出
- 退出时 connect 会自动给 executor 发 SIGTERM 并清理 hub 上的绑定
- 你的 terminal 状态（光标显示、bracketed paste、kitty 协议）会被正确还原

## 相关

- [第一次会话](./first-session)
- [远程执行 → executor 生命周期](../remote-execution/executor-lifecycle)
- [用户与认证 → DPI_AUTH_TOKEN](../auth/dpi-auth-token)

## 注意事项

- connect 会同时拉起 executor 子进程；如果你的 hub 启用了 remote execution，executor 在你机器上跑 native 工具
- 在 ssh / tmux 里跑 connect 时，executor 会从 ssh session 继承 cwd

```

**Step 2: 写 `first-session.md`**

完整内容：

```markdown
---
title: 第一次会话
sidebar_position: 5
---

# 第一次会话

一句话：跑通「init → serve → connect → 让 agent 读一个文件」的最小闭环。

## 准备

完成 [安装](./install) 和 [初始化 workspace](./init)。

## 步骤

**1. 起 hub**（一个终端）

```bash
cd ~/my-project
d-pi serve
```

等看到 `Listening on http://localhost:39090`。

**2. 拿 auth token**（另一个终端）

hub 第一次启动会为当前 user 生成一个 token：

```bash
cd ~/my-project
cat .dpi/hub-state.json | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['tokens'][0])"
```

复制输出，下一步用。

**3. 连 client**（第三个终端，或退出 hub 之前后台）

```bash
cd ~/my-project
DPI_AUTH_TOKEN=<刚才拿的 token> d-pi connect
```

进入 pi TUI。

**4. 让 agent 干活**

在 TUI 里输入：

```
请用 remote_read 读一下当前目录的 README.md，告诉我里面有什么
```

agent 会调 `remote_read` 工具，路由到你的 executor 子进程（在你机器上跑 `cat README.md`），
把结果回给 LLM，LLM 给你摘要。

**5. 退出**

TUI 里按 `Ctrl+C`。

## 预期结果

成功路径下你应该看到：
- hub 终端打出 `client connected`
- client 终端进入 TUI，能正常打字
- agent 调 `remote_read` 几秒内返回内容
- 退出时两个终端都干净退出，无 hang、无 kitty 协议污染

## 常见问题

**Q: 401 Unauthorized。**
A: `DPI_AUTH_TOKEN` 没传或传错，重新跑 step 2 拿 token。

**Q: 卡在 `[d-pi connect] TUI child exited` 不退。**
A: 老版本 bug；当前 alpha 已修，确保 `@sheason/d-pi >= 0.6.0-alpha.1`。

**Q: 终端退出后光标没了 / 键入变乱码。**
A: kitty 协议没 pop；当前 alpha 已修；如遇老版本参考 [故障排查](#)。

## 相关

- [远程执行 → remote tools](../remote-execution/remote-tools)
- [多 Agent 编排 → 概览](../multi-agent/overview)

```

**Step 3: 提交**

Run:
```bash
git add packages/d-pi-official/docs/getting-started/connect.md packages/d-pi-official/docs/getting-started/first-session.md
git commit -m "docs(d-pi-official): add getting-started connect and first-session pages"
```

---

## Task 8: Multi-agent — `overview.md`

**Files:**
- Create: `packages/d-pi-official/docs/multi-agent/overview.md`

**Step 1: 写文件**（用 overview 风格，不是工具模板）

完整内容：

```markdown
---
title: 概览
sidebar_position: 1
---

# 多 Agent 编排

d-pi 的核心能力是让你用一个 root agent 拆任务，每个子 agent 拿一份独立上下文跑，
最后 root 把结果汇总。整个 agent 网络是一个**树形**拓扑，
root 是树根，子 agent 是中间节点，叶子 agent 只做执行不做拆分。

## 工具一览

| 工具 | 用途 |
|---|---|
| [create_agent](./create-agent) | 在当前 agent 下创建子 agent |
| [send_message](./send-message) | 派活给另一个 agent（异步） |
| [agent_network](./agent-network) | 查整个 agent 树 |
| [destroy_agent](./destroy-agent) | 收尾时销毁子 agent |
| [meta-connect](./meta-connect) | 在 TUI 输入 `connect <id>` 把消息定向到指定 agent |

## 端到端例子

root agent 拿到「研究 X 主题并写总结」的任务：

```
1. root: create_agent(name="researcher", prompt="你是研究助手")
   → 子 agent 进入 starting → running 状态

2. root: create_agent(name="writer", prompt="你是写作助手")

3. root: send_message(agent_id="researcher", message="研究 X 主题的 5 个关键点")
   → researcher 收到消息 → 跑 LLM → 调工具 → 完成

4. root: send_message(agent_id="writer", message="基于 researcher 的输出写一篇 500 字总结")
   → writer 把 researcher 的历史（通过 hub 共享）作为上下文

5. root: agent_network() 查整个树确认两个子 agent 状态

6. root: 收集完结果 → destroy_agent(researcher) + destroy_agent(writer)
```

## 相关

- [Sources 概览](../sources/overview) — agent 也可以订阅外部数据源
- [Remote Execution 概览](../remote-execution/overview) — agent 调的工具跑在哪里

```

**Step 2: 提交**

Run:
```bash
git add packages/d-pi-official/docs/multi-agent/overview.md
git commit -m "docs(d-pi-official): add multi-agent overview page"
```

---

## Task 9: Multi-agent — `create-agent.md` + `send-message.md`

**Files:**
- Create: `packages/d-pi-official/docs/multi-agent/create-agent.md`
- Create: `packages/d-pi-official/docs/multi-agent/send-message.md`

**Step 1: 写 `create-agent.md`**

完整内容：

```markdown
---
title: create_agent
sidebar_position: 2
---

# create_agent

一句话：在当前 agent 下创建一个子 agent，返回子 agent 的 id。

## 用法

工具名 `create_agent`。Agent 在需要把任务委派给子 agent 时调用。

## 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 子 agent 名字，hub 内唯一 |
| `prompt` | string | 否 | 子 agent 的初始 system prompt |
| `parent_id` | string | 否 | 父 agent id；默认调用方自己 |

## 返回值

```json
{
  "id": "uuid-xxx",
  "name": "researcher",
  "parent_id": "uuid-yyy"
}
```

## 示例

**场景**：root agent 创建一个负责查文档的子 agent。

```bash
# Agent 在 LLM 决策时输出
create_agent(name="researcher", prompt="你是文档查询专家")
```

**预期返回**：

```json
{ "id": "a1b2-...", "name": "researcher", "parent_id": "<caller-id>" }
```

随后可用 `send_message(agent_id="researcher", message="...")` 派活。

## 相关

- [agent_network](./agent-network) — 查子 agent 是否已存在
- [send_message](./send-message) — 派活给子 agent
- [destroy_agent](./destroy-agent) — 收尾时清理

## 注意事项

- 子 agent 创建后会进入 `starting` 状态，等其首个 LLM 调用完成才进入 `running`
- `name` 一旦指定不可改；如需重命名，destroy + create

```

**Step 2: 写 `send-message.md`**

完整内容：

```markdown
---
title: send_message
sidebar_position: 3
---

# send_message

一句话：把消息派给指定 agent（异步，不等回复）。

## 用法

工具名 `send_message`。Agent 用来给子 agent 或并行 agent 派活。

## 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `agent_id` | string | 是 | 目标 agent id 或 name |
| `message` | string | 是 | 消息内容 |

## 返回值

```json
{
  "delivered": true,
  "agent_id": "<resolved-id>"
}
```

## 示例

**场景**：root agent 给刚创建的 `researcher` 派活。

```bash
send_message(agent_id="researcher", message="研究 React Server Components 的核心机制")
```

**预期返回**：

```json
{ "delivered": true, "agent_id": "a1b2-..." }
```

目标 agent 会在它的下一轮 LLM 推理中处理这条消息。

## 相关

- [create_agent](./create-agent) — 创建目标 agent
- [agent_network](./agent-network) — 查 agent id

## 注意事项

- **异步语义**：消息成功派发即返回，**不等**目标 agent 完成
- 想等目标 agent 完成再继续：先用 `agent_network` 轮询，或在 message 里写「完成后请通知我」
- `agent_id` 支持用 name 自动解析；如果有重名会失败

```

**Step 3: 提交**

Run:
```bash
git add packages/d-pi-official/docs/multi-agent/create-agent.md packages/d-pi-official/docs/multi-agent/send-message.md
git commit -m "docs(d-pi-official): add multi-agent create-agent and send-message pages"
```

---

## Task 10: Multi-agent — `agent-network.md` + `destroy-agent.md` + `meta-connect.md`

**Files:**
- Create: `packages/d-pi-official/docs/multi-agent/agent-network.md`
- Create: `packages/d-pi-official/docs/multi-agent/destroy-agent.md`
- Create: `packages/d-pi-official/docs/multi-agent/meta-connect.md`

**Step 1: 写 `agent-network.md`**

完整内容：

```markdown
---
title: agent_network
sidebar_position: 4
---

# agent_network

一句话：查整个 agent 树，返回所有 agent 的状态、父子关系。

## 用法

工具名 `agent_network`。无参数，立即返回当前 hub 上的拓扑快照。

## 参数

无。

## 返回值

```json
{
  "rootId": "<root-id>",
  "agents": [
    {
      "id": "<id-1>", "name": "root", "status": "running",
      "parent_id": null, "children": ["<id-2>"]
    },
    {
      "id": "<id-2>", "name": "researcher", "status": "running",
      "parent_id": "<id-1>", "children": []
    }
  ]
}
```

## 示例

**场景**：root agent 派活前先查一下子 agent 是否已存在。

```bash
agent_network()
```

**预期返回**：

```json
{
  "rootId": "r-1",
  "agents": [
    { "id": "r-1", "name": "root", "status": "running", "parent_id": null, "children": ["r-2"] },
    { "id": "r-2", "name": "researcher", "status": "running", "parent_id": "r-1", "children": [] }
  ]
}
```

## 相关

- [create_agent](./create-agent) — 创建后这里能看到
- [destroy_agent](./destroy-agent) — 销毁后这里看不到

## 注意事项

- 调用时拿的是**快照**，没有强一致性；并发创建/销毁可能短暂看到中间态
- 用 agent **name**（不是 id）调 `destroy_agent` / `send_message` 更稳

```

**Step 2: 写 `destroy-agent.md`**

完整内容：

```markdown
---
title: destroy_agent
sidebar_position: 5
---

# destroy_agent

一句话：销毁一个 agent 及其所有子 agent（递归）。

## 用法

工具名 `destroy_agent`。Agent 收尾时调用。

## 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `agent_id` | string | 是 | 目标 agent id 或 name |

## 返回值

```json
{
  "destroyed": ["<id-1>", "<id-2>", "<id-3>"]
}
```

返回的 `destroyed` 列表包含被销毁的 agent 及其所有递归子 agent。

## 示例

**场景**：任务完成，root agent 清理临时子 agent。

```bash
destroy_agent(agent_id="researcher")
```

**预期返回**：

```json
{ "destroyed": ["r-2", "r-3"] }
```

（假设 `researcher` 下面还有子 agent `r-3`，一起被销毁）

## 相关

- [create_agent](./create-agent) — 对面
- [agent_network](./agent-network) — 销毁前先确认

## 注意事项

- 销毁是**递归**的：传一个父 agent 会把它所有子 agent 一起干掉
- 销毁 root agent 不会关 hub，只是让 root 进入 `destroyed` 状态
- 已经在 running 的子 agent 会先收到 graceful shutdown 信号

```

**Step 3: 写 `meta-connect.md`**

完整内容：

```markdown
---
title: connect <id>
sidebar_position: 6
---

# connect &lt;id&gt;

一句话：在 client TUI 输入 `connect <id_or_name>`，把后续消息定向到指定 agent。

## 用法

在 d-pi connect TUI 里输入：

```
connect researcher
```

或用 id：

```
connect r-2
```

TUI 提示切换到该 agent 的会话上下文，后续你输入的内容直接派给该 agent。

## 行为

- 当前 agent 会收到一条 `meta` 消息，标记为「用户已切到 <id>」
- TUI prompt 区显示当前目标 agent 名字
- 后续用户消息**只发给**目标 agent，不发当前 agent
- 切回原 agent：再次 `connect <原名>`

## 示例

**场景**：你在 TUI 里跟 root agent 聊着聊着，想直接跟 `researcher` 子 agent 说话。

```
> connect researcher
[d-pi] switched to agent: researcher (r-2)
> 你好，帮我查一下 X 主题
（researcher 收到并开始处理）
```

切回来：

```
> connect root
[d-pi] switched to agent: root (r-1)
```

## 相关

- [agent_network](../multi-agent/agent-network) — 查 agent id / name
- [/agents 命令](../remote-execution/slash-agents) — 图形化切换

## 注意事项

- `connect` 切的是**消息路由**，不是切换 TUI 主题；TUI 仍然显示同一个 root 会话
- meta 消息会被注入到原 agent 的上下文（带 `connect` 标记），原 agent 看到你切走了

```

**Step 4: 提交**

Run:
```bash
git add packages/d-pi-official/docs/multi-agent/agent-network.md packages/d-pi-official/docs/multi-agent/destroy-agent.md packages/d-pi-official/docs/multi-agent/meta-connect.md
git commit -m "docs(d-pi-official): add multi-agent agent-network, destroy-agent, meta-connect pages"
```

---

## Task 11: Sources — `overview.md` + `create-source.md`

**Files:**
- Create: `packages/d-pi-official/docs/sources/overview.md`
- Create: `packages/d-pi-official/docs/sources/create-source.md`

**Step 1: 写 `overview.md`**

完整内容：

```markdown
---
title: 概览
sidebar_position: 1
---

# 数据源（Sources）

Sources 是把外部命令的输出流注入到 agent 上下文的机制。
你可以注册一个 shell 命令（`tail -f logs`、`ps aux`、自定义脚本），
agent 订阅后，命令的 stdout 会被持续地推送到 agent 上下文里。

## 工具一览

| 工具 | 用途 |
|---|---|
| [create_source](./create-source) | 注册一个 source（命令 + 名字） |
| [subscribe_source](./subscribe-source) | 订阅 source 推送（agent 收到） |
| [unsubscribe_source](./unsubscribe-source) | 取消订阅 |
| [list_sources](./list-sources) | 列出 hub 上所有 source |
| [/sources](./slash-sources) | client TUI 命令，图形化查看 |

## 端到端例子

把 `tail -f /var/log/app.log` 注册成 source 并订阅：

```
1. create_source(name="app-logs", command="tail -f /var/log/app.log")
   → source 进入 running 状态

2. subscribe_source(source_name="app-logs")
   → agent 上下文开始收到新 log 行

3. agent 处理 log，看到 ERROR 级别时自动 create_agent 派子 agent 分析

4. unsubscribe_source(source_name="app-logs")
5. destroy_source 收尾（暂未提供）
```

## 相关

- [多 Agent 编排 → 概览](../multi-agent/overview) — agent 拿到 log 后派活的模式
- [/sources 命令](./slash-sources) — client 端查看

```

**Step 2: 写 `create-source.md`**

完整内容：

```markdown
---
title: create_source
sidebar_position: 2
---

# create_source

一句话：注册一个 source（一条 shell 命令），hub 拉起子进程跑它，stdout 流到订阅者。

## 用法

工具名 `create_source`。Agent 用来把外部数据接入上下文。

## 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | source 名字，hub 内唯一 |
| `command` | string | 是 | 完整 shell 命令（含参数） |
| `cwd` | string | 否 | 命令运行目录 |

## 返回值

```json
{
  "id": "<source-id>",
  "name": "app-logs",
  "status": "running",
  "command": "tail -f /var/log/app.log"
}
```

## 示例

**场景**：agent 监控应用日志。

```bash
create_source(name="app-logs", command="tail -f /var/log/app.log")
```

**预期返回**：

```json
{ "id": "s-1", "name": "app-logs", "status": "running", "command": "tail -f /var/log/app.log" }
```

随后 `subscribe_source(source_name="app-logs")` 即可开始接收日志。

## 相关

- [subscribe_source](./subscribe-source)
- [list_sources](./list-sources)
- [unsubscribe_source](./unsubscribe-source)

## 注意事项

- 命令在 **hub 所在机器** 上跑（不是 client 机器）
- `command` 走 shell 解释，支持 `|` / `&&` 等
- 大流量命令（每秒上千行）可能拖慢 agent；考虑加 `grep` / `awk` 过滤

```

**Step 3: 提交**

Run:
```bash
git add packages/d-pi-official/docs/sources/overview.md packages/d-pi-official/docs/sources/create-source.md
git commit -m "docs(d-pi-official): add sources overview and create-source pages"
```

---

## Task 12: Sources — `subscribe-source.md` + `unsubscribe-source.md` + `list-sources.md`

**Files:**
- Create: `packages/d-pi-official/docs/sources/subscribe-source.md`
- Create: `packages/d-pi-official/docs/sources/unsubscribe-source.md`
- Create: `packages/d-pi-official/docs/sources/list-sources.md`

**Step 1: 写 `subscribe-source.md`**

完整内容：

```markdown
---
title: subscribe_source
sidebar_position: 3
---

# subscribe_source

一句话：把指定 source 的 stdout 流订阅到当前 agent 的上下文。

## 用法

工具名 `subscribe_source`。Agent 调一次即可，hub 持续把新数据推过来。

## 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source_name` | string | 是 | source 名字（不是 id） |

## 返回值

立即返回 `{"subscribed": true}`，后续推送走 hub 异步通知。

## 示例

**场景**：监控日志。

```bash
subscribe_source(source_name="app-logs")
```

**预期返回**：

```json
{ "subscribed": true }
```

随后 agent 会在 LLM 决策时看到 source 新输出的内容（作为用户消息的 `customType: "d-pi-source"` 流）。

## 相关

- [create_source](./create-source) — 先有 source
- [unsubscribe_source](./unsubscribe-source) — 取消订阅

## 注意事项

- 一个 source 可被多个 agent 订阅，互不影响
- agent 退出或被 destroy 时，订阅自动清理

```

**Step 2: 写 `unsubscribe-source.md`**

完整内容：

```markdown

---
title: unsubscribe_source
sidebar_position: 4
---

# unsubscribe_source

一句话：取消对 source 的订阅，agent 上下文不再收到新数据。

## 用法

工具名 `unsubscribe_source`。

## 参数

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `source_name` | string | 是 | source 名字 |

## 返回值

```json
{ "unsubscribed": true }
```

## 示例

```bash
unsubscribe_source(source_name="app-logs")
```

## 相关

- [subscribe_source](./subscribe-source) — 对面

```

**Step 3: 写 `list-sources.md`**

完整内容：

```markdown
---
title: list_sources
sidebar_position: 5
---

# list_sources

一句话：列出 hub 上所有 source 及其状态。

## 用法

工具名 `list_sources`。无参数。

## 返回值

```json
[
  {
    "id": "s-1",
    "name": "app-logs",
    "status": "running",
    "command": "tail -f /var/log/app.log",
    "subscriberCount": 2
  },
  {
    "id": "s-2",
    "name": "ps-aux",
    "status": "running",
    "command": "ps aux | head -20",
    "subscriberCount": 0
  }
]
```

## 示例

```bash
list_sources()
```

## 相关

- [create_source](./create-source) — 注册
- [subscribe_source](./subscribe-source) — 订阅
- [/sources 命令](./slash-sources) — client 端图形化查看

```

**Step 4: 提交**

Run:
```bash
git add packages/d-pi-official/docs/sources/subscribe-source.md packages/d-pi-official/docs/sources/unsubscribe-source.md packages/d-pi-official/docs/sources/list-sources.md
git commit -m "docs(d-pi-official): add sources subscribe, unsubscribe, list pages"
```

---

## Task 13: Sources — `slash-sources.md`

**Files:**
- Create: `packages/d-pi-official/docs/sources/slash-sources.md`

**Step 1: 写文件**

完整内容：

```markdown
---
title: /sources
sidebar_position: 6
---

# /sources

一句话：在 client TUI 里以面板形式查看 hub 上所有 source。

## 用法

在 `d-pi connect` TUI 里输入：

```
/sources
```

TUI 弹出一个 panel，列出所有 source 及其状态：

```
Sources (3)
  app-logs [running] command="tail -f /var/log/app.log" subscribers=2
  ps-aux [running] command="ps aux | head -20" subscribers=0
  build-watch [stopped] command="npm run watch" subscribers=0
```

## 行为

- 命令在 client 端发 HTTP 请求到 hub（`GET /_hub/sources`）
- hub 返回 JSON，client 渲染成可滚动 panel
- 仅查看，不可操作（创建/订阅还得调工具）
- Esc 退出 panel

## 相关

- [list_sources 工具](./list-sources) — agent 用
- [create_source](./create-source) — agent 创建

## 注意事项

- 命令在 client 端执行，所以需要 `DPI_AUTH_TOKEN` 配对
- source 命令本身跑在 hub 机器上（不是 client 机器）

```

**Step 2: 提交**

Run:
```bash
git add packages/d-pi-official/docs/sources/slash-sources.md
git commit -m "docs(d-pi-official): add sources /sources slash command page"
```

---

## Task 14: Remote-execution — `overview.md` + `executor-lifecycle.md`

**Files:**
- Create: `packages/d-pi-official/docs/remote-execution/overview.md`
- Create: `packages/d-pi-official/docs/remote-execution/executor-lifecycle.md`

**Step 1: 写 `overview.md`**

完整内容：

```markdown
---
title: 概览
sidebar_position: 1
---

# 远程执行（Remote Execution）

d-pi 的 agent worker 跑在 hub 机器上（可能在云上），但**工具执行**可以路由回 client 机器，
你（client 端）拥有真正的本地文件、shell、env var。

## 架构

```
client (你)                                          hub (云)            
                                                                             
  pi TUI  ─┐                                                                  
           ├─→  executor 子进程  ──→  hub (RPC)  ──→  agent worker (LLM)
           │   (跑 native tools)                                                  
           │                                                                     
  你机器的 bash / read / write  <──返回结果──  hub  <──返回结果──  agent     
```

## 关键点

- **Executor 是 client 端的子进程**，跟 TUI 一起由 `d-pi connect` 拉起
- Executor 持有 pi 的 native tool 集（read / bash / write / ...）
- Hub 把 agent 的 `remote_*` 工具调用路由到 executor
- Agent 看到的 `remote_bash` 跟 native `bash` 用法完全一样——只是**执行位置**在 client

## 工具一览

（agent 视角）

| 工具 | 等价 native |
|---|---|
| `remote_bash` | `bash` |
| `remote_read` | `read` |
| `remote_ls` | `ls` |
| `remote_grep` | `grep` |
| `remote_find` | `find` |
| `remote_write` | `write` |
| `remote_edit` | `edit` |

## 端到端例子

agent 帮你看本地 config：

```
用户：帮我看看 ~/.zshrc 里有没有设置 RUSTUP_HOME
  → agent 调 remote_grep(pattern="RUSTUP_HOME", path="/Users/me/.zshrc")
  → hub 路由到 client executor
  → executor 在你机器上跑 grep /Users/me/.zshrc → RUSTUP_HOME
  → 结果回 agent → agent 答用户
```

## 相关

- [executor 生命周期](./executor-lifecycle) — connect 启停
- [remote tools 详情](./remote-tools)
- [/agents 命令](./slash-agents) — client 端切换 agent

```

**Step 2: 写 `executor-lifecycle.md`**

完整内容：

```markdown
---
title: Executor 生命周期
sidebar_position: 2
---

# Executor 生命周期

一句话：executor 跟 TUI 一起由 `d-pi connect` 拉起和回收。

## 启动

跑 `d-pi connect` 时，connect 进程会同时拉起：

1. pi TUI 子进程（`pi connect 模式`）
2. d-pi executor 子进程（`d-pi _executor-child`，持有 native tools）

executor 启动后向 hub 注册（`POST /_hub/executor/register`），然后建立 SSE 长连接接收工具调用。

## 运行中

executor 收到工具调用时：

1. 在 client 机器的 cwd 上跑 native tool
2. 把结果 POST 回 hub（`POST /_hub/executor/results`）
3. hub 路由回 agent

executor 跟 hub 走长连接，AbortSignal 透传，agent Ctrl+C 取消会立即终止 executor 里的工具。

## 退出

当 TUI 退出或 hub 死掉时，connect 给 executor 发 SIGTERM：

- executor 的 SIGTERM handler 立即 `process.exit(0)`（不等 SSE drain）
- 终端状态（光标、kitty 协议、bracketed paste）被父进程 pop 干净
- hub 上 `connect_id` 绑定自动清理

## 进程关系

```
shell                                                           
  └─ d-pi connect (parent)                                       
       ├─ pi TUI (子进程)                                        
       └─ d-pi executor (子进程)                                 
            └─ SSE 连接到 hub
```

## 相关

- [connect 命令](../getting-started/connect)
- [第一次会话](../getting-started/first-session) — 跑通 executor 链路

## 注意事项

- executor 跑在 **client 机器的 cwd**，不是 hub 机器的 cwd
- 在 ssh / tmux 里跑 connect，executor 继承 ssh session 的 cwd
- executor 的 native tool 集跟 agent worker 的 native tool 集**完全一致**——
  `remote_*` 工具只是工具名前缀加 `remote_`

```

**Step 3: 提交**

Run:
```bash
git add packages/d-pi-official/docs/remote-execution/overview.md packages/d-pi-official/docs/remote-execution/executor-lifecycle.md
git commit -m "docs(d-pi-official): add remote-execution overview and executor-lifecycle pages"
```

---

## Task 15: Remote-execution — `remote-tools.md` + `slash-agents.md`

**Files:**
- Create: `packages/d-pi-official/docs/remote-execution/remote-tools.md`
- Create: `packages/d-pi-official/docs/remote-execution/slash-agents.md`

**Step 1: 写 `remote-tools.md`**

完整内容：

```markdown
---
title: remote_* 工具集
sidebar_position: 3
---

# remote_* 工具集

一句话：7 个 `remote_*` 工具对应 7 个 pi native 工具，agent 调用时执行在 client 机器。

## 工具清单

| 工具 | 等价 native | 用途 |
|---|---|---|
| `remote_bash` | `bash` | 跑 shell 命令 |
| `remote_read` | `read` | 读文件 |
| `remote_ls` | `ls` | 列目录 |
| `remote_grep` | `grep` | 按 pattern 搜内容 |
| `remote_find` | `find` | 按文件名搜 |
| `remote_write` | `write` | 写文件 |
| `remote_edit` | `edit` | 局部编辑 |

每个工具的参数、返回值跟 native 版本**完全一致**，只是工具名前缀 `remote_`。

## 调用方式

agent 调工具时直接用：

```
remote_read(path="/Users/me/.zshrc")
remote_bash(command="ls -la /tmp | head -5")
remote_grep(pattern="TODO", path="/Users/me/projects")
```

## 工具背后

`remote_*` 是 d-pi 的 inline extension 注册到 agent worker 的：

```
agent LLM 输出: remote_read(path="/Users/me/.zshrc")
  ↓
remote_read.execute() 内部发 POST /agents/<id>/remote-call 到 hub
  ↓
hub 路由到对应 connect_id 的 executor
  ↓
executor 在 client 机器跑 read("/Users/me/.zshrc")
  ↓
结果回 agent
```

## AbortSignal 透传

agent 决策时按 Ctrl+C 取消工具调用，会：

1. agent → remote_*.execute() 收到 AbortSignal
2. fetch 带 signal → hub
3. hub → executor SSE
4. executor 调用 native tool 时传 signal
5. 工具被中止，agent 收到 abort 错误

## 相关

- [概览](./overview)
- [executor 生命周期](./executor-lifecycle)
- [参考 → Agent 工具](../reference/tools) — 完整工具参数表

## 注意事项

- 工具执行在 **client 机器的 cwd**，不是 agent worker 的 cwd
- `remote_bash` 跑的是 client 用户的 shell，权限跟 client 登录用户一致
- 大文件（>1MB）可能拖慢；考虑分块读

```

**Step 2: 写 `slash-agents.md`**

完整内容：

```markdown
---
title: /agents
sidebar_position: 4
---

# /agents

一句话：在 client TUI 里以面板形式查看 agent 树并切换。

## 用法

在 `d-pi connect` TUI 里输入：

```
/agents
```

TUI 弹出 panel，以树形展示 hub 上的 agent 网络：

```
Agent network (4)
  root [running] (r-1) ← current
    researcher [running] (r-2)
    writer [stopped] (r-3)
      writer-sub [running] (r-4)
```

选中一个 agent 按 Enter → TUI 切换到该 agent 上下文（等价于 `connect <id>`）。

## 行为

- 命令在 client 端发 HTTP 请求到 hub（`GET /_hub/network`）
- hub 返回当前拓扑快照
- client 渲染成树形 panel，支持 Enter 选中、Esc 退出
- 切换后 TUI prompt 区显示当前目标 agent

## 相关

- [connect &lt;id&gt;](../multi-agent/meta-connect) — 命令行等价
- [agent_network 工具](../multi-agent/agent-network) — agent 用

## 注意事项

- 命令在 client 端执行，需要 `DPI_AUTH_TOKEN` 配对
- panel 是快照，agent 状态可能在 select 期间已变化

```

**Step 3: 提交**

Run:
```bash
git add packages/d-pi-official/docs/remote-execution/remote-tools.md packages/d-pi-official/docs/remote-execution/slash-agents.md
git commit -m "docs(d-pi-official): add remote-execution remote-tools and slash-agents pages"
```

---

## Task 16: Auth — `users.md` + `allow-user.md` + `dpi-auth-token.md`

**Files:**
- Create: `packages/d-pi-official/docs/auth/users.md`
- Create: `packages/d-pi-official/docs/auth/allow-user.md`
- Create: `packages/d-pi-official/docs/auth/dpi-auth-token.md`

**Step 1: 写 `users.md`**

完整内容：

```markdown
---
title: 用户管理
sidebar_position: 1
---

# d-pi users

一句话：管理 hub 上**本地的**用户账号（用于人/客户端身份，不影响 LLM provider）。

## 子命令

| 命令 | 用途 |
|---|---|
| `d-pi users create <name>` | 创建本地用户 |
| `d-pi users list` | 列出所有用户 |
| `d-pi users update <name>` | 更新 description |
| `d-pi users delete <name>` | 删除用户 |

## 用法

创建用户：

```bash
d-pi users create alice --description "Alice's local account"
```

输出：

```
Created local user alice
description: Alice's local account
publicKey: ed25519:...
```

列出：

```bash
d-pi users list
```

更新：

```bash
d-pi users update alice --description "Alice (admin)"
```

删除：

```bash
d-pi users delete alice
```

## 参数

`create` / `update` 共用：

| 标志 | 说明 |
|---|---|
| `--description` | 用户描述 |

## 相关

- [允许的用户](./allow-user) — 控制谁能连 hub
- [DPI_AUTH_TOKEN](./dpi-auth-token) — 客户端 auth 头

## 注意事项

- 本地用户**不**等同于 LLM provider 账号；它只用于 hub 侧身份
- 删用户不影响其历史 session（sessions 持久化在 `.dpi/sessions/`）

```

**Step 2: 写 `allow-user.md`**

完整内容：

```markdown
---
title: 允许的用户
sidebar_position: 2
---

# d-pi allow-user

一句话：白名单——只有名单里的本地用户被允许连到这个 hub。

## 子命令

| 命令 | 用途 |
|---|---|
| `d-pi allow-user add <name>` | 加入白名单 |
| `d-pi allow-user list` | 列出白名单 |
| `d-pi allow-user update <name>` | 更新 key / description / 启停 |
| `d-pi allow-user remove <name>` | 从白名单移除 |

## 用法

添加用户（带公钥）：

```bash
d-pi allow-user add alice --key ed25519:abc123... --description "Alice's laptop"
```

列出：

```bash
d-pi allow-user list
```

禁用（不删）：

```bash
d-pi allow-user update alice --disabled true
```

移除：

```bash
d-pi allow-user remove alice
```

## 参数

`add` / `update`：

| 标志 | 说明 |
|---|---|
| `--key` | 公钥（ed25519 格式） |
| `--description` | 描述 |
| `--disabled` | `true` / `false`，不禁用 = `false` |

## 相关

- [用户管理](./users) — 创建本地用户
- [DPI_AUTH_TOKEN](./dpi-auth-token) — 客户端连接时怎么带 token

## 注意事项

- `allow-user` **必须**在 d-pi workspace 根目录跑
- 第一次启动 hub 时，hub 自动为**当前 OS 用户**生成 local user + token + 加入白名单
- 多个用户共享一个 hub 时，给每个用户加 `--key` 限制访问

```

**Step 3: 写 `dpi-auth-token.md`**

完整内容：

```markdown
---
title: DPI_AUTH_TOKEN
sidebar_position: 3
---

# DPI_AUTH_TOKEN

一句话：`d-pi connect` 客户端必带的 bearer token，hub 用来验证调用方身份。

## 用法

环境变量方式：

```bash
export DPI_AUTH_TOKEN=<your-token>
d-pi connect --url http://hub.example.com:39090
```

或单次前缀：

```bash
DPI_AUTH_TOKEN=<your-token> d-pi connect --url http://hub.example.com:39090
```

## 怎么拿 token

hub 第一次启动会为当前 OS 用户生成一个 token，存到 `.dpi/hub-state.json`：

```bash
cat .dpi/hub-state.json | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['tokens'][0])"
```

把输出复制下来当 token 用。

## 行为

hub 收到 client 请求时：

1. 从 `Authorization: Bearer <token>` 头拿 token
2. 在 hub 内部 token 表里查找
3. 找到 → 接受；找不到 → 401

## 跨机器共享

如果你想让另一台机器上的 client 连这个 hub：

1. 在 hub 机器生成一个新 token
2. 复制到 client 机器（用 secret manager、scp、或其他安全通道）
3. client 端 `export DPI_AUTH_TOKEN=<that-token>`
4. client 端 `d-pi allow-user add <name> --key <pubkey>` 登记 client 公钥（如果开了公钥校验）

## 相关

- [用户管理](./users)
- [允许的用户](./allow-user)
- [connect 命令](../getting-started/connect)

## 注意事项

- token 等同于密码，泄露 = 失去 hub 控制权
- 当前 alpha 默认**开启** auth（无 `--no-auth` 之类的关法），所有 client 必须带 token
- 失效 token 立即 401，client TUI 会显示 401 错误

```

**Step 4: 提交**

Run:
```bash
git add packages/d-pi-official/docs/auth/users.md packages/d-pi-official/docs/auth/allow-user.md packages/d-pi-official/docs/auth/dpi-auth-token.md
git commit -m "docs(d-pi-official): add auth users, allow-user, dpi-auth-token pages"
```

---

## Task 17: Reference — `cli.md`

**Files:**
- Create: `packages/d-pi-official/docs/reference/cli.md`

**Step 1: 写文件**

完整内容：

```markdown
---
title: CLI 命令
sidebar_position: 1
---

# CLI 命令参考

一句话：所有 `d-pi <command>` 的清单。

## 顶层命令

| 命令 | 用途 | 文档 |
|---|---|---|
| `d-pi init` | 在当前目录创建 d-pi workspace | [快速上手 → init](../getting-started/init) |
| `d-pi serve` | 启动 hub | [快速上手 → serve](../getting-started/serve) |
| `d-pi connect` | 连到 hub 进入 TUI | [快速上手 → connect](../getting-started/connect) |

## 用户管理

### `d-pi users`

| 子命令 | 说明 |
|---|---|
| `d-pi users create <name>` | 创建本地用户 |
| `d-pi users list` | 列出 |
| `d-pi users update <name>` | 更新 |
| `d-pi users delete <name>` | 删除 |

详见 [用户管理](../auth/users)。

### `d-pi allow-user`

| 子命令 | 说明 |
|---|---|
| `d-pi allow-user add <name>` | 加入白名单 |
| `d-pi allow-user list` | 列出 |
| `d-pi allow-user update <name>` | 更新 |
| `d-pi allow-user remove <name>` | 移除 |

详见 [允许的用户](../auth/allow-user)。

## 全局标志

| 标志 | 适用 | 说明 |
|---|---|---|
| `--help`, `-h` | 所有 | 显示帮助 |
| `--version`, `-V` | 所有 | 显示版本 |

## 环境变量

| 变量 | 用途 |
|---|---|
| `DPI_AUTH_TOKEN` | client 端必带的 bearer token |
| `DPI_HUB_URL` | executor 子进程的 hub URL（运行时注入） |
| `DPI_CONNECT_ID` | executor 子进程的 connect id（运行时注入） |
| `DPI_CWD` | executor 子进程的 cwd（运行时注入） |

## 相关

- [Agent 工具参考](./tools) — agent 视角
- [Slash 命令参考](./slash-commands) — TUI 视角

```

**Step 2: 提交**

Run:
```bash
git add packages/d-pi-official/docs/reference/cli.md
git commit -m "docs(d-pi-official): add reference cli page"
```

---

## Task 18: Reference — `tools.md`

**Files:**
- Create: `packages/d-pi-official/docs/reference/tools.md`

**Step 1: 写文件**

完整内容：

```markdown
---
title: Agent 工具
sidebar_position: 2
---

# Agent 工具参考

一句话：所有 agent 可调的工具，按多 agent / sources / remote 三类。

## 多 Agent 编排

| 工具 | 用途 | 文档 |
|---|---|---|
| `agent_network` | 查整个 agent 树 | [多 Agent → agent_network](../multi-agent/agent-network) |
| `create_agent` | 创建子 agent | [多 Agent → create_agent](../multi-agent/create-agent) |
| `send_message` | 派活给 agent | [多 Agent → send_message](../multi-agent/send-message) |
| `destroy_agent` | 销毁 agent | [多 Agent → destroy_agent](../multi-agent/destroy-agent) |

## Sources（数据源）

| 工具 | 用途 | 文档 |
|---|---|---|
| `create_source` | 注册 source | [Sources → create_source](../sources/create-source) |
| `subscribe_source` | 订阅 | [Sources → subscribe_source](../sources/subscribe-source) |
| `unsubscribe_source` | 取消订阅 | [Sources → unsubscribe_source](../sources/unsubscribe-source) |
| `list_sources` | 列出 | [Sources → list_sources](../sources/list-sources) |

## Remote Execution（远程工具）

工具名前缀 `remote_`，在 client 机器执行：

| 工具 | 等价 native |
|---|---|
| `remote_bash` | `bash` |
| `remote_read` | `read` |
| `remote_ls` | `ls` |
| `remote_grep` | `grep` |
| `remote_find` | `find` |
| `remote_write` | `write` |
| `remote_edit` | `edit` |

详见 [Remote Execution → remote tools](../remote-execution/remote-tools)。

## pi 原生工具

agent worker 跑在 hub 上，**默认**可以调所有 pi coding-agent 内置工具（`bash` / `read` / `ls` / `grep` / `find` / `write` / `edit`）。
这些工具跑在 **hub 机器**——如果你希望它们跑在 client 机器，调对应的 `remote_*` 版本。

## 相关

- [CLI 命令](./cli)
- [Slash 命令](./slash-commands)

```

**Step 2: 提交**

Run:
```bash
git add packages/d-pi-official/docs/reference/tools.md
git commit -m "docs(d-pi-official): add reference tools page"
```

---

## Task 19: Reference — `slash-commands.md`

**Files:**
- Create: `packages/d-pi-official/docs/reference/slash-commands.md`

**Step 1: 写文件**

完整内容：

```markdown
---
title: Slash 命令
sidebar_position: 3
---

# Slash 命令参考

一句话：在 `d-pi connect` TUI 里以 `/` 开头的命令。

## d-pi 注册的命令

| 命令 | 用途 | 文档 |
|---|---|---|
| `/sources` | 图形化查看 hub 上所有 source | [Sources → /sources](../sources/slash-sources) |
| `/agents` | 图形化查看 agent 树并切换 | [Remote Execution → /agents](../remote-execution/slash-agents) |

## pi 内置命令（透传）

pi coding-agent 自带的 slash 命令在 d-pi TUI 里同样可用，常用的：

| 命令 | 用途 |
|---|---|
| `/help` | 显示帮助 |
| `/clear` | 清空当前会话 |
| `/compact` | 压缩上下文 |
| `/model` | 切换模型 |
| `/exit` / `/quit` | 退出 TUI |

完整列表见 [上游 pi 文档](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/usage.md)。

## 自定义扩展命令

如果你安装了第三方 d-pi 扩展，它可能注册额外的 `/` 命令。
用 `/commands` 查看当前 TUI 加载的所有命令。

## 相关

- [CLI 命令](./cli)
- [Agent 工具](./tools)

```

**Step 2: 提交**

Run:
```bash
git add packages/d-pi-official/docs/reference/slash-commands.md
git commit -m "docs(d-pi-official): add reference slash-commands page"
```

---

## Task 20: Build verification (full `npm run check`)

**Files:** none (verification only)

**Step 1: 跑全 build + typecheck**

Run: `cd packages/d-pi-official && npm run check 2>&1 | tail -40`
Expected: 退出码 0，最后若干行是 `Done in <Xs>.` 或 `Generated static files in build/`。

**Step 2: 解决任何报错**

如果 `tsc --noEmit` 报错：

- 多数情况是 `docusaurus.config.ts` / `sidebars.ts` 的类型问题，**别**改 config 绕过去，先看错误定位
- 罕见情况是 `@easyops-cn/docusaurus-search-local` 跟 docusaurus 版本不兼容，pin 一个已知组合（`@docusaurus/core@3.10.1` + `@easyops-cn/docusaurus-search-local@0.51.0` 是 2026-06 验证过的）

如果 `docusaurus build` 报错：

- `Broken link` → `sidebars.ts` 引用了不存在的文件，或 markdown 内部链接路径写错
- `Invalid sidebar` → sidebar items 列表里有 typo
- 用 `npm run build -- --no-minify 2>&1 | tail -50` 拿到更详细错误

**Step 3: 跑 served build 抽查 5 页**

Run: `cd packages/d-pi-official && npm run serve &` (后台起)
Run: `sleep 3 && curl -sL http://localhost:3000/intro | head -5`
Expected: 看到 `<title>D-Pi Agent Teams</title>`，不是 404。

抽查 5 个随机页面（每页 head -5 看 title 正确）：

Run:
```bash
for p in multi-agent/overview remote-execution/remote-tools auth/dpi-auth-token reference/cli getting-started/install; do
  echo "=== $p ===";
  curl -sL "http://localhost:3000/$p" | grep -E "<title>|<h1" | head -2;
done
```
Expected: 每个页面 title 跟 h1 都正常，5 篇都 200。

Run: `kill %1` 停掉 serve。

**Step 4: 提交（如有配置调整）**

如果 Task 20 没改任何文件，**不**提交。
如果改了什么：

Run:
```bash
git add <changed-files>
git commit -m "fix(d-pi-official): address build/typecheck issues"
```

---

## Task 21: Versioning snapshot (v0.6)

**Files:**
- Generate: `packages/d-pi-official/versioned_docs/version-0.6/*` (by Docusaurus)
- Generate: `packages/d-pi-official/versioned_sidebars/version-0.6-sidebars.json` (by Docusaurus)

**Step 1: 切快照**

Run: `cd packages/d-pi-official && npm run docusaurus docs:version 0.6`
Expected: Docusaurus 把 `docs/` 拷贝到 `versioned_docs/version-0.6/`，把 `sidebars.ts` 拷成 `versioned_sidebars/version-0.6-sidebars.json`，然后把 `docs/` 清空成 `current` 模板。

**Step 2: 恢复 `docs/` 内容**

Docusaurus 的 `docs:version` 命令会把 `docs/` 替换成只含 `_category_.json` 的空模板，
**我们当前的 docs 内容是想要的 `current` 内容**（v0.7-dev），所以**需要恢复**。

Run: `cd packages/d-pi-official && git checkout -- docs/`
Expected: 28 篇 markdown 文件恢复。

**Step 3: 验证 build**

Run: `cd packages/d-pi-official && npm run build 2>&1 | tail -20`
Expected: build 通过。Docusaurus 会在 navbar 显示 `0.6 (current)` 下拉。

**Step 4: 提交**

Run:
```bash
git add packages/d-pi-official/versioned_docs/version-0.6 packages/d-pi-official/versioned_sidebars/version-0.6-sidebars.json
git commit -m "feat(d-pi-official): snapshot v0.6 docs"
```

**Step 5: 再次确认**

Run: `ls packages/d-pi-official/versioned_docs/version-0.6/`
Expected: 看到 `getting-started/` `multi-agent/` `sources/` `remote-execution/` `auth/` `reference/` `intro.md`。

Run: `cat packages/d-pi-official/versioned_sidebars/version-0.6-sidebars.json | head -10`
Expected: 看到 sidebar JSON，跟 `sidebars.ts` 内容一致。

---

## Task 22: Final sanity check + handoff

**Files:** none (verification only)

**Step 1: 完整 check 一遍**

Run: `cd packages/d-pi-official && npm run check 2>&1 | tail -20`
Expected: 通过。

**Step 2: 跑一次完整 dev 流程**

Run: `cd packages/d-pi-official && timeout 6 npm run start 2>&1 | head -20`
Expected: 看到 `[SUCCESS] Docusaurus server is running on port 3000.` 或类似启动信息。被 timeout 杀是预期的。

**Step 3: 列最终交付**

Run: `git log --oneline origin/main..HEAD`
Expected: 看到 1 个 commit（`docs(d-pi-official): design for D-Pi Agent Teams docs site`）领先 origin/main 之外，**还有** 22 个左右来自本次实现的 commits。

Run: `ls packages/d-pi-official/docs/`
Expected: 6 个子目录 + `intro.md`。

Run: `find packages/d-pi-official/docs -name "*.md" | wc -l`
Expected: `28`（含 intro.md）。

Run: `ls packages/d-pi-official/versioned_docs/version-0.6/ | head`
Expected: 看到 v0.6 快照的子目录。

**Step 4: 通知用户**

报告：
- 实现总 commit 数
- 28 篇页面全部就位
- v0.6 快照生成
- `npm run check` 通过
- 本地 dev 启动正常
- 询问用户是否要本地跑 `npm run start` 手动 spot-check

---

## Done

至此 v1 设计文档要求全部实现：
- 28 篇 markdown 页面覆盖 d-pi 全部已实现功能
- 1 个 logo placeholder
- 1 份 v0.6 versioning 快照
- 6 段统一页面模板
- 本地搜索、zh-CN 单 locale、clean URLs
- `npm run check`（tsc + docusaurus build）通过

未来增量（v1 范围外）：
- 部署到 GH Pages / Vercel / 自定义域
- 加英文 i18n
- 写 tutorial / walkthrough
- Algolia 搜索
- 多版本并行（v0.5 / v0.4 ...）
- 真实 logo / 品牌资源

