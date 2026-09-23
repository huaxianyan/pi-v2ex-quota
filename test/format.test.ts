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
  const view = buildStatus({ window: undefined, now: NOW, waiting: false });
  assert.equal(view.text, "V2EX --");
  assert.equal(view.level, "unknown");
  // 没有数字可画的时候不出进度条，一段空条比没有更让人困惑。
  assert.equal(view.segments.length, 1);
});

test("没有有效窗口时显示空闲", () => {
  const view = buildStatus({ window: windowOf({ active: false }), now: NOW, waiting: false });
  assert.equal(view.text, "V2EX 空闲");
  assert.equal(view.level, "idle");
});

test("额度充足时显示进度条、剩余百分比与倒计时", () => {
  const view = buildStatus({
    window: windowOf({ usedPercent: 50, remainingTokens: 500 }),
    now: NOW,
    waiting: false,
  });
  assert.equal(view.text, "V2EX ████░░░░ 50% · 2h");
  assert.equal(view.level, "ok");
  // 空格子单独一段用于压暗，所以这里必须是四段而不是一整段。
  assert.deepEqual(
    view.segments.map((segment) => segment.tone),
    ["level", "level", "dim", "level"],
  );
});

test("进度条按剩余比例画，四舍五入到格", () => {
  // 剩余百分比是从 usedPercent 反推的，所以两边都要跟着给。
  const bar = (remainingTokens: number): string =>
    buildStatus({
      window: windowOf({
        usedTokens: 1_000 - remainingTokens,
        usedPercent: 100 - (remainingTokens / 1_000) * 100,
        remainingTokens,
      }),
      now: NOW,
      waiting: false,
    }).text;

  assert.equal(bar(1_000), "V2EX ████████ 100% · 2h");
  assert.equal(bar(800), "V2EX ██████░░ 80% · 2h");
  // 97% 不画满格：满格只留给真正满额，否则看着像一点没用，比数字还误导。
  assert.equal(bar(970), "V2EX ███████░ 97% · 2h");
  assert.equal(bar(500), "V2EX ████░░░░ 50% · 2h");
  assert.equal(bar(10), "V2EX ░░░░░░░░ 1% · 2h");
});

test("剩余不足 15% 时降级为告警色", () => {
  const view = buildStatus({
    window: windowOf({ usedPercent: 90, remainingTokens: 100 }),
    now: NOW,
    waiting: false,
  });
  assert.equal(view.text, "V2EX █░░░░░░░ 10% · 2h");
  assert.equal(view.level, "low");
});

test("用尽时显示空条与 0%", () => {
  const view = buildStatus({
    window: windowOf({ usedPercent: 100, usedTokens: 1_000, remainingTokens: 0 }),
    now: NOW,
    waiting: false,
  });
  assert.equal(view.text, "V2EX ░░░░░░░░ 0% · 2h");
  assert.equal(view.level, "empty");
});

test("用尽且已排入等待时显示等待中", () => {
  const view = buildStatus({
    window: windowOf({ usedPercent: 100, usedTokens: 1_000, remainingTokens: 0 }),
    now: NOW,
    waiting: true,
  });
  assert.equal(view.text, "V2EX 等待 2h");
  assert.equal(view.level, "waiting");
});

test("额外用量存在时附在状态末尾", () => {
  const view = buildStatus({
    window: windowOf({
      usedPercent: 20,
      usedTokens: 200,
      remainingTokens: 800,
      extraRemainingTokens: 1_200_000,
    }),
    now: NOW,
    waiting: false,
  });
  assert.equal(view.text, "V2EX ██████░░ 80% · 2h · +1.2M");
});

test("详情面板列出窗口用量与重置时间", () => {
  const lines = buildDetails({
    window: windowOf({ usedPercent: 100, usedTokens: 1_000, remainingTokens: 0 }),
    now: NOW,
    waiting: true,
    autoWaitLabel: "已开启（2h 后继续）",
    retryOnErrorLabel: "已关闭",
    proxyLabel: "http://127.0.0.1:37777",
  });
  const text = lines.join("\n");
  assert.match(text, /窗口已用 1K \/ 1K/);
  assert.match(text, /剩余 0（0%）/);
  assert.match(text, /重置 .*（2h 后）/);
  assert.match(text, /正在等待刷新后自动续跑/);
  assert.match(text, /自动续跑：已开启（2h 后继续）/);
  assert.match(text, /上游重试：已关闭/);
  assert.match(text, /查询代理：http:\/\/127\.0\.0\.1:37777/);
});

test("详情面板在无窗口时说明下一条消息开新窗口", () => {
  const lines = buildDetails({
    window: windowOf({ active: false }),
    now: NOW,
    waiting: false,
    autoWaitLabel: "已关闭",
    retryOnErrorLabel: "已开启",
    proxyLabel: "未设置（直连）",
  });
  const text = lines.join("\n");
  assert.match(text, /没有有效窗口/);
  // 两个开关在任何状态下都要看得见，否则「现在到底开没开」就得猜。
  assert.match(text, /自动续跑：已关闭/);
  assert.match(text, /上游重试：已开启/);
  assert.match(text, /查询代理：未设置（直连）/);
});

test("详情面板在无数据时提示刷新", () => {
  const lines = buildDetails({
    window: undefined,
    now: NOW,
    waiting: false,
    autoWaitLabel: "已关闭",
    retryOnErrorLabel: "已关闭",
    proxyLabel: "未设置（直连）",
  });
  assert.match(lines.join("\n"), /\/v2ex refresh/);
});

test("上游故障等待时状态栏说重试，并带上剩余时间", () => {
  const view = buildStatus({
    window: windowOf({ usedPercent: 50, remainingTokens: 500 }),
    now: NOW,
    waiting: true,
    waitReason: "error",
    resumeAt: NOW + 45_000,
  });
  assert.equal(view.text, "V2EX 重试 45s");
  assert.equal(view.level, "waiting");
});

test("上游故障等待时额度还有量，也不显示成百分比", () => {
  const view = buildStatus({
    window: windowOf({ usedPercent: 10, remainingTokens: 900 }),
    now: NOW,
    waiting: true,
    waitReason: "error",
    resumeAt: NOW + 120_000,
  });
  assert.equal(view.text, "V2EX 重试 2m");
});

test("等待时刻以排期为准，不再是窗口重置时间", () => {
  // quota 等待的 resumeAt 含缓冲秒数，比窗口重置略晚一点。
  const view = buildStatus({
    window: windowOf({ usedPercent: 100, usedTokens: 1_000, remainingTokens: 0 }),
    now: NOW,
    waiting: true,
    waitReason: "quota",
    resumeAt: NOW + 3_600_000 + 20_000,
  });
  assert.equal(view.text, "V2EX 等待 1h");
});

test("详情面板会说明上游故障重试的到点时间", () => {
  const lines = buildDetails({
    window: windowOf({ usedPercent: 50, remainingTokens: 500 }),
    now: NOW,
    waiting: true,
    waitReason: "error",
    resumeAt: NOW + 45_000,
    autoWaitLabel: "已开启",
    retryOnErrorLabel: "已开启（45s 后重试）",
    proxyLabel: "未设置（直连）",
  });
  const text = lines.join("\n");
  assert.match(text, /上游故障，45s 后自动重试/);
  assert.match(text, /上游重试：已开启（45s 后重试）/);
  // 额度还有量，就不该出现「配额已用尽」这类误导。
  assert.doesNotMatch(text, /配额已用尽/);
});

test("状态栏尾部接上三个开关的当前状态", () => {
  const view = buildStatus({
    window: windowOf({ usedPercent: 50, remainingTokens: 500 }),
    now: NOW,
    waiting: false,
    toggles: { autoWait: true, retryOnError: false, proxy: true },
  });
  assert.equal(view.text, "V2EX ████░░░░ 50% · 2h | 续跑 开 · 重试 关 · 代理 开");
  assert.equal(view.level, "ok");
  // 分隔符要比段内的 ` · ` 更重，否则一行里全是同一种点，读不出分组。
  const separator = view.segments.find((segment) => segment.text === " | ");
  assert.ok(separator, "配额段与配置段之间少了分隔符");
  assert.equal(separator.tone, "dim");
  // 代理这一项只报开关，不回显地址：状态栏没地方放，地址在 /v2ex 面板里看。
  assert.doesNotMatch(view.text, /:\d{2,}/);
});

test("开关全关也逐个显示，不省略", () => {
  const view = buildStatus({
    window: windowOf({ usedPercent: 50, remainingTokens: 500 }),
    now: NOW,
    waiting: false,
    toggles: { autoWait: false, retryOnError: false, proxy: false },
  });
  assert.equal(view.text, "V2EX ████░░░░ 50% · 2h | 续跑 关 · 重试 关 · 代理 关");
});

test("配置段不参与状态色，也没带进只问配额的调用", () => {
  const view = buildStatus({
    window: windowOf({ usedPercent: 100, usedTokens: 1_000, remainingTokens: 0 }),
    now: NOW,
    waiting: false,
    toggles: { autoWait: true, retryOnError: true, proxy: true },
  });
  assert.equal(view.level, "empty", "开关开着不该把用尽的状态色改掉");

  const plain = buildStatus({
    window: windowOf({ usedPercent: 50, remainingTokens: 500 }),
    now: NOW,
    waiting: false,
  });
  assert.equal(plain.text, "V2EX ████░░░░ 50% · 2h", "没传开关时不该凭空多出一段");
});

test("等待态与故障重试态同样带开关状态", () => {
  const waiting = buildStatus({
    window: windowOf({ usedPercent: 100, usedTokens: 1_000, remainingTokens: 0 }),
    now: NOW,
    waiting: true,
    waitReason: "quota",
    toggles: { autoWait: true, retryOnError: false, proxy: true },
  });
  assert.equal(waiting.text, "V2EX 等待 2h | 续跑 开 · 重试 关 · 代理 开");

  const retrying = buildStatus({
    window: windowOf({ usedPercent: 50, remainingTokens: 500 }),
    now: NOW,
    waiting: true,
    waitReason: "error",
    resumeAt: NOW + 45_000,
    toggles: { autoWait: false, retryOnError: true, proxy: false },
  });
  assert.equal(retrying.text, "V2EX 重试 45s | 续跑 关 · 重试 开 · 代理 关");
});
