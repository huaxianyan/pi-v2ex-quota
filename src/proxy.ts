/**
 * 走本地代理的传输层，只服务配额查询。
 *
 * 为什么不复用现成的能力：
 * - Node 内置的 fetch 是 undici，它不读 HTTPS_PROXY（那是 Node 24 的
 *   NODE_USE_ENV_PROXY 之后才有的事），要让它走代理得拿到 undici 的 ProxyAgent，
 *   而 Node 22 并没有把 undici 暴露成可 import 的模块。
 * - 也不能去动全局 dispatcher：pi 自己的 provider 请求走不走代理是 pi 的事，
 *   扩展把手伸到那儿，等于替用户改了 pi 的行为，比这里要解决的问题还大。
 * - 环境变量就更不合适了 —— 那会连带影响同 shell 里的所有程序，用户明确不想要。
 *
 * 所以这里只用 node 内置模块手搭隧道：http 代理走 CONNECT，socks5 与 socks4a
 * 各走一遍握手，拿到裸 socket 后 HTTPS 目标再补一层 TLS，最后照常交给
 * http.request 发字节。好处是零依赖，代价是这几套握手得自己写、自己测。
 *
 * 用户只需要写 `127.0.0.1:7890` 这样的「主机:端口」，协议由 probeProxy 挨个试，
 * 以真能建起隧道的那一个为准 —— 本地代理常见的几种协议端口写法五花八门，
 * 让人先查清自己是 http 还是 socks5 没有意义。
 */

import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { connect as netConnect, isIP } from "node:net";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { TLSSocket } from "node:tls";

export type ProxyKind = "http" | "socks5" | "socks4a";

/**
 * 只给了主机与端口时按这个顺序试。
 * http 放最前：能代理 CONNECT 的 http 代理最常见，且试错成本最低。
 */
export const PROBE_ORDER: ProxyKind[] = ["http", "socks5", "socks4a"];

/** 显式写了协议时认这些名字，其余一律判成无法识别（不静默直连）。 */
const SCHEMES: Record<string, ProxyKind> = {
  "http:": "http",
  "socks5:": "socks5",
  "socks:": "socks5",
  "socks4a:": "socks4a",
  "socks4:": "socks4a",
};

/** 没写端口时的默认值。 */
const DEFAULT_PORTS: Record<ProxyKind, number> = { http: 80, socks5: 1080, socks4a: 1080 };

export interface ProxyEndpoint {
  kind: ProxyKind;
  host: string;
  port: number;
  /** http 代理 CONNECT 用的 Proxy-Authorization 头。 */
  authorization?: string;
  /** socks5 走 RFC 1929 认证，socks4a 进 userid 字段。 */
  username?: string;
  password?: string;
}

/** 用户写的那一行地址；协议没写时为 undefined，交给探测决定。 */
export interface ProxySpec {
  host: string;
  port: number;
  kind?: ProxyKind;
  authorization?: string;
  username?: string;
  password?: string;
  /** 归一化写法，同时用作探测结果的缓存键。 */
  text: string;
}

const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;

function proxyText(spec: Omit<ProxySpec, "text">): string {
  const user = spec.username;
  const userInfo =
    user === undefined
      ? ""
      : `${encodeURIComponent(user)}:${encodeURIComponent(spec.password ?? "")}@`;
  const scheme = spec.kind === undefined ? "" : `${spec.kind}://`;
  return `${scheme}${userInfo}${spec.host}:${spec.port}`;
}

/**
 * 解析代理地址。接受 `http://127.0.0.1:7890`、`socks5://127.0.0.1:1080`，
 * 也接受只写 `127.0.0.1:7890`（协议留空待探测）。
 *
 * 不认识的协议（含 https:// 代理）判成非法而不是悄悄直连 —— 静默失效最难查。
 */
export function parseProxySpec(raw: string | undefined): ProxySpec | undefined {
  const text = (raw ?? "").trim();
  if (text.length === 0) return undefined;

  const hasScheme = SCHEME_PATTERN.test(text);
  let url: URL;
  try {
    url = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return undefined;
  }

  const kind = hasScheme ? SCHEMES[url.protocol] : undefined;
  if (hasScheme && kind === undefined) return undefined;

  // URL 会把 IPv6 字面量裹在方括号里，交给 net 之前得脱掉。
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.length === 0) return undefined;

  // 只写主机不给端口时按协议取默认值；URL 对 socks 这类非特殊协议不会补默认端口。
  const port =
    url.port.length > 0 ? Number(url.port) : DEFAULT_PORTS[kind ?? "http"];
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;

  const username = url.username.length > 0 ? decodeURIComponent(url.username) : undefined;
  const password = url.password.length > 0 ? decodeURIComponent(url.password) : undefined;
  const spec = {
    host,
    port,
    kind,
    username,
    password,
    authorization:
      username === undefined
        ? undefined
        : `Basic ${Buffer.from(`${username}:${password ?? ""}`).toString("base64")}`,
  };
  return { ...spec, text: proxyText(spec) };
}

/** 把探测拿到的协议补进 spec，得到一条可以直接用的隧道定义。 */
export function endpointOf(spec: ProxySpec, kind: ProxyKind): ProxyEndpoint {
  return {
    kind,
    host: spec.host,
    port: spec.port,
    authorization: spec.authorization,
    username: spec.username,
    password: spec.password,
  };
}

/** 配置里存的代理地址一律按这个口径校验：合法就存归一化写法，非法就退回空串（直连）。 */
export function normalizeProxy(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return parseProxySpec(raw)?.text ?? "";
}

/**
 * 把探测出来的协议写回配置时要用的文本。
 * 存带协议的写法，下次启动直接可用，不必再挨个试一遍。
 */
export function proxyTextOf(endpoint: ProxyEndpoint): string {
  return proxyText(endpoint);
}

/**
 * 给人看的代理描述。凭据只说明「有」，不回显 —— 这一行会进 `/v2ex` 面板与通知，
 * 密码没有理由出现在屏幕上；存进配置的那份仍然带凭据（否则代理根本连不上）。
 */
export function describeProxy(raw: string | undefined): string {
  const spec = parseProxySpec(raw);
  if (!spec) return "未设置（直连）";
  const scheme = spec.kind === undefined ? "" : `${spec.kind}://`;
  const auth = spec.username === undefined ? "" : "（含认证）";
  const pending = spec.kind === undefined ? "（协议待探测）" : "";
  return `${scheme}${spec.host}:${spec.port}${auth}${pending}`;
}

// ------------------------------------------------------------------ 隧道

export interface ProxyFetchOptions {
  /**
   * 是否校验证书链，默认 true，与正常 TLS 行为一致。
   * 关掉只为一种场景：目标是自签证书的内网服务（端到端自检里的假上游就是）。
   */
  rejectUnauthorized?: boolean;
  /** 自定义信任链，用途同上。 */
  ca?: string | string[];
  /** 与代理建连并完成握手的上限毫秒数，默认 15 秒。 */
  handshakeTimeoutMs?: number;
}

/** 代理不回话时的兜底上限；平时由调用方的 signal 管超时。 */
const CONNECT_TIMEOUT_MS = 15_000;

/** 探测用的握手上限：本地代理要么立刻应声，要么就不对。 */
const PROBE_TIMEOUT_MS = 5_000;

/** 响应头都读不到这么多字节，说明对面不是 HTTP 代理。 */
const MAX_CONNECT_RESPONSE = 64 * 1024;

/**
 * 按字节从 socket 上取数据。
 *
 * 握手的每一段都要求「读满 N 字节」或者「读到某个标记」，而 socket 的 data
 * 事件切在哪一半完全没准，所以得自己在中间垫一层缓冲。
 */
interface ByteReader {
  read: (length: number) => Promise<Buffer>;
  readUntil: (marker: string, limit: number) => Promise<string>;
  /**
   * 交还 socket 之前收尾：摘掉自己的监听，把多读到的字节推回流里。
   * 客户端先开口的协议在握手结束后不该还有别的字节，真多出来就退回去，
   * 免得后面 http.request 读不到响应开头。
   */
  detach: () => void;
}

function createReader(socket: Socket): ByteReader {
  let buffer = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: Error | undefined;

  function release(): void {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  }

  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    release();
  };
  const onEnd = (): void => {
    ended = true;
    release();
  };
  const onError = (error: Error): void => {
    failure = error;
    ended = true;
    release();
  };

  socket.on("data", onData);
  socket.on("end", onEnd);
  socket.on("close", onEnd);
  socket.on("error", onError);

  async function wait(): Promise<void> {
    if (failure) throw failure;
    if (ended) throw new Error("连接在握手完成前被关闭");
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    if (failure) throw failure;
  }

  return {
    async read(length) {
      while (buffer.length < length) await wait();
      const head = buffer.subarray(0, length);
      buffer = buffer.subarray(length);
      return head;
    },
    async readUntil(marker, limit) {
      for (;;) {
        const index = buffer.indexOf(marker, 0, "latin1");
        if (index >= 0) {
          const text = buffer.subarray(0, index + marker.length).toString("latin1");
          buffer = buffer.subarray(index + marker.length);
          return text;
        }
        if (buffer.length > limit) {
          throw new Error("代理返回的不是 HTTP 响应");
        }
        await wait();
      }
    },
    detach() {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      // 特意留着 error 监听：摘干净之后到上层装上自己的监听之间有个空档，
      // 这期间来一次 socket 错误就会变成进程级未捕获异常。
      if (buffer.length > 0) {
        try {
          socket.unshift(buffer);
        } catch {
          // 连接已经结束了，多出来的字节也没人要。
        }
        buffer = Buffer.alloc(0);
      }
    },
  };
}

type Handshake = (io: {
  read: (length: number) => Promise<Buffer>;
  readUntil: (marker: string, limit: number) => Promise<string>;
  write: (data: Buffer) => void;
}) => Promise<void>;

/**
 * 连上代理、跑完握手，交出一条可以当传输层用的裸 socket。
 *
 * 超时与取消都靠 destroy 一个带错误的 socket 来收口：读口的 promise 挂在
 * data/close 事件上，socket 一销毁它就醒，不会留下悬着的 await。
 */
async function runHandshake(
  proxy: ProxyEndpoint,
  signal: AbortSignal | undefined,
  options: ProxyFetchOptions,
  handshake: Handshake,
): Promise<Socket> {
  const socket = netConnect({ host: proxy.host, port: proxy.port });
  const timeout = options.handshakeTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const timer = setTimeout(() => socket.destroy(new Error("连接代理超时")), timeout);
  const onAbort = (): void => {
    socket.destroy(new Error("连接代理已取消"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const reader = createReader(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      // 带上代理地址：探测一次会挨个试三种协议，只说「连接失败」看不出是在连谁。
      socket.once("error", (error) =>
        reject(new Error(`连接代理 ${proxy.host}:${proxy.port} 失败：${error.message}`)),
      );
    });
    await handshake({
      read: reader.read,
      readUntil: reader.readUntil,
      write: (data) => {
        socket.write(data);
      },
    });
    return socket;
  } catch (error) {
    socket.destroy();
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    reader.detach();
  }
}

/**
 * http 代理的 CONNECT。
 *
 * 不用 http.request 发这几行：实测它对非 200 的 CONNECT 响应既不发 response
 * 也不发 connect，只是把 socket 挂断成一句 `socket hang up`。代理回了 407
 * 还是 502 完全看不到，而这两种情况的处置方式恰好不同。自己发、自己解析状态行，
 * 状态码就攥在自己手里。
 */
const httpHandshake: (proxy: ProxyEndpoint, host: string, port: number) => Handshake =
  (proxy, host, port) =>
  async ({ readUntil, write }) => {
    const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
    if (proxy.authorization) lines.push(`Proxy-Authorization: ${proxy.authorization}`);
    write(Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"));

    const head = await readUntil("\r\n\r\n", MAX_CONNECT_RESPONSE);
    const statusLine = head.split("\r\n")[0] ?? "";
    const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1] ?? 0);
    if (status !== 200) {
      const hint = status === 407 ? "（代理要求认证）" : "";
      throw new Error(`代理拒绝建立隧道：HTTP ${status}${hint}`);
    }
  };

/** SOCKS5 握手应答码 → 人话。 */
const SOCKS5_ERRORS: Record<number, string> = {
  0x01: "代理内部故障",
  0x02: "代理规则不允许",
  0x03: "网络不可达",
  0x04: "目标主机不可达",
  0x05: "目标拒绝连接",
  0x06: "TTL 过期",
  0x07: "代理不支持该命令",
  0x08: "代理不支持该地址类型",
};

/** IPv6 字面量转 16 字节，顺带认下 `::ffff:1.2.3.4` 这种尾部带点分四段的写法。 */
function ipv6Bytes(host: string): Buffer {
  const [head = "", tail] = host.split("::");
  const split = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const headParts = split(head);
  const tailParts = tail === undefined ? [] : split(tail);
  // 点分四段占两个组，补零个数得按「组」算而不是按字符串段数算，
  // 否则 `::ffff:1.2.3.4` 会被补出 18 字节。
  const widthOf = (parts: string[]): number =>
    parts.reduce((sum, part) => sum + (part.includes(".") ? 2 : 1), 0);
  const groups =
    tail === undefined
      ? headParts
      : [
          ...headParts,
          ...Array<string>(Math.max(0, 8 - widthOf(headParts) - widthOf(tailParts))).fill("0"),
          ...tailParts,
        ];

  const bytes = Buffer.alloc(16);
  let offset = 0;
  for (const group of groups) {
    if (group.includes(".")) {
      const quads = group.split(".").map(Number);
      if (quads.length !== 4 || quads.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        throw new Error(`无法解析的 IPv6 地址：${host}`);
      }
      for (const quad of quads) bytes[offset++] = quad;
      continue;
    }
    const value = parseInt(group === "" ? "0" : group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new Error(`无法解析的 IPv6 地址：${host}`);
    }
    bytes.writeUInt16BE(value, offset);
    offset += 2;
  }
  if (offset !== 16) throw new Error(`无法解析的 IPv6 地址：${host}`);
  return bytes;
}

/** SOCKS5 的目标地址字段：IP 字面量给二进制，域名给长度前缀。 */
export function encodeSocks5Address(host: string): Buffer {
  const version = isIP(host);
  if (version === 4) {
    return Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split(".").map(Number))]);
  }
  if (version === 6) {
    return Buffer.concat([Buffer.from([0x04]), ipv6Bytes(host)]);
  }
  const name = Buffer.from(host, "utf8");
  if (name.length > 255) throw new Error(`域名过长：${host}`);
  return Buffer.concat([Buffer.from([0x03, name.length]), name]);
}

/** 服务端在应答里回的绑定地址，长度按地址类型走，读完丢掉。 */
async function skipSocks5Address(
  read: (length: number) => Promise<Buffer>,
  atyp: number,
): Promise<void> {
  if (atyp === 0x01) return void (await read(4 + 2));
  if (atyp === 0x04) return void (await read(16 + 2));
  if (atyp === 0x03) {
    const length = (await read(1))[0] ?? 0;
    await read(length + 2);
    return;
  }
  throw new Error(`代理回了不认识的地址类型：0x${atyp.toString(16)}`);
}

const socks5Handshake: (proxy: ProxyEndpoint, host: string, port: number) => Handshake =
  (proxy, host, port) =>
  async ({ read, write }) => {
    const wantsAuth = proxy.username !== undefined;
    write(Buffer.from([0x05, 0x01, wantsAuth ? 0x02 : 0x00]));

    const method = await read(2);
    if (method[0] !== 0x05) {
      throw new Error(`对端不是 SOCKS5 代理（版本字节 0x${(method[0] ?? 0).toString(16)}）`);
    }
    const chosen = method[1] ?? 0xff;
    if (chosen === 0x02) {
      if (!wantsAuth) throw new Error("代理要求用户名密码认证，地址里没带凭据");
      const user = Buffer.from(proxy.username ?? "", "utf8");
      const pass = Buffer.from(proxy.password ?? "", "utf8");
      write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const auth = await read(2);
      if (auth[1] !== 0x00) throw new Error("代理拒绝了用户名密码认证");
    } else if (chosen !== 0x00) {
      throw new Error(`代理要求不支持的认证方式（0x${chosen.toString(16)}）`);
    }

    write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00]),
        encodeSocks5Address(host),
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]),
    );

    const reply = await read(4);
    const code = reply[1] ?? 0xff;
    if (code !== 0x00) {
      throw new Error(`代理拒绝连接目标：${SOCKS5_ERRORS[code] ?? `错误码 0x${code.toString(16)}`}`);
    }
    await skipSocks5Address(read, reply[3] ?? 0x01);
  };

/**
 * SOCKS4a 握手。
 *
 * 目标不是 IPv4 字面量时用 4a 的写法：IP 字段填 0.0.0.1，域名缀在后面 ——
 * 配额接口是域名，走的就是这条路。IPv6 目标这套协议根本表达不了，直接拒绝。
 */
const socks4aHandshake: (proxy: ProxyEndpoint, host: string, port: number) => Handshake =
  (proxy, host, port) =>
  async ({ read, write }) => {
    const version = isIP(host);
    if (version === 6) throw new Error("SOCKS4 不支持 IPv6 目标");
    const literal = version === 4;
    const address = literal ? Buffer.from(host.split(".").map(Number)) : Buffer.from([0, 0, 0, 1]);
    const user = Buffer.from(proxy.username ?? "", "utf8");

    const parts = [
      Buffer.from([0x04, 0x01, (port >> 8) & 0xff, port & 0xff]),
      address,
      user,
      Buffer.from([0x00]),
    ];
    if (!literal) parts.push(Buffer.from(host, "utf8"), Buffer.from([0x00]));
    write(Buffer.concat(parts));

    const reply = await read(8);
    const code = reply[1] ?? 0xff;
    if (reply[0] !== 0x00 || code !== 0x5a) {
      throw new Error(`代理拒绝连接目标（SOCKS4 应答 0x${code.toString(16)}）`);
    }
  };

/** 让代理开一条到 host:port 的隧道，协议按 endpoint.kind 走。 */
function openTunnel(
  proxy: ProxyEndpoint,
  host: string,
  port: number,
  signal: AbortSignal | undefined,
  options: ProxyFetchOptions = {},
): Promise<Socket> {
  const handshake =
    proxy.kind === "http"
      ? httpHandshake(proxy, host, port)
      : proxy.kind === "socks5"
        ? socks5Handshake(proxy, host, port)
        : socks4aHandshake(proxy, host, port);
  return runHandshake(proxy, signal, options, handshake);
}

// ------------------------------------------------------------------ 协议探测

export interface ProxyProbeAttempt {
  kind: ProxyKind;
  ok: boolean;
  /** 失败原因，成功时为 undefined。 */
  reason?: string;
}

export interface ProxyProbeResult {
  /** 第一个建起隧道的协议；全失败时为 undefined。 */
  endpoint?: ProxyEndpoint;
  attempts: ProxyProbeAttempt[];
}

/**
 * 挨个协议试到能建起隧道为止。
 *
 * 探测目标是调用方给的真实目标（配额接口那个），不另找一个「好连的」网址：
 * 「能不能用它连上目标」才是要判断的事。所以代理活着但规则不放行目标时，
 * 探测同样失败 —— 这正是用户需要知道的。
 */
export async function probeProxy(
  spec: ProxySpec,
  target: { host: string; port: number },
  options: ProxyFetchOptions & { signal?: AbortSignal } = {},
): Promise<ProxyProbeResult> {
  const kinds = spec.kind === undefined ? PROBE_ORDER : [spec.kind];
  const attempts: ProxyProbeAttempt[] = [];

  for (const kind of kinds) {
    const endpoint = endpointOf(spec, kind);
    try {
      const socket = await openTunnel(endpoint, target.host, target.port, options.signal, {
        ...options,
        handshakeTimeoutMs: options.handshakeTimeoutMs ?? PROBE_TIMEOUT_MS,
      });
      // 隧道能建起来就够了，这条连接不必真的发请求。
      socket.destroy();
      attempts.push({ kind, ok: true });
      return { endpoint, attempts };
    } catch (error) {
      attempts.push({ kind, ok: false, reason: errorText(error) });
    }
  }
  return { attempts };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 探测全失败时给人看的一句话。
 * 三种协议给出同一个原因（典型是端口上压根没人监听）就把它们并起来，不重复三遍。
 */
export function describeProbeFailure(spec: ProxySpec, result: ProxyProbeResult): string {
  const reasons = result.attempts.map((attempt) => attempt.reason ?? "未知原因");
  if (reasons.length > 1 && new Set(reasons).size === 1) {
    return `${reasons.length} 种协议都是「${reasons[0]}」`;
  }
  return result.attempts.map((attempt) => `${attempt.kind} ${attempt.reason}`).join(" · ");
}

// ------------------------------------------------------------------ fetch

/** 探测结果按地址缓存：同一地址在一次运行里只试一次协议。 */
const endpointCache = new Map<string, ProxyEndpoint>();

function portOf(url: URL, secure: boolean): number {
  return url.port.length > 0 ? Number(url.port) : secure ? 443 : 80;
}

function toUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
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
async function requestViaProxy(
  proxy: ProxyEndpoint,
  url: URL,
  init: RequestInit,
  options: ProxyFetchOptions,
): Promise<Response> {
  const secure = url.protocol === "https:";
  if (!secure && url.protocol !== "http:") {
    throw new Error(`${url.protocol} 目标不支持代理，只能走 http 或 https`);
  }
  if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
    throw new Error("代理 fetch 只支持字符串 body");
  }

  const port = portOf(url, secure);
  const signal = init.signal ?? undefined;
  const tunnel = await openTunnel(proxy, url.hostname, port, signal, options);
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
}

export function createProxyFetch(
  proxy: ProxyEndpoint,
  options: ProxyFetchOptions = {},
): typeof fetch {
  return ((input: RequestInfo | URL, init: RequestInit = {}) =>
    requestViaProxy(proxy, toUrl(input), init, options)) as typeof fetch;
}

/**
 * 按配置挑 fetch 实现：配了代理就走隧道，没配就还是原生 fetch。
 *
 * 地址里没写协议时，第一次真正用到才去探测，目标就用这次请求的地址。
 * 目的是让手写配置的人写 `127.0.0.1:7890` 也能用，而不是静默直连或者报一句
 * 「配置非法」让他自己去查协议。
 */
export function createFetch(raw: string | undefined, options: ProxyFetchOptions = {}): typeof fetch {
  const spec = parseProxySpec(raw);
  if (!spec) return fetch;

  let endpoint = spec.kind === undefined ? endpointCache.get(spec.text) : endpointOf(spec, spec.kind);
  let inflight: Promise<ProxyEndpoint> | undefined;

  async function resolve(target: { host: string; port: number }): Promise<ProxyEndpoint> {
    if (endpoint) return endpoint;
    inflight ??= probeProxy(spec!, target, options).then((result) => {
      if (!result.endpoint) {
        throw new Error(`代理 ${spec!.host}:${spec!.port} 用不通：${describeProbeFailure(spec!, result)}`);
      }
      endpointCache.set(spec!.text, result.endpoint);
      return result.endpoint;
    });
    try {
      endpoint = await inflight;
      return endpoint;
    } finally {
      inflight = undefined;
    }
  }

  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = toUrl(input);
    const proxy = await resolve({ host: url.hostname, port: portOf(url, url.protocol === "https:") });
    return requestViaProxy(proxy, url, init, options);
  }) as typeof fetch;
}
