/**
 * 状态栏文案与用量格式化。纯函数，不依赖 pi 运行时，便于直接测试。
 */

import type { WaitReason } from "./config.ts";
import { isExhausted, remainingPercent, resetDeadlineMs, type QuotaWindow } from "./v2ex.ts";

export type StatusLevel = "ok" | "low" | "empty" | "waiting" | "idle" | "unknown";

/** 等待原因定义在 config（它同时是等待计划的落盘字段），这里转发一下方便调用方引用。 */
export type { WaitReason };

export interface StatusView {
  text: string;
  level: StatusLevel;
}

export const LABEL = "v2ex";

/** 剩余比例低于该值时状态转为告警色。 */
export const LOW_REMAINING_PERCENT = 15;

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

export interface StatusInput {
  window: QuotaWindow | undefined;
  now: number;
  waiting: boolean;
  /** 等待原因，缺省按「等配额刷新」处理。 */
  waitReason?: WaitReason;
  /** 等待到点的时刻；缺省时退回按窗口重置时间推算。 */
  resumeAt?: number;
}

/** 状态栏单行文案。百分比是剩余额度，时间是距离窗口重置（或距离下次重试）。 */
export function buildStatus(input: StatusInput): StatusView {
  const { window, now, waiting, waitReason } = input;
  const deadline = input.resumeAt ?? resetDeadlineMs(window);
  const countdown = deadline === undefined ? "" : formatDuration(deadline - now);

  if (waiting) {
    // 上游故障与额度无关，窗口里还有量也照样在等重试。
    if (waitReason === "error") {
      return { text: `${LABEL} 重试 ${countdown || "中"}`, level: "waiting" };
    }
    if (!window || !window.active || isExhausted(window)) {
      return { text: `${LABEL} 等待 ${countdown || "刷新"}`, level: "waiting" };
    }
  }

  if (!window) return { text: `${LABEL} --`, level: "unknown" };
  if (!window.active) return { text: `${LABEL} 空闲`, level: "idle" };

  if (isExhausted(window)) {
    const suffix = countdown ? ` · ${countdown}` : "";
    return { text: `${LABEL} 0%${suffix}`, level: "empty" };
  }

  const percent = Math.round(remainingPercent(window));
  const parts = [`${LABEL} ${percent}%`];
  if (countdown) parts.push(countdown);
  if (window.extraRemainingTokens > 0) parts.push(`+${formatTokens(window.extraRemainingTokens)}`);

  return {
    text: parts.join(" · "),
    level: percent <= LOW_REMAINING_PERCENT ? "low" : "ok",
  };
}

export interface DetailsInput extends StatusInput {
  autoWaitLabel: string;
  retryOnErrorLabel: string;
  /** 代理的展示文案，已由调用方格式化（未设置时给「未设置（直连）」）。 */
  proxyLabel: string;
}

/** `/v2ex` 面板的多行详情。 */
export function buildDetails(input: DetailsInput): string[] {
  const { window, now, waiting, waitReason, autoWaitLabel, retryOnErrorLabel, proxyLabel } = input;
  const toggles = [
    `自动续跑：${autoWaitLabel}`,
    `上游重试：${retryOnErrorLabel}`,
    `查询代理：${proxyLabel}`,
  ];
  const lines = ["V2EX AI Chat 配额"];
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
        : `上游故障，${formatDuration(resumeAt - now)} 后自动重试`,
    );
  }
  if (isExhausted(window)) {
    lines.push(waiting ? "配额已用尽，正在等待刷新后自动续跑" : "配额已用尽");
  }
  lines.push(...toggles);
  return lines;
}
