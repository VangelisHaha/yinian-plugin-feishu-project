/** 只开放有明确语义的工具，不把远端 MCP 方法任意透传给模型。 */
import {
  toolHandlers,
  textResult,
  type ToolDefinition,
} from "../sdk/index.mjs";
import {
  credentialsFrom,
  integrationSettingsFrom,
  fetchSchedule,
} from "./sync.mjs";
import { MeegleClient } from "../feishu/mcp.mjs";
import { mapSchedule } from "../feishu/mapping.mjs";
export const tools: ToolDefinition[] = [
  {
    name: "list_schedule",
    title: "查看飞书项目最新排期",
    description:
      "实时读取当前用户的飞书项目排期、工作项和节点细节。from/to 为日期范围（最多 90 天），keyword 可按标题或节点过滤。无日期使用实例默认窗口；不会导入或修改一念。",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", title: "开始日期" },
        to: { type: "string", title: "结束日期" },
        keyword: { type: "string", title: "关键词" },
        offset: { type: "integer", minimum: 0, title: "起始位置" },
        limit: { type: "integer", minimum: 1, maximum: 20, title: "返回条数" },
      },
      additionalProperties: false,
    },
    execute: async (r) => {
      const settings = integrationSettingsFrom(r.config),
        credentials = credentialsFrom(r.config);
      if (!settings.projectKey) throw new Error("请先配置飞书项目空间");
      const range = parseRange(r.arguments);
      const response = await fetchSchedule(
        new MeegleClient(credentials),
        settings,
        new Date(),
        range,
      );
      const keyword = String(r.arguments.keyword ?? "").toLowerCase();
      const all = mapSchedule(response, {
        simpleName: settings.projectKey,
        host: credentials.host ?? "project.feishu.cn",
        utcOffset: settings.utcOffset,
      }).filter((item) => JSON.stringify(item).toLowerCase().includes(keyword));
      const offset = Number(r.arguments.offset ?? 0),
        limit = Number(r.arguments.limit ?? 10);
      // raw remoteData 不回喂：保留标准化字段、节点与来源，避免不必要的数据暴露和体积膨胀。
      const rows = all
        .slice(offset, offset + limit)
        .map(({ remoteData, ...item }) => item);
      const text = rows
        .map(
          (item) =>
            `${item.title} · ${item.status ?? ""}\n${item.externalUrl ?? ""}\n${(item.schedule ?? []).map((slot) => JSON.stringify(slot)).join("\n")}`,
        )
        .join("\n\n");
      return textResult(text || "所选范围没有匹配排期", {
        rows,
        total: all.length,
        nextOffset:
          offset + rows.length < all.length ? offset + rows.length : null,
        queriedAt: new Date().toISOString(),
      });
    },
  },
];
export const handlers = toolHandlers(tools);

/** 日期需逐字回查，Date.parse 会把 2 月 31 日悄悄滚到 3 月。 */
export function parseRange(
  args: Record<string, unknown>,
): { from: string; to: string } | undefined {
  if (args.from === undefined && args.to === undefined) return undefined;
  const from = String(args.from ?? ""),
    to = String(args.to ?? "");
  const valid = (s: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s;
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (!valid(from) || !valid(to) || days < 0 || days > 90)
    throw new Error("请提供合法起止日期，范围不超过 90 天");
  return { from, to };
}
