/**
 * `sync.pull` / `sync.push`。
 *
 * ## 拉取
 *
 * 一次 `list_schedule` 就能拿到当前用户在窗口内的全部排期节点，所以**不分页**：
 * 飞书那边没有游标，窗口本身就是边界。宿主看到 `hasMore: false` 就收工。
 *
 * ## 回写
 *
 * 只回写**完成状态**，不回写排期。排期以飞书为权威（`docs/11` §5.1）：用户在飞书
 * 调排期，一念这边跟着变；反过来推会让两边各改一半，merge 出来的结果和两边都不一致。
 *
 * 完成状态的回写有个限制：飞书项目的「完成」是**节点/子任务级**的流转，不是工作项
 * 级的开关。一个工作项挂四个节点时，「这个任务完成了」对应哪个节点并不确定。所以
 * 这里只在**工作项恰好只有一个排期节点**时回写，多节点的一律跳过并说明原因——
 * 猜错节点会在飞书上推错流程，比不回写严重得多。
 */

import { context, logger } from "../sdk/index.mjs";
import type {
  ExternalItem,
  PullRequest,
  PullResult,
  PushRequest,
  PushResult,
} from "../sdk/index.mjs";
import { MeegleClient, type MeegleClientOptions } from "../feishu/mcp.mjs";
import {
  mapSchedule,
  type ScheduleNode,
  type ScheduleResponse,
} from "../feishu/mapping.mjs";
import {
  bugRowsOf,
  buildBugMql,
  isBugExternalId,
  mapBugs,
  type BugMqlResponse,
  type BugRow,
  type BugScope,
  type BugSettings,
} from "../feishu/bugs.mjs";
import type { ExternalPriority } from "../sdk/index.mjs";

export interface IntegrationSettings {
  projectKey: string;
  windowDays: number;
  workItemTypes: string[];
  utcOffset: string;
  bugs: BugSettings;
}

/** 默认算「待我修」的缺陷状态。是 huasheng 空间实测过的一组，其它空间在设置里改。 */
const DEFAULT_OPEN_STATUSES = [
  "新建",
  "处理中",
  "重新打开",
  "延期修复",
  "产品验收失败重新打开",
  "提单人确认",
];

const DEFAULT_ASSIGNEE_ROLE = "问题指派修复者";
const BUG_SCOPES: BugScope[] = ["assignee", "operator", "creator"];
const PRIORITIES: ExternalPriority[] = ["none", "low", "medium", "high"];

/** 从合并后的配置里取插件级凭据。 */
export function credentialsFrom(
  config: Record<string, unknown>,
): MeegleClientOptions {
  return {
    token: String(config.token ?? "").trim(),
    host:
      String(config.host ?? "project.feishu.cn").trim() || "project.feishu.cn",
  };
}

/** 从合并后的配置里取实例级设置，缺省值与 settings.integration.json 保持一致。 */
export function integrationSettingsFrom(
  config: Record<string, unknown>,
): IntegrationSettings {
  const types = Array.isArray(config.workItemTypes)
    ? config.workItemTypes.map((value) => String(value)).filter(Boolean)
    : [];
  return {
    projectKey: String(config.projectKey ?? "").trim(),
    windowDays: clampWindow(Number(config.windowDays ?? 21)),
    workItemTypes: types.length > 0 ? types : ["_all"],
    utcOffset: String(config.utcOffset ?? "+08:00").trim() || "+08:00",
    bugs: bugSettingsFrom(config),
  };
}

/**
 * 缺陷同步设置。缺省值与 `settings.integration.json` 保持一致。
 *
 * 老实例的配置里没有这些 key，读到 `undefined` 时要落到「跟新装一样」的默认，
 * 而不是当成「用户关掉了」——否则升级后缺陷同步会静默不生效。
 */
export function bugSettingsFrom(config: Record<string, unknown>): BugSettings {
  const floor = PRIORITIES.includes(config.bugPriorityFloor as ExternalPriority)
    ? (config.bugPriorityFloor as ExternalPriority)
    : "high";
  return {
    // 缺省 true：这一版的目的就是把缺陷带进来
    enabled: config.syncBugs === undefined ? true : Boolean(config.syncBugs),
    assigneeRole:
      String(config.bugAssigneeRole ?? "").trim() || DEFAULT_ASSIGNEE_ROLE,
    // **只有 undefined 才落默认**：用户把勾全清了要如实反映成空数组，让 validate
    // 报出来。悄悄替他补一个默认口径，等于同步进来一批他没要的东西。
    scopes:
      config.bugScopes === undefined
        ? ["assignee"]
        : enumList(config.bugScopes, BUG_SCOPES),
    openStatuses:
      config.bugOpenStatuses === undefined
        ? [...DEFAULT_OPEN_STATUSES]
        : stringList(config.bugOpenStatuses),
    priorityBasis: config.bugPriorityBasis === "severity" ? "severity" : "priority",
    priorityFloor: floor,
    closeLookbackDays: clampInt(config.bugCloseLookbackDays, 14, 1, 90),
    dueDays: clampInt(config.bugDueDays, 0, 0, 90),
    // 显式空串表示不打标签，所以只有 undefined 才落默认
    tag: config.bugTag === undefined ? "缺陷" : String(config.bugTag).trim(),
    limit: clampInt(config.bugLimit, 200, 10, 500),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function enumList<T extends string>(value: unknown, allowed: T[]): T[] {
  return stringList(value).filter((entry): entry is T =>
    (allowed as string[]).includes(entry),
  );
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function clampWindow(days: number): number {
  if (!Number.isFinite(days)) return 21;
  return Math.min(90, Math.max(7, Math.round(days)));
}

/**
 * 窗口：**上周一**起算 `windowDays` 天。
 *
 * 从上周一而不是今天起算，是为了让上周没同步过的排期也能补进来；`nikou-screen`
 * 用的也是这个窗口，实践上够用。
 */
export function scheduleWindow(
  now: Date,
  windowDays: number,
): { from: string; to: string } {
  const weekday = now.getDay() === 0 ? 7 : now.getDay();
  const monday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (weekday - 1),
  );
  const start = new Date(monday);
  start.setDate(monday.getDate() - 7);
  const end = new Date(start);
  end.setDate(start.getDate() + windowDays - 1);
  return { from: isoDay(start), to: isoDay(end) };
}

function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 拉一次窗口内的排期。给 pull 与「预览」共用。 */
export function fetchSchedule(
  client: MeegleClient,
  settings: IntegrationSettings,
  now: Date = new Date(),
  range?: { from: string; to: string },
): Promise<ScheduleResponse> {
  const { from, to } = range ?? scheduleWindow(now, settings.windowDays);
  return client.callTool<ScheduleResponse>("list_schedule", {
    project_key: settings.projectKey,
    user_keys: ["current_login_user()"],
    start_time: from,
    end_time: to,
    work_item_type_keys: settings.workItemTypes,
  });
}

/**
 * 拉一次缺陷。给 pull 与「预览待修缺陷」共用。
 *
 * 关掉时返回空数组而不是抛错，调用方不用到处判开关。
 */
export async function fetchBugs(
  client: MeegleClient,
  settings: IntegrationSettings,
  now: Date = new Date(),
): Promise<BugRow[]> {
  if (!settings.bugs.enabled) return [];
  const mql = buildBugMql({
    projectKey: settings.projectKey,
    settings: settings.bugs,
    since: isoDay(
      new Date(now.getTime() - settings.bugs.closeLookbackDays * 86_400_000),
    ),
  });
  const response = await client.callTool<BugMqlResponse>("search_by_mql", {
    project_key: settings.projectKey,
    mql,
  });
  return bugRowsOf(response);
}

export async function pull(request: PullRequest): Promise<PullResult> {
  // 配置从**请求**里取，不是 context()：一个插件进程服务该插件下的所有实例，
  // init 时的那份配置代表不了具体某个实例（契约 §5.1）
  const config = { ...context().config, ...(request.config ?? {}) };
  const credentials = credentialsFrom(config);
  const settings = integrationSettingsFrom(config);
  if (!settings.projectKey) {
    throw new Error(
      "这个同步实例还没配空间。在设置 → 插件 → 飞书项目 → 对应实例下填「空间」并保存",
    );
  }
  const client = new MeegleClient(credentials);
  const host = credentials.host ?? "project.feishu.cn";

  const response = await fetchSchedule(client, settings);
  const items = mapSchedule(response, {
    simpleName: settings.projectKey,
    host,
    utcOffset: settings.utcOffset,
  });

  const slots = items.reduce(
    (sum, item) => sum + (item.schedule?.length ?? 0),
    0,
  );
  const unscheduled =
    response.user_workload_list?.[0]?.total_unscheduled_task ?? 0;

  // 缺陷失败**不吞**：角色名写错、状态勾错这类只能靠报错暴露，静默降级会变成
  // 「同步成功但缺陷一条没有」，比整轮失败更难查。错误信息带上关掉的办法。
  let bugItems: ExternalItem[] = [];
  if (settings.bugs.enabled) {
    let rows: BugRow[];
    try {
      rows = await fetchBugs(client, settings);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `缺陷同步失败：${reason}。检查实例设置里的「指派修复者角色名」与「待我修状态」是否和这个空间一致；也可以先关掉「同步缺陷」让排期照常同步`,
      );
    }
    bugItems = mapBugs(rows, {
      simpleName: settings.projectKey,
      host,
      utcOffset: settings.utcOffset,
      settings: settings.bugs,
    });

    // 首次拉取（还没有增量下界）**丢掉已收口的缺陷**。
    //
    // 「已关闭回看」那一截是为了给**之前同步过**的缺陷打勾，可插件不知道哪些同步过。
    // 首轮不过滤的话，回看窗口里所有关掉的缺陷都会凭空变成一批「已完成」任务——
    // 实测某个空间首轮就有 6 条全是 CLOSED，用户刚启用就看到 6 条自己没做过的完成项。
    // 第二轮起 `since` 有值，该带的打勾数据照常带。
    if (!request.since) {
      const before = bugItems.length;
      bugItems = bugItems.filter((item) => item.status !== "done");
      const dropped = before - bugItems.length;
      if (dropped > 0) {
        logger.info(`首次拉取，跳过 ${dropped} 条已收口的缺陷`, {
          code: "FEISHU_PROJECT_BUG_FIRST_PULL_SKIP",
          traceId: request.traceId,
        });
      }
    }
  }

  logger.info(
    `拉取完成：${items.length} 个工作项、${slots} 段排期，未排期 ${unscheduled}；缺陷 ${bugItems.length} 条`,
    {
      code: "FEISHU_PROJECT_PULL_DONE",
      traceId: request.traceId,
    },
  );

  return {
    items: [...items, ...bugItems],
    // 飞书这个接口没有游标，窗口就是边界，一轮拉完
    hasMore: false,
    // **不传 deletedExternalIds**：工作项掉出窗口不等于被删除，报上去会让宿主把
    // 关联标成 remote_deleted，用户以为飞书那边删了东西。
    deletedExternalIds: [],
  };
}

export async function push(request: PushRequest): Promise<PushResult> {
  const config = { ...context().config, ...(request.config ?? {}) };
  const settings = integrationSettingsFrom(config);
  const client = new MeegleClient(credentialsFrom(config));

  if (request.action !== "complete" && request.action !== "reopen") {
    // 宿主只会发 capabilities.actions 里声明过的动作，走到这里说明声明与实现不一致
    return { applied: false };
  }

  // 缺陷是**单向**同步：飞书那边的流转要填根因、编码错误分类这些必填项，还会触发
  // 提单人确认流程，在一念点一下「完成」远远不够。这里硬拦，不靠上层记得别调。
  if (isBugExternalId(String(request.externalId))) {
    logger.info(
      `缺陷 ${request.externalId} 单向同步，跳过回写：请到飞书项目里流转`,
      { code: "FEISHU_PROJECT_PUSH_BUG_SKIPPED", traceId: request.traceId },
    );
    return { applied: false };
  }

  const target = soleNode(request.item);
  if (!target) {
    logger.warn(
      `工作项 ${request.externalId} 有多段排期，跳过完成状态回写：无法确定该推进哪个节点`,
      { code: "FEISHU_PROJECT_PUSH_AMBIGUOUS", traceId: request.traceId },
    );
    // applied:false = 插件有意跳过，宿主视为成功且不重试（否则会一直重试到进 error）
    return { applied: false };
  }

  const finished = request.action === "complete";
  if (target.subtaskId) {
    await client.callTool("update_node_subtask", {
      project_key: settings.projectKey,
      work_item_id: String(request.externalId),
      // 这里要的是 node_key（`state_67`），不是 node uuid
      node_id: target.stateId,
      task_id: target.subtaskId,
      action: finished ? "confirm" : "rollback",
    });
  } else {
    await client.callTool("transition_node", {
      project_key: settings.projectKey,
      work_item_id: String(request.externalId),
      node_id: target.stateId,
      action: finished ? "confirm" : "rollback",
      ...(finished ? {} : { rollback_reason: "在一念里重新打开" }),
    });
  }

  logger.info(`已${finished ? "完成" : "回滚"}节点 ${target.stateId}`, {
    code: "FEISHU_PROJECT_PUSH_DONE",
    traceId: request.traceId,
  });
  return {
    applied: true,
    ...(request.externalId ? { externalId: request.externalId } : {}),
  };
}

/**
 * 只有一段排期时返回它的定位信息，否则返回 null。
 *
 * 多段时无法判断「任务完成」指哪个节点——瞎猜会在飞书上推错流程。
 */
export function soleNode(
  item: ExternalItem | undefined,
): { stateId: string; subtaskId?: string } | null {
  const slots = item?.schedule ?? [];
  const only = slots.length === 1 ? slots[0] : undefined;
  if (!only) return null;
  const [stateId, subtaskId] = only.externalRef.split(":");
  if (!stateId) return null;
  return subtaskId ? { stateId, subtaskId } : { stateId };
}

export type { ScheduleNode };
export type { BugRow, BugScope, BugSettings };
