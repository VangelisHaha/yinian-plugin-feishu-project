# AGENTS.md — yinian-plugin-feishu-project

[一念](https://github.com/VangelisHaha/nikou-agenda)的飞书项目（Meegle）排期同步插件。

## 必须遵守

- 中文回复，中文写注释与文档。
- 契约的 source of truth 是一念仓库的 `docs/11-plugin-architecture.md`，**不是本仓库的 SDK**。两者不一致时以文档为准。
- 改完必须 `npm run verify`（build + doctor + 测试）全绿。
- `src/sdk/` 是从 [yinian-plugin-template](https://github.com/VangelisHaha/yinian-plugin-template) 同步来的，**不要在这里改**——改了下次同步会被覆盖。有问题去模板仓库改。
- 不引任何运行时依赖。只用 Node 标准库 + `fetch`。

## 三条不能动的实现约束

1. **鉴权头是 `X-Mcp-Token`**。用 `Authorization: Bearer` 会被当成 OAuth 会话，所有 `tools/call` 都回 `MCPPersonalPreferenceDisabled`，看起来像开关没开，其实是头写错了。
2. **必须走完 MCP 握手**：`initialize` 拿 `mcp-session-id` → `notifications/initialized` → 之后每个请求带 session id。少了会话，服务端认不出是谁。
3. **`externalRef` 必须稳定**，只由 `state_id`（+ 子任务 id）构成。**绝不能把时间拼进去**——宿主靠它认出「同一段被改了时间」，含时间的话每次改排期都会变成删旧块建新块，块上记的实际起止时间跟着丢，还会每轮刷一堆出站事件。

## 不要做的事

- **不要按节点名猜完成状态**。节点名是「中台开发 / 技术方案设计评审 / 中台提测」这类，不含完成语义；而「确认上线」这种带「上线」的会被误判成已完成。权威来源是 `state.passed` / `reached`。`nikou-screen` 踩过这个坑并明确废弃了那套实现。
- **不要用 `work_item_status` 映射一念的任务状态**。它是空间自定义的状态流 key（实测 `zmkpy9tok` 这种随机串），跨空间没有统一含义。
- **不要回写排期**。飞书是排期的权威，见 README 的「边界」。
- **不要上报 `deletedExternalIds`**。工作项掉出拉取窗口不等于被删除。
- **不要在多节点工作项上回写完成状态**。飞书的完成是节点级流转，猜错节点会在飞书上推错流程。

## 时区

飞书返回的排期时间形如 `2026-08-14 00:00:00`，是**空间时区的本地时间且不带偏移**。必须按实例配置的 `utcOffset` 补上再转 RFC3339，当成 UTC 会让整段排期偏 8 小时、跨天节点的首尾日期都错。

## 发布

1. `yinian-plugin.json` 与 `package.json` 的 `version` 同步改。
2. `npm run pack:zip`。
3. Git tag **必须与 manifest 的 `version` 完全一致**，GitHub Release 挂那一个 zip。
4. 索引仓库 [yinian-plugins](https://github.com/VangelisHaha/yinian-plugins) 里加/留一条。

## AI 工具扩展（0.13.0 契约）

`src/handlers/tools.mts` 通过 SDK `toolHandlers` 注册，定义同时作为发现与执行的唯一来源。
公共 SDK 从官方模板同步；参数 Schema 使用宿主支持的子集。读工具不得写入，写工具必须依赖
宿主注入的稳定 operationId；声明 idempotent 必须真正处理超时后核对，不能只靠内存去重。
绑定工具只返回标准外部数据，关联与本地数据库写入由宿主完成，不新增通用动作绕过确认。
