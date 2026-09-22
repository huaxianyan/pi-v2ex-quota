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
}

export async function fetchQuota(
  endpoint: V2exEndpoint,
  options: FetchQuotaOptions = {},
): Promise<QuotaWindow> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(quotaUrl(endpoint.baseUrl), {
    headers: { Authorization: `Bearer ${endpoint.apiKey}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) {
    throw new Error(`配额接口返回 HTTP ${response.status}`);
  }
  return parseQuotaResponse(await response.json());
}
