/**
 * pi-v2ex-quota
 *
 * 把 V2EX AI Chat 的配额与下次刷新时间接进 pi 状态栏；配额用尽时立刻中止本轮
 * （不再陪 pi 把三次退避重试跑完），并可选择等窗口刷新后自动继续未完成的任务。
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import {
  clearPending,
  loadConfig,
  readPending,
  saveConfig,
  writePending,
  type QuotaConfig,
} from "./config.ts";
import {
  buildDetails,
  buildStatus,
  formatDuration,
  formatTimestamp,
  type StatusLevel,
} from "./format.ts";
import {
  fetchQuota,
  isExhausted,
  isQuotaExhaustedSignal,
  parseQuotaHeaders,
  QUOTA_EXHAUSTED_PATTERN,
  quotaUrl,
  readV2exProvider,
  resetDeadlineMs,
  type QuotaWindow,
  type V2exEndpoint,
} from "./v2ex.ts";

const STATUS_KEY = "v2ex-quota";
const DETAILS_KEY = "v2ex-quota-details";
const LOG_FILE = "v2ex-quota.log";

/** 拿不到窗口重置时间时的兜底重试间隔。 */
const FALLBACK_RETRY_MS = 5 * 60 * 1000;

/** setTimeout 超过该值会退化成 1ms 触发，长等待分段进行。 */
const MAX_TIMER_MS = 2_147_000_000;

const LEVEL_COLORS: Record<StatusLevel, ThemeColor> = {
  ok: "dim",
  low: "warning",
  empty: "error",
  waiting: "accent",
  idle: "dim",
  unknown: "muted",
};

const SUBCOMMANDS: AutocompleteItem[] = [
  { value: "refresh", label: "refresh", description: "立即重新读取配额" },
  { value: "status on", label: "status on", description: "在状态栏显示配额" },
  { value: "status off", label: "status off", description: "隐藏状态栏配额" },
  { value: "wait on", label: "wait on", description: "配额用尽时等待刷新并自动续跑" },
  { value: "wait off", label: "wait off", description: "关闭自动续跑" },
  { value: "start", label: "start", description: "已知额度用尽，立即排入等待（不必先发消息）" },
  { value: "cancel", label: "cancel", description: "取消等待中的自动续跑" },
  { value: "debug on", label: "debug on", description: "写调试日志" },
  { value: "debug off", label: "debug off", description: "停止写调试日志" },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  let config: QuotaConfig = loadConfig(agentDir);
  let endpoint: V2exEndpoint | undefined;
  let latest: QuotaWindow | undefined;
  let pending: { resumeAt: number; attempts: number; prompt?: string } | undefined;
  let detailsVisible = false;
  let selfResume = false;
  let quotaHit = false;
  let projectCwd = "";
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCtx: ExtensionContext | undefined;
  let uiDisabled = false;

  function log(message: string): void {
    if (!config.debug) return;
    try {
      appendFileSync(join(agentDir, LOG_FILE), `${new Date().toISOString()} ${message}\n`);
    } catch {
      // 日志写不进去不该影响主流程。
    }
  }

  /**
   * 状态栏与自动续跑只在交互会话里成立。
   * print/json 这类一次性运行会在结束时销毁 extension runner，
   * 之后任何 UI 调用都会抛 stale ctx，所以这里先按模式挡掉。
   */
  function canUseUi(ctx: ExtensionContext): boolean {
    if (uiDisabled) return false;
    return ctx.mode === "tui" || ctx.mode === "rpc";
  }

  function applyUi(what: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      uiDisabled = true;
      log(`${what} failed, 后续不再尝试 UI 写入: ${errorText(error)}`);
    }
  }

  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
    if (!canUseUi(ctx)) return;
    applyUi("notify", () => ctx.ui.notify(message, type));
  }

  function resolveEndpoint(): V2exEndpoint | undefined {
    let baseUrl = config.baseUrl;
    let apiKey = config.apiKey;
    if (!baseUrl || !apiKey) {
      let text: string;
      try {
        text = readFileSync(join(agentDir, "models.json"), "utf8");
      } catch {
        text = "";
      }
      const fromModels = readV2exProvider(text, process.env);
      if (fromModels) {
        baseUrl = baseUrl ?? fromModels.baseUrl;
        apiKey = apiKey ?? fromModels.apiKey;
      }
    }
    if (!baseUrl || !apiKey) return undefined;
    return { baseUrl, apiKey };
  }

  function refreshStatus(ctx: ExtensionContext): void {
    if (!canUseUi(ctx)) return;
    applyUi("setStatus", () => {
      if (!config.status || !endpoint) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const view = buildStatus({ window: latest, now: Date.now(), waiting: pending !== undefined });
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(LEVEL_COLORS[view.level], view.text));
    });
  }

  function detailLines(): string[] {
    let autoWaitLabel = "已关闭";
    if (config.autoWait) {
      autoWaitLabel = pending
        ? `已开启（${formatDuration(pending.resumeAt - Date.now())} 后继续）`
        : "已开启";
    }
    return buildDetails({
      window: latest,
      now: Date.now(),
      waiting: pending !== undefined,
      autoWaitLabel,
    });
  }

  function renderDetails(ctx: ExtensionContext): void {
    if (!detailsVisible || !canUseUi(ctx)) return;
    applyUi("setWidget", () =>
      ctx.ui.setWidget(DETAILS_KEY, detailLines(), { placement: "belowEditor" }),
    );
  }

  function toggleDetails(ctx: ExtensionContext): void {
    if (!canUseUi(ctx)) return;
    detailsVisible = !detailsVisible;
    if (detailsVisible) {
      renderDetails(ctx);
      return;
    }
    applyUi("setWidget", () => ctx.ui.setWidget(DETAILS_KEY, undefined));
  }

  function mergeSnapshot(snapshot: QuotaWindow): QuotaWindow {
    if (snapshot.periodEnd > 0 || !latest) return snapshot;
    return { ...snapshot, periodStart: latest.periodStart, periodEnd: latest.periodEnd };
  }

  /** 取一次配额快照。返回本次查询是否成功，供「以查询结果为准」的调用方判断。 */
  async function pollQuota(ctx: ExtensionContext): Promise<boolean> {
    if (!endpoint) return false;
    let ok = true;
    try {
      latest = await fetchQuota(endpoint);
      log(
        `quota: active=${latest.active} remaining=${latest.remainingTokens}` +
          ` extra=${latest.extraRemainingTokens} reset=${latest.periodEnd}`,
      );
    } catch (error) {
      ok = false;
      log(`quota fetch failed: ${errorText(error)}`);
    }
    refreshStatus(ctx);
    renderDetails(ctx);
    return ok;
  }

  function stopPolling(): void {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = undefined;
  }

  function startPolling(ctx: ExtensionContext): void {
    stopPolling();
    if (!config.status || !endpoint || !canUseUi(ctx)) {
      refreshStatus(ctx);
      return;
    }
    void pollQuota(ctx);
    const timer = setInterval(() => {
      void pollQuota(lastCtx ?? ctx);
    }, config.pollSeconds * 1000);
    (timer as { unref?: () => void }).unref?.();
    pollTimer = timer;
  }

  function persistPending(): void {
    if (!pending) {
      clearPending(agentDir);
      return;
    }
    writePending(agentDir, {
      resumeAt: pending.resumeAt,
      attempts: pending.attempts,
      cwd: projectCwd,
      prompt: pending.prompt,
    });
  }

  function clearWait(reason: string, ctx: ExtensionContext | undefined): void {
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = undefined;
    }
    const had = pending !== undefined;
    pending = undefined;
    clearPending(agentDir);
    if (had) log(`wait cleared: ${reason}`);
    if (!ctx) return;
    refreshStatus(ctx);
    renderDetails(ctx);
  }

  function armWait(ctx: ExtensionContext, resumeAt: number, prompt?: string): void {
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = undefined;
    }
    if (pending) {
      pending.resumeAt = resumeAt;
      if (prompt !== undefined) pending.prompt = prompt;
    } else {
      pending = { resumeAt, attempts: 0, prompt };
    }
    persistPending();
    const delay = Math.max(1_000, resumeAt - Date.now());
    log(`wait armed: resume at ${new Date(resumeAt).toISOString()} (in ${formatDuration(delay)})`);
    const timer = setTimeout(() => {
      void resumeNow(ctx);
    }, Math.min(delay, MAX_TIMER_MS));
    // 等待动辄几小时，别让它成为 pi 退不掉的最后一个理由。计划已经落盘，重启能恢复。
    (timer as { unref?: () => void }).unref?.();
    resumeTimer = timer;
    refreshStatus(ctx);
    renderDetails(ctx);
  }

  async function resumeNow(ctx: ExtensionContext): Promise<void> {
    resumeTimer = undefined;
    if (!pending) return;
    if (Date.now() < pending.resumeAt) {
      armWait(ctx, pending.resumeAt);
      return;
    }
    if (!endpoint) {
      clearWait("v2ex provider 已不可解析", ctx);
      return;
    }

    try {
      latest = await fetchQuota(endpoint);
      log(`resume precheck: remaining=${latest.remainingTokens} reset=${latest.periodEnd}`);
    } catch (error) {
      log(`resume precheck failed: ${errorText(error)}`);
    }

    const deadline = resetDeadlineMs(latest);
    const bufferedDeadline =
      deadline === undefined ? undefined : deadline + config.resumeBufferSeconds * 1000;
    if (isExhausted(latest) && bufferedDeadline !== undefined && bufferedDeadline > Date.now()) {
      if (pending.attempts >= config.maxResumeAttempts) {
        clearWait(`已续跑 ${pending.attempts} 次仍未恢复`, ctx);
        notify(ctx, "V2EX 配额仍未恢复，已停止自动续跑", "warning");
        return;
      }
      pending.attempts += 1;
      armWait(ctx, bufferedDeadline);
      return;
    }

    const attempts = pending.attempts;
    const prompt = pending.prompt ?? config.resumePrompt;
    pending = undefined;
    clearPending(agentDir);
    selfResume = true;
    log(`resume: injecting continuation after ${attempts} attempt(s)`);
    notify(ctx, "V2EX 配额已刷新，继续未完成的任务", "info");
    refreshStatus(ctx);
    renderDetails(ctx);
    if (ctx.isIdle()) pi.sendUserMessage(prompt);
    else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }

  function handleExhausted(ctx: ExtensionContext, source: string): void {
    log(`quota exhausted via ${source}; autoWait=${config.autoWait}`);
    const first = !quotaHit;
    quotaHit = true;

    // pi 把 429 归为可重试，会退避重试；配额墙后面重试没有意义。
    // 每次检测到都掐一次，光掐第一次只挡得住当前这次尝试。
    try {
      ctx.abort();
      log(`abort requested (streaming=${ctx.signal !== undefined})`);
    } catch (error) {
      log(`abort failed: ${errorText(error)}`);
    }

    if (!first) return;
    notify(ctx, "V2EX 配额已用尽，已中止本轮", "warning");
    if (config.autoWait) {
      notify(ctx, "等待窗口刷新后自动继续，/v2ex cancel 可取消", "info");
    } else {
      notify(ctx, "需要自动续跑请执行 /v2ex wait on", "info");
    }
    void pollQuota(ctx);
    refreshStatus(ctx);
  }

  /**
   * `/v2ex start`：明确知道当前窗口已经用尽（典型场景是刚重开会话），
   * 直接把自动续跑排上，不必先发一条消息去撞墙。
   *
   * 是否真的排等待以查询结果为准：仍有额度、或当前没有活跃窗口时都不排，
   * 免得凭一句「我觉得没了」就空等一轮。
   */
  async function startWait(ctx: ExtensionContext, prompt: string | undefined): Promise<void> {
    if (!canUseUi(ctx)) {
      notify(ctx, "当前模式没有可续跑的交互会话，无法排入自动续跑", "warning");
      return;
    }
    if (!endpoint) {
      notify(ctx, "未在 models.json 找到 v2ex provider，无法查询配额", "warning");
      return;
    }
    if (pending) {
      notify(
        ctx,
        `已在等待中，${formatDuration(pending.resumeAt - Date.now())} 后自动继续；/v2ex cancel 可取消`,
        "info",
      );
      return;
    }

    const fetched = await pollQuota(ctx);
    if (!fetched || !latest) {
      notify(ctx, "配额查询失败，无法确认当前额度，未排入等待", "warning");
      return;
    }
    if (!latest.active) {
      notify(ctx, "当前没有活跃配额窗口，发一条消息即可开新窗口，不需要等待", "info");
      return;
    }
    if (!isExhausted(latest)) {
      const view = buildStatus({ window: latest, now: Date.now(), waiting: false });
      notify(ctx, `当前仍有额度（${view.text}），未排入等待`, "info");
      return;
    }

    const deadline = resetDeadlineMs(latest);
    const resumeAt =
      (deadline ?? Date.now() + FALLBACK_RETRY_MS) + config.resumeBufferSeconds * 1000;
    const notes: string[] = [];
    if (!config.autoWait) {
      config = saveConfig(agentDir, { autoWait: true });
      notes.push("自动续跑开关已一并开启");
    }
    if (deadline === undefined) {
      notes.push(`未取到窗口重置时间，先按 ${formatDuration(FALLBACK_RETRY_MS)} 后重试`);
    }

    armWait(ctx, resumeAt, prompt);
    log(`start: wait armed at ${new Date(resumeAt).toISOString()}${prompt ? `, prompt=${prompt}` : ""}`);
    const when = deadline === undefined ? "" : `（窗口于 ${formatTimestamp(latest.periodEnd)} 重置）`;
    const detail = notes.length > 0 ? ` · ${notes.join(" · ")}` : "";
    notify(
      ctx,
      `已排入自动续跑：${formatDuration(resumeAt - Date.now())} 后继续${when}${detail}`,
      "info",
    );
  }

  function restorePending(ctx: ExtensionContext): void {
    // 一次性运行不接管上一次交互会话留下的等待计划，留给下次交互启动。
    if (!canUseUi(ctx)) return;
    const stored = readPending(agentDir);
    if (!stored) return;
    if (stored.cwd && stored.cwd !== ctx.cwd) {
      clearPending(agentDir);
      log(`stored wait dropped: cwd ${stored.cwd} != ${ctx.cwd}`);
      return;
    }
    if (!config.autoWait) {
      clearPending(agentDir);
      log("stored wait dropped: autoWait disabled");
      return;
    }
    pending = { resumeAt: stored.resumeAt, attempts: stored.attempts, prompt: stored.prompt };
    log(`stored wait restored: resume at ${new Date(stored.resumeAt).toISOString()}`);
    armWait(ctx, Math.max(stored.resumeAt, Date.now() + 2_000));
    notify(ctx, `V2EX 配额等待已恢复，${formatDuration(pending.resumeAt - Date.now())} 后自动继续`, "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    projectCwd = ctx.cwd;
    config = loadConfig(agentDir);
    endpoint = resolveEndpoint();
    log(
      `session_start: mode=${ctx.mode} status=${config.status} autoWait=${config.autoWait}` +
        ` endpoint=${endpoint ? quotaUrl(endpoint.baseUrl) : "missing"}`,
    );
    if (!endpoint) {
      refreshStatus(ctx);
      notify(ctx, "未在 models.json 找到 v2ex provider，配额状态不可用", "warning");
      return;
    }
    restorePending(ctx);
    startPolling(ctx);
  });

  pi.on("session_shutdown", async () => {
    stopPolling();
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = undefined;
    }
    // 等待计划留在磁盘上，重启 pi 后还能接着等。
  });

  pi.on("after_provider_response", async (event, ctx) => {
    lastCtx = ctx;
    log(
      `provider response: status=${event.status}` +
        ` tokenRemaining=${event.headers["x-ai-chat-token-remaining"] ?? "n/a"}`,
    );
    const snapshot = parseQuotaHeaders(event.headers);
    if (snapshot) {
      latest = mergeSnapshot(snapshot);
      refreshStatus(ctx);
      renderDetails(ctx);
    }
    if (isQuotaExhaustedSignal(event.status, event.headers)) {
      handleExhausted(ctx, `HTTP ${event.status}`);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    lastCtx = ctx;
    const message = event.message as {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    };
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error" || !message.errorMessage) return;
    if (!QUOTA_EXHAUSTED_PATTERN.test(message.errorMessage)) return;
    handleExhausted(ctx, "错误文案");
  });

  pi.on("agent_settled", async (_event, ctx) => {
    lastCtx = ctx;
    if (!quotaHit) return;
    quotaHit = false;
    if (!config.autoWait || pending) return;
    if (!canUseUi(ctx)) {
      log("auto wait skipped: 当前模式没有可续跑的交互会话");
      return;
    }
    const deadline = resetDeadlineMs(latest);
    const resumeAt = (deadline ?? Date.now() + FALLBACK_RETRY_MS) + config.resumeBufferSeconds * 1000;
    armWait(ctx, resumeAt);
    notify(ctx, `V2EX 配额将在 ${formatDuration(resumeAt - Date.now())} 后刷新，已排入自动续跑`, "info");
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    lastCtx = ctx;
    if (selfResume) {
      selfResume = false;
      return;
    }
    if (pending) clearWait("用户已接管本轮", ctx);
  });

  pi.on("agent_end", async () => {
    selfResume = false;
  });

  async function applyToggle(
    ctx: ExtensionContext,
    action: string,
    on: boolean,
  ): Promise<void> {
    if (action === "status") {
      config = saveConfig(agentDir, { status: on });
      startPolling(ctx);
      notify(ctx, on ? "状态栏配额已开启" : "状态栏配额已关闭", "info");
      return;
    }
    if (action === "wait") {
      config = saveConfig(agentDir, { autoWait: on });
      if (!on) {
        clearWait("自动续跑已关闭", ctx);
        notify(ctx, "自动续跑已关闭", "info");
        return;
      }
      notify(ctx, "自动续跑已开启，配额用尽时自动排入等待", "info");
      // 开关的语义只是「用尽后要不要自动排」；如果此刻已经用尽，给一条立刻排队的路。
      if (!pending && latest && latest.active && isExhausted(latest)) {
        notify(ctx, "当前配额已用尽，/v2ex start 可立即排入等待", "info");
      }
      return;
    }
    config = saveConfig(agentDir, { debug: on });
    notify(ctx, on ? `已开启调试日志：${join(agentDir, LOG_FILE)}` : "已关闭调试日志", "info");
  }

  pi.registerCommand("v2ex", {
    description: "查看 V2EX AI Chat 配额，切换状态显示，手动排入或取消自动续跑",
    getArgumentCompletions: (prefix: string) => {
      const items = SUBCOMMANDS.filter((item) => item.value.startsWith(prefix));
      return items.length > 0 ? [...items] : null;
    },
    handler: async (args, ctx) => {
      lastCtx = ctx;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens[0] ?? "";
      const value = tokens[1] ?? "";

      if (action === "") {
        await pollQuota(ctx);
        toggleDetails(ctx);
        return;
      }
      if (action === "refresh") {
        const fetched = await pollQuota(ctx);
        if (!fetched) {
          notify(ctx, "配额查询失败，开启 /v2ex debug on 可看日志", "warning");
          return;
        }
        const view = buildStatus({ window: latest, now: Date.now(), waiting: pending !== undefined });
        notify(ctx, `V2EX 配额：${view.text}`, "info");
        return;
      }
      if (action === "start") {
        // 提示词可选：`/v2ex start 继续改 xxx` 决定续跑时注入什么。
        const prompt = tokens.slice(1).join(" ").trim();
        await startWait(ctx, prompt.length > 0 ? prompt : undefined);
        return;
      }
      if (action === "cancel") {
        if (!pending) {
          notify(ctx, "当前没有等待中的自动续跑", "info");
          return;
        }
        clearWait("用户取消", ctx);
        notify(ctx, "已取消等待中的自动续跑", "info");
        return;
      }
      if (action === "status" || action === "wait" || action === "debug") {
        if (value !== "on" && value !== "off") {
          notify(ctx, `用法：/v2ex ${action} on|off`, "warning");
          return;
        }
        await applyToggle(ctx, action, value === "on");
        return;
      }
      notify(
        ctx,
        `未知子命令：${action}（可用 refresh / start / cancel / status on|off / wait on|off / debug on|off）`,
        "warning",
      );
    },
  });
}
