/**
 * 状态栏文案与用量格式化。纯函数，不依赖 pi 运行时，便于直接测试。
 */

import { isExhausted, remainingPercent, resetDeadlineMs, type QuotaWindow } from "./v2ex.ts";

export type StatusLevel = "ok" | "low" | "empty" | "waiting" | "idle" | "unknown";

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
}

/** 状态栏单行文案。百分比是剩余额度，时间是距离窗口重置。 */
export function buildStatus(input: StatusInput): StatusView {
  const { window, now, waiting } = input;
  if (!window) return { text: `${LABEL} --`, level: "unknown" };
  if (!window.active) return { text: `${LABEL} 空闲`, level: "idle" };

  const deadline = resetDeadlineMs(window);
  const countdown = deadline === undefined ? "" : formatDuration(deadline - now);

  if (isExhausted(window)) {
    if (waiting) {
      return { text: `${LABEL} 等待 ${countdown || "刷新"}`, level: "waiting" };
    }
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
}

/** `/v2ex` 面板的多行详情。 */
export function buildDetails(input: DetailsInput): string[] {
  const { window, now, waiting, autoWaitLabel } = input;
  const lines = ["V2EX AI Chat 配额"];
  if (!window) {
    lines.push("尚未取到配额数据，/v2ex refresh 重试");
    return lines;
  }
  if (!window.active) {
    lines.push("当前没有有效窗口，发送下一条消息时开始新的 5 小时窗口");
    lines.push(`自动续跑：${autoWaitLabel}`);
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
  if (isExhausted(window)) {
    lines.push(waiting ? "配额已用尽，正在等待刷新后自动续跑" : "配额已用尽");
  }
  lines.push(`自动续跑：${autoWaitLabel}`);
  return lines;
}
