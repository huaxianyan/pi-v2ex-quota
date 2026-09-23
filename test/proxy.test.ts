/**
 * 代理传输层的测试。
 *
 * 这里不用 mock：起真会转发隧道的假代理（http / socks5 / socks4a 各一个），
 * 让它们连到本地假目标。「http.request 能不能拿一条自己建好的 socket 当传输层」
 * 与「几种握手有没有写对字节」这两件事都没有文档保证，只有真跑一遍才知道，
 * 所以这一层的价值就在于它验的是真 socket。
 */

import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect, createServer as netCreateServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { after, test } from "node:test";

import {
  createFetch,
  createProxyFetch,
  describeProbeFailure,
  describeProxy,
  encodeSocks5Address,
  endpointOf,
  normalizeProxy,
  parseProxySpec,
  probeProxy,
  type ProxyEndpoint,
} from "../src/proxy.ts";
import { fetchQuota } from "../src/v2ex.ts";

/** 自签证书（CN=localhost，SAN 含 localhost 与 127.0.0.1），只为让 TLS 那条路能真跑。 */
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUeK79sBKCTXnqcnb2OHrZAlvxseYwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkyMjEyMDM0NloXDTM2MDkx
OTEyMDM0NlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA2cfADAP9U8y05C8cZPDZVu5EVxKy7Xqr837t00wDehT0
zR91fEqrtId5h9S9KbmFDt6EKwRF7WBuO6vLAw7M1cUt9IJJi+AaL458C9RfAEtM
aRvFWwdGTB4dCgzMml/+O9IYg2l3KPIXXqW0petZ4/tjw+O8KRHviIQ3R+PMxZos
OiaT8qZq10wJdKN0VA3KrlddVB95CTfUH9SVq08paionRN1Q14QPh9gCSqXhS04S
gtM8X+sAPb/PSeHeRfBdUHEeqx3TTB3W/Y/yqMBR6fL+W4QhzzAhJiww751vjS9l
yjzWiijeZslX9RdzaJKJ7jhieNoC+JFWpMeNcE16DwIDAQABo28wbTAdBgNVHQ4E
FgQUGAzjLHLbqkWltgjGo3qCj85JD0gwHwYDVR0jBBgwFoAUGAzjLHLbqkWltgjG
o3qCj85JD0gwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBANC4WebYBbpqw8CAcl+bbf6NsFtPJnN+
+NGFk68M5snVZoTdUMRAWGAuErEM7YxdgG+LK7/BGeoxPBcX0G3BuU75Yk/ElAQa
qKJRl/iL071JlzUdR+bTAUVqlqp4JtVw4Xt9Xh9NlbZXdOnxUibkvSTKSTeXQfkc
dZiiqFve6eG7Wi1n7lisORRpRhrYcVmVATD3hCXJlkzgk1nHDo0jk4N/X3dTJcCA
nxaZkQPobt7xb4siUU3Ld2u02g9Xgu4AF1PfRLadkddwil6hgL7Yt0PIOu0hiyUU
8dQlOEshbGcaS60DYc/KKanAw6jWiGeJ4ChpdsJqHerOi/RUfL7Pc84=
-----END CERTIFICATE-----
`;

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDZx8AMA/1TzLTk
Lxxk8NlW7kRXErLteqvzfu3TTAN6FPTNH3V8Squ0h3mH1L0puYUO3oQrBEXtYG47
q8sDDszVxS30gkmL4BovjnwL1F8AS0xpG8VbB0ZMHh0KDMyaX/470hiDaXco8hde
pbSl61nj+2PD47wpEe+IhDdH48zFmiw6JpPypmrXTAl0o3RUDcquV11UH3kJN9Qf
1JWrTylqKidE3VDXhA+H2AJKpeFLThKC0zxf6wA9v89J4d5F8F1QcR6rHdNMHdb9
j/KowFHp8v5bhCHPMCEmLDDvnW+NL2XKPNaKKN5myVf1F3NokonuOGJ42gL4kVak
x41wTXoPAgMBAAECggEACuTBPZ+8k18xHwADZHr9DtUG+algdI7R4HGOSUN9BXq/
xBErOfcQdQynHPKALoDK9U/lBXq4WhIOHDUfQMfnaOZ7NDjB9QtyfMPVm1AZjOMa
6EOCeC7BasYzShug54m7ClE4E1q6TPWWQ+W+8caiP5No8T/6ImkftcnK3aoq/rdR
sHBrhFm1Lj5yT1t7Hm2pqS1NqPbEr1TmWP3itP0kVsfvRT1vP16jLMwbd75jbUDa
5+DKyqtlimW58j8LoKqx672b+/9SQ3ZkxoLkLV0AodQyCx6yHF1gh70sh8dbzqpz
+Cc9pOy0Lw+eo/EkL4KpBpQryPsrNtPpHEftTAmSAQKBgQD1mApHeJaQzO4qyxJf
+/wxoRXGC2yADUEfxMWcTR9x1NFAArrQK70/UNkGQvp535oT7P8EeekLIu7UTKIa
Ux6oXxXL1pZ8Rtn8IDx+isneACO6OBJhCvWo3bqKN31+5t1K2GzHIVI5Xr3svGE+
WsS3pkH88PnrUY9io+pkhQlrcwKBgQDjAgPnLQVAJxk+w7M/BgeGm9g9zi8hUtDq
hlHynlZG9vUHjGNDR9ipj3xlPS6OxZt6kkcZS0ko/Z2NYt0V4T/fna4EeYvHiDLU
cUYf1AOFOCYCYxvlP2jNrffXwWZ2bTCUofGe1171DL7TezpK8B2JXmTbwesCiIif
KgPW1uCH9QKBgEmRsgKW7QOTYAURr/9wzKtRReR9p5L0ZX3OxCN+Nt0ykzxJlQyn
DZnZ7ikiB0Za5Rzy8bG1k0nyvPh7vFOGcridQzo8nfe8gbA1N+nwSWhnQkyWX2sS
jWR4h1jAJqfNIJ07F9rO8IKfDuXLyJWVOziIZVwQE82aMQmrcJuL/rZhAoGBAK2+
rR4S5yHiyv+u6VIjWz87qJYlaQ0oRZ46kB4R8hb+jSvp1093fezJVXxnB2te81Et
BB3n8WbeNegw8uX8MNcF6FqkbMebBsxypilWLBuajfzlvkQH9D74F+marMGXcMdR
64yXaqZDywoyFruka/bnuGo6UZTuyyKHFckpTVDBAoGAGixUJ0baLgdHXmP+Jy2d
vZZtlrUnpOuM7UEX+9O89wf2nXfJY94Afm71WoanQICmRkTaZPCgqhaGzE2q2FXN
a6L9s+VhwWN7g8O1yMliEA2qc9j8H7tFk8qD5aI2O961i/ghPd2m6XvwN3H2Jo9U
ZEr3Zodd/8QBIojMQqrTzRk=
-----END PRIVATE KEY-----
`;

interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

function closeServer(server: {
  close: (cb?: () => void) => unknown;
  closeAllConnections?: () => void;
}): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // 隧道是长连接，不主动掐掉的话 close 会一直等。
    server.closeAllConnections?.();
  });
}

/**
 * 假代理共用的字节读取器。
 *
 * 客户端握手的每一段都是「先读 N 字节，再决定写什么」，而 socket 的 data 事件
 * 切在哪儿完全没准，所以要在中间垫一层缓冲。连接提前断掉时必须抛错而不是
 * 一直等 —— 探测会拿被拒的连接反复试，卡住一次整条链路就废了。
 */
class StreamReader {
  private buffer = Buffer.alloc(0);
  private wake: (() => void) | undefined;
  private ended = false;

  constructor(socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.release();
    });
    socket.on("close", () => {
      this.ended = true;
      this.release();
    });
    socket.on("error", () => {
      this.ended = true;
      this.release();
    });
  }

  private release(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private async wait(): Promise<void> {
    if (this.ended) throw new Error("连接已关闭");
    await new Promise<void>((resolve) => {
      this.wake = resolve;
    });
    if (this.ended) throw new Error("连接已关闭");
  }

  async need(length: number): Promise<Buffer> {
    while (this.buffer.length < length) await this.wait();
    const head = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return head;
  }

  /** 读到某个字节（含）为止，用来切 0x00 结尾的字符串。 */
  async until(byte: number): Promise<Buffer> {
    for (;;) {
      const index = this.buffer.indexOf(byte);
      if (index >= 0) {
        const head = this.buffer.subarray(0, index + 1);
        this.buffer = this.buffer.subarray(index + 1);
        return head;
      }
      await this.wait();
    }
  }

  /** 握手结束后把多读到的字节交出来，转发阶段不能丢掉它们。 */
  drain(): Buffer {
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    return rest;
  }
}

/** 连上目标并把两条 socket 对接起来，三种假代理的收尾都一样。 */
function bridge(socket: Socket, reader: StreamReader, host: string, port: number): void {
  const upstream = netConnect(port, host, () => {
    const pending = reader.drain();
    if (pending.length > 0) upstream.write(pending);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

/** 假目标：任何请求都回一份配额 JSON，顺带回显收到的 path / host / 认证头。 */
const quotaHandler: RequestListener = (req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      success: true,
      path: req.url,
      host: req.headers.host,
      authorization: req.headers.authorization ?? null,
      result: {
        active: true,
        total_tokens: 1_000,
        used_tokens: 100,
        remaining_tokens: 900,
        used_percent: 10,
        period_start: 1_700_000_000,
        period_end: 1_700_018_000,
        extra_usage: { remaining_tokens: 0 },
      },
    }),
  );
};

async function startTarget(secure: boolean): Promise<RunningServer> {
  const server = secure
    ? createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, quotaHandler)
    : createHttpServer(quotaHandler);
  // 不指定 host：https 那条用 localhost 访问，而 localhost 可能先解析到 ::1。
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => closeServer(server),
  };
}

interface FakeProxy extends RunningServer {
  /** 收到过的目标，形如 `host:port`。 */
  connects: string[];
}

/** 假 http 代理：只认 CONNECT，转发到目标后双向 pipe。 */
async function startHttpProxy(): Promise<FakeProxy> {
  const connects: string[] = [];
  const server = createHttpServer((_req, res) => {
    res.writeHead(400).end("只接受 CONNECT");
  });
  server.on("connect", (req, clientSocket, head) => {
    const target = req.url ?? "";
    connects.push(target);
    const index = target.lastIndexOf(":");
    const upstream = netConnect(Number(target.slice(index + 1)), target.slice(0, index), () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    connects,
    close: () => closeServer(server),
  };
}

/** 假 SOCKS5 代理，可选要求用户名密码（RFC 1929）。 */
async function startSocks5Proxy(
  auth?: { user: string; pass: string },
): Promise<FakeProxy> {
  const connects: string[] = [];
  const server = netCreateServer((socket) => {
    void (async () => {
      try {
        const reader = new StreamReader(socket);
        const greeting = await reader.need(2);
        // 头一个字节就不是 0x05 说明对面在用别的协议，立刻断开：
        // 探测阶段要能快速判否，不能陪着一起等超时。
        if (greeting[0] !== 0x05) {
          socket.destroy();
          return;
        }
        const methods = await reader.need(greeting[1] ?? 0);
        if (auth) {
          if (!methods.includes(0x02)) {
            socket.end(Buffer.from([0x05, 0xff]));
            return;
          }
          socket.write(Buffer.from([0x05, 0x02]));
          const head = await reader.need(2);
          const user = (await reader.need(head[1] ?? 0)).toString();
          const length = (await reader.need(1))[0] ?? 0;
          const pass = (await reader.need(length)).toString();
          const ok = user === auth.user && pass === auth.pass;
          socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) {
            socket.destroy();
            return;
          }
        } else {
          socket.write(Buffer.from([0x05, 0x00]));
        }

        const request = await reader.need(4);
        const atyp = request[3] ?? 0x01;
        let host: string;
        if (atyp === 0x01) {
          host = Array.from(await reader.need(4)).join(".");
        } else if (atyp === 0x03) {
          const length = (await reader.need(1))[0] ?? 0;
          host = (await reader.need(length)).toString("utf8");
        } else {
          // 测试不用 IPv6 目标，bytes 到这儿就够。
          const raw = await reader.need(16);
          host = Array.from({ length: 8 }, (_, index) =>
            raw.readUInt16BE(index * 2).toString(16),
          ).join(":");
        }
        const portBytes = await reader.need(2);
        const port = ((portBytes[0] ?? 0) << 8) | (portBytes[1] ?? 0);
        connects.push(`${host}:${port}`);
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        bridge(socket, reader, host, port);
      } catch {
        socket.destroy();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    connects,
    close: () => closeServer(server),
  };
}

/** 假 SOCKS4a 代理：域名走 4a 的写法（IP 字段 0.0.0.1，域名缀在 userid 之后）。 */
async function startSocks4aProxy(): Promise<FakeProxy> {
  const connects: string[] = [];
  const server = netCreateServer((socket) => {
    void (async () => {
      try {
        const reader = new StreamReader(socket);
        const version = (await reader.need(1))[0];
        if (version !== 0x04) {
          socket.destroy();
          return;
        }
        const rest = await reader.need(7);
        const port = ((rest[1] ?? 0) << 8) | (rest[2] ?? 0);
        const ip = [rest[3] ?? 0, rest[4] ?? 0, rest[5] ?? 0, rest[6] ?? 0];
        await reader.until(0x00);
        const literal = !(ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0);
        const host = literal ? ip.join(".") : (await reader.until(0x00)).subarray(0, -1).toString();
        connects.push(`${host}:${port}`);
        socket.write(Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0]));
        bridge(socket, reader, host, port);
      } catch {
        socket.destroy();
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    connects,
    close: () => closeServer(server),
  };
}

/** 明确拒绝隧道（407 之类），用来验错误信息说得清不清楚。 */
async function startRejectingProxy(status: number): Promise<RunningServer> {
  const server = createHttpServer((_req, res) => {
    res.writeHead(status, { "content-type": "text/plain" }).end("no tunnel for you");
  });
  server.on("connect", (_req, clientSocket) => {
    // 用 end 而不是 destroy：直接销毁会在客户端读到响应前发 RST，
    // 报出来的就是 ECONNRESET，验不到「代理回了什么状态码」这条信息。
    clientSocket.end(`HTTP/1.1 ${status} Nope\r\nContent-Length: 0\r\n\r\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => closeServer(server),
  };
}

const servers: RunningServer[] = [];
async function track<T extends RunningServer>(server: T): Promise<T> {
  servers.push(server);
  return server;
}

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** 直接给一条已知协议的代理定义，跳过探测。 */
function endpoint(port: number, kind: ProxyEndpoint["kind"] = "http"): ProxyEndpoint {
  return endpointOf(parseProxySpec(`127.0.0.1:${port}`)!, kind);
}

// ------------------------------------------------------------------ 解析与文案

test("代理地址的解析", () => {
  const plain = parseProxySpec("http://127.0.0.1:37777");
  assert.equal(plain?.host, "127.0.0.1");
  assert.equal(plain?.port, 37777);
  assert.equal(plain?.kind, "http");
  assert.equal(plain?.text, "http://127.0.0.1:37777");

  // 只写主机和端口是主推写法：协议留空，交给探测。
  const bare = parseProxySpec(" 127.0.0.1:7890 ");
  assert.equal(bare?.port, 7890);
  assert.equal(bare?.kind, undefined);
  assert.equal(bare?.text, "127.0.0.1:7890");

  // socks 两种都认，写 socks 当 socks5。
  assert.equal(parseProxySpec("socks5://127.0.0.1:1080")?.kind, "socks5");
  assert.equal(parseProxySpec("socks://127.0.0.1:1080")?.kind, "socks5");
  assert.equal(parseProxySpec("socks4a://127.0.0.1:1080")?.kind, "socks4a");

  // 不写端口按协议取默认值。
  assert.equal(parseProxySpec("http://127.0.0.1")?.port, 80);
  assert.equal(parseProxySpec("socks5://127.0.0.1")?.port, 1080);

  // 带凭据的代理：转成 Basic 头（http 用），同时留着用户名密码（socks 用）。
  const authed = parseProxySpec("http://user:pa%3Ass@127.0.0.1:8080");
  assert.equal(authed?.authorization, `Basic ${Buffer.from("user:pa:ss").toString("base64")}`);
  assert.equal(authed?.username, "user");
  assert.equal(authed?.password, "pa:ss");

  // 认不出来的必须判非法，不能悄悄直连 —— 静默失效最难查。
  assert.equal(parseProxySpec("https://127.0.0.1:8443"), undefined);
  assert.equal(parseProxySpec("ftp://127.0.0.1:21"), undefined);
  assert.equal(parseProxySpec(""), undefined);
  assert.equal(parseProxySpec(undefined), undefined);
  assert.equal(parseProxySpec("http://"), undefined);
  assert.equal(parseProxySpec("http://127.0.0.1:99999"), undefined);
});

test("配置里的代理留合法值、丢非法值", () => {
  assert.equal(normalizeProxy("http://127.0.0.1:37777"), "http://127.0.0.1:37777");
  assert.equal(normalizeProxy(" 127.0.0.1:37777 "), "127.0.0.1:37777");
  assert.equal(normalizeProxy("socks5://127.0.0.1:1080"), "socks5://127.0.0.1:1080");
  assert.equal(normalizeProxy("https://127.0.0.1:8443"), "");
  assert.equal(normalizeProxy(""), "");
  assert.equal(normalizeProxy(42), "");
  assert.equal(normalizeProxy(undefined), "");
});

test("代理的描述文案", () => {
  assert.equal(describeProxy(""), "未设置（直连）");
  assert.equal(describeProxy(undefined), "未设置（直连）");
  assert.equal(describeProxy("http://127.0.0.1:37777"), "http://127.0.0.1:37777");
  // 只写了主机端口的，明说协议要等探测，别让人以为已经定了。
  assert.equal(describeProxy("127.0.0.1:7890"), "127.0.0.1:7890（协议待探测）");
  // 凭据只说明「有」，不回显。
  assert.equal(describeProxy("http://u:p@127.0.0.1:8080"), "http://127.0.0.1:8080（含认证）");
});

test("SOCKS5 地址字段的编码", () => {
  assert.deepEqual(encodeSocks5Address("1.2.3.4"), Buffer.from([0x01, 1, 2, 3, 4]));
  assert.deepEqual(
    encodeSocks5Address("::1"),
    Buffer.from([0x04, ...Array<number>(15).fill(0), 1]),
  );
  // 点分四段占两个组，压缩写法补零个数得按组算。
  assert.deepEqual(
    encodeSocks5Address("::ffff:1.2.3.4"),
    Buffer.from([0x04, ...Array<number>(10).fill(0), 0xff, 0xff, 1, 2, 3, 4]),
  );
  assert.deepEqual(encodeSocks5Address("2001:db8::1"), Buffer.from([
    0x04, 0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x01,
  ]));
  const domain = encodeSocks5Address("edge.v2ex.com");
  assert.equal(domain[0], 0x03);
  assert.equal(domain[1], "edge.v2ex.com".length);
  assert.equal(domain.subarray(2).toString("utf8"), "edge.v2ex.com");
});

test("没配代理时就是原生 fetch", () => {
  assert.equal(createFetch(""), fetch);
  assert.equal(createFetch(undefined), fetch);
  assert.notEqual(createFetch("http://127.0.0.1:37777"), fetch);
});

// ------------------------------------------------------------------ 隧道

test("经 CONNECT 隧道访问 http 目标", async () => {
  const target = await track(await startTarget(false));
  const proxy = await track(await startHttpProxy());
  const doFetch = createProxyFetch(endpoint(proxy.port));

  const response = await doFetch(`http://127.0.0.1:${target.port}/api/v2/chat/quota`, {
    headers: { authorization: "Bearer tok" },
  });

  assert.equal(response.status, 200);
  const body = (await response.json()) as { path: string; host: string; authorization: string };
  assert.equal(body.path, "/api/v2/chat/quota");
  // Host 头必须是目标而不是代理，否则虚拟主机托管的上游会答错站点。
  assert.equal(body.host, `127.0.0.1:${target.port}`);
  assert.equal(body.authorization, "Bearer tok");
  assert.deepEqual(proxy.connects, [`127.0.0.1:${target.port}`]);
});

test("经 CONNECT 隧道访问 https 目标（含 TLS 握手）", async () => {
  const target = await track(await startTarget(true));
  const proxy = await track(await startHttpProxy());
  // 目标名走 localhost，好让 SNI 真的被用上（IP 字面量不做 SNI）。
  const doFetch = createProxyFetch(endpoint(proxy.port), { ca: TEST_CERT });

  const response = await doFetch(`https://localhost:${target.port}/api/v2/chat/quota`);

  assert.equal(response.status, 200);
  const body = (await response.json()) as { host: string };
  assert.equal(body.host, `localhost:${target.port}`);
  assert.deepEqual(proxy.connects, [`localhost:${target.port}`]);
});

test("https 目标不信任自签证书时会失败", async () => {
  const target = await track(await startTarget(true));
  const proxy = await track(await startHttpProxy());
  const doFetch = createProxyFetch(endpoint(proxy.port));

  await assert.rejects(doFetch(`https://localhost:${target.port}/api/v2/chat/quota`), /TLS 握手失败/);
});

test("经 SOCKS5 隧道访问 http 目标", async () => {
  const target = await track(await startTarget(false));
  const proxy = await track(await startSocks5Proxy());
  const doFetch = createProxyFetch(endpoint(proxy.port, "socks5"));

  const response = await doFetch(`http://127.0.0.1:${target.port}/api/v2/chat/quota`);

  assert.equal(response.status, 200);
  // 走的是无认证分支：地址里没凭据时不会多发认证那一段。
  assert.deepEqual(proxy.connects, [`127.0.0.1:${target.port}`]);
});

test("SOCKS5 带用户名密码时走 RFC 1929 认证", async () => {
  const target = await track(await startTarget(false));
  const proxy = await track(await startSocks5Proxy({ user: "u", pass: "p" }));
  const spec = parseProxySpec(`socks5://u:p@127.0.0.1:${proxy.port}`);
  assert.ok(spec);
  const doFetch = createProxyFetch(endpointOf(spec, "socks5"));

  const response = await doFetch(`http://127.0.0.1:${target.port}/api/v2/chat/quota`);
  assert.equal(response.status, 200);
  assert.deepEqual(proxy.connects, [`127.0.0.1:${target.port}`]);
});

test("SOCKS5 认证不通过时报错，不发目标请求", async () => {
  const target = await track(await startTarget(false));
  const proxy = await track(await startSocks5Proxy({ user: "u", pass: "p" }));
  const spec = parseProxySpec(`socks5://u:wrong@127.0.0.1:${proxy.port}`);
  assert.ok(spec);
  const doFetch = createProxyFetch(endpointOf(spec, "socks5"));

  await assert.rejects(
    doFetch(`http://127.0.0.1:${target.port}/api/v2/chat/quota`),
    /拒绝建立隧道|用户名密码/,
  );
  assert.deepEqual(proxy.connects, []);
});

test("经 SOCKS4a 隧道访问域名目标", async () => {
  const target = await track(await startTarget(false));
  const proxy = await track(await startSocks4aProxy());
  const doFetch = createProxyFetch(endpoint(proxy.port, "socks4a"));

  // 目标名用 localhost：它不是 IPv4 字面量，正好走 4a 的域名写法。
  const response = await doFetch(`http://localhost:${target.port}/api/v2/chat/quota`);

  assert.equal(response.status, 200);
  assert.deepEqual(proxy.connects, [`localhost:${target.port}`]);
});

test("配额查询能整条走通代理", async () => {
  const target = await track(await startTarget(false));
  const proxy = await track(await startHttpProxy());

  const window = await fetchQuota(
    { baseUrl: `http://127.0.0.1:${target.port}`, apiKey: "tok" },
    { proxy: `http://127.0.0.1:${proxy.port}` },
  );

  assert.equal(window.remainingTokens, 900);
  assert.equal(window.periodEnd, 1_700_018_000);
  assert.equal(proxy.connects.length, 1);
});

test("只写 ip:port 时按探测结果走，探测结果会缓存", async () => {
  const target = await track(await startTarget(false));
  const proxy = await track(await startSocks5Proxy());
  const raw = `127.0.0.1:${proxy.port}`;
  const doFetch = createFetch(raw);

  const first = await doFetch(`http://127.0.0.1:${target.port}/api/v2/chat/quota`);
  assert.equal(first.status, 200);
  // 同一个地址第二次不该再试协议：探测过一次就够了。
  const connectsAfterFirst = proxy.connects.length;
  const second = await doFetch(`http://127.0.0.1:${target.port}/api/v2/chat/quota`);
  assert.equal(second.status, 200);
  assert.equal(proxy.connects.length, connectsAfterFirst + 1);
});

// ------------------------------------------------------------------ 探测

test("探测按 http → socks5 → socks4a 的顺序，以能建起隧道的为准", async () => {
  const target = await track(await startTarget(false));
  const proxy = await track(await startSocks4aProxy());
  const spec = parseProxySpec(`127.0.0.1:${proxy.port}`);
  assert.ok(spec);

  const result = await probeProxy(
    spec,
    { host: "127.0.0.1", port: target.port },
    { handshakeTimeoutMs: 3_000 },
  );

  assert.equal(result.endpoint?.kind, "socks4a");
  assert.deepEqual(
    result.attempts.map((attempt) => `${attempt.kind}:${attempt.ok}`),
    ["http:false", "socks5:false", "socks4a:true"],
  );
});

test("三种协议都不通时探测报失败并说明原因", async () => {
  const target = await track(await startTarget(false));
  // 1 号端口上不会有人监听，三种协议都会在 connect 阶段就失败。
  const spec = parseProxySpec("127.0.0.1:1");
  assert.ok(spec);

  const result = await probeProxy(spec, { host: "127.0.0.1", port: target.port });
  assert.equal(result.endpoint, undefined);

  const reason = describeProbeFailure(spec, result);
  // 三种协议同一个原因时并成一句，不重复三遍。
  assert.match(reason, /^3 种协议都是「连接代理 127\.0\.0\.1:1 失败/);
});

test("写了协议就只试那一种", async () => {
  const target = await track(await startTarget(false));
  const proxy = await track(await startHttpProxy());
  const spec = parseProxySpec(`socks5://127.0.0.1:${proxy.port}`);
  assert.ok(spec);

  const result = await probeProxy(spec, { host: "127.0.0.1", port: target.port });
  assert.equal(result.endpoint, undefined);
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.kind),
    ["socks5"],
  );
});

test("代理不可达时的错误要说清是代理的问题", async () => {
  const doFetch = createProxyFetch(endpoint(1));
  await assert.rejects(doFetch("http://127.0.0.1:9/whatever"), /连接代理 127\.0\.0\.1:1 失败/);
});

test("代理拒绝隧道时报出状态码", async () => {
  const proxy = await track(await startRejectingProxy(407));
  const doFetch = createProxyFetch(endpoint(proxy.port));
  await assert.rejects(
    doFetch("http://127.0.0.1:9/whatever"),
    /拒绝建立隧道：HTTP 407（代理要求认证）/,
  );
});

test("不支持的目标协议直接拒绝", async () => {
  const doFetch = createProxyFetch(endpoint(1));
  await assert.rejects(doFetch("ftp://example.com/x"), /只能走 http 或 https/);
});
