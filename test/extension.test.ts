import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig, saveConfig } from "../src/config.ts";

const STATUS_KEY = "v2ex-quota";
const roots: string[] = [];

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

interface Harness {
  dir: string;
  ctx: ReturnType<typeof makeCtx>["ctx"];
  statuses: Map<string, string>;
  widgets: Map<string, string[]>;
  notifications: Array<{ message: string; type: string }>;
  abortCount: () => number;
  sent: string[];
  commands: Map<string, { description?: string; handler: CommandHandler }>;
  events: Set<string>;
  emit: (event: string, payload: unknown) => Promise<void>;
  run: (name: string, args: string) => Promise<void>;
}

function makeCtx(cwd: string) {
  const statuses = new Map<string, string>();
  const widgets = new Map<string, string[]>();
  const notifications: Array<{ message: string; type: string }> = [];
  let aborts = 0;

  const ctx = {
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus(key: string, text: string | undefined) {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
      setWidget(key: string, content: string[] | undefined) {
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, content);
      },
      notify(message: string, type?: string) {
        notifications.push({ message, type: type ?? "info" });
      },
    },
    mode: "tui",
    cwd,
    isIdle: () => true,
    signal: undefined as AbortSignal | undefined,
    abort() {
      aborts += 1;
    },
  };

  return { ctx, statuses, widgets, notifications, abortCount: () => aborts };
}

const factory = (await import("../src/index.ts")).default;

/** 每个用例一份全新的 agent 目录与假 pi，避免用例之间互相污染。 */
async function startExtension(config: Record<string, unknown>): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "pi-v2ex-ext-"));
  roots.push(dir);
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        v2ex: { baseUrl: "https://edge.v2ex.com/chat/v1", apiKey: "test-key" },
      },
    }),
  );
  saveConfig(dir, { pollSeconds: 3600, ...config });
  process.env["PI_CODING_AGENT_DIR"] = dir;

  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { description?: string; handler: CommandHandler }>();
  const sent: string[] = [];

  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerCommand(name: string, options: { description?: string; handler: CommandHandler }) {
      commands.set(name, options);
    },
    sendUserMessage(content: unknown) {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  };

  factory(pi as unknown as ExtensionAPI);

  const harness = makeCtx("E:/dev/pi");
  return {
    dir,
    ...harness,
    sent,
    commands,
    events: new Set(handlers.keys()),
    async emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, harness.ctx);
    },
    async run(name: string, args: string) {
      const command = commands.get(name);
      assert.ok(command, `未注册命令 ${name}`);
      await command.handler(args, harness.ctx);
    },
  };
}

/** 假配额接口：余额与重置时间都可动态变化，用来演出「刷新前后」。 */
function stubQuota(
  remaining: () => number,
  resetAtMs: () => number,
  active: () => boolean = () => true,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const total = 8_000_000;
    const left = remaining();
    return new Response(
      JSON.stringify({
        success: true,
        result: {
          active: active(),
          total_tokens: total,
          used_tokens: total - left,
          remaining_tokens: left,
          used_percent: ((total - left) / total) * 100,
          period_start: Math.floor(resetAtMs() / 1000) - 18_000,
          period_end: Math.floor(resetAtMs() / 1000),
          extra_usage: { remaining_tokens: 0 },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** 配额接口直接不可用，用来验证「查不到就不擅自排队」。 */
function failingQuota(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** 读落盘的等待计划；没有就返回 undefined。 */
function readPlan(dir: string): { resumeAt: number; attempts: number; prompt?: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "v2ex-quota-pending.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function exhaustedResponse(resetAtMs: number) {
  return {
    type: "after_provider_response",
    status: 429,
    headers: {
      "x-ai-chat-token-limit": "8000000",
      "x-ai-chat-token-remaining": "0",
      "x-ai-chat-token-reset": String(Math.floor(resetAtMs / 1000)),
      "x-ai-chat-extra-usage-remaining": "0",
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("扩展注册命令并订阅配额相关事件", async () => {
  const ext = await startExtension({});
  assert.ok(ext.commands.has("v2ex"));
  for (const event of [
    "session_start",
    "session_shutdown",
    "after_provider_response",
    "message_end",
    "agent_settled",
    "before_agent_start",
    "agent_end",
  ]) {
    assert.ok(ext.events.has(event), `缺少事件订阅：${event}`);
  }
});

test("session_start 后状态栏显示配额", async () => {
  const restore = stubQuota(
    () => 8_000_000,
    () => Date.now() + 3_600_000,
  );
  try {
    const ext = await startExtension({ status: true });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(80);
    const status = ext.statuses.get(STATUS_KEY);
    assert.ok(status, "状态栏没有写入配额");
    assert.match(status, /^v2ex 100% · /);
  } finally {
    restore();
  }
});

test("配额用尽时立刻中止本轮并提示", async () => {
  const restore = stubQuota(
    () => 0,
    () => Date.now() + 600_000,
  );
  try {
    const ext = await startExtension({ autoWait: false });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await ext.emit("after_provider_response", exhaustedResponse(Date.now() + 600_000));
    await sleep(80);

    assert.equal(ext.abortCount(), 1);
    assert.ok(ext.notifications.some((item) => item.message.includes("配额已用尽")));
    assert.ok(ext.notifications.some((item) => item.message.includes("wait on")));
    assert.equal(ext.sent.length, 0, "未开启自动续跑时不该注入消息");
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^v2ex 0% · /);
  } finally {
    restore();
  }
});

test("每分钟限流的 429 不触发中止", async () => {
  const restore = stubQuota(
    () => 4_000_000,
    () => Date.now() + 600_000,
  );
  try {
    const ext = await startExtension({});
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await ext.emit("after_provider_response", {
      type: "after_provider_response",
      status: 429,
      headers: { "x-ai-chat-token-limit": "8000000", "x-ai-chat-token-remaining": "4000000" },
    });
    await sleep(50);
    assert.equal(ext.abortCount(), 0);
  } finally {
    restore();
  }
});

test("开启自动续跑后，窗口刷新即注入续跑消息", async () => {
  let remaining = 0;
  const restore = stubQuota(
    () => remaining,
    () => Date.now() - 60_000,
  );
  try {
    const ext = await startExtension({ autoWait: true, resumeBufferSeconds: 0 });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await ext.emit("after_provider_response", exhaustedResponse(Date.now() - 60_000));
    assert.equal(ext.abortCount(), 1);

    remaining = 8_000_000;
    await ext.emit("agent_settled", { type: "agent_settled" });
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^v2ex 等待 /);

    await sleep(1_500);
    assert.equal(ext.sent.length, 1, "没有注入续跑消息");
    assert.equal(ext.sent[0], "配额已刷新，继续完成任务。");
    assert.ok(ext.notifications.some((item) => item.message.includes("已刷新")));
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^v2ex 100% · /);
  } finally {
    restore();
  }
});

test("到期仍未恢复时按上限停止等待", async () => {
  const restore = stubQuota(
    () => 0,
    () => Date.now() + 1_500,
  );
  try {
    const ext = await startExtension({
      autoWait: true,
      resumeBufferSeconds: 0,
      maxResumeAttempts: 1,
    });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await ext.emit("after_provider_response", exhaustedResponse(Date.now() + 1_500));
    await ext.emit("agent_settled", { type: "agent_settled" });

    await sleep(5_000);
    assert.equal(ext.sent.length, 0);
    assert.ok(
      ext.notifications.some((item) => item.message.includes("仍未恢复")),
      `未按上限停止，通知为：${ext.notifications.map((item) => item.message).join(" / ")}`,
    );
  } finally {
    restore();
  }
});

test("用户自己发消息会取消等待中的自动续跑", async () => {
  const restore = stubQuota(
    () => 0,
    () => Date.now() + 3_600_000,
  );
  try {
    const ext = await startExtension({ autoWait: true });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await ext.emit("after_provider_response", exhaustedResponse(Date.now() + 3_600_000));
    await ext.emit("agent_settled", { type: "agent_settled" });
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^v2ex 等待 /);

    await ext.emit("before_agent_start", { type: "before_agent_start", prompt: "换个任务" });
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^v2ex 0% · /);

    await sleep(60);
    assert.equal(ext.sent.length, 0);

    const cancelList = ext.notifications.map((item) => item.message).join(" / ");
    assert.ok(!cancelList.includes("已刷新"), `不该注入续跑：${cancelList}`);
  } finally {
    restore();
  }
});

test("/v2ex start 在配额已用尽时立即排入等待", async () => {
  let remaining = 0;
  const restore = stubQuota(() => remaining, () => Date.now() + 1_200);
  try {
    const ext = await startExtension({ autoWait: true, resumeBufferSeconds: 0 });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(60);

    // 关键差异：会话里没有任何 agent 轮次，纯粹靠命令排队。
    await ext.run("v2ex", "start");
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^v2ex 等待 /);
    assert.ok(
      ext.notifications.some((item) => item.message.includes("已排入自动续跑")),
      `未提示排期：${ext.notifications.map((item) => item.message).join(" / ")}`,
    );
    assert.equal(ext.sent.length, 0, "排期时不该注入消息");
    assert.ok(readPlan(ext.dir), "等待计划没有落盘");

    remaining = 8_000_000;
    await sleep(2_200);
    assert.equal(ext.sent.length, 1, `没有注入续跑消息：${JSON.stringify(ext.sent)}`);
    assert.equal(ext.sent[0], "配额已刷新，继续完成任务。");
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^v2ex 100% · /);
    assert.equal(readPlan(ext.dir), undefined, "续跑后等待计划该被清掉");
  } finally {
    restore();
  }
});

test("/v2ex start 的提示词随等待计划落盘，并决定续跑注入什么", async () => {
  let remaining = 0;
  const restore = stubQuota(() => remaining, () => Date.now() + 1_200);
  try {
    const ext = await startExtension({ autoWait: true, resumeBufferSeconds: 0 });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(60);

    await ext.run("v2ex", "start 接着把状态栏对齐修掉");
    assert.equal(readPlan(ext.dir)?.prompt, "接着把状态栏对齐修掉");

    remaining = 8_000_000;
    await sleep(2_200);
    assert.deepEqual(ext.sent, ["接着把状态栏对齐修掉"]);
  } finally {
    restore();
  }
});

test("/v2ex start 在仍有额度时不排等待", async () => {
  const restore = stubQuota(
    () => 4_000_000,
    () => Date.now() + 3_600_000,
  );
  try {
    const ext = await startExtension({ autoWait: true });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(60);

    await ext.run("v2ex", "start");
    assert.ok(
      ext.notifications.some((item) => item.message.includes("当前仍有额度")),
      `未说明仍有额度：${ext.notifications.map((item) => item.message).join(" / ")}`,
    );
    assert.equal(readPlan(ext.dir), undefined, "有用量时不该排等待");
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^v2ex 50% · /);
  } finally {
    restore();
  }
});

test("/v2ex start 在没有活跃窗口时不排等待", async () => {
  const restore = stubQuota(
    () => 0,
    () => 0,
    () => false,
  );
  try {
    const ext = await startExtension({ autoWait: true });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(60);

    await ext.run("v2ex", "start");
    assert.ok(
      ext.notifications.some((item) => item.message.includes("没有活跃配额窗口")),
      `未说明窗口状态：${ext.notifications.map((item) => item.message).join(" / ")}`,
    );
    assert.equal(readPlan(ext.dir), undefined, "无窗口时不该排等待");
  } finally {
    restore();
  }
});

test("/v2ex start 在已有等待时只提示，不覆盖既有计划", async () => {
  const restore = stubQuota(
    () => 0,
    () => Date.now() + 3_600_000,
  );
  try {
    const ext = await startExtension({ autoWait: true });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(60);

    await ext.run("v2ex", "start");
    const first = readPlan(ext.dir);
    assert.ok(first, "第一次 start 就该排上等待");

    await ext.run("v2ex", "start 换个提示词");
    const second = readPlan(ext.dir);
    assert.equal(second?.resumeAt, first.resumeAt, "重复 start 不该改排期时刻");
    assert.equal(second?.prompt, undefined, "重复 start 不该改已有计划的提示词");
    assert.ok(ext.notifications.some((item) => item.message.includes("已在等待中")));
  } finally {
    restore();
  }
});

test("/v2ex start 会顺带打开自动续跑开关", async () => {
  const restore = stubQuota(
    () => 0,
    () => Date.now() + 3_600_000,
  );
  try {
    const ext = await startExtension({ autoWait: false });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(60);
    assert.equal(loadConfig(ext.dir).autoWait, false);

    await ext.run("v2ex", "start");
    assert.equal(loadConfig(ext.dir).autoWait, true, "手动排队后开关该是开着的");
    assert.ok(
      ext.notifications.some((item) => item.message.includes("自动续跑开关已一并开启")),
      `未说明开关变化：${ext.notifications.map((item) => item.message).join(" / ")}`,
    );
  } finally {
    restore();
  }
});

test("/v2ex start 在配额查询失败时不排等待", async () => {
  const restore = failingQuota();
  try {
    const ext = await startExtension({ autoWait: true });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(60);

    await ext.run("v2ex", "start");
    assert.ok(
      ext.notifications.some((item) => item.message.includes("配额查询失败")),
      `未报查询失败：${ext.notifications.map((item) => item.message).join(" / ")}`,
    );
    assert.equal(readPlan(ext.dir), undefined, "查不到额度时不该擅自排队");
  } finally {
    restore();
  }
});

test("/v2ex start 在非交互模式下不排等待", async () => {
  const restore = stubQuota(
    () => 0,
    () => Date.now() + 3_600_000,
  );
  try {
    const ext = await startExtension({ autoWait: true });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(60);

    // print/json 这类一次性运行结束后会销毁 runner，排了等待也没人能续跑。
    ext.ctx.mode = "json";
    await ext.run("v2ex", "start");
    assert.equal(readPlan(ext.dir), undefined, "非交互模式下不该排等待");
  } finally {
    restore();
  }
});
