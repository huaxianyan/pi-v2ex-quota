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
