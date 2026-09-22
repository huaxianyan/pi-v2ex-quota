/**
 * 走本地 HTTP 代理的传输层，只服务配额查询。
 *
 * 为什么不复用现成的能力：
 * - Node 内置的 fetch 是 undici，它不读 HTTPS_PROXY（那是 Node 24 的
 *   NODE_USE_ENV_PROXY 之后才有的事），要让它走代理得拿到 undici 的 ProxyAgent，
 *   而 Node 22 并没有把 undici 暴露成可 import 的模块。
 * - 也不能去动全局 dispatcher：pi 自己的 provider 请求走不走代理是 pi 的事，
 *   扩展把手伸到那儿，等于替用户改了 pi 的行为，比这里要解决的问题还大。
 * - 环境变量就更不合适了 —— 那会连带影响同 shell 里的所有程序，用户明确不想要。
 *
 * 所以这里只用 node 内置模块手搭一条 HTTP CONNECT 隧道：先让代理开隧道拿到裸
 * socket，HTTPS 目标再在它上面补一层 TLS，最后照常交给 http.request 发字节。
 * 好处是零依赖，代价是只支持 http:// 代理 —— SOCKS 要另写一套握手，不值当。
 */

import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { connect as netConnect, isIP } from "node:net";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { TLSSocket } from "node:tls";

export interface ProxyEndpoint {
  host: string;
  port: number;
  /** CONNECT 用的 Proxy-Authorization 头；没配凭据时为空。 */
  authorization?: string;
}

export interface ProxyFetchOptions {
  /**
   * 是否校验证书链，默认 true，与正常 TLS 行为一致。
   * 关掉只为一种场景：目标是自签证书的内网服务（端到端自检里的假上游就是）。
   */
  rejectUnauthorized?: boolean;
  /** 自定义信任链，用途同上。 */
  ca?: string | string[];
}

const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;

/**
 * 解析代理地址。接受 `http://127.0.0.1:37777`，也接受省略协议的 `127.0.0.1:37777`。
 * 只认 http 代理，写 socks5:// 之类会被判成非法而不是悄悄直连 —— 静默失效最难查。
 */
export function parseProxy(raw: string | undefined): ProxyEndpoint | undefined {
  const text = (raw ?? "").trim();
  if (text.length === 0) return undefined;

  let url: URL;
  try {
    url = new URL(SCHEME_PATTERN.test(text) ? text : `http://${text}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:") return undefined;

  // URL 会把 IPv6 字面量裹在方括号里，交给 net 之前得脱掉。
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.length === 0) return undefined;

  const port = url.port.length > 0 ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;

  const authorization =
    url.username.length > 0
      ? `Basic ${Buffer.from(
          `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
        ).toString("base64")}`
      : undefined;

  return { host, port, authorization };
}

/** 配置里存的代理地址一律按这个口径校验：合法就原样保留，非法就退回空串（直连）。 */
export function normalizeProxy(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  return parseProxy(text) ? text : "";
}

/** 给人看的代理描述。凭据不回显内容，只说明有。 */
export function describeProxy(raw: string | undefined): string {
  const endpoint = parseProxy(raw);
  if (!endpoint) return "未设置（直连）";
  return `http://${endpoint.host}:${endpoint.port}${endpoint.authorization ? "（含认证）" : ""}`;
}

/** 按配置挑 fetch 实现：配了代理就走隧道，没配就还是原生 fetch。 */
export function createFetch(proxy: string | undefined, options: ProxyFetchOptions = {}): typeof fetch {
  const endpoint = parseProxy(proxy);
  if (!endpoint) return fetch;
  return createProxyFetch(endpoint, options);
}

function toUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

/** 代理不回话时的兜底上限；平时由调用方的 signal 管超时。 */
const CONNECT_TIMEOUT_MS = 15_000;

/** 响应头都读不到这么多字节，说明对面不是 HTTP 代理。 */
const MAX_CONNECT_RESPONSE = 64 * 1024;

/**
 * 让代理开一条到 host:port 的隧道。
 *
 * 不用 http.request 发 CONNECT：实测它对非 200 的 CONNECT 响应既不发 response
 * 也不发 connect，只是把 socket 挂断成一句 `socket hang up`。代理回了 407
 * 还是 502 完全看不到，而这两种情况的处置方式恰好不同。自己发这几行请求，
 * 状态码就攥在自己手里。
 */
function openTunnel(
  proxy: ProxyEndpoint,
  host: string,
  port: number,
  signal: AbortSignal | undefined,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxy.host, port: proxy.port });
    let settled = false;

    // 用函数声明而不是 const 箭头：这几个互相引用，靠提升避开临时死区。
    function cleanup(): void {
      socket.off("data", onData);
      signal?.removeEventListener("abort", onAbort);
    }
    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    }
    function onAbort(): void {
      fail(new Error(`连接代理 ${proxy.host}:${proxy.port} 已取消`));
    }

    let buffer = Buffer.alloc(0);
    function onData(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffer.length > MAX_CONNECT_RESPONSE) {
          fail(new Error(`代理 ${proxy.host}:${proxy.port} 返回的不是 HTTP 响应`));
        }
        return;
      }

      const statusLine = buffer.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine);
      const status = match ? Number(match[1]) : 0;
      if (status !== 200) {
        const hint = status === 407 ? "（代理要求认证）" : "";
        fail(new Error(`代理 ${proxy.host}:${proxy.port} 拒绝建立隧道：HTTP ${status}${hint}`));
        return;
      }

      // 200 之后不该再有别的字节 —— 隧道是客户端先开口的。真有就丢掉。
      settled = true;
      socket.setTimeout(0);
      cleanup();
      resolve(socket);
    }

    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      fail(new Error(`连接代理 ${proxy.host}:${proxy.port} 超时`));
    });
    socket.on("error", (error) => {
      fail(new Error(`连接代理 ${proxy.host}:${proxy.port} 失败：${error.message}`));
    });
    socket.on("data", onData);
    signal?.addEventListener("abort", onAbort, { once: true });

    const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
    if (proxy.authorization) lines.push(`Proxy-Authorization: ${proxy.authorization}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
}

/** 在已建立的隧道上补一层 TLS。SNI 只在目标是域名时设，IP 字面量设了会被忽略并告警。 */
function upgradeToTls(
  socket: Socket,
  host: string,
  port: number,
  signal: AbortSignal | undefined,
  options: ProxyFetchOptions,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({
      socket,
      // host 是「拿哪个名字校验证书」，SNI 只在目标是域名时才发。
      host,
      servername: isIP(host) === 0 ? host : undefined,
      rejectUnauthorized: options.rejectUnauthorized !== false,
      ca: options.ca,
    });
    tlsSocket.once("secureConnect", () => resolve(tlsSocket));
    tlsSocket.once("error", (error) => {
      reject(new Error(`与 ${host}:${port} 的 TLS 握手失败：${error.message}`));
    });
    signal?.addEventListener("abort", () => tlsSocket.destroy(), { once: true });
  });
}

/** 隧道已经通了，剩下的就是在这条连接上说 HTTP。 */
function sendOverSocket(
  socket: Socket,
  url: URL,
  method: string,
  headers: Headers,
  body: string | undefined,
  signal: AbortSignal | undefined,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const outgoing: Record<string, string> = {};
    headers.forEach((value, key) => {
      outgoing[key] = value;
    });
    outgoing["host"] = url.host;
    outgoing["connection"] = "close";
    // 不主动接受压缩：读响应时不做解压，省得 json 拿到一堆二进制。
    outgoing["accept-encoding"] = "identity";

    const request = httpRequest(
      {
        createConnection: () => socket,
        method,
        path: `${url.pathname}${url.search}`,
        headers: outgoing,
        signal,
      },
      resolve,
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function readResponse(response: IncomingMessage): Promise<Response> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  return new Response(Buffer.concat(chunks).toString("utf8"), {
    status: response.statusCode ?? 502,
    headers,
  });
}

/**
 * 覆盖 fetch 常用面的最小实现：GET/HEAD、字符串 body、headers、signal。
 *
 * 刻意不做成通用替代品 —— 只走一条「开隧道、发一次请求、读完就关」的路。
 * 连接不池化，配额查询最多一分钟一次，省下的那点握手时间不值这个复杂度。
 */
export function createProxyFetch(
  proxy: ProxyEndpoint,
  options: ProxyFetchOptions = {},
): typeof fetch {
  const proxied = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = toUrl(input);
    const secure = url.protocol === "https:";
    if (!secure && url.protocol !== "http:") {
      throw new Error(`${url.protocol} 目标不支持代理，只能走 http 或 https`);
    }
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
      throw new Error("代理 fetch 只支持字符串 body");
    }

    const port = url.port.length > 0 ? Number(url.port) : secure ? 443 : 80;
    const signal = init.signal ?? undefined;
    const tunnel = await openTunnel(proxy, url.hostname, port, signal);
    const socket = secure ? await upgradeToTls(tunnel, url.hostname, port, signal, options) : tunnel;

    try {
      const response = await sendOverSocket(
        socket,
        url,
        init.method ?? "GET",
        new Headers(init.headers),
        init.body as string | undefined,
        signal,
      );
      return await readResponse(response);
    } finally {
      socket.destroy();
    }
  };
  return proxied as typeof fetch;
}
