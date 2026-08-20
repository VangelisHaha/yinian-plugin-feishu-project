/**
 * 映射测试：飞书项目的扁平排期节点 → 一念的「一个 Task 多个排期块」。
 *
 * 用真实抓下来的响应片段（huasheng 空间，2026-08-17~08-23）驱动，不发网络请求。
 * 重点覆盖那些「真机上不容易发现、错了又很隐蔽」的地方：时区、externalRef 稳定性、
 * 由流转标记折状态。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mapSchedule,
  rollupStatus,
  slotStatus,
  toRfc3339,
  workItemUrl,
} from "../dist/feishu/mapping.mjs";

const OPTIONS = { simpleName: "huasheng", host: "project.feishu.cn", utcOffset: "+08:00" };

/** 实测响应的裁剪版：KAZ-BCC 一个工作项挂三个节点。 */
function realResponse() {
  return {
    user_workload_list: [
      {
        user_info: { name: "王杰", userKey: "7264839126464102402" },
        total_score: 17.9,
        total_unscheduled_task: 59,
        tasks: [
          {
            work_item_info: { name: "KAZ-BCC银行接入", id: 7072539263 },
            state: { state_id: "state_67", state_name: "中台开发", passed: false, reached: true },
            subtasks: null,
            time: { start: "2026-08-14 00:00:00", end: "2026-08-20 23:59:59", duration: 5 },
          },
          {
            work_item_info: { name: "KAZ-BCC银行接入", id: 7072539263 },
            state: { state_id: "state_113", state_name: "中台联调", passed: false, reached: false },
            subtasks: null,
            time: { start: "2026-08-17 00:00:00", end: "2026-08-24 23:59:59", duration: 2 },
          },
          {
            work_item_info: { name: "KAZ-BCC银行接入", id: 7072539263 },
            state: { state_id: "state_3", state_name: "技术方案设计评审", passed: true, reached: true },
            subtasks: null,
            time: { start: "2026-08-13 00:00:00", end: "2026-08-14 23:59:59", duration: 1 },
          },
          {
            work_item_info: { name: "主站-更新出金TT模板", id: 7072390498 },
            state: { state_id: "state_67", state_name: "中台开发", passed: true, reached: true },
            subtasks: null,
            time: { start: "2026-08-17 00:00:00", end: "2026-08-18 23:59:59", duration: 2 },
          },
        ],
      },
    ],
  };
}

describe("时间转换", () => {
  // 飞书给的是空间本地时间且不带偏移，当 UTC 会让整段排期偏 8 小时，
  // 跨天节点的首尾日期都会错
  it("补上时区偏移而不是当成 UTC", () => {
    assert.equal(toRfc3339("2026-08-14 00:00:00", "+08:00"), "2026-08-14T00:00:00+08:00");
    assert.equal(toRfc3339("2026-08-20 23:59:59", "+05:00"), "2026-08-20T23:59:59+05:00");
  });

  it("认不出来的值返回 null 而不是瞎猜", () => {
    for (const bad of [undefined, "", "昨天", "2026/08/14"]) {
      assert.equal(toRfc3339(bad, "+08:00"), null);
    }
  });
});

describe("节点状态", () => {
  // 权威来源是 passed/reached，不是节点名。按名字猜会把「确认上线」误判成已完成，
  // 而「中台开发」这类永远匹配不上——nikou-screen 踩过并废弃了那套实现
  it("由流转标记折出三态", () => {
    assert.equal(slotStatus({ passed: true, reached: true }), "finished");
    assert.equal(slotStatus({ passed: false, reached: true }), "active");
    assert.equal(slotStatus({ passed: false, reached: false }), "planned");
    assert.equal(slotStatus(undefined), "planned");
  });

  it("子任务自带完成标记时以它为准", () => {
    assert.equal(slotStatus({ passed: false, reached: false }, true), "finished");
    assert.equal(slotStatus({ passed: true, reached: true }, false), "active");
  });

  it("全部完成才算工作项完成", () => {
    assert.equal(rollupStatus([{ status: "finished" }, { status: "finished" }]), "done");
    assert.equal(rollupStatus([{ status: "finished" }, { status: "active" }]), "doing");
    assert.equal(rollupStatus([{ status: "planned" }, { status: "finished" }]), "todo");
    assert.equal(rollupStatus([]), "todo");
  });
});

describe("聚合成工作项", () => {
  it("同一工作项的多个节点聚成一条任务、多段排期", () => {
    const items = mapSchedule(realResponse(), OPTIONS);

    assert.equal(items.length, 2, "两个工作项");
    const kaz = items.find((item) => item.externalId === "7072539263");
    assert.ok(kaz);
    assert.equal(kaz.title, "KAZ-BCC银行接入");
    assert.equal(kaz.schedule.length, 3, "三个节点各一段排期");
  });

  // 宿主靠 externalRef 认出「同一段被改了时间」。把时间拼进去会让每次改排期
  // 都变成删旧块建新块，块上记的实际起止时间跟着丢
  it("externalRef 只由节点 id 构成，不含时间", () => {
    const items = mapSchedule(realResponse(), OPTIONS);
    const refs = items.flatMap((item) => item.schedule.map((slot) => slot.externalRef));
    assert.deepEqual([...refs].sort(), ["state_113", "state_3", "state_67", "state_67"].sort());
    for (const ref of refs) {
      assert.ok(!/\d{4}-\d{2}-\d{2}/.test(ref), `externalRef 不能含时间：${ref}`);
    }
  });

  it("同一份响应重复映射得到完全一样的结果", () => {
    const first = mapSchedule(realResponse(), OPTIONS);
    const second = mapSchedule(realResponse(), OPTIONS);
    assert.deepEqual(first, second, "映射必须是纯函数，否则每轮同步都会误判成有变化");
  });

  it("按节点流转推导整体状态，不看空间自定义的 work_item_status", () => {
    const items = mapSchedule(realResponse(), OPTIONS);
    // 三段里有 active，整体是进行中
    assert.equal(items.find((item) => item.externalId === "7072539263").status, "doing");
    // 唯一一段已通过，整体完成
    assert.equal(items.find((item) => item.externalId === "7072390498").status, "done");
  });

  it("截止时间取最晚一段的结束时间", () => {
    const items = mapSchedule(realResponse(), OPTIONS);
    const kaz = items.find((item) => item.externalId === "7072539263");
    assert.equal(kaz.dueAt, "2026-08-24T23:59:59+08:00");
  });

  it("估分合计折成分钟", () => {
    const items = mapSchedule(realResponse(), OPTIONS);
    const kaz = items.find((item) => item.externalId === "7072539263");
    // 5 + 2 + 1 = 8 人天 × 8 小时 × 60
    assert.equal(kaz.estimateMinutes, 8 * 8 * 60);
  });

  it("带上可跳回 Meegle 的地址", () => {
    const items = mapSchedule(realResponse(), OPTIONS);
    assert.equal(
      items[0].externalUrl,
      workItemUrl("project.feishu.cn", "huasheng", "7072539263"),
    );
  });

  // 飞书项目独有的字段进不了一念主模型，只能靠 details 透出到「来源」区块
  it("展示字段给出空间、当前节点与排期负责人", () => {
    const items = mapSchedule(realResponse(), OPTIONS);
    const kaz = items.find((item) => item.externalId === "7072539263");
    const byLabel = new Map(kaz.details.map((field) => [field.label, field.value]));

    assert.equal(byLabel.get("空间"), "huasheng");
    // reached && !passed 的那段才是「正在做」，已通过和还没到的都不算
    assert.equal(byLabel.get("当前节点"), "中台开发");
    assert.equal(byLabel.get("排期负责人"), "王杰");
    assert.equal(byLabel.get("排期节点"), "3 段");

    // 全部节点都已通过时没有「当前节点」这条，不留一个空值占位
    const done = items.find((item) => item.externalId === "7072390498");
    assert.ok(!done.details.some((field) => field.label === "当前节点"));
  });

  // 没有有效起止时间的节点在飞书里就是「未排期」，硬塞一个块会在日历上凭空多一段
  it("丢掉没有排期时间的节点，整条都没有时不产出工作项", () => {
    const response = {
      user_workload_list: [
        {
          tasks: [
            {
              work_item_info: { name: "还没排期的需求", id: 111 },
              state: { state_id: "state_1" },
              subtasks: null,
              time: { duration: 0 },
            },
          ],
        },
      ],
    };
    assert.deepEqual(mapSchedule(response, OPTIONS), []);
  });

  it("有子任务时按子任务拆段，externalRef 带上子任务 id", () => {
    const response = {
      user_workload_list: [
        {
          tasks: [
            {
              work_item_info: { name: "带子任务的需求", id: 222 },
              state: { state_id: "state_67", state_name: "中台开发", reached: true },
              subtasks: [
                {
                  id: 6994443087,
                  name: "接口联调",
                  is_finished: true,
                  time: { start: "2026-08-18 00:00:00", end: "2026-08-19 23:59:59", duration: 1 },
                },
                {
                  id: 6994443088,
                  name: "补单测",
                  is_finished: false,
                  time: { start: "2026-08-20 00:00:00", end: "2026-08-20 23:59:59", duration: 0.5 },
                },
              ],
              time: { start: "2026-08-18 00:00:00", end: "2026-08-20 23:59:59", duration: 1.5 },
            },
          ],
        },
      ],
    };
    const [item] = mapSchedule(response, OPTIONS);
    assert.equal(item.schedule.length, 2);
    assert.deepEqual(
      item.schedule.map((slot) => slot.externalRef),
      ["state_67:6994443087", "state_67:6994443088"],
    );
    assert.equal(item.schedule[0].status, "finished");
    assert.equal(item.schedule[1].status, "active");
    assert.equal(item.schedule[0].title, "接口联调");
  });

  it("没有工作项 id 的条目直接跳过而不是让整批失败", () => {
    const response = {
      user_workload_list: [
        {
          tasks: [
            {
              work_item_info: { name: "缺 id" },
              state: { state_id: "state_1" },
              time: { start: "2026-08-18 00:00:00", end: "2026-08-18 23:59:59" },
            },
            {
              work_item_info: { name: "正常", id: 333 },
              state: { state_id: "state_1" },
              time: { start: "2026-08-18 00:00:00", end: "2026-08-18 23:59:59" },
            },
          ],
        },
      ],
    };
    const items = mapSchedule(response, OPTIONS);
    assert.equal(items.length, 1);
    assert.equal(items[0].externalId, "333");
  });
});
