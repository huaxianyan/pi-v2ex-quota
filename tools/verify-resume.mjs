/**
 * 真机自检：验证扩展在真实 pi 上的关键路径。
 *
 * 这是 `npm test` 覆盖不到的一层 —— 单元测试用的是假 pi，证明的是扩展自己的逻辑；
 * 这里驱动的是真 pi 进程，证明的是扩展与 pi 生命周期的配合。
 *
 * 用法：
 *   node tools/verify-resume.mjs              # 默认：到点后能不能真的把一轮对话拉起来
 *   node tools/verify-resume.mjs --case rearm # 用户接管本轮后，等待会不会重新排期
 *   node tools/verify-resume.mjs --case start # 已知额度用尽，/v2ex start 能不能直接排上
 *   node tools/verify-resume.mjs --case start-live # /v2ex start 排上后到点能不能真的接上
 *   node tools/verify-resume.mjs --case retry # 上游 522 之后能不能按退避自动重试
 *   node tools/verify-resume.mjs --case proxy # 只写主机端口能不能自动认出代理协议
 *
 * 六条路径都靠 `PI_CODING_AGENT_DIR` 把 agent 目录挪到临时目录，
 * 绝不碰你真实的配置与等待计划；跑完自动清理。
 *
 * 其中 start / rearm / proxy 打的是真实的配额接口（proxy 还要连真实代理）。
 * 本机直连不到 edge.v2ex.com 时，给它们配一个本地代理即可
 * （用假服务的另外三条不读这个变量）：
 *   V2EX_VERIFY_PROXY=http://127.0.0.1:37777 npm run verify:start
 *   V2EX_VERIFY_PROXY=http://127.0.0.1:37777 npm run verify:proxy
 * rearm 还得给 pi 自己再设一次 HTTPS_PROXY（它要发真消息去撞配额墙）。
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

/**
 * 真实配额接口的 case（start / rearm）可以走本地代理。
 *
 * 只有这两条需要它：另外三条打的是 127.0.0.1 上的假服务，绕代理反而可能被
 * 代理自己的 bypass 规则拦住，凭空多一个失败点。
 */
const VERIFY_PROXY = (process.env["V2EX_VERIFY_PROXY"] ?? "").trim();
const proxyConfig = () => (VERIFY_PROXY ? { proxy: VERIFY_PROXY } : {});

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

/** 读扩展落在临时 agent 目录里的配置。 */
function readConfigFile(agentDir) {
  try {
    return JSON.parse(readFileSync(join(agentDir, "v2ex-quota.json"), "utf8"));
  } catch {
    return {};
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
  prepareAgentDir(agentDir, undefined, proxyConfig());
  if (VERIFY_PROXY) console.log(`${stamp()} 配额接口走代理: ${VERIFY_PROXY}`);

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
  // 这条 case 推进靠的是「发一条真消息、上游回 429」。额度还有量时那条消息会
  // 真的发出去、真的花掉额度，而链路根本不会触发 —— 与其报一个假失败，不如明说跳过。
  const quotaLine = /quota: active=(\w+) remaining=(\d+) extra=(\d+) reset=(\d+)/.exec(
    snapshot.text,
  );
  const exhausted =
    quotaLine !== null &&
    quotaLine[1] === "true" &&
    Number(quotaLine[2]) <= 0 &&
    Number(quotaLine[3]) <= 0;
  if (!exhausted) {
    child.kill();
    console.log(`${stamp()} --- 扩展调试日志 ---`);
    process.stdout.write(readLog(agentDir));
    console.log(
      `\n跳过：这条 case 需要此刻配额确实用尽（它会真发一条消息去撞墙）；` +
        `当前 remaining=${quotaLine?.[2] ?? "?"} extra=${quotaLine?.[3] ?? "?"}。\n` +
        "      等窗口用尽后再跑，别为了让它通过去烧额度。",
    );
    return 2;
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
  prepareAgentDir(agentDir, undefined, proxyConfig());
  if (VERIFY_PROXY) console.log(`${stamp()} 配额接口走代理: ${VERIFY_PROXY}`);
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
  const waited = statusTexts.some((t) => t.startsWith("V2EX 等待"));
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

// ------------------------------------------------------------------ case: proxy

/**
 * 场景：本机得走代理才出网，但用户只写「主机:端口」，协议交给扩展自己试。
 * 期望：探测出真能用的那种协议并写回配置、设置完立刻查询成功、状态栏把代理记为「开」，
 * 关闭后回到直连且状态栏记为「关」。
 *
 * 需要 `V2EX_VERIFY_PROXY` 指向本机一个真实可用的代理，且地址里的协议会被故意剥掉 ——
 * 走的就是用户实际会走的那条路（不告诉扩展对面是什么协议）。
 */
async function caseProxy(agentDir) {
  if (!VERIFY_PROXY) {
    console.log("失败：这条 case 需要一个真实可用的本地代理才能验");
    console.log("      V2EX_VERIFY_PROXY=http://127.0.0.1:37777 npm run verify:proxy");
    return 2;
  }
  const bare = VERIFY_PROXY.replace(/^[a-z][a-z\d+.-]*:\/\//i, "");
  prepareAgentDir(agentDir, undefined, {});
  console.log(`${stamp()} 只写主机端口来设置代理: ${bare}`);

  const child = spawnPi(agentDir);
  const ui = [];
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
        ui.push({ method: "setStatus", text: stripAnsi(ev.statusText ?? "") });
        console.log(
          `${stamp()} setStatus ${ev.statusKey} = ${JSON.stringify(stripAnsi(ev.statusText ?? ""))}`,
        );
      } else if (ev.method === "notify") {
        ui.push({ method: "notify", message: ev.message, kind: ev.notifyType });
        console.log(`${stamp()} notify[${ev.notifyType ?? "info"}] ${ev.message}`);
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

  // 阶段一：先让启动那次直连查询跑完（本机大概会超时），确认扩展就绪且此刻是直连。
  const first = await waitForLog(
    agentDir,
    (text) =>
      text.includes("quota: active=") || (text.includes("quota fetch failed") ? "failed" : undefined),
    40_000,
  );
  if (!first) return finish(1, "失败：启动查询一直没有结论");
  console.log(`${stamp()} 启动时的直连查询：${first.hit === "failed" ? "失败（预期）" : "成功"}`);
  const directFailed = first.hit === "failed";
  const before = readConfigFile(agentDir).proxy ?? "";
  const statusBefore = ui.filter((e) => e.method === "setStatus").map((e) => e.text).at(-1) ?? "";

  // 阶段二：只给主机端口，协议由扩展探测。
  child.stdin.write(`${JSON.stringify({ type: "prompt", message: `/v2ex proxy ${bare}` })}\n`);
  // 要等到「设置之后这次查询」有结论为止，不能只等 proxy set —— 那只是探测完成，
  // 真正取配额是紧接着的第二次请求，先于它断言会读到一个还没更新的状态栏。
  await waitForLog(
    agentDir,
    (text) => {
      const marker = text.indexOf("proxy set:");
      if (marker < 0) return undefined;
      const after = text.slice(marker);
      if (after.includes("quota: active=")) return "query-ok";
      return after.includes("quota fetch failed") ? "query-failed" : undefined;
    },
    60_000,
  );
  await sleep(400);

  const log = readLog(agentDir);
  const saved = readConfigFile(agentDir).proxy ?? "";
  const resolved = /^(http|socks5|socks4a):\/\//.exec(saved)?.[1];
  // 此刻还没有关闭阶段的事件，所以直接扫 ui 就是「设置阶段」的通知。
  const saidOk = ui.some((e) => e.method === "notify" && e.message.includes("配额查询已走"));
  const statusWithProxy = ui.filter((e) => e.method === "setStatus").map((e) => e.text).at(-1) ?? "";
  const showsQuota = /^V2EX [█░]+ \d+%/.test(statusWithProxy);
  const showsProxyOn = statusWithProxy.includes("代理 开");

  console.log(`${stamp()} 配置里存下的代理：${saved || "(空)"}`);
  console.log(`${stamp()} 状态栏：${statusWithProxy}`);

  // 阶段三：关掉代理要能退回去。
  child.stdin.write(`${JSON.stringify({ type: "prompt", message: "/v2ex proxy off" })}\n`);
  await sleep(3_000);
  const afterOff = readConfigFile(agentDir).proxy ?? "?";
  const statusAfterOff = ui.filter((e) => e.method === "setStatus").map((e) => e.text).at(-1) ?? "";
  const showsProxyOff = statusAfterOff.includes("代理 关");

  const pass =
    directFailed &&
    before === "" &&
    Boolean(resolved) &&
    saidOk &&
    showsQuota &&
    showsProxyOn &&
    afterOff === "" &&
    showsProxyOff;

  return finish(
    pass ? 0 : 1,
    [
      `直连失败=${directFailed} 设置前配置为空=${before === ""}`,
      `探测出协议=${resolved ?? "(无)"} 写回配置=${saved || "(空)"}`,
      `设置后查询成功=${saidOk} 状态栏有配额进度条=${showsQuota} 代理=开=${showsProxyOn}`,
      `关闭后配置=「${afterOff}」状态栏代理=关=${showsProxyOff}`,
      `\n${pass ? "通过" : "失败"}：只写主机端口即可自动认协议并接通`,
      log.includes("proxy probe:")
        ? `探测日志：${/proxy probe: .*/m.exec(log)?.[0]}`
        : "（日志里没有 proxy probe 行）",
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

// ------------------------------------------------------------------ case: retry

/**
 * 假上游：配额接口正常，但补全接口固定返回 522。
 *
 * 522 是 Cloudflare 的「连接源站超时」，2026-09-22 那次真机故障就是这个码。
 * 注意 pi 会把它压成一句 `Connection error.`，字面里看不出状态码 ——
 * 扩展的故障分类必须认这句，否则整条路都不会被触发。
 */
function startFlakyProvider() {
  const state = { completions: 0 };
  const quota = () =>
    JSON.stringify({
      success: true,
      message: "fake quota",
      result: {
        active: true,
        total_tokens: 8_020_000,
        used_tokens: 0,
        remaining_tokens: 8_020_000,
        used_percent: 0,
        period_start: Math.floor(Date.now() / 1000) - 60,
        period_end: Math.floor(Date.now() / 1000) + 3600,
        extra_usage: { pack_count: 0, total_tokens: 0, used_tokens: 0, remaining_tokens: 0 },
      },
    });
  const server = createServer((req, res) => {
    if (req.url.startsWith("/api/v2/chat/quota")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(quota());
      return;
    }
    state.completions += 1;
    res.writeHead(522, { "content-type": "text/plain" });
    res.end("");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port }));
  });
}

/**
 * 场景：上游返回 522，整轮会话被打断。
 *
 * pi 自己会先做三次快速重试（2s / 4s / 8s 退避），每次都重跑一轮 agent，
 * 全失败后才发 agent_settled。扩展接手的正是这个时点：按自己的退避再排一次，
 * 到点把对话接上。单元测试里用的是假 pi，只有这里能证明它跟真 pi 合得上。
 */
async function caseRetry(agentDir) {
  const fake = await startFlakyProvider();
  const retrySeconds = 5;
  prepareAgentDir(agentDir, `http://127.0.0.1:${fake.port}`, {
    retryOnError: true,
    errorRetrySeconds: retrySeconds,
    maxErrorRetries: 2,
    // 这个 case 只验上游故障那条路，别让配额续跑掺进来。
    autoWait: false,
    resumeBufferSeconds: 0,
  });

  console.log(`${stamp()} 假上游: http://127.0.0.1:${fake.port}（配额正常，补全固定 522）`);

  const child = spawnPi(agentDir);
  let agentStarts = 0;
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
        agentStarts += 1;
        console.log(`${stamp()} agent_start（第 ${agentStarts} 次）`);
      } else if (ev.type === "auto_retry_start") {
        console.log(
          `${stamp()} pi 自己的重试：第 ${ev.attempt}/${ev.maxAttempts} 次，${ev.delayMs}ms 后`,
        );
      } else if (ev.type === "auto_retry_end") {
        console.log(`${stamp()} pi 自己的重试结束：success=${ev.success}`);
      } else if (ev.type === "message_end" && ev.message?.role === "user") {
        const text = textOf(ev.message);
        if (text.includes(RESUME_PROMPT)) {
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

  // 阶段一：等配额快照落地，确认扩展已经就绪。
  const snapshot = await waitForLog(agentDir, (text) => text.includes("quota: active="), 30_000);
  if (!snapshot) return finish(1, "失败：拿不到假配额快照");

  console.log(`${stamp()} 发一条消息，上游会返回 522`);
  child.stdin.write(`${JSON.stringify({ type: "prompt", message: "hi" })}\n`);

  // 阶段二：pi 自己重试三次要花掉约 55 秒，扩展在 agent_settled 之后才排期。
  const armed = await waitForLog(
    agentDir,
    (text) => {
      const match = /wait armed: resume at (\S+) \((error|quota), in (.+?)\)/.exec(text);
      return match ? { iso: match[1], reason: match[2], delay: match[3] } : undefined;
    },
    120_000,
  );
  if (!armed) return finish(1, "失败：上游 522 之后没有排入重试");

  const plan = readPlanFile(agentDir);
  const planOk = plan?.reason === "error";
  const gapMs = Date.parse(armed.hit.iso) - Date.now();
  // 排期发生在 agent_settled 那一刻，到这里已经过了一小会儿，所以只校验量级。
  const backoffOk = gapMs > 0 && gapMs <= retrySeconds * 1000;
  console.log(
    `${stamp()} 已排期: ${armed.hit.iso}（${armed.hit.delay} 后，reason=${armed.hit.reason}）`,
  );

  // 阶段三：到点真的把对话接上。
  const startsBeforeResume = agentStarts;
  const resumed = await waitForLog(
    agentDir,
    (text) => text.includes("resume: injecting continuation (error)"),
    60_000,
  );
  await sleep(3_000);

  const restarted = agentStarts > startsBeforeResume;
  const pass = planOk && backoffOk && resumed !== undefined && restarted && resumedText !== undefined;
  return finish(
    pass ? 0 : 1,
    [
      `计划 reason=error=${planOk}（值 ${plan?.reason}）退避约 ${Math.round(gapMs / 1000)}s=${backoffOk}`,
      `到点注入=${resumed !== undefined} 注入后又起一轮=${restarted}` +
        `（${startsBeforeResume} → ${agentStarts}）续跑消息进入会话=${resumedText !== undefined}`,
      `\n${pass ? "通过" : "失败"}：上游 522 之后扩展按退避重试并把对话接上了`,
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
  } else if (CASE === "retry") {
    process.exitCode = await caseRetry(agentDir);
  } else if (CASE === "proxy") {
    process.exitCode = await caseProxy(agentDir);
  } else {
    console.error(
      `未知的 case：${CASE}（可用 resume / rearm / start / start-live / retry / proxy）`,
    );
    process.exitCode = 2;
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
