/**
 * 扩展点的业务类型。
 *
 * 与一念仓库 `docs/11-plugin-architecture.md` §5（同步）、§7（设置面板）、
 * §8（出站事件）逐字段对应。字段名就是线格式，**不要在这里改驼峰/下划线**——
 * 宿主按线格式反序列化，改了名就是契约违规（`PLUGIN_CONTRACT_VIOLATION`）。
 */

import type { ConfigScope } from "./protocol.mjs";

// ── 同步 ─────────────────────────────────────────────────────────────────

export type SyncResource = "task" | "event";

export type SyncActionKind =
  | "list"
  | "get"
  | "create"
  | "update"
  | "complete"
  | "reopen"
  | "cancel"
  | "delete";

export type SyncField =
  | "title"
  | "notes"
  | "due_at"
  | "priority"
  | "schedule"
  | "subtasks"
  | "tags"
  | "recurrence";

export type ExternalStatus = "todo" | "doing" | "done" | "canceled";

export type ExternalPriority = "none" | "low" | "medium" | "high";

/**
 * 外部系统的一条记录。
 *
 * 两个容易踩的点：
 *
 * - `completedAt` **不知道就不要传**。传当前时间会让历史任务全部堆在同一秒，
 *   一念的「今日完成」会瞬间多出几百条（`nikou-screen` 踩过）。
 * - `remoteUpdatedAt` 尽量给。宿主的字段级冲突判定靠它，缺了就只能保守处理。
 */
export interface ExternalItem {
  /** 外部系统主键，同一 Integration 内必须唯一且稳定。 */
  externalId: string;
  externalUrl?: string;
  title: string;
  notes?: string;
  status?: ExternalStatus;
  priority?: ExternalPriority;
  /** RFC3339。Deadline 语义：最晚什么时候完成。 */
  dueAt?: string;
  dueTimezone?: string;
  estimateMinutes?: number;
  /** 真实完成时间。不知道就别传。 */
  completedAt?: string;
  recurrenceRule?: string;
  parentExternalId?: string;
  tags?: string[];
  /**
   * 外部系统已经排好的排期段。
   *
   * `dueAt` 回答「最晚什么时候完成」，这个回答「打算什么时候做」——一念把两件事
   * 分开建模，日历上前者是 Deadline 细标记，后者才在时间轴上占一段。**只给 dueAt
   * 的任务在日历上永远只有一个标记。**
   *
   * 只有 manifest 的 `capabilities.fields` 里声明了 `schedule` 才生效。
   *
   * **缺省与空数组语义不同**：不传表示「这次不带排期信息」，宿主不动任何块；
   * 传 `[]` 表示「外部明确没有排期了」，宿主会清掉它建过的块。
   */
  schedule?: ExternalScheduleSlot[];
  /** 外部最后更新时间，RFC3339。 */
  remoteUpdatedAt?: string;
  /** 外部原始 JSON 全量。宿主会原样存下来，界面可以不展示。 */
  remoteData?: unknown;
  /**
   * 想让用户在任务详情「来源」区看到的额外字段。
   *
   * 一念主模型只有所有待办系统都有的字段；飞书项目独有的东西（空间、工作项状态、
   * 当前节点）走这里，宿主原样展示。
   *
   * **缺省与空数组语义不同**：不传表示「这次不带」，宿主保持上次的值；传 `[]` 表示清空。
   */
  details?: ExternalDetailField[];
}

/**
 * 一条展示字段。
 *
 * 宿主硬限制（超出直接丢弃）：最多 20 条，`label` ≤ 32 字符，`value` ≤ 512 字符。
 * `kind: "link"` 的 value 必须是 http(s)，否则宿主降级成纯文本。
 */
export interface ExternalDetailField {
  label: string;
  /** 已经格式化好的值：时间戳、枚举 id 请自己转成人能读的文本。 */
  value: string;
  kind?: "text" | "link";
}

/** 排期段状态，取值与一念的排期块一致。 */
export type ScheduleSlotStatus =
  | "planned"
  | "active"
  | "finished"
  | "unfinished"
  | "canceled";

/** 外部系统里的一段排期，落成一念 Task 的一个排期块。 */
export interface ExternalScheduleSlot {
  /**
   * 这一段在外部系统里的**稳定**标识，同一条 `ExternalItem` 内唯一。
   *
   * 宿主全靠它区分「同一段被改了时间」和「删一段又加一段」。给不稳定的值
   * （比如带上了开始时间）会让每轮同步都删旧块建新块，块上记的实际起止时间
   * 跟着丢，还会刷一堆出站事件。
   */
  externalRef: string;
  /** RFC3339。 */
  plannedStart: string;
  /** RFC3339，必须晚于 `plannedStart`。 */
  plannedEnd: string;
  status?: ScheduleSlotStatus;
  /** 段名（如「中台开发」）。一念的排期块不存名字，这里只进日志与诊断。 */
  title?: string;
}

export interface PullRequest {
  integrationId: string;
  traceId: string;
  resource: SyncResource;
  cursor?: string;
  /** RFC3339，增量下界。 */
  since?: string;
  /** 忽略游标做全量拉取。 */
  full: boolean;
  /**
   * 这个 Integration 的完整配置（插件级 + 实例级，宿主已合并，secret 已解密）。
   *
   * **用它，不要用 `context().config`**：一个插件进程服务该插件下的所有实例，
   * `plugin.init` 里那份配置代表不了具体某个实例。
   */
  config?: Record<string, unknown>;
}

export interface PullResult {
  items: ExternalItem[];
  cursor?: string;
  hasMore: boolean;
  /**
   * 外部已删除的 id。
   *
   * 宿主**不会**删本地任务，只把关联标成 `remote_deleted` 等人处理——
   * 外部删除不该静默带走本地数据。
   */
  deletedExternalIds?: string[];
}

export interface PushRequest {
  integrationId: string;
  traceId: string;
  resource: SyncResource;
  action: SyncActionKind;
  /** `create` 时为空。 */
  externalId?: string;
  item: ExternalItem;
  /** 本次变更涉及的字段，供你做最小化更新。状态类动作为空数组。 */
  changedFields?: SyncField[];
  /** 这个 Integration 的完整配置，语义同 `PullRequest.config`。 */
  config?: Record<string, unknown>;
}

export interface PushResult {
  /**
   * `false` 表示你有意跳过（外部已经是目标状态）。
   *
   * 宿主视为成功且不重试，也不会开 ack 窗口——毕竟外部没被改动。
   */
  applied: boolean;
  externalId?: string;
  externalUrl?: string;
  remoteUpdatedAt?: string;
  remoteData?: unknown;
}

// ── 生命周期钩子 ─────────────────────────────────────────────────────────

export type HookTopic =
  | "task.created"
  | "task.updated"
  | "task.completed"
  | "task.reopened"
  | "task.canceled"
  | "task.deleted"
  | "event.created"
  | "event.updated"
  | "event.canceled"
  | "event.deleted"
  | "schedule_block.created"
  | "schedule_block.updated"
  | "schedule_block.deleted";

export type EntityKind = "task" | "event" | "schedule_block";

export interface EntityRef {
  type: EntityKind;
  id: string;
}

export interface HookEvent {
  /**
   * 发件箱记录 id。
   *
   * **必须按它做幂等**：投递保证是「至少一次」，重试与宿主重启都会让同一条事件
   * 再来一遍。把处理过的 id 存进 `host.setState`，别只放内存——进程随时会被重启。
   */
  outboxId: string;
  traceId: string;
  topic: HookTopic;
  /** 业务实际发生时间，不是派发时间。 */
  occurredAt: string;
  entity: EntityRef;
  payload: {
    /** 变更后的实体全量快照（线格式）。 */
    snapshot?: Record<string, unknown>;
    changedFields?: string[];
  };
}

export interface HookResult {
  ok: boolean;
  detail?: string;
}

// ── 通知渠道 ─────────────────────────────────────────────────────────────

export type NotificationKind =
  | "task_due"
  | "task_completed"
  | "schedule_start"
  | "event_start"
  | "sync_failed"
  | "custom";

export interface NotificationAction {
  id: string;
  label: string;
}

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  entity?: EntityRef;
  /** 只有 manifest 里声明了 `supportsActions` 的渠道才会收到。 */
  actions?: NotificationAction[];
}

export interface NotifyRequest {
  traceId: string;
  notification: Notification;
}

export interface NotifyResult {
  delivered: boolean;
  detail?: string;
}

// ── 设置面板 ─────────────────────────────────────────────────────────────

export type SettingsFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "duration"
  | "enum"
  | "multi-enum"
  | "action"
  | "group"
  | "note";

export interface SettingsFieldOption {
  value: unknown;
  label: string;
}

export interface SettingsField {
  /** `^[a-zA-Z][a-zA-Z0-9_]*$` */
  key: string;
  type: SettingsFieldType;
  label: string;
  help?: string;
  required?: boolean;
  default?: unknown;
  /** 只支持一层判断。隐藏的字段不参与必填校验，也不提交。 */
  visibleWhen?: { field: string; equals: unknown };
  /** `secret` 落加密存储且永不回显。 */
  format?: "text" | "url" | "path" | "secret";
  placeholder?: string;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: "seconds" | "minutes";
  options?: SettingsFieldOption[];
  /** `host:tags` / `host:calendars` / `rpc:<自定义方法>` */
  optionsFrom?: string;
  maxItems?: number;
  /** `action` 必填：点按钮时调的自定义方法。 */
  rpc?: string;
  confirm?: string;
  /** `group` 必填。 */
  fields?: SettingsField[];
  /** `note` 必填。 */
  text?: string;
}

export interface SettingsSchema {
  scope: ConfigScope;
  fields: SettingsField[];
}

export interface ConfigValidateRequest {
  scope: ConfigScope;
  config: Record<string, unknown>;
}

export interface FieldError {
  /** 对应 schema 里的 `key`。省略则降级成整体错误提示。 */
  field?: string;
  message: string;
}

export interface ConfigValidateResult {
  ok: boolean;
  errors?: FieldError[];
}

/**
 * `action` 按钮的返回值，三个字段都可选。
 *
 * `openUrl` 只接受 http/https，宿主用系统浏览器打开——这是 OAuth 类插件把授权
 * 链接递到用户面前的唯一方式，插件自己画不了界面。
 */
export interface ActionResult {
  message?: string;
  openUrl?: string;
  /** 按 key 合并回表单。 */
  patch?: Record<string, unknown>;
}

/** `optionsFrom: "rpc:*"` 的返回值。 */
export interface OptionsResult {
  options: SettingsFieldOption[];
}
