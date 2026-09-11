/**
 * 缺陷（`issue`）→ 一念的 `ExternalItem[]`。**单向，只拉不推。**
 *
 * ## 为什么缺陷不能复用排期那条链路
 *
 * 排期走 `list_schedule`，返回的是**节点流**工作项（需求）的排期节点。缺陷在飞书项目里
 * 是**状态流**工作项：它没有节点、没有排期、`list_schedule` 里根本不会出现。所以这里
 * 走 `search_by_mql` 单独查一遍，产出的 `ExternalItem` **不带 `schedule`**。
 *
 * 「不带」是有意的：契约里 `schedule` 缺省表示「这次不带排期信息」，宿主不动任何块；
 * 传 `[]` 会被理解成「外部明确没有排期了」，宿主会去清块。缺陷本来就没有块，传 `[]`
 * 只是白跑一趟清理逻辑，还会误伤用户自己在一念里给这条缺陷加的手工块。
 *
 * ## 缺陷的 `work_item_status` 是可以用的
 *
 * 仓库 AGENTS.md 里有一条「不要用 `work_item_status` 映射一念的任务状态」——**那条只
 * 针对需求（`story`）**：需求的状态流 key 是空间自定义的随机串（实测 `zmkpy9tok`），
 * 跨空间没有统一含义。缺陷不一样，实测 huasheng 空间返回的是
 * `OPEN` / `IN PROGRESS` / `RESOLVED` / `REOPENED` / `CLOSED` 这类有语义的 key，加上
 * 空间自定义的若干个。这里用的是**状态的中文 label**并且**哪些算「待我修」由用户在
 * 设置里勾选**，不硬编码任何空间私有的 key —— 换空间只需重新勾一遍。
 *
 * ## 已修完的怎么收尾
 *
 * 只拉未关闭的缺陷会留下一个坑：飞书那边关掉后，缺陷掉出结果集，而插件按约定
 * **不上报 `deletedExternalIds`**，于是一念里这条任务永远挂着。所以查询条件是
 *
 *   （未关闭状态，不限时间） OR （最近 N 天有更新）
 *
 * 后半截把刚关掉的缺陷也捞回来，映射成 `done`，让一念自己打勾。一条 MQL 就够，
 * 不需要为「已关闭」再跑第二次，也不必枚举空间里所有的关闭态（自定义状态随时会加）。
 */

import type {
  ExternalDetailField,
  ExternalItem,
  ExternalPriority,
  ExternalStatus,
} from "../sdk/index.mjs";

/** 归属口径：这条缺陷凭什么算「我的」。 */
export type BugScope = "assignee" | "operator" | "creator";

export interface BugSettings {
  enabled: boolean;
  /**
   * 「指派修复者」在当前空间叫什么。
   *
   * MQL 里角色写作 `` `__角色名` ``，而角色名是**空间自定义**的（huasheng 空间叫
   * 「问题指派修复者」）。写死会让换空间的人拿到 `attribute not found`，所以做成设置项。
   */
  assigneeRole: string;
  scopes: BugScope[];
  /** 算「待我修」的状态中文 label。不在这个集合里的一律视为已收口。 */
  openStatuses: string[];
  /** 紧急度按「优先级」还是「严重程度」折算。 */
  priorityBasis: "priority" | "severity";
  /** 折算结果的下限，缺陷普遍比普通任务急，默认抬到 high。 */
  priorityFloor: ExternalPriority;
  /** 往回看多少天的已关闭缺陷，用来给一念侧打勾。 */
  closeLookbackDays: number;
  /** >0 时用「创建时间 + N 天」造一个 dueAt，让缺陷在日历上有 Deadline 标记。 */
  dueDays: number;
  /** 给同步来的缺陷打的标签，留空则不打。 */
  tag: string;
  limit: number;
}

/** MQL 返回的一行。字段名与飞书返回一致。 */
export interface MoqlRow {
  moql_field_list?: Array<{
    key?: string;
    name?: string;
    value_type?: string;
    value?: {
      long_value?: number;
      double_value?: number;
      string_value?: string;
      key_label_value?: { key?: string; label?: string };
      key_label_value_list?: Array<{ key?: string; label?: string }>;
    };
  }>;
}

export interface BugMqlResponse {
  list?: Array<{ count?: number }> | null;
  /** 按分组装的行，分组名无意义，拍平即可。 */
  data?: Record<string, MoqlRow[]> | null;
}

/** 一行扁平化之后的形状。 */
export interface BugRow {
  workItemId: string;
  name: string;
  statusLabel: string;
  priorityLabel: string;
  severityLabel: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 飞书优先级 → 一念四档。
 *
 * 一念没有「紧急」这一档（只有 none/low/medium/high），所以「紧急」和「高」都落到
 * `high`，真正的紧急度差别靠 `priorityFloor` 与用户自己在一念里的排序解决。
 */
const PRIORITY_MAP: Record<string, ExternalPriority> = {
  紧急: "high",
  高: "high",
  中: "medium",
  低: "low",
};

/** 飞书严重程度 → 一念四档。 */
const SEVERITY_MAP: Record<string, ExternalPriority> = {
  致命: "high",
  严重: "high",
  一般: "medium",
  轻微: "low",
  建议: "low",
};

/** 只有这一个状态算「正在修」，其余待修状态都是还没开工。 */
const DOING_STATUSES = new Set(["处理中"]);

const PRIORITY_ORDER: ExternalPriority[] = ["none", "low", "medium", "high"];

/** 取两个优先级里更高的那个。用来实现「下限」。 */
export function maxPriority(
  a: ExternalPriority,
  b: ExternalPriority,
): ExternalPriority {
  return PRIORITY_ORDER.indexOf(a) >= PRIORITY_ORDER.indexOf(b) ? a : b;
}

/**
 * 把 `moql_field_list` 拍成扁平对象。
 *
 * `value_type` 决定值藏在哪个字段里；枚举类取 `label`（人能读的中文）而不是 `key`
 * ——`key` 是空间私有的，展示出来毫无意义。
 */
export function flattenRow(row: MoqlRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of row.moql_field_list ?? []) {
    const key = field.key;
    const value = field.value;
    if (!key || !value) continue;
    if (value.long_value != null) out[key] = String(value.long_value);
    else if (value.double_value != null) out[key] = String(value.double_value);
    else if (value.string_value != null) out[key] = value.string_value;
    else if (value.key_label_value) {
      out[key] = value.key_label_value.label ?? value.key_label_value.key ?? "";
    } else if (value.key_label_value_list) {
      out[key] = value.key_label_value_list
        .map((entry) => entry.label ?? entry.key ?? "")
        .filter(Boolean)
        .join("、");
    }
  }
  return out;
}

/** 拍平整个响应。飞书按分组返回，分组名没有业务含义。 */
export function bugRowsOf(response: BugMqlResponse): BugRow[] {
  const rows = Object.values(response.data ?? {}).flat();
  const out: BugRow[] = [];
  for (const raw of rows) {
    const flat = flattenRow(raw);
    const workItemId = (flat.work_item_id ?? "").trim();
    if (!workItemId) continue;
    out.push({
      workItemId,
      name: (flat.name ?? "").trim(),
      statusLabel: (flat.work_item_status ?? "").trim(),
      priorityLabel: (flat.priority ?? "").trim(),
      severityLabel: (flat.severity ?? "").trim(),
      createdAt: (flat.start_time ?? "").trim(),
      updatedAt: (flat.updated_at ?? "").trim(),
    });
  }
  return out;
}

/** MQL 字符串字面量里的单引号要转义，否则状态名带引号就把语句劈开了。 */
function quote(value: string): string {
  return `'${value.replace(/'/g, "\\'")}'`;
}

/** 一个归属口径对应的 WHERE 片段。 */
function scopeClause(scope: BugScope, assigneeRole: string): string | null {
  switch (scope) {
    case "assignee":
      // 角色在 MQL 里写作 `__角色名`
      return `array_contains(\`__${assigneeRole}\`, current_login_user())`;
    case "operator":
      return "array_contains(`当前负责人`, current_login_user())";
    case "creator":
      // 创建者是 user 单值，用等号；不要用 array_contains
      return "`创建者` = current_login_user()";
    default:
      return null;
  }
}

export interface BugQueryOptions {
  projectKey: string;
  settings: BugSettings;
  /** 已关闭缺陷的回看起点，`YYYY-MM-DD`。 */
  since: string;
}

/**
 * 拼查询语句。
 *
 * 状态条件与回看条件是 **OR**：未关闭的不限时间全带（否则长期挂着没人动的老 bug 会
 * 因为「更新时间太旧」被过滤掉，正是最该提醒的那批），最近有更新的额外带一批用来收口。
 */
export function buildBugMql(options: BugQueryOptions): string {
  const { projectKey, settings, since } = options;
  const scopes = settings.scopes
    .map((scope) => scopeClause(scope, settings.assigneeRole))
    .filter((clause): clause is string => clause !== null);
  if (scopes.length === 0) {
    throw new Error("缺陷同步至少要勾一个归属口径（指派修复者 / 当前负责人 / 我创建的）");
  }
  if (settings.openStatuses.length === 0) {
    throw new Error("缺陷同步至少要勾一个「待我修」状态");
  }

  const statuses = settings.openStatuses.map(quote).join(", ");
  return (
    "SELECT `work_item_id`, `name`, `priority`, `severity`, `work_item_status`, " +
    "`start_time`, `updated_at` " +
    `FROM \`${projectKey}\`.\`缺陷\` ` +
    `WHERE (${scopes.join(" OR ")}) ` +
    `AND (\`work_item_status\` IN (${statuses}) OR \`updated_at\` >= ${quote(since)}) ` +
    `LIMIT ${settings.limit}`
  );
}

/** 缺陷详情地址。路径段是 `issue`，不是需求那边的 `story`。 */
export function bugUrl(
  host: string,
  simpleName: string,
  workItemId: string,
): string {
  return `https://${host}/${simpleName}/issue/detail/${workItemId}`;
}

/**
 * `externalId` 前缀。
 *
 * 缺陷和需求的 `work_item_id` 都是数字，混在同一个 Integration 里靠前缀区分：
 * `sync.push` 据此硬拦（缺陷单向，绝不回写飞书），日志里也能一眼看出是哪类。
 */
export const BUG_ID_PREFIX = "bug:";

export function isBugExternalId(externalId: string): boolean {
  return externalId.startsWith(BUG_ID_PREFIX);
}

export interface MapBugOptions {
  simpleName: string;
  host: string;
  utcOffset: string;
  settings: BugSettings;
}

/** 折算一条缺陷的紧急度：先按口径映射，再套下限。 */
export function bugPriority(row: BugRow, settings: BugSettings): ExternalPriority {
  const table = settings.priorityBasis === "severity" ? SEVERITY_MAP : PRIORITY_MAP;
  const label = settings.priorityBasis === "severity" ? row.severityLabel : row.priorityLabel;
  const mapped = table[label] ?? "medium";
  return maxPriority(mapped, settings.priorityFloor);
}

/** 由状态 label 折出一念三态。不在「待我修」集合里的一律 `done`。 */
export function bugStatus(row: BugRow, settings: BugSettings): ExternalStatus {
  if (!settings.openStatuses.includes(row.statusLabel)) return "done";
  return DOING_STATUSES.has(row.statusLabel) ? "doing" : "todo";
}

/** `YYYY-MM-DD` → 当天 00:00 的 RFC3339，按空间时区。 */
function dayStart(day: string, utcOffset: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return `${day}T00:00:00${utcOffset}`;
}

/** `YYYY-MM-DD` 加 n 天后的当天 23:59:59，按空间时区。Deadline 落在当天结束。 */
function dayEndAfter(day: string, days: number, utcOffset: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parts = day.split("-").map(Number);
  // UTC 构造再取 UTC 字段，避免本机时区把日期滚掉一天
  const base = Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!);
  const shifted = new Date(base + days * 86_400_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}T23:59:59${utcOffset}`;
}

/**
 * 映射成 `ExternalItem[]`。
 *
 * 有意不设置的三个字段：
 *
 * - **`schedule`**：缺陷没有排期。不传（而非传 `[]`）才不会让宿主去清块。
 * - **`completedAt`**：飞书这边只有天精度的更新时间，按它造一个「完成时刻」是假数据；
 *   契约明确要求不知道就别传，宿主自己会记录收到 `done` 的时间。
 * - **`estimateMinutes`**：空间里的「缺陷估分(人天)」是自定义字段（`field_e0597b`
 *   这种空间私有 key），跨空间取不到，不做。
 */
export function mapBugs(rows: BugRow[], options: MapBugOptions): ExternalItem[] {
  const { settings } = options;
  const items: ExternalItem[] = [];
  for (const row of rows) {
    const item: ExternalItem = {
      externalId: `${BUG_ID_PREFIX}${row.workItemId}`,
      externalUrl: bugUrl(options.host, options.simpleName, row.workItemId),
      title: row.name || `缺陷 #${row.workItemId}`,
      status: bugStatus(row, settings),
      priority: bugPriority(row, settings),
      details: bugDetails(row, options),
      remoteData: { kind: "bug", workItemId: row.workItemId, row },
    };

    const remoteUpdatedAt = dayStart(row.updatedAt, options.utcOffset);
    if (remoteUpdatedAt) item.remoteUpdatedAt = remoteUpdatedAt;

    if (settings.dueDays > 0) {
      const due = dayEndAfter(row.createdAt, settings.dueDays, options.utcOffset);
      if (due) item.dueAt = due;
    }

    if (settings.tag) item.tags = [settings.tag];

    items.push(item);
  }
  return items;
}

/** 任务详情「来源」区要展示的缺陷字段，值都已经是人能读的文本。 */
function bugDetails(row: BugRow, options: MapBugOptions): ExternalDetailField[] {
  const fields: ExternalDetailField[] = [
    { label: "类型", value: "缺陷" },
    { label: "空间", value: options.simpleName },
  ];
  if (row.statusLabel) fields.push({ label: "缺陷状态", value: row.statusLabel });
  if (row.priorityLabel) fields.push({ label: "优先级", value: row.priorityLabel });
  if (row.severityLabel) fields.push({ label: "严重程度", value: row.severityLabel });
  if (row.createdAt) fields.push({ label: "创建时间", value: row.createdAt });
  return fields;
}
