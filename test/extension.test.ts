import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect as netConnect } from "node:net";
import type { AddressInfo } from "node:net";
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
  /** 状态栏写过的每一版文案，用来断言「刷了多少次」这类随时间发生的事。 */
  statusLog: string[];
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
  const statusLog: string[] = [];
  const widgets = new Map<string, string[]>();
  const notifications: Array<{ message: string; type: string }> = [];
  let aborts = 0;

  const ctx = {
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus(key: string, text: string | undefined) {
        if (text === undefined) {
          statuses.delete(key);
          return;
        }
        statuses.set(key, text);
        statusLog.push(text);
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

  return { ctx, statuses, statusLog, widgets, notifications, abortCount: () => aborts };
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
  /** 让响应慢下来，用来撑开「已到点但续跑复核还没回来」的那一小段窗口。 */
  delayMs: () => number = () => 0,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const wait = delayMs();
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
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
function readPlan(
  dir: string,
): { resumeAt: number; attempts: number; prompt?: string; reason?: string } | undefined {
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

/**
 * 等某个条件成立，比固定 sleep 更贴题：断言的是「那一刻真的到了」，
 * 而不是「我猜它这时候该到了」。
 */
async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(25);
  }
  return check();
}

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
    assert.match(status, /^V2EX ████████ 100% · /);
  } finally {
    restore();
  }
});

test("改开关后状态栏立刻反映，不等下一次轮询", async () => {
  const restore = stubQuota(
    () => 8_000_000,
    () => Date.now() + 3_600_000,
  );
  try {
    const ext = await startExtension({ status: true });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(80);
    // 测试台的轮询间隔是 3600 秒，所以这一行只可能由开关自己触发刷新。
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /续跑 关 · 重试 关 · 代理 关$/);

    await ext.run("v2ex", "wait on");
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /续跑 开 · 重试 关 · 代理 关$/);

    await ext.run("v2ex", "retry on");
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /续跑 开 · 重试 开 · 代理 关$/);

    await ext.run("v2ex", "wait off");
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /续跑 关 · 重试 开 · 代理 关$/);
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
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^V2EX ░░░░░░░░ 0% · /);
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
    // 假接口把窗口重置设在 60 秒前，排期时刻已经是过去时，所以状态栏说的是「即将开始」。
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^V2EX 即将开始 \| /);

    await sleep(1_500);
    assert.equal(ext.sent.length, 1, "没有注入续跑消息");
    assert.equal(ext.sent[0], "配额已刷新，继续完成任务。");
    assert.ok(ext.notifications.some((item) => item.message.includes("已刷新")));
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^V2EX ████████ 100% · /);
  } finally {
    restore();
  }
});

test("最后一分钟里逐秒走，归零后改说即将开始", async () => {
  let delayMs = 0;
  const restore = stubQuota(
    () => 0,
    () => Date.now() + 12_000,
    () => true,
    () => delayMs,
  );
  try {
    const ext = await startExtension({ autoWait: true, resumeBufferSeconds: 0 });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(80);
    await ext.emit("after_provider_response", exhaustedResponse(Date.now() + 12_000));
    await ext.emit("agent_settled", { type: "agent_settled" });

    // 只剩十几秒，状态栏该已经按秒走。会话的轮询间隔是 3600 秒，所以后面每一个
    // 新的秒数都只可能来自倒计时自己的定时器。
    const secondsSeen = (): Set<string> =>
      new Set(
        ext.statusLog
          .map((text) => /^V2EX 等待 (\d+)s \|/.exec(text)?.[1])
          .filter((value) => value !== undefined),
      );
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^V2EX 等待 \d{1,2}s \| /);
    assert.ok(
      await waitFor(() => secondsSeen().size >= 2, 12_000),
      `倒计时没有逐秒走，只见到 ${[...secondsSeen()].join("/") || "(无)"}`,
    );

    // 到点后的额度复核故意放慢，好让「即将开始」有一段稳定的可观测窗口。
    delayMs = 3_000;
    assert.ok(
      await waitFor(() => (ext.statuses.get(STATUS_KEY) ?? "").startsWith("V2EX 即将开始"), 15_000),
      `归零后没有换成即将开始：${ext.statuses.get(STATUS_KEY)}`,
    );
  } finally {
    restore();
  }
});

test("到点那个瞬间就说即将开始，不等复核回来", async () => {
  // 排期之后让复核一直挂着不返回，模拟「已经到点、正在复核」的那一段；状态栏不该停在 0s。
  let armed = false;
  const restore = stubQuota(
    () => 0,
    () => Date.now() + 3_000,
    () => true,
    () => (armed ? 3_000 : 0),
  );
  try {
    const ext = await startExtension({ autoWait: true, resumeBufferSeconds: 0 });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(80);
    await ext.emit("after_provider_response", exhaustedResponse(Date.now() + 3_000));
    await ext.emit("agent_settled", { type: "agent_settled" });
    armed = true;

    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^V2EX (等待 \ds|即将开始) \| /);
    assert.ok(
      await waitFor(() => (ext.statuses.get(STATUS_KEY) ?? "").startsWith("V2EX 即将开始"), 12_000),
      `到点后没有说即将开始：${ext.statuses.get(STATUS_KEY)}`,
    );
    // 倒计时文案里不该再出现 0s。
    assert.doesNotMatch(ext.statuses.get(STATUS_KEY) ?? "", /等待 0s/);
  } finally {
    restore();
  }
});

test("等待排在一分钟以外时不逐秒刷新", async () => {
  // 固定基准时刻：假接口每次应答都报同一个窗口重置时间，余量才确定。
  const base = Date.now();
  const restore = stubQuota(
    () => 0,
    () => base + 180_000,
  );
  try {
    const ext = await startExtension({ autoWait: true, resumeBufferSeconds: 0 });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(80);
    await ext.run("v2ex", "start");

    const waitingWrites = (): string[] =>
      ext.statusLog.filter((text) => text.startsWith("V2EX 等待 "));
    assert.equal(waitingWrites().length, 1, "排期那一刻该写一次等待状态");
    assert.match(waitingWrites()[0] ?? "", /^V2EX 等待 \d+m \| /, "还差几分钟时按分钟报");

    // 到点前三分钟，逐秒刷屏没有意义：这几秒里除了排期那次，不该再有写入。
    await sleep(3_000);
    assert.equal(
      waitingWrites().length,
      1,
      `离到点还早却刷新了：${waitingWrites().join(" / ")}`,
    );
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
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^V2EX 等待 /);

    await ext.emit("before_agent_start", { type: "before_agent_start", prompt: "换个任务" });
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^V2EX ░░░░░░░░ 0% · /);

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
  // 留 2.5 秒：既落在最后一分钟里（状态栏该按秒报），又不会近到被判成「即将开始」，
  // 免得这条验排期的用例挂在倒计时文案的边界上。
  const restore = stubQuota(() => remaining, () => Date.now() + 2_500);
  try {
    const ext = await startExtension({ autoWait: true, resumeBufferSeconds: 0 });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(60);

    // 关键差异：会话里没有任何 agent 轮次，纯粹靠命令排队。
    await ext.run("v2ex", "start");
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^V2EX 等待 2s \| /);
    assert.ok(
      ext.notifications.some((item) => item.message.includes("已排入自动续跑")),
      `未提示排期：${ext.notifications.map((item) => item.message).join(" / ")}`,
    );
    assert.equal(ext.sent.length, 0, "排期时不该注入消息");
    assert.ok(readPlan(ext.dir), "等待计划没有落盘");

    remaining = 8_000_000;
    await sleep(3_200);
    assert.equal(ext.sent.length, 1, `没有注入续跑消息：${JSON.stringify(ext.sent)}`);
    assert.equal(ext.sent[0], "配额已刷新，继续完成任务。");
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^V2EX ████████ 100% · /);
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
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^V2EX ████░░░░ 50% · /);
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
    // 开关状态要当场反映到状态栏上，否则「刚才那下到底改没改」还得再敲一条命令确认。
    const status = ext.statuses.get(STATUS_KEY) ?? "";
    assert.match(status, /\| 续跑 开 · 重试 关 · 代理 关/, `状态栏没带上配置段：${status}`);
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

/** pi 把上游故障压成一句 errorMessage，这里照原样构造。 */
function providerError(text: string) {
  return {
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: text },
  };
}

/** 实测原话：一次 Cloudflare 522 断掉整轮会话，pi 没有重试。 */
const BAD_GATEWAY = "522 status code (no body)";
const RESUME_PROMPT = "配额已刷新，继续完成任务。";

test("上游 522 在开启重试后于本轮结束时刻排期", async () => {
  const restore = stubQuota(
    () => 4_000_000,
    () => Date.now() + 3_600_000,
  );
  try {
    const ext = await startExtension({ retryOnError: true, errorRetrySeconds: 60 });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(60);

    await ext.emit("message_end", providerError(BAD_GATEWAY));
    assert.equal(readPlan(ext.dir), undefined, "message_end 阶段不该抢在收尾前排期");

    await ext.emit("agent_settled", { type: "agent_settled" });
    const plan = readPlan(ext.dir);
    assert.ok(plan, "没有排入重试");
    assert.equal(plan.reason, "error");
    const gap = plan.resumeAt - Date.now();
    assert.ok(gap > 50_000 && gap < 70_000, `首次退避该是 errorRetrySeconds，实际 ${gap}ms`);
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^V2EX 重试 /);

    const notes = ext.notifications.map((item) => item.message).join(" / ");
    assert.ok(notes.includes("HTTP 522"), `通知里没说明故障：${notes}`);
    assert.equal(ext.sent.length, 0, "排期时不该注入消息");
  } finally {
    restore();
  }
});

test("关闭上游重试时只提示怎么开，不排期", async () => {
  const restore = stubQuota(
    () => 4_000_000,
    () => Date.now() + 3_600_000,
  );
  try {
    const ext = await startExtension({ retryOnError: false });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(60);

    await ext.emit("message_end", providerError(BAD_GATEWAY));
    await ext.emit("agent_settled", { type: "agent_settled" });

    assert.equal(readPlan(ext.dir), undefined, "开关关着就不该排期");
    assert.equal(ext.sent.length, 0);
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^V2EX ████░░░░ 50% · /);
    assert.ok(
      ext.notifications.some((item) => item.message.includes("/v2ex retry on")),
      "没告诉用户怎么开启",
    );
  } finally {
    restore();
  }
});

test("上游故障到点续跑，连续故障时退避逐次翻倍", async () => {
  const restore = stubQuota(
    () => 4_000_000,
    () => Date.now() + 3_600_000,
  );
  try {
    const ext = await startExtension({
      retryOnError: true,
      errorRetrySeconds: 5,
      maxErrorRetries: 3,
    });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(60);

    await ext.emit("message_end", providerError(BAD_GATEWAY));
    await ext.emit("agent_settled", { type: "agent_settled" });
    assert.ok(readPlan(ext.dir), "第一次故障该排上重试");

    await sleep(6_000);
    assert.deepEqual(ext.sent, [RESUME_PROMPT], "到点没有注入续跑消息");

    // 续跑又撞上同一个故障：这一轮该按翻倍后的间隔排。
    await ext.emit("message_end", providerError(BAD_GATEWAY));
    await ext.emit("agent_settled", { type: "agent_settled" });
    const second = readPlan(ext.dir);
    assert.ok(second, "第二次故障该继续排期");
    const gap = second.resumeAt - Date.now();
    assert.ok(gap > 8_000 && gap < 16_000, `第二次退避该翻倍到约 10s，实际 ${gap}ms`);
    assert.ok(
      ext.notifications.some((item) => item.message.includes("第 2 次")),
      `通知里没标次数：${ext.notifications.map((item) => item.message).join(" / ")}`,
    );
  } finally {
    restore();
  }
});

test("上游连续故障达到上限后停止自动重试", async () => {
  const restore = stubQuota(
    () => 4_000_000,
    () => Date.now() + 3_600_000,
  );
  try {
    const ext = await startExtension({
      retryOnError: true,
      errorRetrySeconds: 5,
      maxErrorRetries: 1,
    });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(60);

    await ext.emit("message_end", providerError(BAD_GATEWAY));
    await ext.emit("agent_settled", { type: "agent_settled" });
    assert.ok(readPlan(ext.dir), "第一次故障该排上重试");

    await sleep(6_000);
    assert.equal(ext.sent.length, 1, "到点该续跑一次");

    await ext.emit("message_end", providerError(BAD_GATEWAY));
    await ext.emit("agent_settled", { type: "agent_settled" });

    assert.equal(readPlan(ext.dir), undefined, "到上限后不该再排期");
    assert.ok(
      ext.notifications.some((item) => item.message.includes("已停止自动重试")),
      `没提示停止：${ext.notifications.map((item) => item.message).join(" / ")}`,
    );
  } finally {
    restore();
  }
});

test("落盘的上游重试计划会在下次会话被恢复", async () => {
  const restore = stubQuota(
    () => 4_000_000,
    () => Date.now() + 3_600_000,
  );
  try {
    const ext = await startExtension({ retryOnError: true });
    writeFileSync(
      join(ext.dir, "v2ex-quota-pending.json"),
      `${JSON.stringify(
        { resumeAt: Date.now() - 1_000, attempts: 0, cwd: "E:/dev/pi", reason: "error" },
        null,
        2,
      )}\n`,
    );
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    // 恢复时会留 2 秒余量，免得和会话初始化抢时序。
    await sleep(3_500);
    assert.deepEqual(ext.sent, [RESUME_PROMPT], "恢复后到点没有续跑");
    assert.equal(readPlan(ext.dir), undefined, "续跑后等待计划该被清掉");
  } finally {
    restore();
  }
});

test("关掉上游重试后，落盘的重试计划不会被恢复", async () => {
  const restore = stubQuota(
    () => 4_000_000,
    () => Date.now() + 3_600_000,
  );
  try {
    const ext = await startExtension({ retryOnError: false });
    writeFileSync(
      join(ext.dir, "v2ex-quota-pending.json"),
      `${JSON.stringify(
        { resumeAt: Date.now() + 3_600_000, attempts: 0, cwd: "E:/dev/pi", reason: "error" },
        null,
        2,
      )}\n`,
    );
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(200);
    assert.equal(readPlan(ext.dir), undefined, "开关关着就不该恢复计划");
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^V2EX ████░░░░ 50% · /);
    assert.equal(ext.sent.length, 0);
  } finally {
    restore();
  }
});

/**
 * 本机假配额服务 + 只做转发的 CONNECT 代理。
 *
 * 用来验证「配了代理之后，扩展的查询真的从代理出去了」——
 * 光断言配置落盘证明不了这一点，那只能说明文件写对了。
 */
async function startProxyChain(): Promise<{
  targetPort: number;
  proxyPort: number;
  connects: string[];
  close: () => Promise<void>;
}> {
  const target = createHttpServer((_req, res) => {
    const now = Math.floor(Date.now() / 1000);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        result: {
          active: true,
          total_tokens: 8_000_000,
          used_tokens: 4_000_000,
          remaining_tokens: 4_000_000,
          used_percent: 50,
          period_start: now - 1_000,
          period_end: now + 3_600,
          extra_usage: { remaining_tokens: 0 },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
  const targetPort = (target.address() as AddressInfo).port;

  const connects: string[] = [];
  const proxy = createHttpServer((_req, res) => {
    res.writeHead(400).end("只接受 CONNECT");
  });
  proxy.on("connect", (req, clientSocket, head) => {
    connects.push(req.url ?? "");
    const upstream = netConnect(targetPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
  const proxyPort = (proxy.address() as AddressInfo).port;

  return {
    targetPort,
    proxyPort,
    connects,
    async close() {
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  };
}

test("/v2ex proxy 设置后，配额查询真的从代理走", async () => {
  const chain = await startProxyChain();
  try {
    const ext = await startExtension({
      baseUrl: `http://127.0.0.1:${chain.targetPort}`,
      apiKey: "k",
    });
    await ext.emit("session_start", { type: "session_start", reason: "startup" });
    await sleep(80);
    // 没配代理时是直连，代理这边不该有任何记录。
    assert.deepEqual(chain.connects, [], "没配代理就不该走代理");
    assert.match(ext.statuses.get(STATUS_KEY) ?? "", /^V2EX ████░░░░ 50% · /);

    // 只写主机端口 —— 协议由探测决定，探测通了才认这个设置。
    await ext.run("v2ex", `proxy 127.0.0.1:${chain.proxyPort}`);
    assert.equal(
      loadConfig(ext.dir).proxy,
      `http://127.0.0.1:${chain.proxyPort}`,
      "探测出来的协议该写回配置，下次就不必再试",
    );
    // 一次是探测建的隧道，一次是设置后的立即查询。
    assert.deepEqual(
      chain.connects,
      [`127.0.0.1:${chain.targetPort}`, `127.0.0.1:${chain.targetPort}`],
      "设置后没走代理",
    );
    assert.ok(
      ext.notifications.some((item) => item.message.includes("连接正常")),
      `没报连接正常：${ext.notifications.map((item) => item.message).join(" / ")}`,
    );
    // 状态栏只报开关，不回显地址。
    const withProxy = ext.statuses.get(STATUS_KEY) ?? "";
    assert.ok(withProxy.includes("代理 开"), `状态栏没显示代理已开：${withProxy}`);
    assert.doesNotMatch(withProxy, new RegExp(String(chain.proxyPort)), "状态栏不该出现代理端口");

    await ext.run("v2ex", "proxy off");
    assert.equal(loadConfig(ext.dir).proxy, "");
    assert.equal(chain.connects.length, 2, "关掉代理后不该再走代理");
    assert.match(
      ext.statuses.get(STATUS_KEY) ?? "",
      /代理 关/,
      "关掉代理后状态栏该回到「关」",
    );
  } finally {
    await chain.close();
  }
});

test("/v2ex proxy 拒绝认不出的地址与连不通的地址，且不动已有配置", async () => {
  const ext = await startExtension({ proxy: "http://127.0.0.1:1" });

  // 认不出的协议：当场告知，不静默直连也不静默存下。
  await ext.run("v2ex", "proxy https://127.0.0.1:8443");
  assert.equal(loadConfig(ext.dir).proxy, "http://127.0.0.1:1", "非法值不该覆盖已有配置");
  assert.ok(
    ext.notifications.some((item) => item.message.includes("无法识别")),
    `没提示地址非法：${ext.notifications.map((item) => item.message).join(" / ")}`,
  );

  // 地址格式没问题但三种协议都连不通：同样算设置失败。
  await ext.run("v2ex", "proxy 127.0.0.1:1");
  assert.equal(loadConfig(ext.dir).proxy, "http://127.0.0.1:1", "连不通的地址不该写进配置");
  assert.ok(
    ext.notifications.some((item) => item.message.includes("设置失败")),
    `没提示设置失败：${ext.notifications.map((item) => item.message).join(" / ")}`,
  );

  // 不带参数就是把当前值报出来。
  await ext.run("v2ex", "proxy");
  assert.ok(
    ext.notifications.some((item) => item.message.includes("查询代理：http://127.0.0.1:1")),
    `没报出当前代理：${ext.notifications.map((item) => item.message).join(" / ")}`,
  );
});

test("详情面板列出当前的查询代理", async () => {
  const ext = await startExtension({ proxy: "http://127.0.0.1:1" });
  await ext.run("v2ex", "");

  const lines = ext.widgets.get("v2ex-quota-details") ?? [];
  assert.ok(
    lines.some((line) => line.includes("查询代理：http://127.0.0.1:1")),
    `详情里没有代理那行：${lines.join(" / ")}`,
  );
});

test("调试日志记下本次会话读到的代理设置", async () => {
  const ext = await startExtension({ proxy: "http://127.0.0.1:1", debug: true });
  await ext.emit("session_start", { type: "session_start", reason: "startup" });
  await sleep(80);

  const log = readFileSync(join(ext.dir, "v2ex-quota.log"), "utf8");
  assert.match(log, /proxy=http:\/\/127\.0\.0\.1:1/);
});

test("没配代理时日志里标成 none", async () => {
  const ext = await startExtension({ debug: true });
  await ext.emit("session_start", { type: "session_start", reason: "startup" });
  await sleep(80);

  const log = readFileSync(join(ext.dir, "v2ex-quota.log"), "utf8");
  assert.match(log, /proxy=none/);
});
