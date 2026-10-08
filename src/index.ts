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
import { requestSmartCompaction } from "pi-smart-compact/extension-api";

import { CompactWindow, parseWindow } from "./compact-window.ts";
import {
  clearPending,
  loadConfig,
  readPending,
  saveConfig,
  writePending,
  type QuotaConfig,
  type PendingResume,
  type WaitReason,
} from "./config.ts";
import {
  buildDetails,
  buildStatus,
  COUNTDOWN_DUE_MS,
  formatDuration,
  formatTimestamp,
  type StatusLevel,
  type StatusSegment,
} from "./format.ts";
import {
  classifyTransientError,
  fetchQuota,
  isExhausted,
  isQuotaExhaustedSignal,
  parseQuotaHeaders,
  QUOTA_EXHAUSTED_PATTERN,
  quotaUrl,
  readV2exProvider,
  resetDeadlineMs,
  type QuotaWindow,
  type TransientError,
  type V2exEndpoint,
} from "./v2ex.ts";

const STATUS_KEY = "v2ex-quota";
const DETAILS_KEY = "v2ex-quota-details";
const LOG_FILE = "v2ex-quota.log";

/** 拿不到窗口重置时间时的兜底重试间隔。 */
const FALLBACK_RETRY_MS = 5 * 60 * 1000;

/** 上游故障重试的退避上限：再怎么连续失败也不会等超过这么久。 */
const MAX_ERROR_RETRY_MS = 15 * 60 * 1000;

/** setTimeout 超过该值会退化成 1ms 触发，长等待分段进行。 */
const MAX_TIMER_MS = 2_147_000_000;

/**
 * 剩余不足这么久就进入秒级倒计时。
 *
 * 等待可能排在几小时之后，整段都每秒刷一遍状态栏既没必要也吵；只在最后一分钟
 * 改成每秒一动，好让「等待 43s」真的在走。再往上按分钟滚动就够了。
 */
const COUNTDOWN_WINDOW_MS = 60_000;

/** 秒级倒计时的刷新频率。 */
const COUNTDOWN_TICK_MS = 1_000;

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
  { value: "retry on", label: "retry on", description: "上游 5xx / 超时等瞬时故障后自动重试" },
  { value: "retry off", label: "retry off", description: "关闭上游故障自动重试" },
  { value: "start", label: "start", description: "已知额度用尽，立即排入等待（不必先发消息）" },
  { value: "cancel", label: "cancel", description: "取消等待中的自动续跑" },
  { value: "compact window ", label: "compact window", description: "设置临时上下文窗口，例如 400k" },
  { value: "compact on", label: "compact on", description: "启用临时上下文窗口" },
  { value: "compact off", label: "compact off", description: "恢复模型原始窗口" },
  { value: "compact status", label: "compact status", description: "查看窗口与自动压缩触发点" },
  { value: "debug on", label: "debug on", description: "写调试日志" },
  { value: "debug off", label: "debug off", description: "停止写调试日志" },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 内存计划沿用同一个落盘协议，仅把等待原因补齐。 */
interface PendingWait extends Omit<PendingResume, "cwd" | "reason"> {
  reason: WaitReason;
}

const COMPACT_RESUME_PROMPT = "上下文已整理，继续原任务。沿用已完成的步骤和验证结果。";

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  let config: QuotaConfig = loadConfig(agentDir);
  const compactWindow = new CompactWindow(pi);
  let endpoint: V2exEndpoint | undefined;
  let latest: QuotaWindow | undefined;
  let pending: PendingWait | undefined;
  let detailsVisible = false;
  let selfResume = false;
  let quotaHit = false;
  let transientHit = false;
  let transientError: TransientError | undefined;
  let transientAttempts = 0;
  let transientAdvised = false;
  let projectCwd = "";
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  /** 到「最后一分钟起点」的一次性定时器。 */
  let countdownArmTimer: ReturnType<typeof setTimeout> | undefined;
  /** 最后一分钟里的每秒刷新。 */
  let countdownTickTimer: ReturnType<typeof setInterval> | undefined;
  let lastCtx: ExtensionContext | undefined;
  let uiDisabled = false;
  let active = false;
  let modelGeneration = 0;
  let stopAfterCompactFailure = false;
  let compactRecovery: AbortController | undefined;

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
      if (!active || !config.status || !endpoint) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const view = buildStatus({
        window: latest,
        now: Date.now(),
        waiting: pending !== undefined,
        waitReason: pending?.reason,
        resumeAt: pending?.resumeAt,
        toggles: {
          autoWait: config.autoWait,
          retryOnError: config.retryOnError,
        },
      });
      const paint = (segment: StatusSegment): string =>
        segment.tone === "dim"
          ? ctx.ui.theme.fg("dim", segment.text)
          : ctx.ui.theme.fg(LEVEL_COLORS[view.level], segment.text);
      ctx.ui.setStatus(STATUS_KEY, view.segments.map(paint).join(""));
    });
  }

  function detailLines(): string[] {
    const waiting = pending !== undefined;
    // 归零后不再显示「0s 后」：复核与注入都还要一点时间，说「即将」更贴近实情。
    const away = (): string => {
      const left = (pending?.resumeAt ?? Date.now()) - Date.now();
      return left < COUNTDOWN_DUE_MS ? "即将" : `${formatDuration(left)} 后`;
    };

    let autoWaitLabel = "已关闭";
    if (config.autoWait) {
      autoWaitLabel = waiting && pending?.reason === "quota" ? `已开启（${away()}继续）` : "已开启";
    }
    let retryOnErrorLabel = "已关闭";
    if (config.retryOnError) {
      retryOnErrorLabel =
        waiting && pending?.reason === "error" ? `已开启（${away()}重试）` : "已开启";
    }
    return buildDetails({
      window: latest,
      now: Date.now(),
      waiting,
      waitReason: pending?.reason,
      resumeAt: pending?.resumeAt,
      autoWaitLabel,
      retryOnErrorLabel,
    });
  }

  function renderDetails(ctx: ExtensionContext): void {
    if (!active || !detailsVisible || !canUseUi(ctx)) return;
    applyUi("setWidget", () =>
      ctx.ui.setWidget(DETAILS_KEY, detailLines(), { placement: "belowEditor" }),
    );
  }

  function toggleDetails(ctx: ExtensionContext): void {
    if (!active || !canUseUi(ctx)) return;
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
    if (!active || !endpoint) return false;
    const generation = modelGeneration;
    let ok = true;
    try {
      const snapshot = await fetchQuota(endpoint);
      if (!active || generation !== modelGeneration) return false;
      latest = snapshot;
      log(
        `quota: active=${latest.active} remaining=${latest.remainingTokens}` +
          ` extra=${latest.extraRemainingTokens} reset=${latest.periodEnd}`,
      );
    } catch (error) {
      ok = false;
      log(`quota fetch failed: ${errorText(error)}`);
    }
    if (!active || generation !== modelGeneration) return false;
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
    if (!active || !config.status || !endpoint || !canUseUi(ctx)) {
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
    writePending(agentDir, { ...pending, cwd: projectCwd });
  }

  function clearWait(reason: string, ctx: ExtensionContext | undefined): void {
    compactRecovery?.abort();
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
    syncCountdown(ctx);
  }

  function armWait(
    ctx: ExtensionContext,
    resumeAt: number,
    prompt?: string,
    reason: WaitReason = "quota",
  ): void {
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = undefined;
    }
    if (pending) {
      pending.resumeAt = resumeAt;
      pending.reason = reason;
      if (prompt !== undefined) pending.prompt = prompt;
    } else {
      pending = { resumeAt, attempts: 0, prompt, reason };
    }
    persistPending();
    const delay = Math.max(1_000, resumeAt - Date.now());
    log(
      `wait armed: resume at ${new Date(resumeAt).toISOString()} (${reason}, in ${formatDuration(delay)})`,
    );
    const timer = setTimeout(() => {
      void resumeNow(lastCtx ?? ctx);
    }, Math.min(delay, MAX_TIMER_MS));
    // 等待动辄几小时，别让它成为 pi 退不掉的最后一个理由。计划已经落盘，重启能恢复。
    (timer as { unref?: () => void }).unref?.();
    resumeTimer = timer;
    refreshStatus(ctx);
    renderDetails(ctx);
    syncCountdown(ctx);
  }

  function stopCountdown(): void {
    if (countdownArmTimer) {
      clearTimeout(countdownArmTimer);
      countdownArmTimer = undefined;
    }
    if (countdownTickTimer) {
      clearInterval(countdownTickTimer);
      countdownTickTimer = undefined;
    }
  }

  /**
   * 按等待的远近安排秒级倒计时。
   *
   * 这只是本地的展示倒计时，不追求跟服务端对齐 —— 到点之后还要复核额度、
   * 注入消息，本来就会晚一点，归零到真正续跑之间的那一小段由「即将开始」兜着。
   * 排在一分钟以外时只挂一个到「最后一分钟起点」的一次性定时器，不逐秒空转。
   */
  function syncCountdown(ctx: ExtensionContext): void {
    stopCountdown();
    if (!pending || !canUseUi(ctx)) return;
    const left = pending.resumeAt - Date.now();
    if (left > COUNTDOWN_WINDOW_MS) {
      const arm = setTimeout(() => {
        countdownArmTimer = undefined;
        syncCountdown(lastCtx ?? ctx);
      }, Math.min(left - COUNTDOWN_WINDOW_MS, MAX_TIMER_MS));
      (arm as { unref?: () => void }).unref?.();
      countdownArmTimer = arm;
      return;
    }
    const tick = (): void => {
      const live = lastCtx ?? ctx;
      if (!pending) {
        // 计划已被收走（续跑注入、用户取消、到点后清掉），自己停掉并补一次干净的状态栏。
        stopCountdown();
        refreshStatus(live);
        renderDetails(live);
        return;
      }
      refreshStatus(live);
      renderDetails(live);
    };
    const ticker = setInterval(tick, COUNTDOWN_TICK_MS);
    (ticker as { unref?: () => void }).unref?.();
    countdownTickTimer = ticker;
    // 立刻走一帧，免得排上之后还要等一秒才显示秒数。
    tick();
  }

  /**
   * 注入续跑消息并收干净等待状态。
   * 空闲时直接开新一轮；正跑着就排到队列后面，别打断进行中的轮次。
   */
  function injectResume(ctx: ExtensionContext, current: PendingWait, note: string): void {
    const prompt = current.prompt ?? config.resumePrompt;
    pending = undefined;
    clearPending(agentDir);
    selfResume = true;
    log(`resume: injecting continuation (${current.reason})`);
    notify(ctx, note, "info");
    refreshStatus(ctx);
    renderDetails(ctx);
    // 计划已经收掉，倒计时也该跟着停。
    syncCountdown(ctx);
    if (ctx.isIdle()) pi.sendUserMessage(prompt);
    else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }

  async function resumeNow(ctx: ExtensionContext): Promise<void> {
    resumeTimer = undefined;
    const current = pending;
    if (!active || !current) return;
    const generation = modelGeneration;
    if (Date.now() < current.resumeAt) {
      armWait(ctx, current.resumeAt, current.prompt, current.reason);
      return;
    }

    if (current.reason === "compact") {
      await recoverCompaction(ctx, current);
      return;
    }

    // 上游故障的重试不做额度预检：到点就是唯一条件。
    // 真撞上配额墙的话，after_provider_response 那条路会另行接管。
    if (current.reason === "error") {
      injectResume(ctx, current, "上游故障，自动重试未完成的任务");
      return;
    }

    if (!endpoint) {
      clearWait("v2ex provider 已不可解析", ctx);
      return;
    }

    try {
      const snapshot = await fetchQuota(endpoint);
      if (!active || generation !== modelGeneration || pending !== current) return;
      latest = snapshot;
      log(`resume precheck: remaining=${latest.remainingTokens} reset=${latest.periodEnd}`);
    } catch (error) {
      log(`resume precheck failed: ${errorText(error)}`);
    }

    if (!active || generation !== modelGeneration || pending !== current) return;
    const deadline = resetDeadlineMs(latest);
    const bufferedDeadline =
      deadline === undefined ? undefined : deadline + config.resumeBufferSeconds * 1000;
    if (isExhausted(latest) && bufferedDeadline !== undefined && bufferedDeadline > Date.now()) {
      if (current.attempts >= config.maxResumeAttempts) {
        clearWait(`已续跑 ${current.attempts} 次仍未恢复`, ctx);
        notify(ctx, "V2EX 配额仍未恢复，已停止自动续跑", "warning");
        return;
      }
      current.attempts += 1;
      armWait(ctx, bufferedDeadline, current.prompt, "quota");
      return;
    }

    injectResume(ctx, current, "V2EX 配额已刷新，继续未完成的任务");
  }

  function recoveryMatches(ctx: ExtensionContext, current: PendingWait): boolean {
    const scope = current.compact;
    return scope !== undefined && ctx.sessionManager.getSessionId() === scope.sessionId &&
      ctx.model?.provider === "v2ex" && ctx.model.id === scope.modelId &&
      ctx.sessionManager.getBranch().some((entry) => entry.id === scope.branchHeadId);
  }

  async function stopCompactionRecovery(ctx: ExtensionContext, message: string): Promise<void> {
    clearWait("压缩补救已停止", ctx);
    await compactWindow.pause(ctx);
    notify(ctx, message + "。原会话记录保留，请手动执行 /smart-compact；成功后用 /v2ex compact on 恢复", "warning");
  }

  async function recoverCompaction(ctx: ExtensionContext, current: PendingWait): Promise<void> {
    if (compactRecovery) return;
    if (!recoveryMatches(ctx, current)) {
      clearWait("压缩补救对应的会话或分支已变更", ctx);
      return;
    }
    if (!ctx.isIdle()) {
      armWait(ctx, Date.now() + 1_000, current.prompt, "compact");
      return;
    }
    if (current.attempts >= config.maxErrorRetries + 1) {
      await stopCompactionRecovery(ctx, "压缩补救已达到重试上限");
      return;
    }
    current.attempts += 1;
    persistPending(); // 请求前落盘，重启也遵守本次恢复的预算。
    const generation = modelGeneration;
    const controller = new AbortController();
    compactRecovery = controller;
    const live = () => !controller.signal.aborted && active && generation === modelGeneration && pending === current;
    const retry = (label: string) => {
      const delay = errorRetryDelayMs(current.attempts - 1);
      armWait(ctx, Date.now() + delay, current.prompt, "compact");
      notify(ctx, `${label}，${formatDuration(delay)} 后继续压缩补救`, "info");
    };
    const waitForQuota = () => {
      const at = (resetDeadlineMs(latest) ?? Date.now() + FALLBACK_RETRY_MS) + config.resumeBufferSeconds * 1000;
      armWait(ctx, Math.max(Date.now() + 1_000, at), current.prompt, "compact");
      notify(ctx, `V2EX 配额用尽，${formatDuration(at - Date.now())} 后先整理上下文，再继续任务`, "info");
    };
    try {
      if (endpoint) {
        const snapshot = await fetchQuota(endpoint);
        if (!live()) return;
        latest = snapshot;
        if (latest.active && isExhausted(latest)) { waitForQuota(); return; }
      }
      notify(ctx, "正在自动整理上下文，完成后继续原任务", "info");
      const result = await requestSmartCompaction(pi, ctx, controller.signal);
      if (!live()) return;
      if (result.status === "applied") {
        compactWindow.resume();
        await compactWindow.sync(ctx, config);
        if (!live()) return;
        if (ctx.hasPendingMessages()) {
          clearWait("用户已有后续任务", ctx);
          return;
        }
        injectResume(ctx, current, "上下文已整理，继续原任务");
        return;
      }
      if (result.status === "busy") { retry("Smart Compact 正在处理其他压缩"); return; }
      if (result.status === "cancelled") {
        await stopCompactionRecovery(ctx, "压缩补救已取消");
        return;
      }
      if (QUOTA_EXHAUSTED_PATTERN.test(result.errorMessage)) {
        if (endpoint) {
          const snapshot = await fetchQuota(endpoint);
          if (!live()) return;
          latest = snapshot;
        }
        if (live()) waitForQuota();
        return;
      }
      const transient = classifyTransientError(result.errorMessage);
      if (transient) { retry(`压缩时${transient.label}`); return; }
      log(`compact recovery failed: ${result.errorMessage}`);
      await stopCompactionRecovery(ctx, "Smart Compact 未能完成压缩补救，请检查其模型与自动压缩设置");
    } catch (error) {
      if (!live()) return;
      const transient = classifyTransientError(errorText(error));
      if (transient) retry(`压缩补救时${transient.label}`);
      else await stopCompactionRecovery(ctx, "压缩补救失败，请检查 V2EX 连接及 Smart Compact 设置");
      log(`compact recovery error: ${errorText(error)}`);
    } finally {
      if (compactRecovery === controller) compactRecovery = undefined;
    }
  }

  /** 上游故障的退避：首次 errorRetrySeconds，之后按次数翻倍，封顶 MAX_ERROR_RETRY_MS。 */
  function errorRetryDelayMs(attempt: number): number {
    return Math.min(config.errorRetrySeconds * 1000 * 2 ** Math.max(0, attempt), MAX_ERROR_RETRY_MS);
  }

  /**
   * 上游瞬时故障（5xx / 超时 / 连接中断）。
   *
   * 这里只记状态，排期留给 agent_settled —— 那才是本轮真正结束、
   * 可以接下一轮的时点。在 message_end 里排期是在跟 pi 自己的收尾抢时序。
   */
  function handleTransientError(
    ctx: ExtensionContext,
    transient: TransientError,
    raw: string,
  ): void {
    log(`transient error: ${transient.label} (${raw}) retryOnError=${config.retryOnError}`);
    if (!config.retryOnError) {
      if (!transientAdvised) {
        transientAdvised = true;
        notify(ctx, `V2EX 上游${transient.label}；/v2ex retry on 可开启故障后自动重试`, "info");
      }
      return;
    }
    transientHit = true;
    transientError = transient;
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
    if (!active) return;
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
    // 恢复也要看对应的开关：关掉开关后留着计划，只会在下次启动时悄悄生效。
    const reason: WaitReason = stored.reason ?? "quota";
    const enabled = reason === "compact" ? config.compactWindowEnabled : reason === "error" ? config.retryOnError : config.autoWait;
    if (!enabled) {
      clearPending(agentDir);
      log(`stored wait dropped: ${reason} 对应的开关已关闭`);
      return;
    }
    const { cwd: _cwd, ...wait } = stored;
    pending = { ...wait, reason };
    if (reason === "compact" && !recoveryMatches(ctx, pending)) {
      clearWait("压缩补救对应的会话或分支未恢复", ctx);
      return;
    }
    log(`stored wait restored (${reason}): resume at ${new Date(stored.resumeAt).toISOString()}`);
    armWait(ctx, Math.max(stored.resumeAt, Date.now() + 2_000), stored.prompt, reason);
    const what = reason === "compact" ? "压缩补救" : reason === "error" ? "上游故障重试" : "配额等待";
    notify(ctx, `V2EX ${what}已恢复，${formatDuration(pending.resumeAt - Date.now())} 后自动继续`, "info");
  }

  function selectProvider(provider: string | undefined, ctx: ExtensionContext): void {
    lastCtx = ctx;
    const nextActive = provider === "v2ex";
    if (active === nextActive) return;
    active = nextActive;
    modelGeneration += 1;
    if (active) {
      endpoint = resolveEndpoint();
      restorePending(ctx);
      startPolling(ctx);
      return;
    }
    stopPolling();
    clearWait("已切换到其他 provider", ctx);
    stopCountdown();
    latest = undefined;
    quotaHit = false;
    transientHit = false;
    transientError = undefined;
    transientAttempts = 0;
    transientAdvised = false;
    selfResume = false;
    detailsVisible = false;
    stopAfterCompactFailure = false;
    if (canUseUi(ctx)) {
      applyUi("setWidget", () => ctx.ui.setWidget(DETAILS_KEY, undefined));
    }
  }

  async function syncCompactWindow(ctx: ExtensionContext): Promise<void> {
    try {
      await compactWindow.sync(ctx, config);
    } catch (error) {
      await compactWindow.pause(ctx);
      notify(ctx, `临时窗口暂未启用：${errorText(error)}`, "warning");
    }
  }

  pi.on("model_select", async (event, ctx) => {
    if (pending?.reason === "compact" && event.model.id !== pending.compact?.modelId) {
      clearWait("用户已切换模型", ctx);
    }
    selectProvider(event.model.provider, ctx);
    await syncCompactWindow(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    projectCwd = ctx.cwd;
    config = loadConfig(agentDir);
    endpoint = resolveEndpoint();
    log(
      `session_start: mode=${ctx.mode} status=${config.status} autoWait=${config.autoWait}` +
        ` retryOnError=${config.retryOnError}` +
        ` endpoint=${endpoint ? quotaUrl(endpoint.baseUrl) : "missing"}`,
    );
    selectProvider(ctx.model?.provider, ctx);
    compactWindow.resume();
    await syncCompactWindow(ctx);
    if (active && !endpoint) {
      notify(ctx, "未在 models.json 找到 v2ex provider，配额状态不可用", "warning");
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (pending?.reason === "compact" && !recoveryMatches(ctx, pending)) clearWait("用户已切换任务分支", ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    modelGeneration += 1;
    compactRecovery?.abort();
    await compactWindow.restore(ctx);
    stopPolling();
    stopCountdown();
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = undefined;
    }
    // 等待计划留在磁盘上，重启 pi 后还能接着等。
  });

  pi.on("session_compact_failed", async (event, ctx) => {
    if (!active || !config.compactWindowEnabled || event.aborted || event.reason === "manual" || compactRecovery) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const branchHeadId = ctx.sessionManager.getLeafId();
    if (!sessionId || !branchHeadId || !canUseUi(ctx)) {
      await compactWindow.pause(ctx);
      notify(ctx, "当前会话无法保存压缩恢复计划，请手动执行 /smart-compact 后继续任务", "warning");
      return;
    }
    if (!pending || pending.reason !== "compact") {
      clearWait("先处理压缩失败", undefined);
      pending = {
        resumeAt: Date.now() + 1_000, attempts: 0, reason: "compact", prompt: COMPACT_RESUME_PROMPT,
        compact: { sessionId, modelId: ctx.model!.id, branchHeadId },
      };
      persistPending();
    }
    // 发消息前的压缩失败时，agent 尚未启动，等它启动后再中止。
    stopAfterCompactFailure = ctx.signal === undefined;
    ctx.abort();
    notify(ctx, "自动压缩未完成，本轮结束后自动补救，再继续原任务；/v2ex cancel 可取消", "warning");
  });

  pi.on("after_provider_response", async (event, ctx) => {
    if (!active) return;
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
    // 真正走通一次，就把「连续故障」的账清零。
    if (event.status < 400) {
      transientAttempts = 0;
      transientAdvised = false;
    }
    if (isQuotaExhaustedSignal(event.status, event.headers)) {
      handleExhausted(ctx, `HTTP ${event.status}`);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!active) return;
    lastCtx = ctx;
    const message = event.message as {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    };
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error" || !message.errorMessage) return;
    if (QUOTA_EXHAUSTED_PATTERN.test(message.errorMessage)) {
      handleExhausted(ctx, "错误文案");
      return;
    }
    const transient = classifyTransientError(message.errorMessage);
    if (transient) handleTransientError(ctx, transient, message.errorMessage);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!active) return;
    lastCtx = ctx;
    if (pending?.reason === "compact") {
      quotaHit = false;
      transientHit = false;
      armWait(ctx, pending.resumeAt, pending.prompt, "compact");
      return;
    }

    if (quotaHit) {
      quotaHit = false;
      if (!config.autoWait || pending) return;
      if (!canUseUi(ctx)) {
        log("auto wait skipped: 当前模式没有可续跑的交互会话");
        return;
      }
      const deadline = resetDeadlineMs(latest);
      const resumeAt =
        (deadline ?? Date.now() + FALLBACK_RETRY_MS) + config.resumeBufferSeconds * 1000;
      armWait(ctx, resumeAt, undefined, "quota");
      notify(
        ctx,
        `V2EX 配额将在 ${formatDuration(resumeAt - Date.now())} 后刷新，已排入自动续跑`,
        "info",
      );
      return;
    }

    if (!transientHit) return;
    transientHit = false;
    if (!config.retryOnError || pending) return;
    if (!canUseUi(ctx)) {
      log("auto retry skipped: 当前模式没有可续跑的交互会话");
      return;
    }

    const attempt = transientAttempts;
    if (attempt >= config.maxErrorRetries) {
      // 到上限就别再耗着了：每轮重试都要真花掉一次请求，空转没有意义。
      transientAttempts = 0;
      transientError = undefined;
      log(`transient retry given up after ${attempt} attempt(s)`);
      notify(ctx, `V2EX 上游连续 ${attempt} 次出错，已停止自动重试`, "warning");
      return;
    }

    transientAttempts = attempt + 1;
    const label = transientError?.label ?? "故障";
    transientError = undefined;
    const delay = errorRetryDelayMs(attempt);
    armWait(ctx, Date.now() + delay, undefined, "error");
    notify(
      ctx,
      `V2EX 上游${label}，${formatDuration(delay)} 后自动重试（第 ${transientAttempts} 次）`,
      "info",
    );
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!active || !stopAfterCompactFailure) return;
    stopAfterCompactFailure = false;
    ctx.abort();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!active) return;
    lastCtx = ctx;
    if (selfResume) {
      selfResume = false;
      return;
    }
    // 压缩前已接收的用户请求仍属于被中止的原轮次。
    if (stopAfterCompactFailure && pending?.reason === "compact") return;
    // 用户自己开口了，连续故障的账重新从零算起。
    transientAttempts = 0;
    transientAdvised = false;
    transientHit = false;
    transientError = undefined;
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
    // 存完立刻刷新状态栏：这几个开关现在都显示在那一行里，
    // 等到下一次轮询（最长一分钟）才变的话，「现在到底开没开」又得靠猜。
    const persist = (patch: Partial<QuotaConfig>): void => {
      config = saveConfig(agentDir, patch);
      refreshStatus(ctx);
    };
    if (action === "status") {
      persist({ status: on });
      startPolling(ctx);
      notify(ctx, on ? "状态栏配额已开启" : "状态栏配额已关闭", "info");
      return;
    }
    if (action === "wait") {
      persist({ autoWait: on });
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
    if (action === "retry") {
      persist({ retryOnError: on });
      transientAttempts = 0;
      transientHit = false;
      transientError = undefined;
      if (!on) {
        if (pending?.reason === "error") clearWait("上游故障重试已关闭", ctx);
        notify(ctx, "上游故障自动重试已关闭", "info");
        return;
      }
      const note = `5xx / 超时 / 连接中断时等 ${config.errorRetrySeconds}s 起退避重试，最多 ${config.maxErrorRetries} 次`;
      notify(ctx, `上游故障自动重试已开启：${note}`, "info");
      return;
    }
    persist({ debug: on });
    notify(ctx, on ? `已开启调试日志：${join(agentDir, LOG_FILE)}` : "已关闭调试日志", "info");
  }

  pi.registerCommand("v2ex", {
    description: "查看 V2EX 配额，设置自动续跑、上游重试与临时上下文窗口",
    getArgumentCompletions: (prefix: string) => {
      const items = SUBCOMMANDS.filter((item) => item.value.startsWith(prefix));
      return items.length > 0 ? [...items] : null;
    },
    handler: async (args, ctx) => {
      if (!active) {
        notify(ctx, "请先切换到 V2EX 模型，再使用 /v2ex", "info");
        return;
      }
      lastCtx = ctx;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens[0] ?? "";
      const value = tokens[1] ?? "";

      if (action === "compact") {
        if (value === "" || value === "status") {
          notify(ctx, compactWindow.status(ctx, config), "info");
          return;
        }
        if (!ctx.isIdle()) {
          notify(ctx, "请先等待当前任务结束，再调整临时窗口", "warning");
          return;
        }
        try {
          if (value === "off") {
            if (pending?.reason === "compact") clearWait("临时窗口已关闭", ctx);
            stopAfterCompactFailure = false;
            await compactWindow.restore(ctx);
            config = saveConfig(agentDir, { compactWindowEnabled: false });
          } else if (value === "on" || value === "window") {
            const window = value === "on" ? config.compactWindowTokens : parseWindow(tokens[2] ?? "");
            if (window === undefined || tokens.length !== (value === "on" ? 2 : 3)) {
              notify(ctx, "用法：/v2ex compact window 400k，或 /v2ex compact on|off|status", "warning");
              return;
            }
            try {
              compactWindow.validate(ctx.model!, window);
            } catch (error) {
              notify(ctx, `临时窗口设置失败：${errorText(error)}`, "warning");
              return;
            }
            compactWindow.resume();
            const next = { ...config, compactWindowEnabled: true, compactWindowTokens: window };
            await compactWindow.sync(ctx, next);
            config = saveConfig(agentDir, next);
          } else {
            notify(ctx, "用法：/v2ex compact window 400k，或 /v2ex compact on|off|status", "warning");
            return;
          }
          notify(ctx, compactWindow.status(ctx, config), "info");
        } catch (error) {
          await compactWindow.pause(ctx);
          notify(ctx, `临时窗口设置失败：${errorText(error)}`, "warning");
        }
        return;
      }
      if (action === "") {
        await pollQuota(ctx);
        toggleDetails(ctx);
        return;
      }
      if (action === "refresh") {
        const fetched = await pollQuota(ctx);
        if (!active) return;
        if (!fetched) {
          notify(ctx, "配额查询失败，开启 /v2ex debug on 可看日志", "warning");
          return;
        }
        const view = buildStatus({
          window: latest,
          now: Date.now(),
          waiting: pending !== undefined,
          waitReason: pending?.reason,
          resumeAt: pending?.resumeAt,
        });
        notify(ctx, view.text, "info");
        return;
      }
      if (action === "start") {
        // 提示词可选：`/v2ex start 继续改 xxx` 决定续跑时注入什么。
        const prompt = tokens.slice(1).join(" ").trim();
        await startWait(ctx, prompt.length > 0 ? prompt : undefined);
        return;
      }
      if (action === "cancel") {
        transientAttempts = 0;
        transientHit = false;
        transientError = undefined;
        if (!pending) {
          notify(ctx, "当前没有等待中的自动续跑", "info");
          return;
        }
        clearWait("用户取消", ctx);
        notify(ctx, "已取消等待中的自动续跑", "info");
        return;
      }
      if (action === "status" || action === "wait" || action === "retry" || action === "debug") {
        if (value !== "on" && value !== "off") {
          notify(ctx, `用法：/v2ex ${action} on|off`, "warning");
          return;
        }
        await applyToggle(ctx, action, value === "on");
        return;
      }
      notify(
        ctx,
        `未知子命令：${action}（可用 refresh / start / cancel / status on|off / wait on|off` +
          ` / retry on|off / compact window <tokens> / compact on|off|status / debug on|off）`,
        "warning",
      );
    },
  });
}
