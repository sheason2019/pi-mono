---
title: 示例
sidebar_position: 4
---

# 示例

三个**完整可粘贴**的 worked example，从 0 搭一个 group-architecture 出来。每个 example 自包含，能直接落地试。

---

## Example 1：最小可跑 — `researcher` 角色

只放一个角色，最简单。

**Step 1：建目录**

```bash
mkdir -p group-architecture/roles/researcher/skills
```

**Step 2：写 `group-architecture/roles/researcher/AGENTS.md`**

```markdown
# Role: researcher

你负责查资料、读代码、跑实验。**不**做改动，只产出发现。

## 工作流

1. `group_architecture()` 看现有 sub-agent，避免重复劳动
2. `grep` / `find` 定位相关代码
3. `read` 关键文件（不超过 5 个）
4. 输出发现清单

## 输出格式

```text
【发现】 src/auth/login.ts 缺输入校验
【证据】 src/auth/login.ts:42, 没有任何 sanitize 调用
【下一步建议】 加 zod schema 校验
```

## 不要做

- 不要 `write` / `edit`
- 不要 `create_agent` 派活
```

**Step 3：把 root 挂上**

编辑 `agents/root/agent.json`：

```json
{
  "name": "root",
  "parentName": null,
  "roles": ["researcher"]
}
```

`agents/root/AGENTS.md` 加：

```markdown
# 你的工具箱

- `create_agent(roles=["researcher"])` — 派研究员查资料
```

**Step 4：验证**

```bash
d-pi serve &
sleep 3
# 在 TUI 跑：
# "请用 researcher 角色找一下 src/ 里所有 TODO 注释"
# 应该看到子 agent 进入 starting → ready 状态，
# 输出符合【发现】/【证据】/【不确定】格式
```

---

## Example 2：多角色协作 — `researcher` + `writer` + `reviewer`

3 个 role 配对，模拟真实的多 agent 团队。

**Step 1：建 3 个目录**

```bash
mkdir -p group-architecture/roles/researcher/skills
mkdir -p group-architecture/roles/writer/skills
mkdir -p group-architecture/roles/reviewer/skills
```

**Step 2：3 个 AGENTS.md**

`group-architecture/roles/researcher/AGENTS.md`：

```markdown
# Role: researcher

查资料、读代码、跑实验。**不**改动任何文件。

## 工作流

1. `group_architecture()` 看 sub-agent 状态
2. `grep` / `find` 定位
3. `read` 关键文件（≤5）
4. 汇报

## 输出

```
【发现】`<一句话>`
【证据】`&lt;文件:行号&gt;
【下一步】&lt;建议&gt;
```
```

`group-architecture/roles/writer/AGENTS.md`：

```markdown
# Role: writer

写文档、写 commit message、写注释。**不**改逻辑代码。

## 工作流

1. 读上游 sub-agent 的输出（通过 hub 共享历史）
2. 整理成结构化文档
3. 用 `write` 写到 `docs/` 或 `.md` 注释位置
4. 给出可粘贴的 commit message

## 输出

- 文件路径
- 内容摘要
- 建议 commit message（Conventional Commits 格式）
```

`group-architecture/roles/reviewer/AGENTS.md`：

```markdown
# Role: reviewer

审代码、找 bug。**只读**，不修改。

## 工作流

1. `read` diff（git diff main..HEAD）
2. 检查：命名、错误处理、并发安全、测试覆盖
3. 给 5 条以内最严重的问题

## 输出

```
【问题 1】 src/api/posts.ts 的 createPost 缺鉴权
【位置】 src/api/posts.ts:24
【建议修法】 加 requireAuth() 中间件
【严重程度】 critical
```

## 不要做

- 不要 `bash` 跑测试（这是 tester 角色的事）
- 不要 `edit` 改代码
```

**Step 3：每个 role 配 1 个 skill**

```bash
# researcher: git bisect
mkdir -p group-architecture/roles/researcher/skills/git-bisect
cat > group-architecture/roles/researcher/skills/git-bisect/SKILL.md <<'SKILL_EOF'
---
name: git-bisect
description: 用 git bisect 找引入 bug 的 commit
---

# git bisect

1. 确认 good/bad commit
2. \`git bisect start; git bisect bad &lt;sha&gt;; git bisect good &lt;sha&gt;\`
3. 测试，`git bisect good` 或 `bad`
4. 找到后 `git bisect reset`
SKILL_EOF

# writer: markdown style
mkdir -p group-architecture/roles/writer/skills/markdown-style
cat > group-architecture/roles/writer/skills/markdown-style/SKILL.md <<'SKILL_EOF'
---
name: markdown-style
description: d-pi 文档站用的 markdown 风格（中文，6 段模板）
---

# markdown 风格

每篇功能页严格 6 段：

1. # title（一句话）
2. ## 用法
3. ## 参数（表格）
4. ## 返回值
5. ## 示例（bash 块）
6. ## 相关（链接）

可选第 7 段「注意事项」按需。
SKILL_EOF

# reviewer: PR checklist
mkdir -p group-architecture/roles/reviewer/skills/pr-checklist
cat > group-architecture/roles/reviewer/skills/pr-checklist/SKILL.md <<'SKILL_EOF'
---
name: pr-checklist
description: PR review 检查清单
---

# 检查清单

- [ ] 命名清晰（不缩写）
- [ ] 错误处理完整（不吞异常）
- [ ] 边界条件覆盖
- [ ] 测试覆盖新分支
- [ ] 文档同步（CHANGELOG、README）
- [ ] 无新依赖或依赖有理由
SKILL_EOF
```

**Step 4：root 挂上 3 个 role + 工具箱**

`agents/root/agent.json`：

```json
{
  "name": "root",
  "parentName": null,
  "roles": ["researcher", "writer", "reviewer"]
}
```

`agents/root/AGENTS.md`：

```markdown
# 你的工具箱

你有 3 个角色可以派：

- `create_agent(roles=["researcher"])` — 查资料
- `create_agent(roles=["writer"])` — 写文档
- `create_agent(roles=["reviewer"])` — 审代码

典型工作流：

1. researcher 查 → writer 写 → reviewer 审
2. researcher + reviewer 并行（一个查事实、一个查风格）
3. 直接调 reviewer 快速审
```

**Step 5：验证**

```bash
d-pi serve &
sleep 3
# TUI 跑：
# "请帮我研究 X 主题、写一篇文档、然后让 reviewer 审一遍"
# 应该看到 3 个子 agent 依次或并行启动
```

---

## Example 3：网络级共享 + role 组合

网络级放**所有 agent 都用得到**的资源，role 放**专项**。两者叠加。

**Step 1：网络级（所有 agent 共享）**

```bash
mkdir -p group-architecture/skills/bash-style
cat > group-architecture/AGENTS.md <<'AGENTS_EOF'
# 项目约定

## 代码风格

- TypeScript 严格模式
- 命名：camelCase 变量、PascalCase 类型
- 错误：用 Result 模式，不 throw

## 不要碰的路径

- `legacy/` — 老代码，准备扔
- `vendor/` — 第三方

## 提交规范

- Conventional Commits（feat / fix / docs / refactor）
- 1 commit 1 件事
AGENTS_EOF

cat > group-architecture/skills/bash-style/SKILL.md <<'SKILL_EOF'
---
name: bash-style
description: d-pi 项目的 bash 脚本风格
---

# bash 风格

- `set -euo pipefail` 必须
- 变量双引号
- 用 `[[ ]]` 不是 `[ ]`
- 函数用 `function name()` 形式
SKILL_EOF
```

**Step 2：role 放专项（继承网络级 + 自己的）**

```bash
mkdir -p group-architecture/roles/security-auditor/skills
cat > group-architecture/roles/security-auditor/AGENTS.md <<'AGENTS_EOF'
# Role: security-auditor

在项目约定基础上，专门做安全审计。

## 重点

- 注入风险（SQL / shell / path）
- 敏感信息泄露（log 里打印 token / 写文件用错 mode）
- 认证 / 授权遗漏

## 输出

按发现严重度排序，critical 放最前。
AGENTS_EOF

cat > group-architecture/roles/security-auditor/skills/owasp-top10/SKILL.md <<'SKILL_EOF'
---
name: owasp-top10
description: OWASP Top 10 检查清单
---

# OWASP Top 10 (2021)

- A01 Broken Access Control
- A02 Cryptographic Failures
- A03 Injection (SQL / NoSQL / OS command / LDAP)
- A04 Insecure Design
- A05 Security Misconfiguration
- A06 Vulnerable and Outdated Components
- A07 Identification and Authentication Failures
- A08 Software and Data Integrity Failures
- A09 Security Logging and Monitoring Failures
- A10 Server-Side Request Forgery (SSRF)
SKILL_EOF
```

**Step 3：root 挂上**

`agents/root/agent.json`：

```json
{
  "name": "root",
  "parentName": null,
  "roles": ["security-auditor"]
}
```

**Step 4：观察 merge 顺序**

子 agent `create_agent(roles=["security-auditor"])` 启动时，effective context 包含（**按顺序**）：

1. workspace 级 `AGENTS.md`（如果存在）
2. **网络级** `group-architecture/AGENTS.md`（项目约定）
3. **网络级** `group-architecture/skills/bash-style/`（bash 风格）
4. **Role 级** `group-architecture/roles/security-auditor/AGENTS.md`（角色指令）
5. **Role 级** `group-architecture/roles/security-auditor/skills/owasp-top10/`（OWASP checklist）
6. agent 级 `agents/&lt;name&gt;/AGENTS.md`（agent 自己的）

**Step 5：验证**

```bash
d-pi serve &
sleep 3
# TUI 跑：
# "请 security-auditor 检查 src/auth/ 下的所有文件"
# 子 agent 应该：先用 bash-style skill（set -euo pipefail），
# 再用 owasp-top10 skill（A01-A10），
# 然后 read 文件找注入、敏感信息等。
```

---

## 三个 example 对照

| 维度 | Example 1 | Example 2 | Example 3 |
|---|---|---|---|
| 角色数 | 1 | 3 | 1（+ 网络级） |
| 网络级共享 | 无 | 无 | 有（约定 + 通用 skill） |
| 角色 skill | 无 | 各 1 个 | 1 个 |
| 适用场景 | 试水 | 真实多 agent 团队 | 真实项目治理 |

**起步建议**：

- 先做 Example 1 验证流程跑通
- 再做 Example 2 跑多角色协作
- 真要做项目级落地时加 Example 3 的网络级共享

## 相关

- [目录约定](./directory-convention) —— 完整文件系统布局 + merge 规则
- [角色 Roles](./roles) —— role 7 步设计流程
- [概览](./overview) —— 三层结构总览
