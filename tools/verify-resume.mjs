/**
 * 真机自检：验证扩展在真实 pi 上的两条关键路径。
 *
 * 这是 `npm test` 覆盖不到的一层 —— 单元测试用的是假 pi，证明的是扩展自己的逻辑；
 * 这里驱动的是真 pi 进程，证明的是扩展与 pi 生命周期的配合。
 *
 * 用法：
 *   node tools/verify-resume.mjs              # 默认：到点后能不能真的把一轮对话拉起来
 *   node tools/verify-resume.mjs --case rearm # 用户接管本轮后，等待会不会重新排期
 *   node tools/verify-resume.mjs --case start # 已知额度用尽，/v2ex start 能不能直接排上
 *   node tools/verify-resume.mjs --case start-live # /v2ex start 排上后到点能不能真的接上
 *
 * 四条路径都靠 `PI_CODING_AGENT_DIR` 把 agent 目录挪到临时目录，
 * 绝不碰你真实的配置与等待计划；跑完自动清理。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RESUME_PROMPT = "配额已刷新，继续完成任务。";
const RESUME_BUFFER_SECONDS = 20;

const argIndex = process.argv.indexOf("--case");
const CASE = argIndex >= 0 && process.argv[argIndex + 1] ? process.argv[argIndex + 1] : "resume";

const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(6)}ms`;

const PI_CLI_CANDIDATES = [
  process.env.PI_CLI,
  // 本仓库 node_modules 里若有 pi 包（软链或正常安装），优先用它，跟测试解析到的是同一份。
  join(REPO_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
  // 退回到 npm 全局安装的常见位置（Windows）。
  join(
    homedir(),
    "AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  ),
];

function resolvePiCli() {
  const hit = PI_CLI_CANDIDATES.find((path) => path && existsSync(path));
  if (!hit) {
    console.error(
      "找不到 pi 的入口 cli.js。请设置环境变量 PI_CLI 指向它，例如：\n" +
        "  PI_CLI=$(npm root -g)/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    );
    process.exit(2);
  }
  return hit;
}

function writeConfig(agentDir, extra) {
  writeFileSync(
    join(agentDir, "v2ex-quota.json"),
    `${JSON.stringify(
      {
        status: true,
        autoWait: true,
        pollSeconds: 60,
        resumeBufferSeconds: RESUME_BUFFER_SECONDS,
        maxResumeAttempts: 3,
        resumePrompt: RESUME_PROMPT,
        debug: true,
        ...extra,
      },
      null,
      2,
    )}\n`,
  );
}

function prepareAgentDir(agentDir, baseUrl, extraConfig = {}) {
  mkdirSync(agentDir, { recursive: true });
  copyFileSync(join(homedir(), ".pi/agent/models.json"), join(agentDir, "models.json"));
  writeConfig(agentDir, {
    ...(baseUrl ? { baseUrl, apiKey: "verify-harness-key" } : {}),
    ...extraConfig,
  });
}

function spawnPi(agentDir) {
  return spawn(
    process.execPath,
    [
      resolvePiCli(),
      "--mode",
      "rpc",
      "--provider",
      "v2ex",
      "--model",
      "coder",
      "--no-session",
      "--offline",
      "-e",
      join(REPO_ROOT, "src/index.ts"),
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : (c?.text ?? ""))).join("");
  }
  return "";
}

function readLog(agentDir) {
  try {
    return readFileSync(join(agentDir, "v2ex-quota.log"), "utf8");
  } catch {
    return "";
  }
}

/** 读扩展落盘的等待计划；没有就返回 undefined。 */
function readPlanFile(agentDir) {
  try {
    return JSON.parse(readFileSync(join(agentDir, "v2ex-quota-pending.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 反复读扩展自己的调试日志，直到谓词命中或超时。 */
async function waitForLog(agentDir, predicate, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const text = readLog(agentDir);
    const hit = predicate(text);
    if (hit !== undefined && hit !== false) return { text, hit };
    await sleep(300);
  }
  return undefined;
}

// ---------------------------------------------------------------- case: resume

/** 假配额服务：余额与重置时间可动态变化，用来把「刷新前后」压缩到几秒内。 */
function startFakeQuota(state = { remaining: 8019000, periodEnd: Math.floor(Date.now() / 1000) + 3600 }) {
  const body = () =>
    JSON.stringify({
      success: true,
      message: "fake quota",
      result: {
        active: true,
        total_tokens: 8020000,
        used_tokens: 8020000 - state.remaining,
        remaining_tokens: state.remaining,
        used_percent: ((8020000 - state.remaining) / 8020000) * 100,
        period_start: state.periodEnd - 18000,
        period_end: state.periodEnd,
        extra_usage: { pack_count: 0, total_tokens: 0, used_tokens: 0, remaining_tokens: 0 },
      },
    });
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function caseResume(agentDir) {
  const fake = await startFakeQuota();
  const leadMs = 12_000;
  prepareAgentDir(agentDir, `http://127.0.0.1:${fake.port}`);
  const resumeAt = Date.now() + leadMs;
  writeFileSync(
    join(agentDir, "v2ex-quota-pending.json"),
    `${JSON.stringify({ resumeAt, attempts: 0, cwd: "" }, null, 2)}\n`,
  );

  console.log(`${stamp()} 假配额服务: http://127.0.0.1:${fake.port}/api/v2/chat/quota`);
  console.log(`${stamp()} 等待计划到期: ${new Date(resumeAt).toISOString()}（${leadMs}ms 后）`);

  const child = spawnPi(agentDir);
  let sawAgentStart = false;
  let sawResumePrompt = false;

  const verdict = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ pass: false, why: "超时：没看到续跑被注入" }), 45_000);
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "agent_start") {
          sawAgentStart = true;
          console.log(`${stamp()} agent_start`);
        } else if (ev.type === "message_end" && ev.message?.role === "user") {
          const text = textOf(ev.message);
          console.log(`${stamp()} 会话内出现用户消息: ${JSON.stringify(text.slice(0, 60))}`);
          if (text.includes(RESUME_PROMPT)) sawResumePrompt = true;
        }
        if (sawAgentStart && sawResumePrompt) {
          clearTimeout(timer);
          resolve({ pass: true, why: null });
        }
      }
    });
  });

  child.kill();
  fake.server.close();

  console.log(`\n${stamp()} --- 扩展调试日志 ---`);
  process.stdout.write(readLog(agentDir));

  console.log(
    `\n${verdict.pass ? "通过" : "失败"}：agent_start=${sawAgentStart}` +
      ` 续跑消息进入会话=${sawResumePrompt}${verdict.why ? `（${verdict.why}）` : ""}`,
  );
  return verdict.pass ? 0 : 1;
}

// ----------------------------------------------------------------- case: rearm

/**
 * 场景：已排入等待 → 用户自己发了一条消息 → 撞上真实的配额墙。
 * 期望：被取消的等待在 `agent_settled` 时按窗口重置时间重新排上，
 * 既不丢失，也不退化成 5 分钟的兜底重试。
 */
async function caseRearm(agentDir) {
  prepareAgentDir(agentDir);

  const initialResumeAt = Date.now() + 40 * 60 * 1000;
  writeFileSync(
    join(agentDir, "v2ex-quota-pending.json"),
    `${JSON.stringify({ resumeAt: initialResumeAt, attempts: 0, cwd: "" }, null, 2)}\n`,
  );
  console.log(`${stamp()} 预置等待计划: ${new Date(initialResumeAt).toISOString()}（40 分钟后）`);

  const child = spawnPi(agentDir);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", () => {});
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stdout.write(`${stamp()} [stderr] ${d}`));

  // 阶段一：等第一次配额快照落地。真实会话里 latest 早被轮询填好了；
  // 若快照还没到就结束本轮，agent_settled 拿不到重置时间，只能退化成 5 分钟兜底。
  const snapshot = await waitForLog(
    agentDir,
    (text) =>
      text.includes("quota: active=") || (text.includes("quota fetch failed") ? "failed" : undefined),
    30_000,
  );
  if (!snapshot || snapshot.hit === "failed") {
    child.kill();
    console.log(`${stamp()} --- 扩展调试日志 ---`);
    process.stdout.write(readLog(agentDir));
    console.log(`\n失败：拿不到配额快照，无法验证重新排期的时刻`);
    return 1;
  }
  console.log(`${stamp()} 配额快照已落地，发一条消息（当前配额为 0，必然撞墙）`);
  child.stdin.write(`${JSON.stringify({ type: "prompt", message: "hi" })}\n`);

  // 阶段二：等「取消 → 撞墙 → 重新排期」的完整链路。
  const chain = await waitForLog(
    agentDir,
    (text) => {
      const clearedAt = text.indexOf("wait cleared: 用户已接管本轮");
      const lastArmedAt = text.lastIndexOf("wait armed: resume at ");
      const hit =
        clearedAt >= 0 && lastArmedAt > clearedAt && text.includes("quota exhausted via")
          ? { lastArmedAt }
          : undefined;
      return hit;
    },
    60_000,
  );

  const text = readLog(agentDir);
  child.kill();

  console.log(`\n${stamp()} --- 扩展调试日志 ---`);
  process.stdout.write(text);

  if (!chain) {
    console.log(`\n失败：没能在 60 秒内观察到「取消 → 撞墙 → 重新排期」的完整链路`);
    return 1;
  }

  const armedIso = /wait armed: resume at (\S+)/.exec(text.slice(chain.hit.lastArmedAt))?.[1];
  const resetPattern = /reset=(\d+)/g;
  let reset;
  let m;
  while ((m = resetPattern.exec(text)) !== null) reset = m[1];

  const armedMs = Date.parse(armedIso);
  const awayMinutes = Math.round((armedMs - Date.now()) / 60000);
  const expectedMs =
    reset === undefined ? undefined : (Number(reset) + RESUME_BUFFER_SECONDS) * 1000;
  const matchesWindow = expectedMs !== undefined && Math.abs(armedMs - expectedMs) < 1000;
  const notFallback = awayMinutes > 30;
  const pass = matchesWindow && notFallback;

  console.log(`重新排期时刻: ${armedIso}（${awayMinutes} 分钟后）`);
  console.log(
    `期望 = 窗口重置 ${reset}s + ${RESUME_BUFFER_SECONDS}s = ` +
      `${expectedMs === undefined ? "?" : new Date(expectedMs).toISOString()}`,
  );
  console.log(`与窗口重置一致=${matchesWindow} 不是 5 分钟兜底=${notFallback}`);
  console.log(`\n${pass ? "通过" : "失败"}：等待被重新排到窗口重置时间，没有丢失`);
  return pass ? 0 : 1;
}

// ------------------------------------------------------------------ case: start

/**
 * 场景：刚重开会话，明确知道配额已经用尽，直接执行 `/v2ex start`。
 * 期望：一次 agent 轮次都不需要，命令自己把等待排上，时刻 = 窗口重置 + 缓冲。
 *
 * 这条路径用真配额接口、真窗口时间，不伪造任何东西。排上之后立刻杀进程，
 * 不给它机会到点注入 —— 那会真的消耗额度。
 */
/** 状态栏文本带主题色转义序列，比对前先剥掉。 */
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

async function caseStart(agentDir) {
  prepareAgentDir(agentDir);
  const customPrompt = "验证用提示词：接着把状态栏对齐修掉";

  const child = spawnPi(agentDir);
  const ui = [];
  let sawAgentStart = false;
  let buf = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stdout.write(`${stamp()} [stderr] ${d}`));
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.method === "setStatus") {
        ui.push({ method: "setStatus", key: ev.statusKey, text: ev.statusText });
        console.log(
          `${stamp()} setStatus ${ev.statusKey} = ${JSON.stringify(stripAnsi(ev.statusText ?? ""))}`,
        );
      } else if (ev.method === "notify") {
        ui.push({ method: "notify", message: ev.message, kind: ev.notifyType });
        console.log(`${stamp()} notify[${ev.notifyType ?? "info"}] ${ev.message}`);
      } else if (ev.type === "agent_start") {
        sawAgentStart = true;
        console.log(`${stamp()} agent_start`);
      }
    }
  });

  const finish = (code, lines) => {
    child.kill();
    console.log(`\n${stamp()} --- 扩展调试日志 ---`);
    process.stdout.write(readLog(agentDir));
    console.log(`\n${lines}`);
    return code;
  };

  // 阶段一：等真配额快照落地，顺便读出当前余额与窗口重置时间。
  const snapshot = await waitForLog(
    agentDir,
    (text) =>
      text.includes("quota: active=") || (text.includes("quota fetch failed") ? "failed" : undefined),
    30_000,
  );
  if (!snapshot || snapshot.hit === "failed") {
    return finish(1, "失败：拿不到真实配额快照，无法验证手动排期");
  }

  const quotaLine = /quota: active=(\w+) remaining=(\d+) extra=(\d+) reset=(\d+)/.exec(snapshot.text);
  if (!quotaLine) return finish(1, "失败：配额日志格式不认识");
  const [, activeRaw, remainingRaw, extraRaw, resetRaw] = quotaLine;
  console.log(
    `${stamp()} 真实配额：active=${activeRaw} remaining=${remainingRaw} extra=${extraRaw} reset=${resetRaw}`,
  );

  const exhausted = Number(remainingRaw) <= 0 && Number(extraRaw) <= 0 && activeRaw === "true";

  console.log(`${stamp()} 执行 /v2ex start ${customPrompt}`);
  child.stdin.write(
    `${JSON.stringify({ type: "prompt", message: `/v2ex start ${customPrompt}` })}\n`,
  );
  await sleep(4_000);

  const plan = readPlanFile(agentDir);
  const statusTexts = ui
    .filter((e) => e.method === "setStatus")
    .map((e) => stripAnsi(e.text ?? ""));
  const waited = statusTexts.some((t) => t.startsWith("v2ex 等待"));
  const saidArmed = ui.some((e) => e.method === "notify" && e.message.includes("已排入自动续跑"));
  const saidHasQuota = ui.some((e) => e.method === "notify" && e.message.includes("当前仍有额度"));

  console.log(`${stamp()} 等待计划：${plan ? JSON.stringify(plan) : "(无)"}`);
  console.log(`${stamp()} 状态栏出现「等待」=${waited} agent 轮次=${sawAgentStart}`);

  // 配额此刻还有余量时，「不擅自排队」本身就是要验的行为。
  if (!exhausted) {
    const ok = saidHasQuota && plan === undefined && !sawAgentStart;
    return finish(
      ok ? 0 : 1,
      `${ok ? "通过" : "失败"}：配额仍有余量，start 未排等待并说明了原因` +
        `（提示=${saidHasQuota} 无计划=${plan === undefined} 无 agent 轮次=${!sawAgentStart}）`,
    );
  }

  if (!plan) {
    return finish(1, `失败：配额已用尽但 start 没有排入等待（提示已排期=${saidArmed}）`);
  }

  const expectedMs = (Number(resetRaw) + RESUME_BUFFER_SECONDS) * 1000;
  const matchesWindow = Math.abs(plan.resumeAt - expectedMs) < 1000;
  const keepsPrompt = plan.prompt === customPrompt;
  const noAgentTurn = !sawAgentStart;
  const pass = matchesWindow && keepsPrompt && waited && saidArmed && noAgentTurn;

  return finish(
    pass ? 0 : 1,
    [
      `排期时刻: ${new Date(plan.resumeAt).toISOString()}（${Math.round((plan.resumeAt - Date.now()) / 60000)} 分钟后）`,
      `期望 = 窗口重置 ${resetRaw}s + ${RESUME_BUFFER_SECONDS}s = ${new Date(expectedMs).toISOString()}`,
      `与窗口重置一致=${matchesWindow} 提示词随计划落盘=${keepsPrompt}` +
        ` 状态栏进入等待=${waited} 有排期提示=${saidArmed} 未产生 agent 轮次=${noAgentTurn}`,
      `\n${pass ? "通过" : "失败"}：/v2ex start 在零 agent 轮次下完成了排期`,
    ].join("\n"),
  );
}

// ------------------------------------------------------------ case: start-live

/**
 * 场景：`/v2ex start` 排上之后，到点真的把对话接上。
 *
 * 这是 start 与 resume 的合体 —— 入口是命令，出口是新的 agent 轮次。
 * 两条分开验过不等于链路成立，所以专门跑一次。用假配额服务把「窗口重置」
 * 压到 8 秒后（真窗口要等几十分钟到几小时），一分钟内跑完整条链：
 * 命令排期 → 到点复核 → 注入续跑 → agent 起一轮。
 */
async function caseStartLive(agentDir) {
  const state = { remaining: 0, periodEnd: Math.floor(Date.now() / 1000) + 8 };
  const fake = await startFakeQuota(state);
  prepareAgentDir(agentDir, `http://127.0.0.1:${fake.port}`, { resumeBufferSeconds: 0 });
  const customPrompt = "开始改状态栏对齐";

  console.log(
    `${stamp()} 假配额：余额 0、窗口 ${new Date(state.periodEnd * 1000).toISOString()} 重置（8 秒后）`,
  );

  const child = spawnPi(agentDir);
  let sawAgentStart = false;
  let resumedText;
  let buf = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stdout.write(`${stamp()} [stderr] ${d}`));
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "agent_start") {
        sawAgentStart = true;
        console.log(`${stamp()} agent_start`);
      } else if (ev.type === "message_end" && ev.message?.role === "user") {
        const text = textOf(ev.message);
        if (text.includes(customPrompt)) {
          resumedText = text;
          console.log(`${stamp()} 会话内出现用户消息: ${JSON.stringify(text.slice(0, 60))}`);
        }
      }
    }
  });

  const finish = (code, lines) => {
    child.kill();
    fake.server.close();
    console.log(`\n${stamp()} --- 扩展调试日志 ---`);
    process.stdout.write(readLog(agentDir));
    console.log(`\n${lines}`);
    return code;
  };

  const snapshot = await waitForLog(agentDir, (text) => text.includes("quota: active="), 30_000);
  if (!snapshot) return finish(1, "失败：拿不到假配额快照");

  console.log(`${stamp()} 执行 /v2ex start ${customPrompt}`);
  child.stdin.write(
    `${JSON.stringify({ type: "prompt", message: `/v2ex start ${customPrompt}` })}\n`,
  );

  const armed = await waitForLog(agentDir, (text) => text.includes("start: wait armed"), 15_000);
  if (!armed) return finish(1, "失败：start 没有排入等待");

  const plan = readPlanFile(agentDir);
  const armedOk = plan !== undefined && Math.abs(plan.resumeAt - state.periodEnd * 1000) < 1500;
  console.log(
    `${stamp()} 已排期：${plan ? new Date(plan.resumeAt).toISOString() : "(无)"}` +
      `（窗口重置 ${new Date(state.periodEnd * 1000).toISOString()}）`,
  );

  // 到点之前把额度放回去，模拟「窗口刷新了」。
  await sleep(5_000);
  state.remaining = 8_000_000;
  console.log(`${stamp()} 额度已恢复（假的），等它到点续跑`);

  const resumed = await waitForLog(agentDir, (text) => text.includes("resume: injecting"), 20_000);
  await sleep(1_500);

  const pass = armedOk && resumed !== undefined && sawAgentStart && resumedText !== undefined;
  return finish(
    pass ? 0 : 1,
    [
      `排期与窗口重置一致=${armedOk} 到点复核后注入=${resumed !== undefined}` +
        ` agent 起了一轮=${sawAgentStart} 注入内容=自定义提示词=${resumedText !== undefined}`,
      `\n${pass ? "通过" : "失败"}：/v2ex start 排的等待到点真的把对话接上了`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------- 入口

const sandbox = join(tmpdir(), `pi-v2ex-verify-${Date.now()}`);
const agentDir = join(sandbox, "agent");

try {
  if (CASE === "resume") {
    process.exitCode = await caseResume(agentDir);
  } else if (CASE === "rearm") {
    process.exitCode = await caseRearm(agentDir);
  } else if (CASE === "start") {
    process.exitCode = await caseStart(agentDir);
  } else if (CASE === "start-live") {
    process.exitCode = await caseStartLive(agentDir);
  } else {
    console.error(`未知的 case：${CASE}（可用 resume / rearm / start / start-live）`);
    process.exitCode = 2;
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
