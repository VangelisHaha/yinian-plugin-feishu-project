import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRange, handlers } from "../dist/handlers/tools.mjs";
test("查询窗口兼容实例缺省，拒绝无效日期和超范围", () => {
  assert.equal(parseRange({}), undefined);
  assert.deepEqual(parseRange({ from: "2026-09-01", to: "2026-09-07" }), {
    from: "2026-09-01",
    to: "2026-09-07",
  });
  for (const range of [
    { from: "2026-02-31", to: "2026-03-05" },
    { from: "2026-09-08" },
    { from: "2026-01-01", to: "2026-09-07" },
    { from: "2026-09-08", to: "2026-09-07" },
  ])
    assert.throws(() => parseRange(range));
});
test("目录只提供语义化只读排期工具，不透传远端 MCP", () => {
  const tools = handlers["tools.list"]({}).tools;
  assert.deepEqual(
    tools.map((t) => [t.name, t.effect]),
    [["list_schedule", "read"]],
  );
});
