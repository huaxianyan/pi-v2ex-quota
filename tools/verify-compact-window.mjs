/** 真实 pi + 已安装的 Smart Compact，模型响应为 fixture，全程不消耗上游配额。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const hostEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import(new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", hostEntry).href);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const recoveryCase = process.argv.includes("--recovery");
const faultKey = "__v2exRecoveryFixtureFailure";
const smartPath = process.env.SMART_COMPACT_EXTENSION ?? join(homedir(), ".pi/agent/npm/node_modules/pi-smart-compact/dist/index.js");
const agentDir = mkdtempSync(join(tmpdir(), "pi-v2ex-window-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
let session;
let quotaServer;
let quotaResetAt = 0;
let stopped = false;
const timer = setTimeout(() => { stopped = true; void session?.abort(); }, 60_000);

const usage = { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 200,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const summary = "## Goal\nImplement a V2EX quota monitor.\n" +
  "## Constraints & Preferences\nUse TypeScript. Keep models.json unchanged.\n" +
  "## Progress\nThe quota monitor design is documented. Implementation is pending.\n" +
  "## Key Decisions\nUse the existing pi compaction lifecycle.\n" +
  "## Next Steps\nImplement the quota monitor in src/index.ts.\n" +
  "## Critical Context\nThe project is pi-v2ex-quota. No files have been changed yet.\n";

function message(model, text, messageUsage = usage) {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text }], usage: messageUsage, stopReason: "stop", timestamp: Date.now() };
}
const definition = { id: "window-test", name: "Window test", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 8192 };
const initialModels = JSON.stringify({ providers: { v2ex: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture", api: "openai-completions", models: [definition] } } });
const notifications = [];
const errors = [];
const downstreamContexts = [];

try {
  writeFileSync(join(agentDir, "models.json"), initialModels);
  const extra = {};
  const faultPath = join(agentDir, "force-native-failure.ts");
  if (recoveryCase) {
    quotaServer = createServer((_request, response) => {
      if (!quotaResetAt) quotaResetAt = Date.now() + 2_000;
      const left = Date.now() >= quotaResetAt ? 8_000_000 : 0;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ success: true, result: { active: true,
        total_tokens: 8_000_000, used_tokens: 8_000_000 - left, remaining_tokens: left,
        used_percent: left ? 0 : 100, period_end: Math.floor(quotaResetAt / 1000), extra_usage: { remaining_tokens: 0 } } }));
    });
    await new Promise((resolve) => quotaServer.listen(0, "127.0.0.1", resolve));
    extra.baseUrl = `http://127.0.0.1:${quotaServer.address().port}/v1`;
    extra.apiKey = "fixture";
    extra.resumeBufferSeconds = 0;
    writeFileSync(faultPath, `export default function (pi) {
      let first = true;
      pi.on("session_before_compact", (event) => {
        if (!first || event.reason !== "threshold") return;
        first = false;
        globalThis[${JSON.stringify(faultKey)}] = true;
        return {}; // Fixture: force one real native summarization failure.
      });
    }`);
  }
  writeFileSync(join(agentDir, "v2ex-quota.json"), JSON.stringify({ status: false, ...extra }));
  const settings = { compaction: { enabled: true, reserveTokens: 30_000, keepRecentTokens: 20_000 },
    smartCompact: { autoTrigger: true, minContextPercent: 60, mode: "fast", requireApproval: true, contextGraphEnabled: false },
    retry: { enabled: false } };
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  const settingsManager = SettingsManager.inMemory(settings);
  const resourceLoader = new DefaultResourceLoader({ cwd: agentDir, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [smartPath, join(root, "src/index.ts"), ...(recoveryCase ? [faultPath] : [])],
    extensionFactories: [(pi) => {
      for (const provider of ["v2ex", "other"]) {
        pi.registerProvider(provider, { baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture", api: "openai-completions", models: [definition],
          streamSimple: (model, context) => {
            const stream = createAssistantMessageEventStream();
            downstreamContexts.push(context);
            const continuing = context.messages.some((entry) => entry.role === "user" &&
              (typeof entry.content === "string" ? entry.content : entry.content?.map((part) => part.text ?? "").join("") ?? "").startsWith("上下文已整理，继续原任务"));
            const response = message(model, continuing ? "TASK_RESUMED" : summary);
            stream.push({ type: "start", partial: response });
            if (globalThis[faultKey]) {
              delete globalThis[faultKey];
              response.stopReason = "error";
              response.errorMessage = '400: {"message":"Message content is too long"}';
              stream.push({ type: "error", reason: "error", error: response });
            } else stream.push({ type: "done", reason: "stop", message: response });
            stream.end();
            return stream;
          } });
      }
    }] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(agentDir);
  const fixtureModel = { ...definition, provider: "v2ex", api: "openai-completions" };
  // 历史输入及用量都是固定 fixture；从持久化入口恢复给真实 pi。
  for (let i = 0; i < 24; i++) {
    manager.appendMessage({ role: "user", content: "Implement a V2EX quota monitor. Use TypeScript. Keep models.json unchanged.\n" +
      "The quota monitor design is documented. Implementation is pending. Use the existing pi compaction lifecycle.\n".repeat(120), timestamp: Date.now() });
    manager.appendMessage(message(fixtureModel, "Implementation is pending. No files have been changed yet."));
  }
  manager.appendMessage(message(fixtureModel, "Continue with src/index.ts next.", {
    ...usage, input: 75_000, output: 100, totalTokens: 75_100 }));
  ({ session } = await createAgentSession({ cwd: agentDir, agentDir, settingsManager, resourceLoader,
    sessionManager: manager, tools: [] }));
  await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error),
    uiContext: { hasUI: true, theme: { fg: (_color, text) => text },
      notify: (text) => notifications.push(text), setStatus() {}, setWidget() {} } });
  const original = session.model;
  assert.equal(original.provider, "v2ex");
  await session.prompt("/v2ex compact window 100k");
  assert.equal(session.model.contextWindow, 100_000);
  assert.equal(original.contextWindow, 1_000_000);
  assert.ok(notifications.some((text) => text.includes("70,000")));
  await session.prompt("/v2ex compact window 60k");
  assert.equal(session.model.contextWindow, 100_000);
  await session.prompt("/v2ex compact off");
  assert.equal(session.model.contextWindow, 1_000_000);
  await session.prompt("/v2ex compact on");
  assert.equal(session.model.contextWindow, 100_000);
  const other = session.modelRuntime.getModel("other", "window-test");
  await session.setModel(other);
  assert.equal(session.model.contextWindow, 1_000_000);
  await session.setModel(original);
  assert.equal(session.model.contextWindow, 100_000);
  await session.reload();
  assert.equal(session.model.contextWindow, 100_000);
  await session.prompt("/v2ex compact off");
  assert.equal(session.model.contextWindow, 1_000_000);
  await session.prompt("/v2ex compact on");

  await session.prompt("Continue the quota monitor task");
  if (recoveryCase) {
    const waitFor = async (check) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !check()) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(check(), `恢复验收未达到预期状态：${JSON.stringify({ notifications, errors })}`);
    };
    await waitFor(() => quotaResetAt > 0);
    const plan = JSON.parse(readFileSync(join(agentDir, "v2ex-quota-pending.json"), "utf8"));
    assert.equal(plan.reason, "compact");
    assert.equal(plan.compact.sessionId, session.sessionManager.getSessionId());
    await session.reload();
    await waitFor(() => session.getLastAssistantText() === "TASK_RESUMED" && session.isIdle);
    console.log("通过：自动压缩失败后保存恢复计划，等待配额、重载恢复、补救摘要自动应用并继续原任务。");
  }
  const compaction = session.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
  assert.ok(compaction, `自动压缩没有生成会话记录：${JSON.stringify({ notifications, errors })}`);
  assert.ok(compaction.details?.runId, "没有应用 Smart Compact 的摘要");
  assert.ok(compaction.summary.length > 0);
  assert.ok(downstreamContexts.at(-1)?.messages.length < 48,
    `下一次模型请求没有使用压缩后的上下文：${downstreamContexts.at(-1)?.messages.length} 条消息`);
  assert.equal(readFileSync(join(agentDir, "models.json"), "utf8"), initialModels);
  assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), JSON.stringify(settings));
  assert.deepEqual(errors, []);
  assert.equal(stopped, false, "验收超时");
  console.log("通过：临时窗口、关闭恢复、切换模型、重载恢复及 Smart Compact 自动应用；模型和 pi 设置文件保持原样。");
  console.log("边界：使用真实 pi 和 Smart Compact，模型响应为 fixture，未请求 V2EX 上游。");
} finally {
  clearTimeout(timer);
  session?.dispose();
  if (quotaServer) await new Promise((resolve) => quotaServer.close(resolve));
  delete globalThis[faultKey];
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
}
