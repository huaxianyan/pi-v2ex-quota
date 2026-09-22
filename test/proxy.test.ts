/**
 * 代理传输层的测试。
 *
 * 这里不用 mock：起一个真会转发 CONNECT 的假代理，让它连到本地假目标。
 * 「http.request 能不能拿一条自己建好的 socket 当传输层」这件事没有文档保证，
 * 只有真跑一遍才知道，所以这一层的价值就在于它验的是真 socket。
 */

import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect } from "node:net";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import {
  createFetch,
  createProxyFetch,
  describeProxy,
  normalizeProxy,
  parseProxy,
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

function closeServer(server: { close: (cb?: () => void) => unknown; closeAllConnections?: () => void }): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // 隧道是长连接，不主动掐掉的话 close 会一直等。
    server.closeAllConnections?.();
  });
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
  /** 收到过的 CONNECT 目标，形如 `host:port`。 */
  connects: string[];
}

/** 假代理：只认 CONNECT，转发到目标后双向 pipe。 */
async function startProxy(): Promise<FakeProxy> {
  const connects: string[] = [];
  const server = createHttpServer((_req, res) => {
    res.writeHead(400).end("只接受 CONNECT");
  });
  server.on("connect", (req, clientSocket, head) => {
    const target = req.url ?? "";
    connects.push(target);
    const index = target.lastIndexOf(":");
    const host = target.slice(0, index);
    const port = Number(target.slice(index + 1));
    const upstream = netConnect(port, host, () => {
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

/** 只接受 CONNECT 的代理会把普通请求 400 回去，用来验错误信息说得清不清楚。 */
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

test("代理地址的解析与规范化", () => {
  assert.deepEqual(parseProxy("http://127.0.0.1:37777"), {
    host: "127.0.0.1",
    port: 37777,
    authorization: undefined,
  });
  // 省略协议也认，手写配置时少打几个字符。
  assert.equal(parseProxy("127.0.0.1:37777")?.port, 37777);
  assert.equal(parseProxy("http://127.0.0.1")?.port, 80);
  assert.equal(parseProxy(" http://127.0.0.1:37777 ")?.host, "127.0.0.1");

  // 带凭据的代理：转成 Basic 头，凭据本身不出现在描述里。
  const authed = parseProxy("http://user:pa%3Ass@127.0.0.1:8080");
  assert.equal(authed?.authorization, `Basic ${Buffer.from("user:pa:ss").toString("base64")}`);

  // 只支持 http 代理；socks 之类必须判成非法，不能悄悄直连。
  assert.equal(parseProxy("socks5://127.0.0.1:1080"), undefined);
  assert.equal(parseProxy("https://127.0.0.1:8443"), undefined);
  assert.equal(parseProxy(""), undefined);
  assert.equal(parseProxy(undefined), undefined);
  assert.equal(parseProxy("http://"), undefined);
  assert.equal(parseProxy("http://127.0.0.1:99999"), undefined);
});

test("配置里的代理留合法值、丢非法值", () => {
  assert.equal(normalizeProxy("http://127.0.0.1:37777"), "http://127.0.0.1:37777");
  assert.equal(normalizeProxy(" 127.0.0.1:37777 "), "127.0.0.1:37777");
  assert.equal(normalizeProxy("socks5://127.0.0.1:1080"), "");
  assert.equal(normalizeProxy(""), "");
  assert.equal(normalizeProxy(42), "");
  assert.equal(normalizeProxy(undefined), "");
});

test("代理的描述文案", () => {
  assert.equal(describeProxy(""), "未设置（直连）");
  assert.equal(describeProxy(undefined), "未设置（直连）");
  assert.equal(describeProxy("http://127.0.0.1:37777"), "http://127.0.0.1:37777");
  // 凭据只说明「有」，不回显。
  assert.equal(describeProxy("http://u:p@127.0.0.1:8080"), "http://127.0.0.1:8080（含认证）");
});

test("没配代理时就是原生 fetch", () => {
  assert.equal(createFetch(""), fetch);
  assert.equal(createFetch(undefined), fetch);
  assert.notEqual(createFetch("http://127.0.0.1:37777"), fetch);
});

test("经 CONNECT 隧道访问 http 目标", async () => {
  const target = await track(await startTarget(false));
  const proxy = await track(await startProxy());
  const doFetch = createProxyFetch({ host: "127.0.0.1", port: proxy.port });

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
  const proxy = await track(await startProxy());
  // 目标名走 localhost，好让 SNI 真的被用上（IP 字面量不做 SNI）。
  const doFetch = createProxyFetch({ host: "127.0.0.1", port: proxy.port }, { ca: TEST_CERT });

  const response = await doFetch(`https://localhost:${target.port}/api/v2/chat/quota`);

  assert.equal(response.status, 200);
  const body = (await response.json()) as { host: string };
  assert.equal(body.host, `localhost:${target.port}`);
  assert.deepEqual(proxy.connects, [`localhost:${target.port}`]);
});

test("https 目标不信任自签证书时会失败", async () => {
  const target = await track(await startTarget(true));
  const proxy = await track(await startProxy());
  const doFetch = createProxyFetch({ host: "127.0.0.1", port: proxy.port });

  await assert.rejects(doFetch(`https://localhost:${target.port}/api/v2/chat/quota`), /TLS 握手失败/);
});

test("配额查询能整条走通代理", async () => {
  const target = await track(await startTarget(false));
  const proxy = await track(await startProxy());

  const window = await fetchQuota(
    { baseUrl: `http://127.0.0.1:${target.port}`, apiKey: "tok" },
    { proxy: `http://127.0.0.1:${proxy.port}` },
  );

  assert.equal(window.remainingTokens, 900);
  assert.equal(window.periodEnd, 1_700_018_000);
  assert.equal(proxy.connects.length, 1);
});

test("代理不可达时的错误要说清是代理的问题", async () => {
  const doFetch = createProxyFetch({ host: "127.0.0.1", port: 1 });
  await assert.rejects(doFetch("http://127.0.0.1:9/whatever"), /连接代理 127\.0\.0\.1:1 失败/);
});

test("代理拒绝隧道时报出状态码", async () => {
  const proxy = await track(await startRejectingProxy(407));
  const doFetch = createProxyFetch({ host: "127.0.0.1", port: proxy.port });
  await assert.rejects(
    doFetch("http://127.0.0.1:9/whatever"),
    /拒绝建立隧道：HTTP 407（代理要求认证）/,
  );
});

test("不支持的目标协议直接拒绝", async () => {
  const doFetch = createProxyFetch({ host: "127.0.0.1", port: 1 });
  await assert.rejects(doFetch("ftp://example.com/x"), /只能走 http 或 https/);
});
