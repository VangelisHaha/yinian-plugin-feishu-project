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

## 缺陷（`issue`）那条链路（0.3.0 起）

缺陷和排期是**两条完全独立的链路**，代码在 `src/feishu/bugs.mts`，别往 `mapping.mts` 里塞。

- **缺陷是状态流工作项，没有节点、没有排期**，`list_schedule` 里根本不会出现，所以走 `search_by_mql` 查 `` `缺陷` `` 表。
- **单向，只拉不推**。`externalId` 带 `bug:` 前缀，`sync.push` 据此**硬拦**——不要改成「靠上层记得别调」。飞书那边流转缺陷要填根因、编码错误分类这些必填项并触发提单人确认流程，在一念点一下「完成」远远不够。
- **`ExternalItem` 不带 `schedule`**。契约里缺省 = 「这次不带排期信息」，宿主不动任何块；传 `[]` = 「外部明确没有排期了」，宿主会去清块，连用户自己给这条缺陷加的手工块一起误伤。**不要为了「看起来完整」补一个 `[]`。**
- **不带 `completedAt`**。飞书这边只有天精度的更新时间，按它造一个完成时刻是假数据。
- **不带 `estimateMinutes`**。空间里的「缺陷估分(人天)」是自定义字段（`field_e0597b` 这种空间私有 key），跨空间取不到。
- **查询条件是「未关闭状态（不限时间） OR 最近 N 天有更新」**，两截都不能删：前半截保证长期挂着没人动的老 bug 不会因为「更新时间太旧」被过滤掉（那批恰恰最该提醒）；后半截把刚关掉的缺陷捞回来映射成 `done`，让一念自己打勾——插件按约定不上报 `deletedExternalIds`，少了它一念里的缺陷任务会永远挂着。
- **首次拉取（`request.since` 为空）要丢掉 `status === "done"` 的缺陷**。回看那一截是给**之前同步过**的缺陷打勾用的，可插件不知道哪些同步过；首轮不过滤，回看窗口里所有关掉的缺陷都会凭空变成一批「已完成」任务。实测 huasheng 空间首轮 6 条全是 `CLOSED`——用户刚启用就会看到 6 条自己没做过的完成项。**不要因为「代码看起来多余」把这段删掉。**
- **空间自定义的东西一律做成设置项，不写死**：「指派修复者」的角色名（huasheng 叫「问题指派修复者」）、算「待我修」的状态 label。写死会让换空间的人拿到 `attribute not found`。
- **缺陷失败不吞**。角色名写错、状态勾错只能靠报错暴露；静默降级会变成「同步成功但缺陷一条没有」，比整轮失败难查得多。错误信息里要带「可以先关掉缺陷同步」的出路。

### 一条例外要记住

下面「不要用 `work_item_status` 映射一念的任务状态」**只针对需求（`story`）**。缺陷的状态是有语义的（实测 `OPEN` / `IN PROGRESS` / `RESOLVED` / `REOPENED` / `CLOSED` + 空间自定义若干），而且这里用的是**中文 label** 且**哪些算「待我修」由用户勾选**，没有硬编码任何空间私有 key。别把 `bugs.mts` 当成违规实现删掉。

## 不要做的事

- **不要按节点名猜完成状态**。节点名是「中台开发 / 技术方案设计评审 / 中台提测」这类，不含完成语义；而「确认上线」这种带「上线」的会被误判成已完成。权威来源是 `state.passed` / `reached`。`nikou-screen` 踩过这个坑并明确废弃了那套实现。
- **不要用 `work_item_status` 映射一念的任务状态**（**仅指需求 `story`**）。它是空间自定义的状态流 key（实测 `zmkpy9tok` 这种随机串），跨空间没有统一含义。缺陷不受这条约束，见上一节的例外说明。
- **不要回写排期**。飞书是排期的权威，见 README 的「边界」。
- **不要回写缺陷**。缺陷是单向的，见上一节。
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
