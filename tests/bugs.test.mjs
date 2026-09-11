/**
 * 缺陷映射测试。
 *
 * 用 huasheng 空间实测抓下来的 `search_by_mql` 响应片段驱动，不发网络请求。
 * 重点盯那些「错了很隐蔽」的地方：
 *
 * - `externalId` 必须带 `bug:` 前缀（`sync.push` 靠它硬拦回写）
 * - **不能带 `schedule`**（传 `[]` 会让宿主去清块）
 * - **不能带 `completedAt`**（飞书只有天精度，造出来的完成时刻是假数据）
 * - 状态不在「待我修」集合里就该是 `done`，否则关掉的缺陷会永远挂着
 * - 紧急度下限要真的抬得起来
 * - `bugDueDays` 的日期加法不能被本机时区滚掉一天
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUG_ID_PREFIX,
  bugPriority,
  bugRowsOf,
  bugStatus,
  bugUrl,
  buildBugMql,
  flattenRow,
  isBugExternalId,
  mapBugs,
  maxPriority,
} from "../dist/feishu/bugs.mjs";
import { bugSettingsFrom } from "../dist/handlers/sync.mjs";

const SETTINGS = bugSettingsFrom({});
const OPTIONS = {
  simpleName: "huasheng",
  host: "project.feishu.cn",
  utcOffset: "+08:00",
  settings: SETTINGS,
};

/** 实测响应的裁剪版：两条缺陷，一条已关闭、一条处理中。 */
function realResponse() {
  return {
    list: [{ count: 2 }],
    data: {
      1: [
        {
          moql_field_list: [
            {
              key: "work_item_id",
              value_type: "long_value",
              value: { long_value: 7109026460 },
            },
            {
              key: "name",
              value_type: "string_value",
              value: {
                string_value:
                  "持仓子仓页面，美股小数股存在五位小数时，查询页面展示只展示整数",
              },
            },
            {
              key: "priority",
              value_type: "key_label_value",
              value: { key_label_value: { key: "2", label: "中" } },
            },
            {
              key: "severity",
              value_type: "key_label_value",
              value: { key_label_value: { key: "3", label: "一般" } },
            },
            {
              key: "work_item_status",
              value_type: "key_label_value_list",
              value: { key_label_value_list: [{ key: "CLOSED", label: "关闭" }] },
            },
            {
              key: "start_time",
              value_type: "string_value",
              value: { string_value: "2026-09-07" },
            },
            {
              key: "updated_at",
              value_type: "string_value",
              value: { string_value: "2026-09-08" },
            },
          ],
        },
        {
          moql_field_list: [
            {
              key: "work_item_id",
              value_type: "long_value",
              value: { long_value: 7103011917 },
            },
            {
              key: "name",
              value_type: "string_value",
              value: { string_value: "【KAZ-BCC银行】USD跨行转账被拦截" },
            },
            {
              key: "priority",
              value_type: "key_label_value",
              value: { key_label_value: { key: "99", label: "低" } },
            },
            {
              key: "severity",
              value_type: "key_label_value",
              value: { key_label_value: { key: "1", label: "致命" } },
            },
            {
              key: "work_item_status",
              value_type: "key_label_value_list",
              value: {
                key_label_value_list: [{ key: "IN PROGRESS", label: "处理中" }],
              },
            },
            {
              key: "start_time",
              value_type: "string_value",
              value: { string_value: "2026-08-31" },
            },
            {
              key: "updated_at",
              value_type: "string_value",
              value: { string_value: "2026-09-02" },
            },
          ],
        },
      ],
    },
  };
}

describe("响应拍平", () => {
  it("枚举取 label 而不是空间私有的 key", () => {
    const rows = bugRowsOf(realResponse());
    assert.equal(rows.length, 2);
    assert.equal(rows[0].statusLabel, "关闭");
    assert.equal(rows[0].priorityLabel, "中");
    assert.equal(rows[0].severityLabel, "一般");
    assert.equal(rows[0].workItemId, "7109026460");
  });

  it("没有 work_item_id 的行直接丢掉", () => {
    const rows = bugRowsOf({
      data: { 1: [{ moql_field_list: [{ key: "name", value: { string_value: "x" } }] }] },
    });
    assert.deepEqual(rows, []);
  });

  it("多值枚举拼成一串，空响应不炸", () => {
    assert.deepEqual(bugRowsOf({}), []);
    assert.deepEqual(bugRowsOf({ data: null }), []);
    const flat = flattenRow({
      moql_field_list: [
        {
          key: "work_item_status",
          value: {
            key_label_value_list: [{ label: "新建" }, { label: "处理中" }],
          },
        },
      ],
    });
    assert.equal(flat.work_item_status, "新建、处理中");
  });
});

describe("状态与紧急度", () => {
  it("不在「待我修」集合里就是 done，处理中是 doing", () => {
    const [closed, doing] = bugRowsOf(realResponse());
    assert.equal(bugStatus(closed, SETTINGS), "done");
    assert.equal(bugStatus(doing, SETTINGS), "doing");
    assert.equal(
      bugStatus({ ...doing, statusLabel: "新建" }, SETTINGS),
      "todo",
    );
  });

  it("默认下限 high，把「低」也抬成 high", () => {
    const [, doing] = bugRowsOf(realResponse());
    assert.equal(doing.priorityLabel, "低");
    assert.equal(bugPriority(doing, SETTINGS), "high");
  });

  it("下限设 none 时完全跟随飞书", () => {
    const settings = bugSettingsFrom({ bugPriorityFloor: "none" });
    const [closed, doing] = bugRowsOf(realResponse());
    assert.equal(bugPriority(closed, settings), "medium"); // 中
    assert.equal(bugPriority(doing, settings), "low"); // 低
  });

  it("依据切到严重程度后，致命 → high", () => {
    const settings = bugSettingsFrom({
      bugPriorityFloor: "none",
      bugPriorityBasis: "severity",
    });
    const [closed, doing] = bugRowsOf(realResponse());
    assert.equal(bugPriority(closed, settings), "medium"); // 一般
    assert.equal(bugPriority(doing, settings), "high"); // 致命
  });

  it("认不出来的枚举落到 medium，不是 none", () => {
    const settings = bugSettingsFrom({ bugPriorityFloor: "none" });
    assert.equal(
      bugPriority({ priorityLabel: "P0", severityLabel: "" }, settings),
      "medium",
    );
  });

  it("maxPriority 按 none<low<medium<high 排序", () => {
    assert.equal(maxPriority("low", "high"), "high");
    assert.equal(maxPriority("medium", "low"), "medium");
    assert.equal(maxPriority("none", "none"), "none");
  });
});

describe("映射成 ExternalItem", () => {
  it("externalId 带 bug: 前缀，URL 走 issue 路径", () => {
    const items = mapBugs(bugRowsOf(realResponse()), OPTIONS);
    assert.equal(items[0].externalId, `${BUG_ID_PREFIX}7109026460`);
    assert.ok(isBugExternalId(items[0].externalId));
    assert.equal(
      items[0].externalUrl,
      "https://project.feishu.cn/huasheng/issue/detail/7109026460",
    );
    assert.equal(
      bugUrl("meegle.com", "demo", "1"),
      "https://meegle.com/demo/issue/detail/1",
    );
  });

  it("不带 schedule、不带 completedAt", () => {
    for (const item of mapBugs(bugRowsOf(realResponse()), OPTIONS)) {
      // 传 [] 会被宿主理解成「外部明确没有排期了」，去清它建过的块
      assert.equal("schedule" in item, false);
      // 飞书只有天精度，造完成时刻是假数据
      assert.equal("completedAt" in item, false);
    }
  });

  it("remoteUpdatedAt 按空间时区补偏移", () => {
    const items = mapBugs(bugRowsOf(realResponse()), OPTIONS);
    assert.equal(items[0].remoteUpdatedAt, "2026-09-08T00:00:00+08:00");
  });

  it("默认不造截止日；开了之后按创建时间加天数，落当天 23:59:59", () => {
    const [withoutDue] = mapBugs(bugRowsOf(realResponse()), OPTIONS);
    assert.equal("dueAt" in withoutDue, false);

    const settings = bugSettingsFrom({ bugDueDays: 3 });
    const [withDue] = mapBugs(bugRowsOf(realResponse()), {
      ...OPTIONS,
      settings,
    });
    // 2026-09-07 + 3d = 2026-09-10，不能因为本机时区滚成 09-09 或 09-11
    assert.equal(withDue.dueAt, "2026-09-10T23:59:59+08:00");
  });

  it("跨月加天数不出错", () => {
    const settings = bugSettingsFrom({ bugDueDays: 5 });
    const [, item] = mapBugs(bugRowsOf(realResponse()), { ...OPTIONS, settings });
    // 2026-08-31 + 5d = 2026-09-05
    assert.equal(item.dueAt, "2026-09-05T23:59:59+08:00");
  });

  it("标签默认「缺陷」，显式留空则不打", () => {
    const [tagged] = mapBugs(bugRowsOf(realResponse()), OPTIONS);
    assert.deepEqual(tagged.tags, ["缺陷"]);
    const [untagged] = mapBugs(bugRowsOf(realResponse()), {
      ...OPTIONS,
      settings: bugSettingsFrom({ bugTag: "" }),
    });
    assert.equal("tags" in untagged, false);
  });

  it("details 用中文 label，不出现空间私有 key", () => {
    const [item] = mapBugs(bugRowsOf(realResponse()), OPTIONS);
    const labels = item.details.map((f) => f.label);
    assert.deepEqual(labels, [
      "类型",
      "空间",
      "缺陷状态",
      "优先级",
      "严重程度",
      "创建时间",
    ]);
    assert.equal(item.details[0].value, "缺陷");
    assert.ok(!JSON.stringify(item.details).includes("IN PROGRESS"));
  });

  it("没有标题时用工作项 id 兜底", () => {
    const [item] = mapBugs([{ workItemId: "9", name: "", statusLabel: "新建" }], OPTIONS);
    assert.equal(item.title, "缺陷 #9");
  });
});

describe("MQL 拼装", () => {
  const base = { projectKey: "huasheng", settings: SETTINGS, since: "2026-08-28" };

  it("默认只查指派修复者，状态与回看之间是 OR", () => {
    const mql = buildBugMql(base);
    assert.ok(mql.includes("FROM `huasheng`.`缺陷`"));
    assert.ok(mql.includes("array_contains(`__问题指派修复者`, current_login_user())"));
    // 未关闭的不限时间 OR 最近有更新的，缺一半都会漏
    assert.ok(mql.includes("`work_item_status` IN ('新建', '处理中'"));
    assert.ok(mql.includes("OR `updated_at` >= '2026-08-28'"));
    assert.ok(mql.includes("LIMIT 200"));
  });

  it("三个归属口径之间是 OR，创建者用等号不是 array_contains", () => {
    const settings = bugSettingsFrom({
      bugScopes: ["assignee", "operator", "creator"],
    });
    const mql = buildBugMql({ ...base, settings });
    assert.ok(mql.includes("array_contains(`当前负责人`, current_login_user())"));
    assert.ok(mql.includes("`创建者` = current_login_user()"));
    assert.equal(mql.match(/ OR array_contains|`创建者`/g).length >= 2, true);
  });

  it("角色名可换，跟着空间走", () => {
    const settings = bugSettingsFrom({ bugAssigneeRole: "缺陷修复人" });
    assert.ok(buildBugMql({ ...base, settings }).includes("`__缺陷修复人`"));
  });

  it("状态名里的单引号被转义，不会把语句劈开", () => {
    const settings = bugSettingsFrom({ bugOpenStatuses: ["it's open"] });
    assert.ok(buildBugMql({ ...base, settings }).includes("'it\\'s open'"));
  });

  it("口径或状态被清空时报错，而不是拼出查不到东西的语句", () => {
    assert.throws(
      () => buildBugMql({ ...base, settings: bugSettingsFrom({ bugScopes: [] }) }),
      /归属口径/,
    );
    assert.throws(
      () =>
        buildBugMql({
          ...base,
          settings: bugSettingsFrom({ bugOpenStatuses: [] }),
        }),
      /状态/,
    );
  });
});

describe("设置解析", () => {
  it("老配置里没有这些 key 时落到「跟新装一样」的默认", () => {
    const settings = bugSettingsFrom({});
    assert.equal(settings.enabled, true);
    assert.equal(settings.priorityFloor, "high");
    assert.equal(settings.priorityBasis, "priority");
    assert.equal(settings.closeLookbackDays, 14);
    assert.equal(settings.dueDays, 0);
    assert.equal(settings.tag, "缺陷");
    assert.equal(settings.limit, 200);
    assert.deepEqual(settings.scopes, ["assignee"]);
    assert.equal(settings.assigneeRole, "问题指派修复者");
  });

  it("显式清空勾选如实反映成空数组，不悄悄补默认", () => {
    assert.deepEqual(bugSettingsFrom({ bugScopes: [] }).scopes, []);
    assert.deepEqual(bugSettingsFrom({ bugOpenStatuses: [] }).openStatuses, []);
  });

  it("越界数值被夹到区间内，非法枚举回落默认", () => {
    assert.equal(bugSettingsFrom({ bugCloseLookbackDays: 9999 }).closeLookbackDays, 90);
    assert.equal(bugSettingsFrom({ bugCloseLookbackDays: 0 }).closeLookbackDays, 1);
    assert.equal(bugSettingsFrom({ bugLimit: "abc" }).limit, 200);
    assert.equal(bugSettingsFrom({ bugPriorityFloor: "urgent" }).priorityFloor, "high");
    assert.deepEqual(bugSettingsFrom({ bugScopes: ["nope"] }).scopes, []);
  });

  it("syncBugs 显式 false 时关掉", () => {
    assert.equal(bugSettingsFrom({ syncBugs: false }).enabled, false);
  });
});
