/**
 * 飞书项目（Meegle）官方 MCP 客户端 —— streamable HTTP，不是 stdio。
 *
 * 这条路是从官方两个客户端反推出来的（都指向同一个端点）：
 *   - `larksuite/meegle-cli`（Go）：`https://{host}/mcp_server/v1`
 *   - `@lark-project/mcp`（Node）：同一路径，`StreamableHTTPClientTransport`
 *
 * 为什么不用它们、自己写一份：
 *
 * - `@lark-project/mcp` 是 stdio 包装器，用它就得 `spawn npx`。插件申请 `spawn`
 *   权限等于要用户批准「可执行任意代码」，而我们要的只是几个 HTTP 请求。
 * - `meegle-cli` 是 Go 二进制，插件跑在 node 子进程里，没法带。
 * - 端点本身就是普通的 JSON-RPC over HTTP，自己写只有一百来行，
 *   而且 manifest 里只要声明 `net`。
 *
 * ## 三个必须照做的细节
 *
 * 1. **鉴权头是 `X-Mcp-Token`，不是 `Authorization: Bearer`**。用 Bearer 会被当成
 *    OAuth 会话，所有 `tools/call` 都回 `MCPPersonalPreferenceDisabled`。
 * 2. **必须走完 MCP 握手**：`initialize` 拿 `mcp-session-id`，再发
 *    `notifications/initialized`，之后每个请求都带上这个 session id。
 * 3. **`Accept` 必须同时含 `application/json` 与 `text/event-stream`**。服务端会
 *    按情况回普通 JSON 或 SSE，两种都得能解。
 */

import { logger } from "../sdk/index.mjs";

/** MCP 服务路径，与官方客户端一致。 */
const MCP_PATH = "/mcp_server/v1";

/** 握手时报给服务端的客户端标识。 */
const CLIENT_NAME = "yinian-plugin-feishu-project";
const CLIENT_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";

/** 单次请求超时。`sync.pull` 的宿主超时是 120s，留足余量。 */
const REQUEST_TIMEOUT_MS = 30_000;

/** MCP 个人偏好没开时服务端回的错误码。 */
export const PREFERENCE_DISABLED = "MCPPersonalPreferenceDisabled";

/** 配置页地址——这个错误必须把它带给用户，否则没人猜得到要去哪开。 */
export const MCP_CONFIG_URL = "https://project.feishu.cn/b/mcp";

export class MeegleError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "preference" | "network" | "tool" | "protocol",
    /** 服务端 logid，报障时飞书要它。 */
    readonly logId?: string,
  ) {
    super(message);
    this.name = "MeegleError";
  }

  /** 值得重试吗？配置类问题重试一万次也不会好。 */
  get retriable(): boolean {
    return this.kind === "network";
  }
}

export interface MeegleClientOptions {
  /** `m-` 开头的 MCP token，从 https://project.feishu.cn/b/mcp 获取。 */
  token: string;
  /** 默认 `project.feishu.cn`；Meegle 国际版是 `meegle.com`。 */
  host?: string;
}

interface JsonRpcResponse {
  id?: number;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

export class MeegleClient {
  private readonly token: string;
  private readonly host: string;
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(options: MeegleClientOptions) {
    this.token = options.token.trim();
    this.host = (options.host || "project.feishu.cn").replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  private get url(): string {
    return `https://${this.host}${MCP_PATH}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // 服务端会按情况回 JSON 或 SSE，两个都要接受
      Accept: "application/json, text/event-stream",
      "X-Mcp-Token": this.token,
      "X-Meego-MCP-Connection-Type": "stdio",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  /**
   * 建立会话。
   *
   * 会话是 `tools/call` 的前提：没有它服务端认不出是谁，所有调用都会被
   * 个人偏好网关挡掉。会话失效时 `call` 会自动重建一次。
   */
  async connect(): Promise<void> {
    if (!this.token) {
      throw new MeegleError("没有填 MCP Token", "auth");
    }
    this.sessionId = null;
    const { response, body } = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
    });

    const sessionId = response.headers.get("mcp-session-id");
    if (!sessionId) {
      throw new MeegleError(
        `握手没拿到会话（HTTP ${response.status}）：${body.slice(0, 200)}`,
        "protocol",
      );
    }
    this.sessionId = sessionId;

    // 通知类请求没有响应体，失败也不影响后续调用，所以不检查结果
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
  }

  /**
   * 调一个 MCP 工具。
   *
   * 会话过期（服务端换实例、超时回收）时自动重连一次再试——把这个藏在客户端里，
   * 调用方不必到处写重连逻辑。
   */
  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.sessionId) await this.connect();
    try {
      return await this.callOnce<T>(name, args);
    } catch (error) {
      if (error instanceof MeegleError && error.kind === "protocol") {
        logger.debug(`MCP 会话可能已失效，重连后重试 ${name}`);
        await this.connect();
        return this.callOnce<T>(name, args);
      }
      throw error;
    }
  }

  private async callOnce<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { body } = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });

    const frame = parseFrame(body);
    if (frame.error) {
      throw new MeegleError(`MCP ${name} 失败：${frame.error.message}`, "protocol");
    }

    const contents = frame.result?.content ?? [];
    const logId = contents
      .map((part) => part.text ?? "")
      .find((text) => text.startsWith("logid:"))
      ?.slice("logid:".length)
      .trim();

    if (frame.result?.isError) {
      const detail = contents.find((part) => !(part.text ?? "").startsWith("logid:"))?.text ?? "";
      throw toolError(name, detail, logId);
    }

    // 工具结果是 content 里第一段能解成 JSON 的文本；另一段通常是 logid
    for (const part of contents) {
      const text = part.text ?? "";
      if (!text.startsWith("{") && !text.startsWith("[")) continue;
      try {
        return JSON.parse(text) as T;
      } catch {
        // 不是 JSON 就继续看下一段
      }
    }
    throw new MeegleError(`MCP ${name} 没有返回可解析的结果`, "protocol", logId);
  }

  private async post(payload: unknown): Promise<{ response: Response; body: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 本机代理挂了也走这条路，所以提示要把「网络」和「凭据」区分开
      throw new MeegleError(
        `连不上飞书项目（${this.url}）：${reason}。如果本机开了代理，先确认它能访问 ${this.host}`,
        "network",
      );
    } finally {
      clearTimeout(timer);
    }

    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new MeegleError(
        `MCP Token 被拒绝（HTTP ${response.status}）。去 ${MCP_CONFIG_URL} 重新获取`,
        "auth",
      );
    }
    if (!response.ok) {
      throw new MeegleError(
        `飞书项目返回 HTTP ${response.status}：${body.slice(0, 200)}`,
        response.status >= 500 ? "network" : "protocol",
      );
    }
    return { response, body };
  }
}

/**
 * 把工具层的错误串翻成人话。
 *
 * 服务端的格式是 `error=CODE,message=...,retriable=false`。个人偏好这个错最常见
 * 也最容易让人卡住——它长得像鉴权失败，其实 token 是好的，只是开关没开，
 * 所以必须把配置页地址直接给出来。
 */
function toolError(name: string, detail: string, logId?: string): MeegleError {
  const code = /error=([A-Za-z0-9_]+)/.exec(detail)?.[1] ?? "";
  const message = /message=([^,]*)/.exec(detail)?.[1]?.trim() ?? detail;

  if (code === PREFERENCE_DISABLED) {
    return new MeegleError(
      `飞书项目的 MCP 功能没有开启。去 ${MCP_CONFIG_URL} 打开「个人偏好」里的 MCP 开关，然后重新同步`,
      "preference",
      logId,
    );
  }
  return new MeegleError(`MCP ${name} 失败：${message || detail}`, "tool", logId);
}

/**
 * 解析一帧响应。
 *
 * 服务端可能回普通 JSON，也可能回 SSE（`data: {...}`）。SSE 时取**最后**一个
 * 数据行：前面可能是进度通知，真正的结果在最后。
 */
export function parseFrame(body: string): JsonRpcResponse {
  let last: JsonRpcResponse | null = null;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "").replace(/^data:\s*/, "").trim();
    if (!line.startsWith("{")) continue;
    try {
      last = JSON.parse(line) as JsonRpcResponse;
    } catch {
      // 不完整的行忽略
    }
  }
  if (!last) {
    throw new MeegleError(`飞书项目返回了无法解析的响应：${body.slice(0, 200)}`, "protocol");
  }
  return last;
}
