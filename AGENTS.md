# AGENTS.md — yinian-plugin-feishu-project

[安时](https://github.com/VangelisHaha/nikou-agenda)飞书项目（Meegle）排期同步插件。

- 中文回复，中文注释与文档。改完必须 `npm run verify` 全绿。**零运行时依赖**（Node 标准库 + `fetch`）。
- 契约以安时主仓库《插件架构》文档为准；`src/sdk/` 是模板副本，**不要在这里改**。
- **鉴权头是 `X-Mcp-Token`**，不是 `Authorization: Bearer`（后者所有 `tools/call` 都回 `MCPPersonalPreferenceDisabled`）。
- **必须走完 MCP 握手**：`initialize` → `notifications/initialized` → 之后每个请求带 `mcp-session-id`。
- **`externalRef` 必须稳定**，只由 `state_id`（+ 子任务 id）构成，**绝不拼时间**，否则每次改排期都变成删旧块建新块。
- 缺陷（`issue`）与排期是两条独立链路，代码在 `src/feishu/bugs.mts`：缺陷**单向只拉不推**、不带 `schedule` / `completedAt` / `estimateMinutes`、已收口一律 `updateOnly`、`deletedExternalIds` 只报按 id 核实过的；排期链路一条删除都不报。
- 不按节点名猜完成状态（用 `state.passed` / `reached`）；不用 `work_item_status` 映射需求状态；不回写排期与缺陷；不在多节点工作项上回写完成状态。
- 飞书排期时间是空间时区的本地时间且不带偏移，必须按实例 `utcOffset` 补上再转 RFC3339。
- 发布：`version` 同步 → `npm run pack:zip` → Git tag 与 manifest `version` 完全一致 → 索引仓库加/留一条。
