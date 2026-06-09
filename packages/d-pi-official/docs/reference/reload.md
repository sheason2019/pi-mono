---
title: reload
sidebar_position: 3
---

# reload

一句话：LLM-callable工具，让 agent在**不重启 hub**的情况下重新加载自己的上下文资源（skills / system prompt / AGENTS.md / extensions）。

##用法

工具名 `reload`。无参数。Agent在修改了 workspace的 `AGENTS.md` / `APPEND_SYSTEM.md` / `skills/` / `extensions/` 后调一次，刷新自己的内存。

##参数

无。

##返回值

工具返回**纯 text + JSON snapshot**：

```
Reload completed. Post-reload state: {"skills":7,"systemPrompt":"<truncated first200 chars>","appendSystemPrompt":"<truncated>","contextFiles":3}
```

`details`字段是结构化的 post-reload状态：

|字段 |类型 |含义 |
|---|---|---|
| `skills` |number | 当前加载的 skill数 |
| `systemPrompt` |string |截断后的 system prompt首200字符 |
| `appendSystemPrompt` |string |截断后的 APPEND_SYSTEM.md首200字符 |
| `contextFiles` |number | 当前加载的 agents files 数（含 workspace + agent-network + role + agent级所有 AGENTS.md） |

##示例

**场景**:用户改了 `agents/<name>/AGENTS.md`，想让 agent立刻看到，不需要重启 hub。

```
请用 reload工具刷新一下你的上下文
```

agent调 `reload()`，返回刷新后的 snapshot，确认 `contextFiles` 等数字符合预期。

##相关

- [Agent工具参考 → Runtime工具](./tools#runtime工具reload)
- [Agent Network目录约定 →重新加载语义](../agent-network/directory-convention)

##注意事项

- `reload` **不**触发 `agent-network/roles/<role>/` 重读——role目录加载发生在 `hub.createAgent`，role修改仍需 destroy + recreate 或重启 hub
- `reload` **不**重新解析 `agents/<name>/agent.json`（agent wiring）——修改 `agent.json`（roles / model / tools / excludeTools）仍需重启 hub
- `reload`跑在 in-flight turn 的当前 session；如果 agent正在跑 tool调用，会被 abort（in-flight turn abort 后下一 turn看到 reload后的 context）
- `reload`失败时（e.g. resource loader还没初始化）返回 isError；agent看到错误后可以重试或 fallback 到手动重启 hub
- `reload` 是 PR23 inline extension的一部分（commit `0b93eab91`），由 `extension/reload-tools.ts:createReloadTools` 注册
