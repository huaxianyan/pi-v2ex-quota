/**
 * 状态栏文案与用量格式化。纯函数，不依赖 pi 运行时，便于直接测试。
 */

import type { WaitReason } from "./config.ts";
import { isExhausted, remainingPercent, resetDeadlineMs, type QuotaWindow } from "./v2ex.ts";

export type StatusLevel = "ok" | "low" | "empty" | "waiting" | "idle" | "unknown";

/** 等待原因定义在 config（它同时是等待计划的落盘字段），这里转发一下方便调用方引用。 */
export type { WaitReason };

/**
 * 渲染时的取色档位。`text` 只有一个字符串，做不到逐段上色 ——
 * 进度条的空格要比实心格暗一档，配置段也该比配额暗，所以另给一份分段。
 */
export type StatusTone = "level" | "dim";

export interface StatusSegment {
  text: string;
  tone: StatusTone;
}

export interface StatusView {
  /** 各段拼起来的纯文本，通知与断言都读它。 */
  text: string;
  level: StatusLevel;
  segments: StatusSegment[];
}

export const LABEL = "V2EX";

/** 剩余比例低于该值时状态转为告警色。 */
export const LOW_REMAINING_PERCENT = 15;

/**
 * 倒计时算作「已到点」的余量：不足一秒就当已经归零。
 *
 * 显示粒度是秒，`0.4s` 与 `0s` 在状态栏上是同一个样子；非等到它真的走到负数
 * 再换文案，中间会白挂一秒「等待 0s」。
 */
export const COUNTDOWN_DUE_MS = 1_000;

/** 进度条格数，与 pi-usage-bars 页脚那条一致：够看出来，又不至于把状态栏撑满。 */
export const BAR_WIDTH = 8;
export const BAR_FILLED = "█";
export const BAR_EMPTY = "░";

/**
 * 状态栏里「配额」与「开关」两段之间的分隔符。
 *
 * 段内统一用 ` · `，段间换成更重一档的竖线：一行里同时有倒计时和三个开关时，
 * 光靠同一种分隔符会读成一串平铺的字段，分不出哪些在说额度、哪些在说配置。
 */
export const SEGMENT_SEPARATOR = " | ";

/**
 * 状态栏尾部那两个开关的当前状态。
 *
 * 都是全局配置、与具体窗口无关，所以不复用配额那套颜色；关着的也要显示，
 * 否则「现在到底开没开」就得靠 `/v2ex` 面板或翻配置来确认。
 */
export interface StatusToggles {
  /** 配额用尽后是否等待刷新并自动续跑。 */
  autoWait: boolean;
  /** 上游瞬时故障后是否自动重试。 */
  retryOnError: boolean;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d${restHours}h`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function formatTimestamp(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * 额度进度条：实心格表示**剩余**，与旁边的百分比一个口径。
 *
 * 满格只在真正满额时出现，其余向上封到 `BAR_WIDTH - 1`：四舍五入的话 97%
 * 也会画成满格，看着像一点没用，比旁边的数字还误导。
 */
function buildBar(percent: number): { filled: string; empty: string } {
  const clamped = Math.min(100, Math.max(0, percent));
  const count =
    clamped >= 100 ? BAR_WIDTH : Math.min(BAR_WIDTH - 1, Math.round((clamped / 100) * BAR_WIDTH));
  return {
    filled: BAR_FILLED.repeat(count),
    empty: BAR_EMPTY.repeat(BAR_WIDTH - count),
  };
}

export interface StatusInput {
  window: QuotaWindow | undefined;
  now: number;
  waiting: boolean;
  /** 等待原因，缺省按「等配额刷新」处理。 */
  waitReason?: WaitReason;
  /** 等待到点的时刻；缺省时退回按窗口重置时间推算。 */
  resumeAt?: number;
  /** 开关状态段；缺省时整段省略（命令回执这类只看配额的地方不必带）。 */
  toggles?: StatusToggles;
}

function plainView(text: string, level: StatusLevel): StatusView {
  return { text, level, segments: [{ text, tone: "level" }] };
}

/** 配额那一段：进度条、百分比（或等待状态）与倒计时。百分比是剩余额度。 */
function buildQuotaSegment(input: StatusInput): StatusView {
  const { window, now, waiting, waitReason } = input;
  const deadline = input.resumeAt ?? resetDeadlineMs(window);
  const left = deadline === undefined ? undefined : deadline - now;
  const countdown = left === undefined ? "" : formatDuration(left);
  const due = left !== undefined && left < COUNTDOWN_DUE_MS;

  if (waiting) {
    // 上游故障与额度无关，窗口里还有量也照样在等重试。
    if (waitReason === "error") {
      // 倒计时归零后改说「即将」：到点与真正续跑之间还隔着一次复核与消息注入，
      // 盯着一个不动的 `0s` 会以为卡住了。
      return plainView(due ? `${LABEL} 即将重试` : `${LABEL} 重试 ${countdown || "中"}`, "waiting");
    }
    if (!window || !window.active || isExhausted(window)) {
      return plainView(due ? `${LABEL} 即将开始` : `${LABEL} 等待 ${countdown || "刷新"}`, "waiting");
    }
  }

  if (!window) return plainView(`${LABEL} --`, "unknown");
  if (!window.active) return plainView(`${LABEL} 空闲`, "idle");

  const percent = Math.round(remainingPercent(window));
  const bar = buildBar(percent);
  const tail = [
    `${percent}%`,
    countdown,
    window.extraRemainingTokens > 0 ? `+${formatTokens(window.extraRemainingTokens)}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" · ");

  const level: StatusLevel = isExhausted(window)
    ? "empty"
    : percent <= LOW_REMAINING_PERCENT
      ? "low"
      : "ok";

  // 空格子单独一段，渲染时压暗：一整条同色的话，「还剩多少」要数格子才能看出来。
  const segments: StatusSegment[] = [
    { text: `${LABEL} `, tone: "level" },
    { text: bar.filled, tone: "level" },
    { text: bar.empty, tone: "dim" },
    { text: ` ${tail}`, tone: "level" },
  ];
  return { text: segments.map((segment) => segment.text).join(""), level, segments };
}

/** 开关状态段，形如 `续跑 开 · 重试 关`。没有配置信息时给 undefined。 */
function buildToggleSegment(toggles: StatusToggles | undefined): StatusSegment | undefined {
  if (!toggles) return undefined;
  const onOff = (value: boolean) => (value ? "开" : "关");
  return {
    text: [`续跑 ${onOff(toggles.autoWait)}`, `重试 ${onOff(toggles.retryOnError)}`].join(" · "),
    // 配置是静态信息，比实时额度暗一档，眼神先落在配额上。
    tone: "dim",
  };
}

/**
 * 状态栏单行文案：前半是配额，后半是两项开关的当前状态。
 *
 * 颜色只看配额那一段 —— 开关是静态配置，开着还是关着不该让状态栏变色。
 */
export function buildStatus(input: StatusInput): StatusView {
  const quota = buildQuotaSegment(input);
  const toggles = buildToggleSegment(input.toggles);
  if (!toggles) return quota;

  const segments: StatusSegment[] = [
    ...quota.segments,
    { text: SEGMENT_SEPARATOR, tone: "dim" },
    toggles,
  ];
  return { text: segments.map((segment) => segment.text).join(""), level: quota.level, segments };
}

export interface DetailsInput extends StatusInput {
  autoWaitLabel: string;
  retryOnErrorLabel: string;
}

/** `/v2ex` 面板的多行详情。 */
export function buildDetails(input: DetailsInput): string[] {
  const { window, now, waiting, waitReason, autoWaitLabel, retryOnErrorLabel } = input;
  const toggles = [`自动续跑：${autoWaitLabel}`, `上游重试：${retryOnErrorLabel}`];
  const lines = [`${LABEL} AI Chat 配额`];
  if (!window) {
    lines.push("尚未取到配额数据，/v2ex refresh 重试", ...toggles);
    return lines;
  }
  if (!window.active) {
    lines.push("当前没有有效窗口，发送下一条消息时开始新的 5 小时窗口", ...toggles);
    return lines;
  }

  const remaining = remainingPercent(window);
  lines.push(
    `窗口已用 ${formatTokens(window.usedTokens)} / ${formatTokens(window.totalTokens)}`,
    `剩余 ${formatTokens(window.remainingTokens)}（${remaining.toFixed(0)}%）`,
  );
  if (window.extraRemainingTokens > 0) {
    lines.push(`额外用量剩余 ${formatTokens(window.extraRemainingTokens)}`);
  }
  const deadline = resetDeadlineMs(window);
  if (deadline !== undefined) {
    lines.push(`重置 ${formatTimestamp(window.periodEnd)}（${formatDuration(deadline - now)} 后）`);
  } else if (window.periodEnd > 0) {
    lines.push(`重置 ${formatTimestamp(window.periodEnd)}`);
  }
  if (waiting && waitReason === "error") {
    const resumeAt = input.resumeAt;
    lines.push(
      resumeAt === undefined
        ? "上游故障，正在等待重试"
        : resumeAt - now < COUNTDOWN_DUE_MS
          ? "上游故障，即将自动重试"
          : `上游故障，${formatDuration(resumeAt - now)} 后自动重试`,
    );
  }
  if (isExhausted(window)) {
    const left = input.resumeAt === undefined ? undefined : input.resumeAt - now;
    lines.push(
      !waiting
        ? "配额已用尽"
        : left !== undefined && left < COUNTDOWN_DUE_MS
          ? "配额已用尽，即将自动续跑"
          : "配额已用尽，正在等待刷新后自动续跑",
    );
  }
  lines.push(...toggles);
  return lines;
}
