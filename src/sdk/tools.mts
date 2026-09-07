/** 通用 AI 工具注册器。契约见一念插件文档 §15；纯工具插件也可使用。 */
import type { Handler } from "./runtime.mjs";
import type {
  ExternalItem,
  ExternalEvent,
  ExternalCalendar,
} from "./types.mjs";
export interface ToolSchema {
  type:
    "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, ToolSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ToolSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
  title?: string;
}
export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: ToolSchema;
  outputSchema?: ToolSchema;
  effect: "read" | "write";
  binding?: "task" | "event";
  idempotent?: boolean;
}
export interface ToolContext {
  integrationId?: string | null;
  config: Record<string, unknown>;
}
export interface ToolCall extends ToolContext {
  name: string;
  arguments: Record<string, unknown>;
  operationId?: string | null;
}
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  binding?:
    | { resource: "task"; item: ExternalItem }
    | { resource: "event"; event: ExternalEvent; calendar: ExternalCalendar };
}
export interface ToolDefinition extends ToolSpec {
  execute: (request: ToolCall) => ToolResult | Promise<ToolResult>;
}
const keys = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "description",
  "title",
]);
export function validateToolSchema(schema: ToolSchema, depth = 0): void {
  if (!schema || typeof schema !== "object" || depth > 8)
    throw new Error("Schema 对象或嵌套深度不合法");
  for (const key of Object.keys(schema))
    if (!keys.has(key)) throw new Error(`不支持的 Schema 关键字：${key}`);
  if (
    ![
      "object",
      "array",
      "string",
      "number",
      "integer",
      "boolean",
      "null",
    ].includes(schema.type) ||
    (depth === 0 && schema.type !== "object")
  )
    throw new Error("Schema 根必须是 object");
  if (
    schema.properties !== undefined &&
    (!schema.properties ||
      typeof schema.properties !== "object" ||
      Array.isArray(schema.properties))
  )
    throw new Error("properties 必须是对象");
  for (const child of Object.values(schema.properties ?? {}))
    validateToolSchema(child, depth + 1);
  if (schema.type === "array" && !schema.items)
    throw new Error("array 必须声明 items");
  if (schema.items) validateToolSchema(schema.items, depth + 1);
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.some(
        (k) =>
          typeof k !== "string" || !Object.hasOwn(schema.properties ?? {}, k),
      ))
  )
    throw new Error("required 引用了未定义字段");
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  )
    throw new Error("additionalProperties 必须是布尔值");
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || !schema.enum.length)
  )
    throw new Error("enum 必须是非空数组");
  for (const k of ["minimum", "maximum"] as const)
    if (schema[k] !== undefined && !Number.isFinite(schema[k]))
      throw new Error("数值界限必须是数字");
  for (const k of ["minLength", "maxLength", "minItems", "maxItems"] as const)
    if (
      schema[k] !== undefined &&
      (!Number.isInteger(schema[k]) || schema[k]! < 0)
    )
      throw new Error("长度界限必须是非负整数");
}
export function validateToolValue(
  schema: ToolSchema,
  value: unknown,
  path = "arguments",
): void {
  const fail = () => {
    throw new Error(`${path} 不符合工具参数要求`);
  };
  if (
    schema.enum &&
    !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))
  )
    fail();
  const bounds = (n: number, min?: number, max?: number) => {
    if ((min !== undefined && n < min) || (max !== undefined && n > max))
      fail();
  };
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return fail();
      const fields = value as Record<string, unknown>;
      for (const key of schema.required ?? [])
        if (!Object.hasOwn(fields, key)) fail();
      for (const [key, val] of Object.entries(fields)) {
        const child = schema.properties?.[key];
        if (child) validateToolValue(child, val, `${path}.${key}`);
        else if (schema.additionalProperties === false) fail();
      }
      break;
    }
    case "array":
      if (!Array.isArray(value)) return fail();
      bounds(value.length, schema.minItems, schema.maxItems);
      for (const v of value) validateToolValue(schema.items!, v, path);
      break;
    case "string":
      if (typeof value !== "string") return fail();
      bounds([...value].length, schema.minLength, schema.maxLength);
      break;
    case "number":
    case "integer":
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (schema.type === "integer" && !Number.isInteger(value))
      )
        return fail();
      bounds(value, schema.minimum, schema.maximum);
      break;
    case "boolean":
      if (typeof value !== "boolean") fail();
      break;
    case "null":
      if (value !== null) fail();
      break;
  }
}
export function textResult(
  text: string,
  data?: Record<string, unknown>,
): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(data ? { structuredContent: data } : {}),
  };
}
/** 定义是唯一来源：发现和调用共用此目录，避免声明与 handler 漂移。 */
export function toolHandlers(
  definitions: ToolDefinition[],
): Record<string, Handler> {
  if (definitions.length > 32) throw new Error("每个插件最多 32 个工具");
  const index = new Map<string, ToolDefinition>();
  for (const tool of definitions) {
    if (
      !/^[A-Za-z0-9_]{1,64}$/.test(tool.name) ||
      !tool.title.trim() ||
      !tool.description.trim() ||
      index.has(tool.name)
    )
      throw new Error("工具名称、标题、说明或重复定义不合法");
    if (
      !["read", "write"].includes(tool.effect) ||
      (tool.effect === "read" && tool.binding)
    )
      throw new Error("工具读写声明不合法");
    validateToolSchema(tool.inputSchema);
    if (tool.outputSchema) validateToolSchema(tool.outputSchema);
    index.set(tool.name, tool);
  }
  return {
    "tools.list": () => ({
      tools: definitions.map(({ execute, ...spec }) => spec),
    }),
    "tools.call": async (request: ToolCall) => {
      const tool = index.get(request.name);
      if (!tool) throw new Error("工具不存在");
      validateToolValue(tool.inputSchema, request.arguments);
      if (tool.effect === "write" && !request.operationId)
        throw new Error("写入缺少宿主 operationId");
      const result = await tool.execute(request);
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > 65536)
        throw new Error("工具结果超过 64 KiB");
      if (!result.isError) {
        if (tool.outputSchema)
          validateToolValue(
            tool.outputSchema,
            result.structuredContent,
            "result",
          );
        if (tool.binding !== result.binding?.resource)
          throw new Error("工具关联结果与声明不符");
      }
      return result;
    },
  };
}
/** 本地绑定字段示例：远端目标须放在 item 之外，宿主负责本地 calendarId。 */
export const taskItemSchema: ToolSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 500 },
    notes: { type: "string" },
    dueAt: { type: "string" },
    estimateMinutes: { type: "integer", minimum: 1 },
    priority: { type: "string", enum: ["none", "low", "medium", "high"] },
  },
  required: ["title"],
  additionalProperties: false,
};
export const eventItemSchema: ToolSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 500 },
    notes: { type: "string" },
    allDay: { type: "boolean" },
    startAt: { type: "string" },
    endAt: { type: "string" },
    startDate: { type: "string" },
    endDate: { type: "string" },
    location: { type: "string" },
  },
  required: ["title", "allDay"],
  additionalProperties: false,
};

/** 成功回执落盘，跨进程重启复用。execute 自己必须用服务端幂等键或查重处理结果不明。 */
export async function withToolReceipt(
  dataDir: string,
  request: ToolCall,
  execute: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const { mkdir, readFile, writeFile, rename } =
    await import("node:fs/promises");
  const { join } = await import("node:path");
  if (
    !request.operationId ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId)
  )
    throw new Error("operationId 不合法");
  const dir = join(dataDir, "tool-operations");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${request.operationId}.json`);
  const fingerprint = JSON.stringify({
    name: request.name,
    integrationId: request.integrationId,
    arguments: request.arguments,
  });
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (saved.fingerprint !== fingerprint)
      throw new Error("同一 operationId 不能更换参数");
    return saved.result as ToolResult;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const result = await execute();
  if (result.isError) return result;
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ fingerprint, result }), {
    mode: 0o600,
  });
  await rename(temp, file);
  return result;
}
