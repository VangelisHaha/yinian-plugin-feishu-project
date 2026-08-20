#!/usr/bin/env node
/**
 * 模拟宿主。零依赖，只用 Node 标准库。
 *
 * 按真实宿主的方式起插件子进程并走一遍完整生命周期，让你**不装一念也能开发**：
 *
 *   plugin.init → config.validate → sync.pull → sync.push
 *   → hook.dispatch（含一次重复投递，验证幂等）→ notify.send → plugin.shutdown
 *
 * 它同时在做四件真实宿主也会做的事，所以能提前暴露契约问题：
 *
 * - 校验 stdout 的每一行都是合法 JSON 帧（非法行按 PLUGIN_CONTRACT_VIOLATION 报）；
 * - 拒绝插件主动发的 request（带 id 的帧）；
 * - 收集 host.log / host.progress / host.setState 通知；
 * - 按契约 §4.5 的超时表掐每次调用。
 *
 * 用法：
 *   node scripts/mock-host.mjs            # 跑全套
 *   node scripts/mock-host.mjs --verbose  # 打印每一帧
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERBOSE = process.argv.includes("--verbose");

/** 与契约 §4.5 一致。 */
const TIMEOUTS = {
  "plugin.init": 30_000,
  "config.validate": 30_000,
  "config.schema": 15_000,
  "sync.pull": 120_000,
  "sync.push": 120_000,
  "hook.dispatch": 30_000,
  "notify.send": 30_000,
  "plugin.shutdown": 5_000,
};
const DEFAULT_TIMEOUT = 15_000;

const violations = [];
const notifications = [];

class MockHost {
  #child;
  #pending = new Map();
  #nextId = 1;

  constructor(entry) {
    this.#child = spawn(process.execPath, [entry], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });

    createInterface({ input: this.#child.stdout }).on("line", (line) =>
      this.#onLine(line),
    );
    // 真实宿主会把 stderr 逐行收进插件日志（debug 级）
    createInterface({ input: this.#child.stderr }).on("line", (line) => {
      if (VERBOSE) console.log(`  [stderr] ${line}`);
    });
    this.#child.on("exit", (code) => {
      for (const [, pending] of this.#pending) {
        pending.reject(new Error(`插件进程在调用期间退出（code ${code}）`));
      }
      this.#pending.clear();
    });
  }

  #onLine(line) {
    if (!line.trim()) return;
    if (VERBOSE) console.log(`  ← ${line}`);

    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      // 真实宿主会记 PLUGIN_CONTRACT_VIOLATION。最常见的原因是忘删的 console.log
      violations.push(`stdout 出现非 JSON 行: ${line.slice(0, 120)}`);
      return;
    }

    if (frame.id !== undefined && frame.method !== undefined) {
      violations.push(`插件主动发了 request（${frame.method}），协议不允许`);
      return;
    }

    if (frame.method !== undefined) {
      if (!/^host\.(log|progress|setState)$/.test(frame.method)) {
        violations.push(`未知的通知方法 ${frame.method}`);
        return;
      }
      notifications.push(frame);
      return;
    }

    const pending = this.#pending.get(frame.id);
    if (!pending) {
      violations.push(`响应 id ${frame.id} 对不上任何请求`);
      return;
    }
    this.#pending.delete(frame.id);
    if (frame.error) {
      pending.reject(
        new Error(`${frame.error.message}（code ${frame.error.code}）`),
      );
      return;
    }
    pending.resolve(frame.result);
  }

  call(method, params) {
    const id = this.#nextId++;
    const frame = { jsonrpc: "2.0", id, method, params };
    if (VERBOSE) console.log(`  → ${JSON.stringify(frame)}`);
    this.#child.stdin.write(`${JSON.stringify(frame)}\n`);

    const timeout = TIMEOUTS[method] ?? DEFAULT_TIMEOUT;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // 真实宿主超时会杀进程，因为迟到的响应会让 id 流错位
        reject(new Error(`${method} 超时（${timeout}ms），真实宿主会杀掉进程`));
      }, timeout);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  kill() {
    this.#child.kill("SIGKILL");
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readManifest() {
  return JSON.parse(readFileSync(join(ROOT, "yinian-plugin.json"), "utf8"));
}

function initParams(manifest, dataDir) {
  const config = {};
  // 从静态 schema 里取 default，模拟「用户什么都没改」的配置
  for (const file of manifest.contributes?.settingsPanel ?? []) {
    const schema = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
    for (const field of schema.fields ?? []) {
      collectDefaults(field, config);
    }
  }
  // 模板的 config.validate 要求 token 以 demo- 开头
  config.apiToken = "demo-token";

  return {
    protocolVersion: 1,
    hostVersion: manifest.minHostVersion ?? "0.5.0",
    pluginId: manifest.id,
    integrationId: "mock-integration",
    apiBaseUrl: "http://127.0.0.1:19735/api/v1",
    apiToken: "mock-api-token",
    dataDir,
    locale: "zh-CN",
    logLevel: "debug",
    devMode: true,
    config,
    state: {},
  };
}

function collectDefaults(field, into) {
  if (field.type === "group") {
    for (const child of field.fields ?? []) collectDefaults(child, into);
    return;
  }
  if (field.default !== undefined) into[field.key] = field.default;
}

async function main() {
  const manifest = readManifest();
  const entry =
    manifest.runtime?.entry?.[process.platform] ??
    manifest.runtime?.entry?.default;
  assert(entry, "manifest 里没有可用的 runtime.entry");
  assert(
    existsSync(join(ROOT, entry)),
    `${entry} 不存在，先跑 npm run build`,
  );

  const dataDir = mkdtempSync(join(tmpdir(), "yinian-plugin-mock-"));
  const host = new MockHost(join(ROOT, entry));
  const contributes = manifest.contributes ?? {};

  try {
    const init = await host.call("plugin.init", initParams(manifest, dataDir));
    assert(init?.ok === true, "plugin.init 必须返回 { ok: true }");
    console.log(`✓ plugin.init（插件版本 ${init.pluginVersion ?? "未报"}）`);

    const validated = await host.call("config.validate", {
      scope: "plugin",
      config: { apiToken: "demo-token", endpoint: "https://example.com/api" },
    });
    assert(validated?.ok === true, `config.validate 未通过：${JSON.stringify(validated)}`);
    console.log("✓ config.validate");

    // 故意给一个坏配置，确认校验真的会拦
    const rejected = await host.call("config.validate", {
      scope: "plugin",
      config: { apiToken: "wrong", endpoint: "http://example.com" },
    });
    assert(
      rejected?.ok === false && Array.isArray(rejected.errors) && rejected.errors.length > 0,
      "坏配置应当被 config.validate 拦住并给出 errors",
    );
    assert(
      rejected.errors.every((item) => typeof item.message === "string"),
      "每条 error 都要有 message",
    );
    console.log(`✓ config.validate 能拦住坏配置（${rejected.errors.length} 处）`);

    if (contributes.sync) {
      const page = await host.call("sync.pull", {
        integrationId: "mock-integration",
        traceId: "mock-trace-pull",
        resource: "task",
        full: false,
      });
      assert(Array.isArray(page?.items), "sync.pull 必须返回 items 数组");
      assert(typeof page.hasMore === "boolean", "sync.pull 必须返回 hasMore");
      for (const item of page.items) {
        assert(
          typeof item.externalId === "string" && item.externalId,
          "每个 item 都要有 externalId",
        );
        assert(typeof item.title === "string", "每个 item 都要有 title");
      }
      console.log(`✓ sync.pull（${page.items.length} 条，hasMore=${page.hasMore}）`);

      const actions = contributes.sync.capabilities?.actions ?? [];
      if (actions.includes("complete") && page.items[0]) {
        const outcome = await host.call("sync.push", {
          integrationId: "mock-integration",
          traceId: "mock-trace-push",
          resource: "task",
          action: "complete",
          externalId: page.items[0].externalId,
          item: { ...page.items[0], status: "done" },
          changedFields: [],
        });
        assert(
          typeof outcome?.applied === "boolean",
          "sync.push 必须返回 applied",
        );
        console.log(`✓ sync.push complete（applied=${outcome.applied}）`);
      }
    }

    if ((contributes.hooks ?? []).length > 0) {
      const topic = contributes.hooks[0];
      const event = {
        outboxId: "mock-outbox-1",
        traceId: "mock-trace-hook",
        topic,
        occurredAt: new Date().toISOString(),
        entity: { type: topic.split(".")[0], id: "mock-entity-1" },
        payload: { snapshot: { title: "模拟任务" }, changedFields: ["status"] },
      };
      const first = await host.call("hook.dispatch", event);
      assert(first?.ok === true, "hook.dispatch 必须返回 { ok: true }");

      // 同一条再投一次：投递保证是「至少一次」，插件必须幂等
      const again = await host.call("hook.dispatch", event);
      assert(
        again?.ok === true,
        "重复投递也要返回 ok，报错只会让宿主白白重试",
      );
      console.log("✓ hook.dispatch（含重复投递，幂等）");
    }

    if (contributes.notificationChannel) {
      const outcome = await host.call("notify.send", {
        traceId: "mock-trace-notify",
        notification: {
          id: "mock-notification-1",
          kind: "task_due",
          title: "模拟通知",
          body: "来自 mock host",
        },
      });
      assert(
        typeof outcome?.delivered === "boolean",
        "notify.send 必须返回 delivered",
      );
      console.log(`✓ notify.send（delivered=${outcome.delivered}）`);
    }

    // action 与 optionsFrom 指向的自定义方法
    for (const file of contributes.settingsPanel ?? []) {
      const schema = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
      for (const method of collectCustomMethods(schema.fields ?? [])) {
        const result = await host.call(method, {});
        assert(
          result !== null && typeof result === "object",
          `${method} 必须返回对象`,
        );
        console.log(`✓ ${method}`);
      }
    }

    const shutdown = await host.call("plugin.shutdown", {});
    assert(shutdown?.ok === true, "plugin.shutdown 必须返回 { ok: true }");
    console.log("✓ plugin.shutdown");

    report();
  } catch (error) {
    host.kill();
    report();
    console.error(`\n✗ ${error.message}`);
    process.exitCode = 1;
  }
}

function collectCustomMethods(fields) {
  const methods = new Set();
  for (const field of fields) {
    if (field.type === "group") {
      for (const method of collectCustomMethods(field.fields ?? [])) {
        methods.add(method);
      }
      continue;
    }
    if (field.type === "action" && typeof field.rpc === "string") {
      methods.add(field.rpc);
    }
    if (typeof field.optionsFrom === "string" && field.optionsFrom.startsWith("rpc:")) {
      methods.add(field.optionsFrom.slice(4));
    }
  }
  return methods;
}

function report() {
  const byMethod = new Map();
  for (const item of notifications) {
    byMethod.set(item.method, (byMethod.get(item.method) ?? 0) + 1);
  }
  if (byMethod.size > 0) {
    const summary = [...byMethod]
      .map(([method, count]) => `${method}×${count}`)
      .join("、");
    console.log(`\n收到的宿主通知：${summary}`);
  }

  const state = notifications.filter((item) => item.method === "host.setState");
  if (state.length > 0) {
    const last = state.at(-1).params;
    console.log(
      `最后一次 setState：cursor=${last.cursor ?? "(未设)"}，state 键=${Object.keys(last.state ?? {}).join(",") || "(无)"}`,
    );
  }

  if (violations.length > 0) {
    console.error("\n契约违规：");
    for (const item of violations) console.error(`  - ${item}`);
    process.exitCode = 1;
  }
}

await main();
