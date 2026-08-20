# yinian-plugin-feishu-project

[一念（Yinian）](https://github.com/VangelisHaha/nikou-agenda)的**飞书项目（Meegle）排期同步**插件。

工作项成一条任务，工作项下的**每个排期节点成一个排期块**——排期直接落到一念的日历时间轴上，不是只有一个截止时间的细标记。

## 和「飞书任务」插件的区别

| | 飞书任务 | 飞书项目（本插件） |
|---|---|---|
| 数据源 | 飞书任务（Todo） | 飞书项目 / Meegle 的工作项排期 |
| 时间信息 | 只有截止时间 | **每个节点各有起止时间与估分** |
| 落进一念 | 一个任务，日历上是 Deadline 标记 | 一个任务 + 多个排期块，日历上占时间轴 |
| 认证 | OAuth device flow（浏览器授权） | 一个 MCP Token，不用开浏览器 |
| 排期权威方 | — | **飞书**。你在飞书调排期，一念跟着变 |

两个插件可以同时装，互不影响。

## 装之前

去[飞书项目的 MCP 配置页](https://project.feishu.cn/b/mcp)做两件事：

1. **打开个人偏好里的 MCP 开关**
2. 复制页面上的 Token（`m-` 开头）

开关没开的话 Token 有效也会被拒绝，报 `MCPPersonalPreferenceDisabled`——插件会把这个错原样显示并带上配置页链接，不会静默变成「同步了但没数据」。

## 怎么工作

飞书项目返回的是**扁平的排期节点列表**，同一个工作项有几个节点就出现几次：

```
[7072539263] KAZ-BCC银行接入 · 中台开发  8/14~8/20  5d   reached
[7072539263] KAZ-BCC银行接入 · 中台联调  8/17~8/24  2d
[7072539263] KAZ-BCC银行接入 · 中台提测  8/20~8/20  1d
[7048219224] 招商银行银证接口改造 · 中台开发  8/24~10/10  27d
```

插件**按工作项聚合**：上面这段落进一念是 2 个任务，第一个挂 3 个排期块。反过来做（每个节点各成一个任务）会让任务列表被同一个需求的各阶段刷屏。

| 飞书项目 | 一念 |
|---|---|
| 工作项 | Task，`externalId` = 工作项 id |
| 排期节点 / 子任务 | 排期块，`externalRef` = `state_id`（有子任务时 `state_id:subtask_id`） |
| `time.start` / `time.end` | 排期块的起止时间 |
| `state.passed` / `reached` | 块状态 finished / active / planned |
| 所有节点估分之和 | 任务估时（按 8 小时人天折算） |
| 最晚一段的结束时间 | 任务截止时间 |

状态由 `passed` / `reached` 这两个**流转标记**推导，不看 `work_item_status`——后者是空间自定义的状态流 key（实测是 `zmkpy9tok` 这种随机串），跨空间没有统一含义。

同步来的任务在一念的任务详情里有一个「来源」区块，除了「在 <实例名> 中打开」按钮（点开原始工作项），还会展示这几个飞书项目独有的字段：

| 字段 | 取值 |
|---|---|
| 空间 | 实例配置里的 `projectKey` |
| 当前节点 | 正在进行（`reached && !passed`）的节点名 |
| 排期负责人 | 这些节点排给了谁 |
| 排期节点 | 一共几段 |

这些字段走契约的 `details`（`docs/11-plugin-architecture.md` §5.1），一念只负责原样展示，核心不认识飞书项目。**需要宿主 0.5.9 以上**；更老的版本会忽略这一块，其余功能不受影响。

## 边界

- **排期只从飞书流向一念**，不反向推。飞书是排期的权威，两边各改一半再 merge 出来的结果和两边都不一致。想在一念这边自己排期，用手工排期块——同步永远不碰它们。
- **只回写完成状态，而且只在工作项恰好只有一个排期节点时回写**。飞书的「完成」是节点级流转，一个工作项挂四个节点时「任务完成了」对应哪个节点并不确定，猜错会在飞书上推错流程。多节点的会跳过并在日志里说明。
- **不带未排期的工作项**。没有排期时间的节点在飞书里就是「未排期」，硬塞一个块只会在日历上凭空多一段。
- **临时任务默认不同步**，实例设置里勾上「临时任务」才带。
- **工作项掉出拉取窗口不算被删除**，插件不会上报 `deletedExternalIds`——否则关联会被标成「外部已删除」，你会以为飞书那边删了东西。

## 开发

```bash
npm install
npm run verify        # build + doctor + 测试
npm run pack:zip      # 出 release/yinian-feishu-project-v{version}.zip
```

集成方式是**官方的 streamable HTTP MCP**，不是 stdio：

```
POST https://project.feishu.cn/mcp_server/v1
  X-Mcp-Token: m-…                      ← 不是 Authorization: Bearer
  X-Meego-MCP-Connection-Type: stdio
  Accept: application/json, text/event-stream
JSON-RPC 2.0：initialize → mcp-session-id → notifications/initialized → tools/call
```

所以 manifest 里只要 `net` 权限，不需要 `spawn`、npx 或任何运行时依赖。`larksuite/meegle-cli`（Go）与 `@lark-project/mcp`（Node）底下都是这个端点，后者只是它的 stdio 包装器。

三个容易踩的点写在代码注释里：鉴权头必须是 `X-Mcp-Token`、必须走完握手拿会话、`Accept` 要同时含 JSON 与 SSE。

契约见[插件架构文档](https://github.com/VangelisHaha/nikou-agenda/blob/main/docs/11-plugin-architecture.md)，排期段部分在 §5.1。
