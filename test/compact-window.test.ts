import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CompactWindow, parseWindow } from "../src/compact-window.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

test("窗口大小支持整数和 k、m 单位", () => {
  for (const [input, expected] of [
    ["400000", 400_000], ["400k", 400_000], ["0.4m", 400_000], ["1M", 1_000_000],
    ["0", undefined], ["-1", undefined], ["400kb", undefined], ["0.0001k", undefined],
  ] as const) assert.equal(parseWindow(input), expected);
});

test("压缩失败后恢复原始窗口，手动启用才重新应用目标窗口", async () => {
  const original = { provider: "v2ex", id: "fixture", contextWindow: 1_000_000 };
  const ctx = { model: original } as unknown as ExtensionContext;
  const pi = {
    getSettings: () => ({ compaction: { reserveTokens: 136_000, keepRecentTokens: 20_000 } }),
    getCommands: () => [{ name: "smart-compact" }],
    setModel: async (model: typeof original) => { ctx.model = model as ExtensionContext["model"]; return true; },
  } as unknown as ExtensionAPI;
  const window = new CompactWindow(pi);
  const config = { ...DEFAULT_CONFIG, compactWindowEnabled: true };
  await window.sync(ctx, config);
  assert.equal(ctx.model?.contextWindow, 400_000);
  await window.pause(ctx);
  assert.equal(ctx.model?.contextWindow, 1_000_000);
  await window.sync(ctx, config);
  assert.equal(ctx.model?.contextWindow, 1_000_000);
  window.resume();
  await window.sync(ctx, config);
  assert.equal(ctx.model?.contextWindow, 400_000);
  assert.equal(original.contextWindow, 1_000_000);
});

test("状态栏标签与详情说明随开关、暂停和启用变化", async () => {
  const original = { provider: "v2ex", id: "fixture", contextWindow: 1_000_000 };
  const ctx = { model: original } as unknown as ExtensionContext;
  const pi = {
    getSettings: () => ({ compaction: { reserveTokens: 136_000, keepRecentTokens: 20_000 }, smartCompact: { autoTrigger: true } }),
    getCommands: () => [{ name: "smart-compact" }],
    setModel: async (model: typeof original) => { ctx.model = model as ExtensionContext["model"]; return true; },
  } as unknown as ExtensionAPI;
  const window = new CompactWindow(pi);
  const off = { ...DEFAULT_CONFIG, compactWindowEnabled: false };
  const on = { ...DEFAULT_CONFIG, compactWindowEnabled: true };

  assert.equal(window.label(off), "关");
  assert.equal(window.detail(off), "已关闭");

  window.resume();
  await window.sync(ctx, on);
  assert.equal(window.label(on), "400K");
  assert.equal(window.detail(on), "400,000 tokens");

  await window.pause(ctx);
  assert.equal(window.label(on), "暂停");
  assert.equal(window.detail(on), "已暂停，/v2ex compact on 可重试");

  // 开关打开但还没轮到同步：说的是「待启用」，而不是「已开启」。
  assert.equal(window.label(on), "暂停");
  window.resume();
  assert.equal(window.label(on), "待启用");
  assert.equal(window.detail(on), "待启用");
});

test("状态面板报出 Smart Compact 自动开关的实际状态", async () => {
  const ctx = { model: { provider: "v2ex", id: "fixture", contextWindow: 1_000_000 } } as unknown as ExtensionContext;
  const withAuto = (autoTrigger: boolean) => ({
    getSettings: () => ({ compaction: { reserveTokens: 136_000, keepRecentTokens: 20_000 }, smartCompact: { autoTrigger } }),
    getCommands: () => [{ name: "smart-compact" }],
    setModel: async () => true,
  }) as unknown as ExtensionAPI;

  const off = new CompactWindow(withAuto(false)).status(ctx, DEFAULT_CONFIG);
  assert.match(off, /Smart Compact 自动压缩：已关闭/);
  assert.match(off, /\/smart-compact settings/);

  const on = new CompactWindow(withAuto(true)).status(ctx, DEFAULT_CONFIG);
  assert.match(on, /Smart Compact 自动压缩：已开启，最低占比 60%/);
});
