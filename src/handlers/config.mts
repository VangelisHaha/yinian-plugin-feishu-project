/**
 * 配置校验与设置面板上的 action。
 *
 * 形状校验（必填、范围、枚举）宿主已经按 schema 做过了，这里只做它做不了的事：
 * 这个 Token 到底能不能调通、这个空间存不存在。
 *
 * ## 为什么把「开关没开」单独拎出来
 *
 * `MCPPersonalPreferenceDisabled` 长得像鉴权失败，实际上 Token 是好的，只是
 * 飞书项目的个人偏好里 MCP 开关没打开。不给出配置页地址，用户会一直去换 Token。
 * 实测这个开关会被误关（一次误操作就让整条链路静默失效），所以它必须是一条
 * 能看懂、能照着做的错误。
 */

import { context, logger } from "../sdk/index.mjs";
import type {
  ActionResult,
  ConfigValidateRequest,
  ConfigValidateResult,
  FieldError,
} from "../sdk/index.mjs";
import { MCP_CONFIG_URL, MeegleClient, MeegleError } from "../feishu/mcp.mjs";
import { credentialsFrom, integrationSettingsFrom, fetchSchedule } from "./sync.mjs";
import { mapSchedule } from "../feishu/mapping.mjs";

/**
 * `search_user_info` 的返回。
 *
 * 注意它回的是**裸数组**（不是 `{ data: [...] }`），而且名字在 `name_cn` / `name_en`
 * 上，没有 `name` 字段——照 OpenAPI 的习惯去取 `data[].name` 会永远拿到空。
 */
type UserInfoResponse = Array<{
  user_key?: string;
  name_cn?: string;
  name_en?: string;
  email?: string;
}>;

export async function validate(
  request: ConfigValidateRequest,
): Promise<ConfigValidateResult> {
  const errors: FieldError[] = [];

  if (request.scope === "plugin") {
    const credentials = credentialsFrom(request.config);
    if (!credentials.token) {
      return { ok: false, errors: [{ field: "token", message: "请填 MCP Token" }] };
    }
    try {
      await whoami(new MeegleClient(credentials));
      return { ok: true };
    } catch (error) {
      return { ok: false, errors: [fieldErrorOf(error, "token")] };
    }
  }

  // 实例级：空间存不存在、时区偏移写没写对
  const settings = integrationSettingsFrom(request.config);
  if (!settings.projectKey) {
    errors.push({ field: "projectKey", message: "请填空间的 simple name" });
  }
  if (!/^[+-]\d{2}:\d{2}$/.test(settings.utcOffset)) {
    errors.push({
      field: "utcOffset",
      message: "时区偏移要写成 +08:00 这种形式",
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  // 插件级凭据在实例配置里拿不到，所以这里只能校验形状；
  // 空间是否可读留给「预览本窗口排期」与首次同步暴露
  return { ok: true };
}

/** 「测试连接」：把 Token 对应的身份显示出来，比一句「连接正常」有用。 */
export async function testConnection(params: {
  config?: Record<string, unknown>;
}): Promise<ActionResult> {
  const credentials = credentialsFrom(params.config ?? context().config);
  if (!credentials.token) return { message: "请先填 MCP Token" };

  try {
    const who = await whoami(new MeegleClient(credentials));
    return {
      message: who
        ? `连接正常，当前身份：${who}`
        : "连接正常（没取到身份信息，但调用是通的）",
    };
  } catch (error) {
    return actionErrorOf(error);
  }
}

/**
 * 「预览本窗口排期」：启用前先看看会同步进来什么。
 *
 * 实例级 action 拿不到插件级的 Token（两级配置分开存），所以走 `context().config`
 * ——它是宿主合并后的完整配置。
 */
export async function previewSchedule(params: {
  config?: Record<string, unknown>;
}): Promise<ActionResult> {
  const merged = { ...context().config, ...(params.config ?? {}) };
  const credentials = credentialsFrom(merged);
  const settings = integrationSettingsFrom(merged);
  if (!credentials.token) return { message: "请先在插件设置里填 MCP Token" };
  if (!settings.projectKey) return { message: "请先填空间" };

  try {
    const client = new MeegleClient(credentials);
    const response = await fetchSchedule(client, settings);
    const items = mapSchedule(response, {
      simpleName: settings.projectKey,
      host: credentials.host ?? "project.feishu.cn",
      utcOffset: settings.utcOffset,
    });
    const slots = items.reduce((sum, item) => sum + (item.schedule?.length ?? 0), 0);
    if (items.length === 0) {
      return { message: "这个窗口里没有排期。确认空间填对了，并且窗口覆盖到你有排期的日期" };
    }
    const preview = items
      .slice(0, 5)
      .map((item) => `· ${item.title}（${item.schedule?.length ?? 0} 段）`)
      .join("\n");
    return {
      message: `${items.length} 个工作项、${slots} 段排期：\n${preview}${
        items.length > 5 ? `\n… 还有 ${items.length - 5} 个` : ""
      }`,
    };
  } catch (error) {
    return actionErrorOf(error);
  }
}

/** 取当前登录身份。拿不到名字不算失败——调用通了就说明凭据是好的。 */
async function whoami(client: MeegleClient): Promise<string | null> {
  const raw = await client.callTool<UserInfoResponse>("search_user_info", {
    user_keys: ["current_login_user()"],
  });
  const first = Array.isArray(raw) ? raw[0] : undefined;
  if (!first) return null;
  const name = first.name_cn || first.name_en;
  return [name, first.email].filter(Boolean).join(" · ") || null;
}

/** 把异常翻成字段级错误，个人偏好这类要指到能改的那一格。 */
function fieldErrorOf(error: unknown, fallbackField: string): FieldError {
  if (error instanceof MeegleError) {
    return {
      // 开关没开不是 Token 的问题，指到说明那一格，别让用户反复换 Token
      field: error.kind === "preference" ? "howto" : fallbackField,
      message: error.message,
    };
  }
  return {
    field: fallbackField,
    message: error instanceof Error ? error.message : String(error),
  };
}

function actionErrorOf(error: unknown): ActionResult {
  if (error instanceof MeegleError && error.kind === "preference") {
    logger.warn("飞书项目的 MCP 开关没开", { code: "FEISHU_PROJECT_MCP_DISABLED" });
    // 顺手把配置页递到用户面前：插件画不了界面，openUrl 是唯一的路
    return { message: error.message, openUrl: MCP_CONFIG_URL };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}
