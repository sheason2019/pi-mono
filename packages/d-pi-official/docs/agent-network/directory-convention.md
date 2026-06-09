---
title: 目录约定
sidebar_position: 2
---

#目录约定

一句话：`agent-network/`下面**支持哪些文件、每个文件被 d-pi怎么用、不支持什么**——这是 d-pi跟项目作者之间的契约。

##完整布局

```
agent-network/
├── AGENTS.md # 网络级共享上下文（所有 agent共享）
├── skills/ # 网络级 skill池
│ ├── <skill-name>/ # 一个 skill 一个目录
│ │ └── SKILL.md # skill教学内容（markdown）
│ └── ...
├── extensions/ # 网络级 extension池
│ ├── <ext-name>.ts # 或 .js / .mjs
│ └── ...
└── roles/ #角色定义
 ├── <role-name>/ # 一个角色一个目录
 │ ├── AGENTS.md
 │ ├── skills/
 │ └── extensions/
 └── ...
```

**结构是 `agent-network/` → `AGENTS.md / skills/ / extensions/ / roles/<name>/{AGENTS.md, skills/, extensions/}`**——**网络级**和 **role级**的子结构**完全对称**（都是 AGENTS.md + skills + extensions三件套）。

注：`agent-network/` 在 workspace根（**不**在 `.dpi/` 下）；workspace顶级还有 `skills/` `extensions/`目录（也不在 `.dpi/` 下）作为 fallback 网络级 skill/extension池。

## 每类文件的支持能力

### `agent-network/AGENTS.md`（网络级）

|维度 | 说明 |
|---|---|
| **存在与否** | 可选；不存在 =没有任何网络级上下文 |
| **格式** | markdown |
| **什么时候被读** | hub启动时（root agent）+任何子 agent创建时 |
| **作用** | 内容作为 **agents files**合并进所有 agent 的上下文；LLM把它当指令读 |
| **不读它** | 是没写这个文件 |
| **不写 markdown以外的格式** |写了 d-pi不解析（如 `AGENTS.txt`、JSON都不会被加载） |

### `agent-network/skills/<skill>/SKILL.md`（网络级）

|维度 | 说明 |
|---|---|
| **存在与否** | 可选 |
| **格式** | `SKILL.md`（固定文件名，**必须**叫这个） |
| **什么时候被读** | agent启动时把整个目录加入 skill搜索路径；agent 用 `read`工具按需查阅 |
| **作用** | 给所有 agent提供"如何用某工具链"的标准化教学 |
| **约定** | 一个 skill一个目录，目录里**至少**要 `SKILL.md` |
| **不读它** | 文件名不是 `SKILL.md`（如 `README.md` / `skill.md` / 大小写错） |

### `agent-network/extensions/<ext>`（网络级）

|维度 | 说明 |
|---|---|
| **存在与否** | 可选 |
| **格式** |任意（`.ts` / `.js` / `.mjs`都可以） |
| **什么时候被读** |整个 extensions目录**递归扫描**所有条目（`workspace.ts:discoverExtensionEntries`），加进 `additionalExtensionPaths` |
| **作用** | 给所有 agent注入自定义 extension（pi的扩展机制） |
| **约定** |详见 pi扩展文档；典型内容是 `defineTool`注册的工具 |
| **递归扫描** | 单文件、目录（有 `package.json` + `pi.extensions` manifest 或 `index.ts`/`index.js`）、任意 `.ts`/`.js` 子文件都会被加载 |

### `agent-network/roles/<name>/{AGENTS.md, skills/, extensions/}`（role级）

跟网络级三件套**完全对称**——同名目录、同样支持能力，**只**对**套了此 role 的 agent**生效。

|维度 | 说明 |
|---|---|
| **role名字规范** |短词、kebab-case短串（`researcher` / `code-reviewer`），不是 `code-research-assistant` |
| **不存在** |引用此 role 的 agent创建时 hub抛 `Unknown agent role "<name>"` |
| **目录可空** | 空目录 =啥也不附加（但会浪费一次 `existsSync`，建议至少放个 README标注） |
| **AGENTS.md必填吗** | 不必，可空——空 role 主要靠 skills/extensions加载 |

## 不被 d-pi识别的常见反模式

| 你写的 |期望 |实际 |
|---|---|---|
| `agent-network/README.md` | 网络级说明 | d-pi不读（只读 `AGENTS.md`） |
| `agent-network/skills/skill.md`（小写） | skill加载 | d-pi不读（固定 `SKILL.md`） |
| `agent-network/roles/root/AGENTS.md` 里写"我是 root" | root自动套 | 是的，root会自动套（详见 [roles文档](./roles) 的「root 的 implicit规则」），但**名字最好别叫 root**（命名冲突 +跟"root agent"概念混淆） |

## merge顺序详解

`workspace.ts:loadWorkspaceContext()` 的合并逻辑（**靠后覆盖**）：

```
context = { }
context.workspacePrompt = workspace 级 APPEND_SYSTEM.md (if exists)
context.agentsFiles = []
context.skillPaths = []
context.extensionPaths = []

pushAgentsFileIfExists(agentsFiles, agent-network/AGENTS.md) # 网络级 AGENTS.md
pushIfExists(skillPaths, agent-network/skills) # 网络级 skills
pushExtensionEntriesIfExists(extensionPaths, agent-network/extensions) # 网络级 extensions

for each role in effective_roles:
 if role.dir 不存在:
 if role.implicit: continue
 else: throw "Unknown agent role"
 pushAgentsFileIfExists(agentsFiles, role.dir/AGENTS.md)
 pushIfExists(skillPaths, role.dir/skills)
 pushExtensionEntriesIfExists(extensionPaths, role.dir/extensions)

pushIfExists(skillPaths, workspace顶级 skills/)
pushExtensionEntriesIfExists(extensionPaths, workspace顶级 extensions/)
```

**最终 context**（按追加顺序）：

1. workspace 级 `APPEND_SYSTEM.md`
2. **网络级** `agent-network/AGENTS.md`（如果有）
3. **网络级** `agent-network/skills/`
4. **网络级** `agent-network/extensions/`
5. **Role级**（按 effective roles顺序）`agent-network/roles/<role>/{AGENTS.md, skills/, extensions/}`
6. **Workspace顶级** `skills/` + `extensions/`
7. **Agent 级** `agents/<name>/AGENTS.md`（由 `loadWorkspaceContext` 调用方负责加，源在 `hub.createAgent` 的 `rebindSession`流程）

**同类型资源**（比如两个 AGENTS.md）的合并 = **追加**：两份内容都进 LLM上下文，靠后的拼后面。LLM看到的是**完整的多份文件内容**（用文件路径或注释区分），不是去重合并。

**不同类型资源**（AGENTS.md + skills + extensions）的合并 = **配置合并**：skills路径追加、extension path追加、AGENTS.md内容追加。

##校验规则

`hub.createAgent` 创建子 agent时（或 hub启动恢复 root 时）会做以下校验：

1. **role必须存在** ——引用 `roles=["foo"]` 但 `agent-network/roles/foo/` 不存在 →抛 `Unknown agent role "foo": <path>`
2. **implicit role缺失静默跳过** —— root 的 effective roles总是包含 implicit `"root"`，但 `agent-network/roles/root/`缺失时静默 continue（**不报错**）
3. **role名字重复** —— 不允许（同一 hub内），但**跨 hub允许**（不同 workspace独立）
4. **agent名字重复** —— hub内 `create_agent(name="foo")` 时 `foo` 已存在 →抛 `Agent with name "foo" already exists`
5. **空 role** ——允许（仅创建空目录没意义，但合法）

##怎么配置

###启用 root 的 roles

编辑 `agents/root/agent.json`：

```json
{
 "name": "root",
 "parentName": null,
 "roles": ["researcher", "writer", "reviewer"]
}
```

**注意**：`d-pi serve` **没有** `--roles` CLI标志——root 的 roles只能从 `agents/root/agent.json`读，**CLI层面无 escape hatch**。

###启用子 agent 的 roles

`create_agent`工具的 `roles` 参数：

```bash
create_agent(name="cr-1", roles=["reviewer"])
```

详见 [create_agent工具](../multi-agent/create-agent)。子 agent 的 roles也被持久化到 `agents/<name>/agent.json`，hub重启后自动恢复。

##重新加载语义

**role文档修改后不会自动重载**——文件在 `hub.createAgent` 时被读取，已经启动的 agent不会重新读。

**想让 role修改生效**，需要：

-删掉所有引用此 role 的 agent：`destroy_agent(name)`（或重启 hub一次性销毁）
- 等修改完，重新创建：`create_agent(roles=[...])`

**或**重启 hub（自动按 agent.json恢复 agent 并重新加载 role资源）。

**PR23 reload工具例外**：`reload` LLM-callable工具能让 agent 在**不重启 hub**的情况下重新加载 skills / system prompt / AGENTS.md / extensions。但 role目录约定加载发生在 `hub.createAgent`，reload工具**不**触发 role 重读——role目录约定修改仍需重启 hub或 destroy+recreate agent。

## 相关

- [概览](./overview) ——三层结构总览
- [角色 Roles](./roles) ——role 子约定深入
- [示例](./examples) ——完整 worked example
- [多 Agent编排 →概览](../multi-agent/overview) —— runtime视角
