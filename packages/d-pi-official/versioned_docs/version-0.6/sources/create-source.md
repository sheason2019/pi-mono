---
title: create_source
sidebar_position: 2
---

# create_source

一句话：注册一个 source（一条命令），hub拉起子进程跑它，stdout 必须按 [JSONRPC2.0 notification](https://www.jsonrpc.org/specification)格式输出，hub验证后流到订阅者。

##用法

工具名 `create_source`。Agent用来把外部数据接入上下文。

##参数

|字段 |类型 |必填 |说明 |
|---|---|---|---|
| `name` |string |是 | source名字，hub内唯一 |
| `command` |string |是 |argv[0]，要运行的可执行文件 |
| `args` |string[] |否 |逐字传给程序的参数列表，**不走 shell tokenization**（默认 `[]`） |
| `cwd` |string |否 |命令运行目录 |
| `env` |Record&lt;string,string&gt; |否 |附加环境变量 |

## Shell特性:用 `sh -c`

hub 用 `shell: false` + argv array spawn source（参 PR #10），所以管道 / 重定向 / 通配符 /变量展开 **不工作**。
需要 shell特性时显式调 `sh`：

```bash
# "tail -f /var/log/app.log | grep ERROR"
create_source(
 name="app-errors",
 command="sh",
 args=["-c", "tail -f /var/log/app.log | grep ERROR"]
)
```

>任意带空格的参数必须做成 `args` 的 **单个元素**，不要拆成多个元素或加引号 —拆了会被 tokenize 出错误 argv:
> `args: ["-c", "echo hello world"]` →实际跑 `sh -c 'echo hello world'`，对。
> `args: ["-c", "echo", "hello", "world"]` →实际跑 `sh -c echo hello world`，shell收到4个 token，错的。

##返回值

工具返回纯 text（不是 JSON结构）。Source 用 `name`标识，没有 `id`字段：

```
Source "app-logs" created and running. You have been automatically subscribed to this source.
```

##示例

**场景**:agent监控应用日志，进程持续输出 JSONRPC notification。

```bash
create_source(
 name="app-logs",
 command="sh",
 args=["-c", "while true; do echo '{\"jsonrpc\":\"2.0\",\"method\":\"log\",\"params\":{\"text\":\"foo\"}}'; sleep1; done"],
 cwd="/var/log"
)
```

**预期返回**:

```
Source "app-logs" created and running. You have been automatically subscribed to this source.
```

随后 `subscribe_source(source_name="app-logs")`（虽然已 auto-subscribe）即可开始接收推送。

## 相关

- [subscribe_source](./subscribe-source)
- [list_sources](./list-sources)
- [unsubscribe_source](./unsubscribe-source)
- [destroy_source](../reference/tools) —完整收尾

##注意事项

- 命令在 **hub所在机器** 上跑（不是 client机器）
- **stdout 必须按 JSONRPC notification格式** 输出，否则 hub静默 drop（参 [overview → stdout契约](./overview)）。原始日志输出（`tail -f` 不包装）不会被转发 — 用 `sh -c "cmd | while read line; do echo '{\"jsonrpc\":\"2.0\",...}'; done"`包装
- stdout 不是 JSONRPC 的行会被 silent invalid drop（**不写 stderr警告**，不挂 source）—这是 source自己的 contract，hub 不诊断
-进程退出 supervisor 会用 exponential backoff（10s →60s）自动重启，code0也会重启（`tail -f` 类长进程不应"正常完成"）
- 重试超过5 次后 source状态变 `failed`，需 `destroy_source` +修复 +重建
