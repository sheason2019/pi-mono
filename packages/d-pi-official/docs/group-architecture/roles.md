---
title: 角色（Roles）
sidebar_position: 3
---

#角色（Roles）

一句话：role 是 `group-architecture/roles/<name>/`下的一个目录，里面装「指令 + skill + extension」，给子 agent套上即用。**它是 Group Architecture约定下的子概念**——`directory-convention`讲目录怎么放，本页讲 role怎么写。

## 一个 role长什么样

```
group-architecture/roles/researcher/
├── AGENTS.md # 该角色的指令
├── skills/ # 该角色专属 skill
│ └── git-bisect/
│ └── SKILL.md
└── extensions/ # 该角色专属 extension
 └── auto-cite.ts
```

跟网络级三件套**完全对称**——role本质是「带名字的网络级配置包」。

## root 的 implicit规则

`workspace.ts:getEffectiveRoles` 的核心逻辑：

- **root agent**（`agentName === "root"`）的 effective roles：
 -总是包含 implicit `"root"`（除非 `roles`列表里已经显式包含）
 - **结果**：`group-architecture/roles/root/` 如果存在，root **自动**加载它——**不需要**在 `agents/root/agent.json` 里写 `"roles": ["root"]`
 - 如果 `group-architecture/roles/root/` 不存在，静默跳过（不报错）
- **子 agent**（任何其他 `agentName`）的 effective roles：
 - **不**implicit加任何东西
 - 完全靠 `create_agent(roles=[...])`工具参数传

**实践建议**：

- **不要**把你的 root配置目录叫 `root`——会跟"root agent"概念混淆。建议叫 `core` / `orchestrator` / `main`之类的
- 在 `agents/root/agent.json` 的 `roles`列表里**不需要**包含 `root`（除非你显式要把某个 role叫 `root`）
-列表里写**所有**role（root 的 +任何想给 root套的），按需要的顺序

##怎么套 role

###套给 root

`agents/root/agent.json`：

```json
{
 "name": "root",
 "parentName": null,
 "roles": ["researcher", "writer", "reviewer"]
}
```

hub启动时**自动恢复**——重启 hub后 root仍带这套 roles。

###套给子 agent

`create_agent`工具的 `roles`参数：

```bash
create_agent(
 name="code-reviewer-1",
 roles=["reviewer"]
)
```

详见 [create_agent工具](../multi-agent/create-agent)。**多 role累加**：

```bash
create_agent(name="auditor", roles=["researcher", "reviewer"])
```

子 agent同时拿到 researcher + reviewer 的资源，merge顺序按 `roles`数组顺序（**靠后覆盖**）。

##写一个 role的7步

### Step1：选名字

从 task类型反推。短词、kebab-case。常见候选：

- `researcher`（查资料、读代码、跑实验）
- `writer`（写文档、写 commit message）
- `reviewer`（审 PR、找 bug）
- `planner`（拆任务、列步骤）
- `tester`（写测试、跑测试）
- `debugger`（追问题）
- `documenter`（写注释、写 README）

**role数量 ≤5**。多了 root选不过来，**用 [meta-connect](../multi-agent/meta-connect)显式路由**而不是让它自己挑。

### Step2：建目录

```bash
mkdir -p group-architecture/roles/researcher/{skills,extensions}
```

`AGENTS.md` 不必现在创建，**空 role也合法**（只是不附加任何东西）。

### Step3：写 AGENTS.md（指令，不是文档）

```markdown
# Role: researcher

你专门负责查资料、读代码、跑实验。**不**做改动，只产出发现。

##工作流

1. 先 `group_architecture()` 看现有 sub-agent，确认没有重复劳动
2. 用 `grep` / `find`定位相关代码，不要 `bash + cat`全文读
3. 用 `read`读关键文件（不超过5个，避免上下文爆炸）
4.输出一句话总结 +关键发现清单

##工具偏好

- `grep` 而不是 `bash + grep`——参数更结构化
- `read`读文件而不是 `cat`——保留行号
- `group_architecture`查拓扑，不要硬编码 agent id

##输出格式

汇报时严格按这个结构（以「查找 TODO注释」为例）：

\`\`\`text
【发现】 src/ 下共有17处 TODO注释，其中3处标记了具体的修复人
【证据】 src/auth/login.ts:42, src/api/users.ts:88, src/db/migrate.ts:15
【不确定】 src/legacy/下的5处 TODO是否仍需关注
【下一步建议】 先把3处有 owner 的 TODO转成 issue
\`\`\`

##不要做

- 不要 `write` / `edit`改任何文件
- 不要 `create_agent`派活
- 不要超过5次工具调用
```

**关键**：**AGENTS.md 是给 LLM看的指令，不是给人看的参考**。**别**写成 API文档。

### Step4：放 skill（如果该角色常用某工具链）

```bash
mkdir -p group-architecture/roles/researcher/skills/git-bisect
```

写 `group-architecture/roles/researcher/skills/git-bisect/SKILL.md`：

```markdown
---
name: git-bisect
description: 用 git bisect找引入 bug 的 commit。Use when 需要定位「哪一次提交引入了某个回归」。
---

# git bisect

##步骤

1.确认 good commit（不含 bug）和 bad commit（含 bug）
2.跑：
 ```bash
 git bisect start
 git bisect bad <bad-sha>
 git bisect good <good-sha>
 ```
3. git会 checkout中间 commit，让你能测试
4. 测试完告诉 git `git bisect good` 或 `git bisect bad`，继续二分
5.找到第一个 bad commit 后 `git bisect reset`

##坑

-确认 bug存在：用 `git stash`排除 working tree干扰
- 如果构建慢：用 `git bisect run <test-command>`自动化
```

### Step5：放 extension（可选）

写 `group-architecture/roles/researcher/extensions/auto-cite.ts`：

```ts
import type { ExtensionAPI } from "@sheason/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
 pi.on("before_provider_request", async (event) => {
 // 在每次 LLM请求前给消息附加 git log
 // ...
 });
}
```

extension加载是 **recursive**——子目录会扫，详见 [目录约定 → extensions](./directory-convention)。

### Step6：wire到 root

编辑 `agents/root/agent.json`：

```json
{
 "name": "root",
 "parentName": null,
 "roles": ["researcher", "writer", "reviewer"]
}
```

并在 `agents/root/AGENTS.md` 加一段让 root知道这些 role：

```markdown
#你的工具箱

- `create_agent(roles=["researcher"])` —派研究员查资料
- `create_agent(roles=["writer"])` —派写作手写文档
- `create_agent(roles=["reviewer"])` —派审查手审代码
```

### Step7：验证

```bash
d-pi serve &
sleep3
# root启动时 hub会读 group-architecture/，有错会打 stderr
ls group-architecture/roles/
cat group-architecture/roles/researcher/AGENTS.md
# 在 TUI跑 agent让它 create_agent(roles=["researcher"])，
#观察子 agent 的上下文里有没有 researcher/AGENTS.md 的内容
```

##常见误区

1. **把 roleAGENTS.md写成 API文档**——错了，那是给 LLM看的指令
2. **role数量爆炸**（>5）——root选不过来
3. **role之间互相依赖**——role应该是独立的，**不要**"role A假设 role B已经做了 X"
4. **改 role文档不重启 hub**——role文档在 `hub.createAgent` 时合并，hub启动后改 role文档**不会**自动 reload（PR23 的 `reload`工具也不触发 role 重读——role目录加载发生在 agent创建时）
5. **root角色叫 `root`**——跟"root agent"概念混淆，建议叫 `core` / `orchestrator` / `main`
6. **空 role浪费**——`group-architecture/roles/empty/` 空目录占个位置。删了或至少放个 README说明这是 placeholder
7. **role名字跟 agent名字撞**——`create_agent(name="researcher", roles=["researcher"])`合法但混乱；建议 agent用动词/动作名（`researcher-1` / `code-reviewer-job-1`）

##调试

|症状 |原因 |修法 |
|---|---|---|
| `Unknown agent role "foo"` | `group-architecture/roles/foo/` 不存在 |确认目录拼写 +拼写对得上（`kebab-case` vs `camelCase`） |
| role修改没生效 | hub已启动时改的 role | 重启 hub或 destroy + recreate引用此 role 的 agent |
| 子 agent上下文里看不到 role AGENTS.md | 文件名错（如 `readme.md` / `AGENT.md`） |改名成 `AGENTS.md`（区分大小写） |
| role里的 skill不工作 |目录名不是 `<skill>/SKILL.md`形式 |确认子目录里有 `SKILL.md`（固定文件名） |
| extension没加载 | 文件在不被识别的位置 | 检查 `workspace.ts:discoverExtensionEntries`递归规则（单文件 / `index.ts` / `package.json`里的 `pi.extensions` manifest 都算 entry） |

## 相关

- [目录约定](./directory-convention) ——完整文件系统布局
- [示例](./examples) ——3 个完整 worked example
- [create_agent工具](../multi-agent/create-agent) ——怎么用 `roles`参数
- [多 Agent编排 →概览](../multi-agent/overview) —— runtime视角
