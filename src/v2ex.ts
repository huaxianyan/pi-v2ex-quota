/**
 * V2EX AI Chat 配额协议：接口形状、响应头、错误信号。
 *
 * 协议依据 https://edge.v2ex.com/help/quota ：
 * - 用量按 token 计，每 5 小时一个配额窗口，窗口用完即止，不累积；
 * - 无有效窗口时，下一条消息才开始新窗口，查询本身不会开窗口；
 * - GET /api/v2/chat/quota 返回窗口总配额、已用、剩余、已用百分比、窗口起止与额外用量；
 * - OpenAI 兼容接口的每个响应都带 X-AI-Chat-* 头，流式响应反映请求开始时的余额；
 * - 配额用尽时新消息收到 429，body 为 rate_limit_error / rate_limit_exceeded。
 */

import { createFetch } from "./proxy.ts";

export const QUOTA_PATH = "/api/v2/chat/quota";

export const TOKEN_LIMIT_HEADER = "x-ai-chat-token-limit";
export const TOKEN_REMAINING_HEADER = "x-ai-chat-token-remaining";
export const TOKEN_RESET_HEADER = "x-ai-chat-token-reset";
export const EXTRA_USAGE_HEADER = "x-ai-chat-extra-usage-remaining";

/**
 * 配额用尽的错误文案。pi 把 429 归为「可重试」，所以不能只看状态码：
 * 每分钟请求限流也是 429，只有 token 余额归零才是配额用尽。
 */
export const QUOTA_EXHAUSTED_PATTERN =
  /quota exhausted|quota_exceeded|quota exceeded|insufficient_quota/i;

export interface QuotaWindow {
  /** 是否存在有效的配额窗口。false 时 periodStart/periodEnd 均为 0，下一条消息会开新窗口。 */
  active: boolean;
  totalTokens: number;
  usedTokens: number;
  remainingTokens: number;
  usedPercent: number;
  /** Unix 秒。 */
  periodStart: number;
  /** Unix 秒，即下次刷新时间。 */
  periodEnd: number;
  extraRemainingTokens: number;
}

export interface V2exEndpoint {
  baseUrl: string;
  apiKey: string;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 从 OpenAI 兼容响应的 X-AI-Chat-* 头还原一个窗口快照。头不齐时返回 undefined。 */
export function parseQuotaHeaders(
  headers: Record<string, string> | undefined,
): QuotaWindow | undefined {
  if (!headers) return undefined;
  const total = toNumber(headerValue(headers, TOKEN_LIMIT_HEADER));
  const remaining = toNumber(headerValue(headers, TOKEN_REMAINING_HEADER));
  if (total === undefined || remaining === undefined) return undefined;
  return {
    active: true,
    totalTokens: total,
    usedTokens: Math.max(0, total - remaining),
    remainingTokens: Math.max(0, remaining),
    usedPercent: total > 0 ? Math.min(100, Math.max(0, ((total - remaining) / total) * 100)) : 0,
    periodStart: 0,
    periodEnd: toNumber(headerValue(headers, TOKEN_RESET_HEADER)) ?? 0,
    extraRemainingTokens: toNumber(headerValue(headers, EXTRA_USAGE_HEADER)) ?? 0,
  };
}

/**
 * 判定「配额确实用尽」而不是「每分钟请求限流」。
 * 依据：状态码 429，且 token 余额头为 0。请求限流时余额头仍大于 0。
 */
export function isQuotaExhaustedSignal(
  status: number,
  headers: Record<string, string> | undefined,
): boolean {
  if (status !== 429) return false;
  const remaining = toNumber(headerValue(headers ?? {}, TOKEN_REMAINING_HEADER));
  return remaining === 0;
}

/**
 * 上游瞬时故障的类别。只有「再试一次有可能成」的错误才值得等：
 * 服务端错了、请求超时了、连接断了。
 */
export type TransientErrorKind = "server" | "timeout" | "network";

export interface TransientError {
  kind: TransientErrorKind;
  /** HTTP 状态码，仅 kind 为 server 时有值。 */
  status?: number;
  /** 通知与状态栏里用的简短描述。 */
  label: string;
}

/** 429 是「等一会儿再来」，不是「服务端坏了」。 */
const RATE_LIMIT_STATUS = 429;

/**
 * HTTP 状态码必须带语境才认。pi 的报错形如 `522 status code (no body)`，
 * 别处可能是 `HTTP 502` 或 `status code 500`。
 *
 * 之所以不直接抓三位数：错误文案里常混着端口号（443）之类的数字，
 * 光看形状会把 `connect ETIMEDOUT 1.2.3.4:443` 认成 HTTP 443，
 * 于是把一条本该重试的连接超时错判成「请求有问题，不重试」。
 */
const HTTP_STATUS_PATTERN =
  /(?:^|[^\d])([45]\d{2})\s+status\s+code\b|\bstatus\s*code[:\s]+([45]\d{2})\b|\bHTTP\/?[\d.]*\s+([45]\d{2})\b/i;

const TIMEOUT_PATTERN = /timeout|timed out/i;
/**
 * 连接层面的中断。
 *
 * 除了 unix 错误码，还要认 pi 自己的措辞：provider 连接不上（含 522 这种空 body
 * 的响应）时，pi 会把它压成一句 `Connection error.`，字面里没有任何细节。
 * ETIMEDOUT 归这里而不是超时那条：它是 socket 层的连接超时，
 * 与「请求发出去了但对方没回」不是一回事。注意 ETIMEDOUT 里并没有连续的
 * TIMEOUT 子串（中间隔着 D），不会被上面那条吃掉。
 */
const NETWORK_PATTERN =
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|other side closed|UND_ERR_|connection error|network error/i;

function httpStatusFromMessage(message: string): number | undefined {
  const match = HTTP_STATUS_PATTERN.exec(message);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  return raw === undefined ? undefined : Number(raw);
}

/**
 * 从 pi 压平的 errorMessage 里判断这是不是一次值得重试的上游故障。
 *
 * pi 把 provider 报错收敛成一句话，例如 `522 status code (no body)`、
 * `Request timed out`。4xx 里除了限流都是请求本身的问题，重试只会白等，
 * 所以直接返回 undefined。
 */
export function classifyTransientError(message: string): TransientError | undefined {
  if (QUOTA_EXHAUSTED_PATTERN.test(message)) return undefined;
  const status = httpStatusFromMessage(message);
  if (status !== undefined) {
    if (status === RATE_LIMIT_STATUS || status >= 500) {
      return { kind: "server", status, label: `HTTP ${status}` };
    }
    return undefined;
  }
  if (TIMEOUT_PATTERN.test(message)) return { kind: "timeout", label: "请求超时" };
  if (NETWORK_PATTERN.test(message)) return { kind: "network", label: "连接中断" };
  return undefined;
}

/** 窗口与额外用量都见底，才是真的没得用。 */
export function isExhausted(window: QuotaWindow | undefined): boolean {
  if (!window) return false;
  return window.remainingTokens <= 0 && window.extraRemainingTokens <= 0;
}

/** 距离窗口重置的毫秒数；窗口未开始或时间戳缺失时为 undefined。 */
export function resetDeadlineMs(window: QuotaWindow | undefined): number | undefined {
  if (!window || !window.active || window.periodEnd <= 0) return undefined;
  return window.periodEnd * 1000;
}

export function remainingPercent(window: QuotaWindow): number {
  return Math.min(100, Math.max(0, 100 - window.usedPercent));
}

export function quotaUrl(baseUrl: string): string {
  return new URL(QUOTA_PATH, new URL(baseUrl).origin).toString();
}

/** 解析 models.json 里的 apiKey 写法：字面量、$VAR 或 ${VAR}。 */
export function resolveApiKey(raw: string, env: Record<string, string | undefined>): string {
  const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw.trim());
  if (braced) return env[braced[1]] ?? "";
  const plain = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw.trim());
  if (plain) return env[plain[1]] ?? "";
  return raw;
}

/** 从 models.json 文本里取出 v2ex provider 的 baseUrl 与 apiKey。 */
export function readV2exProvider(
  modelsJsonText: string,
  env: Record<string, string | undefined>,
): V2exEndpoint | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(modelsJsonText);
  } catch {
    return undefined;
  }
  const providers = (parsed as { providers?: Record<string, unknown> } | null)?.providers;
  const v2ex = providers?.["v2ex"] as { baseUrl?: unknown; apiKey?: unknown } | undefined;
  if (!v2ex) return undefined;
  const { baseUrl, apiKey } = v2ex;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return undefined;
  if (typeof apiKey !== "string" || apiKey.length === 0) return undefined;
  const resolved = resolveApiKey(apiKey, env);
  if (resolved.length === 0) return undefined;
  return { baseUrl, apiKey: resolved };
}

function toFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseWindowResult(result: unknown): QuotaWindow | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const raw = result as Record<string, unknown>;
  const num = (key: string): number => toFiniteNumber(raw[key]);
  const extra = raw["extra_usage"];
  const extraRemaining =
    typeof extra === "object" && extra !== null
      ? toFiniteNumber((extra as Record<string, unknown>)["remaining_tokens"])
      : 0;
  return {
    active: raw["active"] === true,
    totalTokens: num("total_tokens"),
    usedTokens: num("used_tokens"),
    remainingTokens: num("remaining_tokens"),
    usedPercent: num("used_percent"),
    periodStart: num("period_start"),
    periodEnd: num("period_end"),
    extraRemainingTokens: extraRemaining,
  };
}

export function parseQuotaResponse(raw: unknown): QuotaWindow {
  const body = raw as { success?: unknown; result?: unknown } | null;
  if (!body || body.success !== true) {
    throw new Error("配额接口返回 success=false");
  }
  const window = parseWindowResult(body.result);
  if (!window) throw new Error("配额接口返回结构无法识别");
  return window;
}

export interface FetchQuotaOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 走本地 HTTP 代理查询；空或未设置表示直连。 */
  proxy?: string;
}

export async function fetchQuota(
  endpoint: V2exEndpoint,
  options: FetchQuotaOptions = {},
): Promise<QuotaWindow> {
  const doFetch = options.fetchImpl ?? createFetch(options.proxy);
  const response = await doFetch(quotaUrl(endpoint.baseUrl), {
    headers: { Authorization: `Bearer ${endpoint.apiKey}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) {
    throw new Error(`配额接口返回 HTTP ${response.status}`);
  }
  return parseQuotaResponse(await response.json());
}
