/**
 * `list_schedule` 的响应 → 一念的 `ExternalItem[]`。
 *
 * ## 形状对不上的地方
 *
 * 飞书项目返回的是**扁平的排期节点列表**：同一个工作项有几个排期节点就出现几次。
 * 实测（huasheng 空间）：
 *
 * ```
 * [7072539263] KAZ-BCC银行接入 · 中台开发  8/14~8/20  5d  reached
 * [7072539263] KAZ-BCC银行接入 · 中台联调  8/17~8/24  2d
 * [7072539263] KAZ-BCC银行接入 · 中台提测  8/20~8/20  1d
 * [7048219224] 招商银行银证接口改造 · 中台开发  8/24~10/10  27d
 * ```
 *
 * 一念是「一个 Task 挂多个排期块」，所以这里**按 work_item_id 聚合**：
 * 一个工作项一条 `ExternalItem`，每个节点（或子任务）一个 `schedule` 段。
 *
 * 反过来做（每个节点各成一个 Task）会让任务列表被同一个需求的各阶段刷屏——
 * `nikou-screen` 是那么做的，但它是看板不是任务系统。
 *
 * ## externalRef 必须稳定
 *
 * 宿主靠 `externalRef` 认出「同一段被改了时间」而不是「删一段又加一段」，
 * 所以它只能由 `state_id`（+ 子任务 id）构成，**绝不能把时间拼进去**——
 * 那样每次改排期都会变成删旧块建新块，块上记的实际起止时间会跟着丢。
 */

import type {
  ExternalDetailField,
  ExternalItem,
  ExternalScheduleSlot,
  ExternalStatus,
  ScheduleSlotStatus,
} from "../sdk/index.mjs";

/** `list_schedule` 里的一个排期节点。字段名与飞书返回一致。 */
export interface ScheduleNode {
  work_item_info?: {
    id?: number | string;
    name?: string;
    work_item_status?: string;
  };
  state?: {
    state_id?: string;
    state_name?: string;
    /** 节点已通过。 */
    passed?: boolean;
    /** 流程已走到这个节点。 */
    reached?: boolean;
    different_schedule?: boolean;
  };
  subtasks?: Array<{
    id?: number | string;
    name?: string;
    is_finished?: boolean;
    time?: ScheduleTime;
  }> | null;
  time?: ScheduleTime;
}

interface ScheduleTime {
  /** `"2026-08-14 00:00:00"`，注意不是 RFC3339。 */
  start?: string;
  end?: string;
  /** 估分，单位天。 */
  duration?: number;
}

export interface ScheduleResponse {
  user_workload_list?: Array<{
    user_info?: { name?: string; userKey?: string; email?: string };
    tasks?: ScheduleNode[];
    total_score?: number;
    total_unscheduled_task?: number;
  }>;
}

/** 一天按几分钟折算估时。飞书的 duration 是「人天」，8 小时工作日。 */
const MINUTES_PER_DAY = 8 * 60;

/**
 * 把飞书的 `"2026-08-14 00:00:00"` 转成 RFC3339。
 *
 * 飞书给的是**空间时区的本地时间**且不带偏移。一念要 RFC3339，所以必须补上
 * 时区——按插件配置的 `utcOffset`（默认 +08:00）拼。
 * 直接当 UTC 会让整段排期偏 8 小时，跨天节点的首尾日期都会错。
 */
export function toRfc3339(value: string | undefined, utcOffset: string): string | null {
  if (!value) return null;
  const matched = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value.trim());
  if (!matched) return null;
  return `${matched[1]}T${matched[2]}${utcOffset}`;
}

/**
 * 由节点流转标记折出排期段状态。
 *
 * `passed` / `reached` 是飞书项目的权威流转标记：
 *   - `passed`             → 节点已通过 → `finished`
 *   - `reached && !passed`  → 已走到、正在做 → `active`
 *   - `!reached`            → 流程还没到 → `planned`
 *
 * 子任务自带 `is_finished` 时以它为准（子任务可以先于所属节点完成）。
 *
 * **不要退回「按 state_name 关键词猜完成」**。节点名是「中台开发 / 技术方案设计评审 /
 * 中台提测」这类，不含任何完成语义，猜不出来；而「确认上线」这种名字带「上线」的
 * 反而会被误判成已完成。`nikou-screen` 踩过这个坑并明确废弃了那套实现。
 */
export function slotStatus(
  state: ScheduleNode["state"],
  subtaskFinished: boolean | null = null,
): ScheduleSlotStatus {
  if (typeof subtaskFinished === "boolean") return subtaskFinished ? "finished" : "active";
  if (state?.passed) return "finished";
  if (state?.reached) return "active";
  return "planned";
}

/** 工作项在 Meegle 里的地址，点任务能跳回去。 */
export function workItemUrl(host: string, simpleName: string, workItemId: string): string {
  return `https://${host}/${simpleName}/story/detail/${workItemId}`;
}

export interface MapOptions {
  /** 空间 simple name，用来拼 URL。 */
  simpleName: string;
  host: string;
  /** 飞书时间串要补的时区偏移，如 `+08:00`。 */
  utcOffset: string;
}

/**
 * 聚合成 `ExternalItem[]`。
 *
 * 丢弃规则：**没有有效起止时间的节点直接跳过**。它们在飞书里就是「未排期」，
 * 硬塞一个块进去只会在日历上凭空多出一段。整个工作项一个有效节点都没有时，
 * 这个工作项也不产出——没有排期的工作项进一念只是噪音（用户明确要求不带未排期的）。
 */
export function mapSchedule(response: ScheduleResponse, options: MapOptions): ExternalItem[] {
  const byWorkItem = new Map<string, ExternalItem>();
  // 同一个工作项的几个节点可能排给不同人，收集起来做展示字段
  const ownersByWorkItem = new Map<string, Set<string>>();

  for (const workload of response.user_workload_list ?? []) {
    const owner = (workload.user_info?.name ?? "").trim();
    for (const node of workload.tasks ?? []) {
      const workItemId = String(node.work_item_info?.id ?? "").trim();
      if (!workItemId) continue;

      const slots = slotsOf(node, options.utcOffset);
      if (slots.length === 0) continue;

      if (owner) {
        const owners = ownersByWorkItem.get(workItemId) ?? new Set<string>();
        owners.add(owner);
        ownersByWorkItem.set(workItemId, owners);
      }

      let item = byWorkItem.get(workItemId);
      if (!item) {
        item = {
          externalId: workItemId,
          externalUrl: workItemUrl(options.host, options.simpleName, workItemId),
          title: (node.work_item_info?.name ?? "").trim() || "(未命名工作项)",
          // 状态由所有节点合起来推导，先占位，聚合完再算
          status: "todo",
          schedule: [],
          remoteData: { workItemId, nodes: [] as unknown[] },
        };
        byWorkItem.set(workItemId, item);
      }

      item.schedule!.push(...slots);
      (item.remoteData as { nodes: unknown[] }).nodes.push(node);
    }
  }

  for (const item of byWorkItem.values()) {
    const slots = item.schedule ?? [];
    item.status = rollupStatus(slots);
    // 最晚一段的结束时间当截止时间：日历上有个 Deadline 标记比没有好，
    // 而排期块负责在时间轴上占位
    const latest = slots.reduce<string | null>(
      (best, slot) => (best === null || slot.plannedEnd > best ? slot.plannedEnd : best),
      null,
    );
    if (latest) item.dueAt = latest;
    const estimate = estimateOf(item.remoteData as { nodes: ScheduleNode[] });
    if (estimate !== undefined) item.estimateMinutes = estimate;
    item.details = detailsOf(item, options, ownersByWorkItem.get(item.externalId));
  }

  return [...byWorkItem.values()];
}

/**
 * 「来源」区块要展示的字段。
 *
 * 一念主模型只收所有待办系统都有的字段，飞书项目独有的东西（空间、当前走到哪个节点、
 * 排期给了谁）只能走 `details`。值必须是**已经格式化好的文本**——宿主不认识飞书的
 * 数据结构，原样展示而已。
 *
 * 刻意不放 `work_item_status`：它是空间自定义状态流的 key（实测是 `zmkpy9tok` 这种
 * 随机串），展示出来对用户毫无意义，和 `rollupStatus` 不用它是同一个理由。
 */
function detailsOf(
  item: ExternalItem,
  options: MapOptions,
  owners: Set<string> | undefined,
): ExternalDetailField[] {
  const slots = item.schedule ?? [];
  const fields: ExternalDetailField[] = [{ label: "空间", value: options.simpleName }];

  const active = slots
    .filter((slot) => slot.status === "active")
    .map((slot) => (slot.title ?? "").trim())
    .filter((title) => title.length > 0);
  if (active.length > 0) {
    fields.push({ label: "当前节点", value: unique(active).join("、") });
  }

  if (owners && owners.size > 0) {
    fields.push({ label: "排期负责人", value: [...owners].join("、") });
  }

  fields.push({ label: "排期节点", value: `${slots.length} 段` });
  return fields;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** 一个节点摊成排期段：有子任务按子任务拆，否则整个节点算一段。 */
function slotsOf(node: ScheduleNode, utcOffset: string): ExternalScheduleSlot[] {
  const stateId = (node.state?.state_id ?? "").trim() || "state_unknown";
  const stateName = (node.state?.state_name ?? "").trim();
  const subtasks = Array.isArray(node.subtasks) ? node.subtasks : [];

  if (subtasks.length > 0) {
    const slots: ExternalScheduleSlot[] = [];
    for (const subtask of subtasks) {
      const start = toRfc3339(subtask.time?.start, utcOffset);
      const end = toRfc3339(subtask.time?.end, utcOffset);
      if (!start || !end) continue;
      const subtaskId = String(subtask.id ?? "").trim();
      if (!subtaskId) continue;
      const title = (subtask.name ?? "").trim() || stateName;
      slots.push({
        // 稳定标识：节点 + 子任务，不含任何时间
        externalRef: `${stateId}:${subtaskId}`,
        plannedStart: start,
        plannedEnd: end,
        status: slotStatus(
          node.state,
          typeof subtask.is_finished === "boolean" ? subtask.is_finished : null,
        ),
        // 显式判断而不是塞 undefined：tsconfig 开了 exactOptionalPropertyTypes
        ...(title ? { title } : {}),
      });
    }
    return slots;
  }

  const start = toRfc3339(node.time?.start, utcOffset);
  const end = toRfc3339(node.time?.end, utcOffset);
  if (!start || !end) return [];
  return [
    {
      externalRef: stateId,
      plannedStart: start,
      plannedEnd: end,
      status: slotStatus(node.state),
      ...(stateName ? { title: stateName } : {}),
    },
  ];
}

/**
 * 工作项整体状态。
 *
 * 全部段都完成 → `done`；有段在进行 → `doing`；否则 `todo`。
 *
 * 刻意**不用** `work_item_status`：它是空间自定义的状态流 key（实测是
 * `zmkpy9tok` 这种随机串），跨空间没有统一含义，映射不到一念的三态。
 * 节点流转标记是通用的。
 */
export function rollupStatus(slots: ExternalScheduleSlot[]): ExternalStatus {
  if (slots.length === 0) return "todo";
  if (slots.every((slot) => slot.status === "finished")) return "done";
  if (slots.some((slot) => slot.status === "active")) return "doing";
  return "todo";
}

/** 所有节点估分之和，折成分钟。 */
function estimateOf(remote: { nodes: ScheduleNode[] }): number | undefined {
  let days = 0;
  for (const node of remote.nodes) {
    const subtasks = Array.isArray(node.subtasks) ? node.subtasks : [];
    if (subtasks.length > 0) {
      for (const subtask of subtasks) days += Number(subtask.time?.duration ?? 0) || 0;
    } else {
      days += Number(node.time?.duration ?? 0) || 0;
    }
  }
  if (days <= 0) return undefined;
  return Math.round(days * MINUTES_PER_DAY);
}
