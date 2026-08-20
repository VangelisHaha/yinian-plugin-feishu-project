/**
 * MCP 客户端与同步编排的测试。
 *
 * 用替换 `globalThis.fetch` 的方式驱动，不发真实请求。重点覆盖那些「真机上很难
 * 复现、出错又很隐蔽」的分支：握手与会话、SSE 与 JSON 两种响应、个人偏好被关。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { MCP_CONFIG_URL, MeegleClient, MeegleError, parseFrame } from "../dist/feishu/mcp.mjs";
import { scheduleWindow, soleNode } from "../dist/handlers/sync.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** 按调用顺序返回预设响应，并记录每次请求，便于断言头与载荷。 */
function mockFetch(responses) {
  const calls = [];
  let index = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      headers: new Headers(next.headers ?? {}),
      text: async () => next.body ?? "",
    };
  };
  return calls;
}

const HANDSHAKE = {
  headers: { "mcp-session-id": "yinian.session-1" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: "2025-03-26", serverInfo: { name: "Meego MCP Server" } },
  }),
};

function toolOk(payload) {
  return {
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [
          { type: "text", text: JSON.stringify(payload) },
          { type: "text", text: "logid: abc123" },
        ],
      },
    }),
  };
}

describe("握手与鉴权", () => {
  // 用 Authorization: Bearer 会被当成 OAuth 会话，所有 tools/call 都被个人偏好网关挡掉。
  // 官方客户端用的是 X-Mcp-Token，这条测试把它钉住
  it("鉴权头是 X-Mcp-Token 且不带 Authorization", async () => {
    const calls = mockFetch([HANDSHAKE, { body: "" }, toolOk({ ok: true })]);
    const client = new MeegleClient({ token: "m-test" });
    await client.callTool("search_project_info", { project_key: "huasheng" });

    const headers = calls[0].init.headers;
    assert.equal(headers["X-Mcp-Token"], "m-test");
    assert.ok(!("Authorization" in headers), "带上 Authorization 会被服务端拒绝");
    assert.match(headers.Accept, /application\/json/);
    assert.match(headers["Accept"], /text\/event-stream/);
  });

  it("先 initialize 再 initialized，之后每个请求都带会话 id", async () => {
    const calls = mockFetch([HANDSHAKE, { body: "" }, toolOk({ ok: true })]);
    const client = new MeegleClient({ token: "m-test" });
    await client.callTool("search_project_info", {});

    assert.equal(calls[0].body.method, "initialize");
    assert.equal(calls[1].body.method, "notifications/initialized");
    assert.equal(calls[2].body.method, "tools/call");
    // 握手那一发还没有会话，之后每发都要带
    assert.equal(calls[0].init.headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].init.headers["Mcp-Session-Id"], "yinian.session-1");
    assert.equal(calls[2].init.headers["Mcp-Session-Id"], "yinian.session-1");
  });

  it("握手拿不到会话时明确报协议错误", async () => {
    mockFetch([{ body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) }]);
    const client = new MeegleClient({ token: "m-test" });
    await assert.rejects(() => client.callTool("x.y", {}), (error) => {
      assert.ok(error instanceof MeegleError);
      assert.equal(error.kind, "protocol");
      return true;
    });
  });

  it("没有 token 直接判成配置问题，不发请求", async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error("不该被调用");
    };
    const client = new MeegleClient({ token: "  " });
    await assert.rejects(() => client.callTool("x.y", {}), (error) => {
      assert.equal(error.kind, "auth");
      assert.equal(error.retriable, false);
      return true;
    });
    assert.equal(called, false);
  });

  it("401 归类为凭据问题并指向配置页", async () => {
    mockFetch([{ status: 401, body: "unauthorized" }]);
    const client = new MeegleClient({ token: "m-bad" });
    await assert.rejects(() => client.callTool("x.y", {}), (error) => {
      assert.equal(error.kind, "auth");
      assert.match(error.message, /b\/mcp/);
      return true;
    });
  });

  it("默认打中国版域名，国际版可切", () => {
    const calls = mockFetch([HANDSHAKE, { body: "" }, toolOk({})]);
    return new MeegleClient({ token: "m-test", host: "meegle.com" })
      .callTool("x.y", {})
      .then(() => {
        assert.match(calls[0].url, /^https:\/\/meegle\.com\/mcp_server\/v1$/);
      });
  });
});

describe("响应解析", () => {
  it("普通 JSON 与 SSE 都能解", () => {
    const plain = parseFrame('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
    assert.equal(plain.result.ok, true);

    const sse = parseFrame(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\r\n\n',
    );
    assert.equal(sse.result.ok, true);
  });

  // SSE 里前面可能是进度通知，真正的结果在最后一行
  it("SSE 多行时取最后一帧", () => {
    const frame = parseFrame(
      'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n' +
        'data: {"jsonrpc":"2.0","id":2,"result":{"final":true}}\n',
    );
    assert.equal(frame.result.final, true);
  });

  it("完全解不出来时报协议错误", () => {
    assert.throws(() => parseFrame("<html>502 Bad Gateway</html>"), MeegleError);
  });
});

describe("工具层错误", () => {
  // search_user_info 回的是裸数组、名字在 name_cn/name_en 上。照 OpenAPI 的习惯
  // 去取 data[].name 会永远拿到空，界面上就永远是「没取到身份信息」
  it("工具结果是裸数组时也能解出来", async () => {
    mockFetch([
      HANDSHAKE,
      { body: "" },
      toolOk([{ user_key: "726", name_cn: "王杰", email: "a@b.com" }]),
    ]);
    const client = new MeegleClient({ token: "m-test" });
    const result = await client.callTool("search_user_info", {});
    assert.ok(Array.isArray(result));
    assert.equal(result[0].name_cn, "王杰");
  });

  // 这个错长得像鉴权失败，其实 token 是好的，只是开关没开。
  // 不给出配置页地址，用户会一直去换 token（真实发生过）
  it("个人偏好没开时给出可照做的提示", async () => {
    mockFetch([
      HANDSHAKE,
      { body: "" },
      {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: "error=MCPPersonalPreferenceDisabled,message=user has not enabled this MCP feature. Please configure it in your personal preferences,retriable=false",
              },
              { type: "text", text: "logid: xyz789" },
            ],
          },
        }),
      },
    ]);
    const client = new MeegleClient({ token: "m-test" });
    await assert.rejects(() => client.callTool("list_schedule", {}), (error) => {
      assert.equal(error.kind, "preference");
      assert.match(error.message, new RegExp(MCP_CONFIG_URL.replace(/[/.]/g, "\\$&")));
      assert.equal(error.logId, "xyz789");
      assert.equal(error.retriable, false, "开关没开重试一万次也不会好");
      return true;
    });
  });

  it("网络故障可重试，配置问题不可重试", async () => {
    globalThis.fetch = async () => {
      throw new Error("socket hang up");
    };
    const client = new MeegleClient({ token: "m-test" });
    await assert.rejects(() => client.callTool("x.y", {}), (error) => {
      assert.equal(error.kind, "network");
      assert.equal(error.retriable, true);
      // 本机代理挂了也走这条路，提示要能让人想到去查代理
      assert.match(error.message, /代理/);
      return true;
    });
  });
});

describe("拉取窗口", () => {
  // 从上周一起算，让上周没同步到的排期也能补进来
  it("从上周一开始数满 windowDays 天", () => {
    // 2026-08-20 是周四
    const window = scheduleWindow(new Date(2026, 7, 20), 21);
    assert.equal(window.from, "2026-08-10", "上周一");
    assert.equal(window.to, "2026-08-30", "共 21 天");
  });

  it("周日不会被算成下一周的开始", () => {
    // 2026-08-23 是周日，它属于 8/17 那一周
    const window = scheduleWindow(new Date(2026, 7, 23), 21);
    assert.equal(window.from, "2026-08-10");
  });
});

describe("完成状态回写的边界", () => {
  // 飞书的「完成」是节点级流转。一个工作项挂四个节点时，「任务完成了」对应哪个
  // 节点并不确定——猜错会在飞书上推错流程，比不回写严重得多
  it("只有一段排期时才给出回写目标", () => {
    assert.deepEqual(soleNode({ schedule: [{ externalRef: "state_67" }] }), {
      stateId: "state_67",
    });
    assert.deepEqual(soleNode({ schedule: [{ externalRef: "state_67:6994443087" }] }), {
      stateId: "state_67",
      subtaskId: "6994443087",
    });
  });

  it("多段或无段时拒绝回写", () => {
    assert.equal(
      soleNode({ schedule: [{ externalRef: "state_67" }, { externalRef: "state_31" }] }),
      null,
    );
    assert.equal(soleNode({ schedule: [] }), null);
    assert.equal(soleNode(undefined), null);
  });
});
