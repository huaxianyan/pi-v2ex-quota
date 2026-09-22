import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyTransientError,
  fetchQuota,
  isExhausted,
  isQuotaExhaustedSignal,
  parseQuotaHeaders,
  parseQuotaResponse,
  quotaUrl,
  readV2exProvider,
  resetDeadlineMs,
  type QuotaWindow,
} from "../src/v2ex.ts";

/** 与 2026-09-22 实测响应一致，只是把数字换成好读的值。 */
const QUOTA_BODY = {
  success: true,
  message: "Current AI Chat 5h quota",
  result: {
    active: true,
    total_tokens: 8_020_000,
    used_tokens: 4_010_000,
    remaining_tokens: 4_010_000,
    used_percent: 50,
    period_start: 1_790_057_684,
    period_end: 1_790_075_684,
    extra_usage: { pack_count: 0, total_tokens: 0, used_tokens: 0, remaining_tokens: 0 },
  },
};

test("quotaUrl 从 chat/v1 基址推出配额接口", () => {
  assert.equal(
    quotaUrl("https://edge.v2ex.com/chat/v1"),
    "https://edge.v2ex.com/api/v2/chat/quota",
  );
  assert.equal(
    quotaUrl("https://edge.v2ex.com/chat/v1/"),
    "https://edge.v2ex.com/api/v2/chat/quota",
  );
});

test("parseQuotaResponse 读出窗口全量字段", () => {
  const window = parseQuotaResponse(QUOTA_BODY);
  assert.equal(window.active, true);
  assert.equal(window.totalTokens, 8_020_000);
  assert.equal(window.usedTokens, 4_010_000);
  assert.equal(window.remainingTokens, 4_010_000);
  assert.equal(window.usedPercent, 50);
  assert.equal(window.periodEnd, 1_790_075_684);
  assert.equal(window.extraRemainingTokens, 0);
});

test("parseQuotaResponse 在 success=false 时抛错", () => {
  assert.throws(() => parseQuotaResponse({ success: false }), /success=false/);
});

test("parseQuotaResponse 容忍缺字段，缺失即当 0", () => {
  const window = parseQuotaResponse({ success: true, result: { active: false } });
  assert.equal(window.active, false);
  assert.equal(window.remainingTokens, 0);
  assert.equal(window.periodEnd, 0);
});

test("parseQuotaHeaders 从响应头还原窗口，且大小写不敏感", () => {
  const window = parseQuotaHeaders({
    "X-AI-Chat-Token-Limit": "8020000",
    "X-AI-Chat-Token-Remaining": "2005000",
    "X-AI-Chat-Token-Reset": "1790075684",
    "X-AI-Chat-Extra-Usage-Remaining": "120000",
  });
  assert.ok(window);
  assert.equal(window.totalTokens, 8_020_000);
  assert.equal(window.remainingTokens, 2_005_000);
  assert.equal(window.usedTokens, 8_020_000 - 2_005_000);
  assert.equal(window.periodEnd, 1_790_075_684);
  assert.equal(window.extraRemainingTokens, 120_000);
});

test("parseQuotaHeaders 在缺少用量头时返回 undefined", () => {
  assert.equal(parseQuotaHeaders({}), undefined);
  assert.equal(parseQuotaHeaders(undefined), undefined);
  assert.equal(parseQuotaHeaders({ "x-ai-chat-token-remaining": "1" }), undefined);
});

test("只有 429 且 token 余额为 0 才算配额用尽", () => {
  const exhausted = { "x-ai-chat-token-remaining": "0" };
  const perMinuteLimit = { "x-ai-chat-token-remaining": "1200000" };
  assert.equal(isQuotaExhaustedSignal(429, exhausted), true);
  assert.equal(isQuotaExhaustedSignal(429, perMinuteLimit), false);
  assert.equal(isQuotaExhaustedSignal(200, exhausted), false);
  assert.equal(isQuotaExhaustedSignal(429, {}), false);
});

test("额外用量还有余额时不算用尽", () => {
  const base: QuotaWindow = {
    active: true,
    totalTokens: 100,
    usedTokens: 100,
    remainingTokens: 0,
    usedPercent: 100,
    periodStart: 1,
    periodEnd: 2,
    extraRemainingTokens: 0,
  };
  assert.equal(isExhausted(base), true);
  assert.equal(isExhausted({ ...base, extraRemainingTokens: 5 }), false);
  assert.equal(isExhausted(undefined), false);
});

test("resetDeadlineMs 只在窗口有效时给出时间", () => {
  const base: QuotaWindow = {
    active: true,
    totalTokens: 1,
    usedTokens: 0,
    remainingTokens: 1,
    usedPercent: 0,
    periodStart: 100,
    periodEnd: 1_790_075_684,
    extraRemainingTokens: 0,
  };
  assert.equal(resetDeadlineMs(base), 1_790_075_684_000);
  assert.equal(resetDeadlineMs({ ...base, active: false }), undefined);
  assert.equal(resetDeadlineMs({ ...base, periodEnd: 0 }), undefined);
});

test("readV2exProvider 取出 baseUrl 与 apiKey", () => {
  const text = JSON.stringify({
    providers: {
      v2ex: { baseUrl: "https://edge.v2ex.com/chat/v1", api: "openai-completions", apiKey: "abc" },
      oneapi: { baseUrl: "https://example.com/v1", apiKey: "def" },
    },
  });
  assert.deepEqual(readV2exProvider(text, {}), {
    baseUrl: "https://edge.v2ex.com/chat/v1",
    apiKey: "abc",
  });
});

test("readV2exProvider 支持环境变量形式的 apiKey", () => {
  const text = JSON.stringify({
    providers: { v2ex: { baseUrl: "https://edge.v2ex.com/chat/v1", apiKey: "$V2EX_KEY" } },
  });
  assert.deepEqual(readV2exProvider(text, { V2EX_KEY: "from-env" }), {
    baseUrl: "https://edge.v2ex.com/chat/v1",
    apiKey: "from-env",
  });
  assert.equal(readV2exProvider(text, {}), undefined);
});

test("readV2exProvider 对坏输入返回 undefined 而不是抛错", () => {
  assert.equal(readV2exProvider("{ not json", {}), undefined);
  assert.equal(readV2exProvider("{}", {}), undefined);
  assert.equal(
    readV2exProvider(JSON.stringify({ providers: { v2ex: { baseUrl: "" } } }), {}),
    undefined,
  );
});

test("fetchQuota 带上 Bearer 头并解析响应", async () => {
  let seenUrl = "";
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    assert.equal(
      (init?.headers as Record<string, string>)["Authorization"],
      "Bearer token-1",
    );
    return new Response(JSON.stringify(QUOTA_BODY), { status: 200 });
  }) as typeof fetch;

  const window = await fetchQuota(
    { baseUrl: "https://edge.v2ex.com/chat/v1", apiKey: "token-1" },
    { fetchImpl },
  );
  assert.equal(seenUrl, "https://edge.v2ex.com/api/v2/chat/quota");
  assert.equal(window.remainingTokens, 4_010_000);
});

test("fetchQuota 在非 2xx 时抛错", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(
    fetchQuota({ baseUrl: "https://edge.v2ex.com/chat/v1", apiKey: "t" }, { fetchImpl }),
    /HTTP 500/,
  );
});

test("上游瞬时故障的识别：只认值得重试的那几类", () => {
  // 实测原话：Cloudflare 522 被 pi 压成「522 status code (no body)」。
  assert.deepEqual(classifyTransientError("522 status code (no body)"), {
    kind: "server",
    status: 522,
    label: "HTTP 522",
  });
  assert.equal(classifyTransientError("503 status code (no body)")?.kind, "server");
  // 别的客户端会把状态码写成别的语序，认得出就行。
  assert.equal(classifyTransientError("HTTP 502 Bad Gateway")?.status, 502);
  assert.equal(classifyTransientError("Request failed with status code 503")?.kind, "server");
  // 每分钟限流也是「等一会儿再来」，值得重试；配额用尽在下面单独排除。
  assert.equal(classifyTransientError("429 status code (no body)")?.status, 429);
  assert.equal(classifyTransientError("Request timed out")?.kind, "timeout");
  assert.equal(classifyTransientError("connect ETIMEDOUT 1.2.3.4:443")?.kind, "network");
  assert.equal(classifyTransientError("fetch failed")?.kind, "network");
  assert.equal(classifyTransientError("read ECONNRESET")?.kind, "network");
  assert.equal(classifyTransientError("socket hang up")?.kind, "network");
  // pi 对连不上的 provider 会直接说 Connection error.，字面里什么细节都没有。
  assert.equal(classifyTransientError("Connection error.")?.kind, "network");
  // 端口号长得像状态码（5000），没有 HTTP 语境就不该当成状态码。
  assert.equal(classifyTransientError("connect ECONNREFUSED 127.0.0.1:5000")?.kind, "network");
});

test("上游瞬时故障的识别：不该重试的一律返回 undefined", () => {
  // 配额用尽归 autoWait 管，走到这里会变成「等 5 小时再重试」，必须挡住。
  assert.equal(classifyTransientError("quota exhausted"), undefined);
  assert.equal(classifyTransientError("429 insufficient_quota"), undefined);
  // 请求本身有问题，重试只会白等。
  assert.equal(classifyTransientError("400 status code (no body)"), undefined);
  assert.equal(classifyTransientError("401 unauthorized"), undefined);
  assert.equal(classifyTransientError("404 status code (no body)"), undefined);
  assert.equal(classifyTransientError("模型返回了无法解析的内容"), undefined);
});
