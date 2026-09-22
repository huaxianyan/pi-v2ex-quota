import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDetails, buildStatus, formatDuration, formatTokens } from "../src/format.ts";
import type { QuotaWindow } from "../src/v2ex.ts";

const PERIOD_END = 1_790_075_684;
const NOW = PERIOD_END * 1000 - 7_200_000;

function windowOf(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    active: true,
    totalTokens: 1_000,
    usedTokens: 0,
    remainingTokens: 1_000,
    usedPercent: 0,
    periodStart: 0,
    periodEnd: PERIOD_END,
    extraRemainingTokens: 0,
    ...overrides,
  };
}

test("formatDuration 覆盖秒、分、时、天", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(30_000), "30s");
  assert.equal(formatDuration(90_000), "1m");
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(3_660_000), "1h1m");
  assert.equal(formatDuration(9_660_000), "2h41m");
  assert.equal(formatDuration(90_000_000), "1d1h");
});

test("formatDuration 对负数按 0 处理", () => {
  assert.equal(formatDuration(-5_000), "0s");
});

test("formatTokens 用 M 与 K 缩写", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_500), "2K");
  assert.equal(formatTokens(8_020_000), "8.0M");
});

test("没有数据时状态显示占位", () => {
  assert.deepEqual(buildStatus({ window: undefined, now: NOW, waiting: false }), {
    text: "v2ex --",
    level: "unknown",
  });
});

test("没有有效窗口时显示空闲", () => {
  const view = buildStatus({ window: windowOf({ active: false }), now: NOW, waiting: false });
  assert.equal(view.text, "v2ex 空闲");
  assert.equal(view.level, "idle");
});

test("额度充足时显示剩余百分比与倒计时", () => {
  const view = buildStatus({
    window: windowOf({ usedPercent: 50, remainingTokens: 500 }),
    now: NOW,
    waiting: false,
  });
  assert.equal(view.text, "v2ex 50% · 2h");
  assert.equal(view.level, "ok");
});

test("剩余不足 15% 时降级为告警色", () => {
  const view = buildStatus({
    window: windowOf({ usedPercent: 90, remainingTokens: 100 }),
    now: NOW,
    waiting: false,
  });
  assert.equal(view.text, "v2ex 10% · 2h");
  assert.equal(view.level, "low");
});

test("用尽时显示 0%", () => {
  const view = buildStatus({
    window: windowOf({ usedPercent: 100, usedTokens: 1_000, remainingTokens: 0 }),
    now: NOW,
    waiting: false,
  });
  assert.equal(view.text, "v2ex 0% · 2h");
  assert.equal(view.level, "empty");
});

test("用尽且已排入等待时显示等待中", () => {
  const view = buildStatus({
    window: windowOf({ usedPercent: 100, usedTokens: 1_000, remainingTokens: 0 }),
    now: NOW,
    waiting: true,
  });
  assert.equal(view.text, "v2ex 等待 2h");
  assert.equal(view.level, "waiting");
});

test("额外用量存在时附在状态末尾", () => {
  const view = buildStatus({
    window: windowOf({ usedPercent: 20, remainingTokens: 800, extraRemainingTokens: 1_200_000 }),
    now: NOW,
    waiting: false,
  });
  assert.equal(view.text, "v2ex 80% · 2h · +1.2M");
});

test("详情面板列出窗口用量与重置时间", () => {
  const lines = buildDetails({
    window: windowOf({ usedPercent: 100, usedTokens: 1_000, remainingTokens: 0 }),
    now: NOW,
    waiting: true,
    autoWaitLabel: "已开启（2h 后继续）",
  });
  const text = lines.join("\n");
  assert.match(text, /窗口已用 1K \/ 1K/);
  assert.match(text, /剩余 0（0%）/);
  assert.match(text, /重置 .*（2h 后）/);
  assert.match(text, /正在等待刷新后自动续跑/);
  assert.match(text, /自动续跑：已开启（2h 后继续）/);
});

test("详情面板在无窗口时说明下一条消息开新窗口", () => {
  const lines = buildDetails({
    window: windowOf({ active: false }),
    now: NOW,
    waiting: false,
    autoWaitLabel: "已关闭",
  });
  assert.match(lines.join("\n"), /没有有效窗口/);
});

test("详情面板在无数据时提示刷新", () => {
  const lines = buildDetails({
    window: undefined,
    now: NOW,
    waiting: false,
    autoWaitLabel: "已关闭",
  });
  assert.match(lines.join("\n"), /\/v2ex refresh/);
});
