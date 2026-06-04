---
title: 目录约定
sidebar_position: 2
---

# 目录约定

一句话：`.dpi/agent-network/` 下面**支持哪些文件、每个文件被 d-pi 怎么用、不支持什么**——这是 d-pi 跟项目作者之间的契约。

## 完整布局

```
.dpi/agent-network/
├── AGENTS.md          # 网络级共享上下文（所有 agent 共享）
├── skills/            # 网络级 skill 池
│   ├── <skill-name>/  # 一个 skill 一个目录
│   │   └── SKILL.md   # skill 教学内容（markdown）
│   └── ...
├── extensions/        # 网络级 extension 池
│   ├── <ext-name>.ts  # 或 .js / .mjs
│   └── ...
└── roles/             # 角色定义
    ├── <role-name>/   # 一个角色一个目录
    │   ├── AGENTS.md
    │   ├── skills/
    │   └── extensions/
    └── ...
```

**结构是 `agent-network/` → `AGENTS.md / skills/ / extensions/ / roles/&lt;name&gt;/{AGENTS.md, skills/, extensions/}`**——**网络级**和 **role 级**的子结构**完全对称**（都是 AGENTS.md + skills + extensions 三件套）。

## 每类文件的支持能力

### `.dpi/agent-network/AGENTS.md`（网络级）

| 维度 | 说明 |
|---|---|
| **存在与否** | 可选；不存在 = 没有任何网络级上下文 |
| **格式** | markdown |
| **什么时候被读** | hub 启动时（root agent）+ 任何子 agent 创建时 |
| **作用** | 内容作为 **agents files** 合并进所有 agent 的上下文；LLM 把它当指令读 |
| **不读它** | 是没写这个文件 |
| **不写 markdown 以外的格式** | 写了 d-pi 不解析（如 `AGENTS.txt`、JSON 都不会被加载） |

### `.dpi/agent-network/skills/&lt;skill&gt;/SKILL.md`（网络级）

| 维度 | 说明 |
|---|---|
| **存在与否** | 可选 |
| **格式** | `SKILL.md`（固定文件名，**必须**叫这个） |
| **什么时候被读** | agent 启动时把整个目录加入 skill 搜索路径；agent 用 `read` 工具按需查阅 |
| **作用** | 给所有 agent 提供"如何用某工具链"的标准化教学 |
| **约定** | 一个 skill 一个目录，目录里**至少**要 `SKILL.md` |
| **不读它** | 文件名不是 `SKILL.md`（如 `README.md` / `skill.md` / 大小写错） |

### `.dpi/agent-network/extensions/<ext>`（网络级）

| 维度 | 说明 |
|---|---|
| **存在与否** | 可选 |
| **格式** | 任意（`.ts` / `.js` / `.mjs` 都可以） |
| **什么时候被读** | 整个 extensions 目录扫描所有条目，加进 `additionalExtensionPaths` |
| **作用** | 给所有 agent 注入自定义 extension（pi 的扩展机制） |
| **约定** | 详见 pi 扩展文档；典型内容是 `defineTool` 注册的工具 |
| **注意点** | extension 加载是 **entry-level**——子目录不会被扫描；想嵌套用 workspace 顶级 `.dpi/extensions/` |

### `.dpi/agent-network/roles/&lt;name&gt;/{AGENTS.md, skills/, extensions/}`（role 级）

跟网络级三件套**完全对称**——同名目录、同样支持能力，**只**对**套了此 role 的 agent**生效。

| 维度 | 说明 |
|---|---|
| **role 名字规范** | 短词、kebab-case 短串（`researcher` / `code-reviewer`），不是 `code-research-assistant` |
| **不存在** | 引用此 role 的 agent 创建时 hub 抛 `Unknown agent role "&lt;name&gt;"` |
| **目录可空** | 空目录 = 啥也不附加（但会浪费一次 `existsSync`，建议至少放个 README 标注） |
| **AGENTS.md 必填吗** | 不必，可空——空 role 主要靠 skills/extensions 加载 |

## 不被 d-pi 识别的常见反模式

| 你写的 | 期望 | 实际 |
|---|---|---|
| `agent-network/README.md` | 网络级说明 | d-pi 不读（只读 `AGENTS.md`） |
| `agent-network/skills/skill.md`（小写） | skill 加载 | d-pi 不读（固定 `SKILL.md`） |
| `agent-network/extensions/foo/index.ts` | extension 加载 | 不扫子目录（只扫 entries） |
| `agent-network/roles/root/AGENTS.md` 里写"我是 root" | root 自动套 | 是的，root 会自动套（详见 [roles 文档](./roles) 的「root 的 implicit 规则」），但**名字最好别叫 root**（命名冲突 + 跟"root agent"概念混淆） |

## merge 顺序详解

`workspace.ts:loadWorkspaceContext()` 的合并逻辑（**靠后覆盖**）：

```
context = { }
context += workspace-level AGENTS.md (if exists)
context += network-level AGENTS.md       (if .dpi/agent-network/ exists)
context += workspace-level .dpi/skills/   (if exists)
context += workspace-level .dpi/extensions/ (if exists)
for each role in effective_roles:
  context += role.AGENTS.md
  context += role.skills/
  context += role.extensions/
context += agent-level agents/<name>/AGENTS.md
context += agent-level agents/<name>/.pi/APPEND_SYSTEM.md
return context
```

**同类型资源**（比如两个 AGENTS.md）的合并 = **追加**：两份内容都进 LLM 上下文，靠后的拼后面。LLM 看到的是**完整的多份文件内容**（用文件路径或注释区分），不是去重合并。

**不同类型资源**（AGENTS.md + skills + extensions）的合并 = **配置合并**：skills 路径追加、extension path 追加、AGENTS.md 内容追加。

## 校验规则

`hub.createAgent` 创建子 agent 时（或 hub 启动恢复 root 时）会做以下校验：

1. **role 必须存在** —— 引用 `roles=["foo"]` 但 `.dpi/agent-network/roles/foo/` 不存在 → 抛 `Unknown agent role "foo": <path>`
2. **implicit role 缺失不报错** —— root 的 effective roles 总是包含 implicit `"root"`，但 `.dpi/agent-network/roles/root/` 缺失时**静默跳过**
3. **role 名字重复** —— 不允许（同一 hub 内），但**跨 hub 允许**（不同 workspace 独立）
4. **agent 名字重复** —— hub 内 `create_agent(name="foo")` 时 `foo` 已存在 → 抛 `Agent with name "foo" already exists`
5. **空 role** —— 允许（仅创建空目录没意义，但合法）

## 怎么配置

### 启用 root 的 roles

编辑 `agents/root/agent.json`：

```json
{
  "name": "root",
  "parentName": null,
  "roles": ["researcher", "writer", "reviewer"]
}
```

**注意**：`d-pi serve` **没有** `--roles` CLI 标志——root 的 roles 只能从 `agents/root/agent.json` 读，**CLI 层面无 escape hatch**。

### 启用子 agent 的 roles

`create_agent` 工具的 `roles` 参数：

```bash
create_agent(name="cr-1", roles=["reviewer"])
```

详见 [create_agent 工具](../multi-agent/create-agent)。子 agent 的 roles 也被持久化到 `agents/&lt;name&gt;/agent.json`，hub 重启后自动恢复。

## 重新加载语义

**role 文档修改后不会自动重载**——文件在 `hub.createAgent` 时被读取，已经启动的 agent 不会重新读。

**想让 role 修改生效**，需要：

- 删掉所有引用此 role 的 agent：`destroy_agent(name)`（或重启 hub 一次性销毁）
- 等修改完，重新创建：`create_agent(roles=[...])`

**或**重启 hub（自动按 agent.json 恢复 agent 并重新加载 role 资源）。

## 相关

- [概览](./overview) —— 三层结构总览
- [角色 Roles](./roles) —— role 子约定深入
- [示例](./examples) —— 完整 worked example
- [多 Agent 编排 → 概览](../multi-agent/overview) —— runtime 视角
