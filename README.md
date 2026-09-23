# pi-v2ex-quota

[简体中文](README.md) | [English](README.en.md)

把 V2EX AI Chat 的配额接进 pi 的状态栏，在配额用尽时等窗口刷新后自动继续，也可以在上游瞬时故障后接着重试，配额查询还能单独走本地代理。

## 它做什么

1. **状态栏显示**：额度进度条、剩余百分比、距窗口重置的倒计时，外加三项开关的当前状态。
2. **立刻接手**：配额用尽时（HTTP 429 + token 余额归零）马上中止本轮，不再陪 pi 把三次退避重试跑完。
3. **自动续跑**（可选开关）：等到窗口刷新，先复核配额，再注入一条消息让 agent 接着做没做完的事。
4. **上游故障重试**（可选开关，默认关闭）：5xx / 超时 / 连接中断把本轮打断时，等一段退避时间后自动接着做。
5. **查询走本地代理**（可选）：只让配额查询走你本地的代理，不为此改动 shell 的环境变量；只写 `ip:端口`，协议自己试。

## 安装

直接从 GitHub 安装：

```bash
pi install git:github.com/huaxianyan/pi-v2ex-quota
```

要改代码的话，用本地路径挂载更顺手 —— 改完 `/reload` 即可生效，不需要重新发布：

```bash
pi install /path/to/pi-v2ex-quota
```

一次性的临时加载：

```bash
pi -e /path/to/pi-v2ex-quota/src/index.ts
```

移除：`pi remove git:github.com/huaxianyan/pi-v2ex-quota`（本地挂载则把源换成对应路径）。

扩展的运行前提只有一个：`~/.pi/agent/models.json` 里配好了 `providers.v2ex` —— 配额接口与密钥都从那里读。

装完执行 `/v2ex` 就能看到配额。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/v2ex` | 立即取一次配额，并展开／收起详情面板 |
| `/v2ex refresh` | 只重新取一次配额 |
| `/v2ex status on\|off` | 状态栏是否显示配额 |
| `/v2ex wait on\|off` | 是否启用自动续跑 |
| `/v2ex retry on\|off` | 是否启用上游故障自动重试（默认关闭） |
| `/v2ex start [提示词]` | 已知配额用尽，立即排入等待并自动续跑（不必先发一条消息去撞墙） |
| `/v2ex cancel` | 取消等待中的自动续跑或上游故障重试 |
| `/v2ex proxy [主机:端口\|off]` | 查看／设置／关闭配额查询走的本地代理，协议自动试，设置后立刻试查一次 |
| `/v2ex debug on\|off` | 写调试日志到 agent 目录下的 `v2ex-quota.log` |

## 配置

单个全局文件 `~/.pi/agent/v2ex-quota.json`，不提供项目级覆盖：配额是账号维度的，跟项目无关，多一层覆盖只会让「现在是开还是关」变难判断。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `status` | `true` | 在状态栏显示配额 |
| `autoWait` | `false` | 配额用尽时等待刷新并自动续跑 |
| `retryOnError` | `false` | 上游 5xx / 超时 / 连接中断时退避重试 |
| `errorRetrySeconds` | `60` | 上游故障后的首次重试等待秒数，之后翻倍，范围 5–3600 |
| `maxErrorRetries` | `3` | 连续重试次数上限，一次成功响应或你自己接管本轮都会清零，范围 1–10 |
| `pollSeconds` | `60` | 轮询间隔，同时也是状态栏刷新间隔，范围 15–3600 |
| `resumeBufferSeconds` | `20` | 过了重置时间再等几秒，避开服务端与本地时钟的偏差 |
| `maxResumeAttempts` | `3` | 同一窗口内最多续跑几次，防止反复空转 |
| `resumePrompt` | `配额已刷新，继续完成任务。` | 续跑时注入的消息正文 |
| `proxy` | 空 | 配额查询走的本地代理，形如 `127.0.0.1:37777` 或 `socks5://127.0.0.1:1080`；空表示直连 |
| `baseUrl` | 未设置 | 覆盖从 `models.json` 读到的值 |
| `apiKey` | 未设置 | 覆盖从 `models.json` 读到的值 |
| `debug` | `false` | 写调试日志 |

`baseUrl` 与 `apiKey` 不设置时，从 `~/.pi/agent/models.json` 里的 `providers.v2ex` 读取，`apiKey` 支持 `$VAR` 与 `${VAR}` 写法。

## 状态栏怎么读

一行分成两段，中间用 ` | ` 隔开：前半是配额，后半是三个开关的当前状态。

```
V2EX ███████░ 87% · 4h12m | 续跑 关 · 重试 关 · 代理 开   还剩 87%，距重置 4 小时 12 分
V2EX ░░░░░░░░ 0% · 2h41m | 续跑 开 · 重试 关 · 代理 开   配额用尽，还没排入等待
V2EX 等待 2h41m | 续跑 开 · 重试 关 · 代理 开            已排入自动续跑，倒计时结束后继续
V2EX 重试 45s | 续跑 开 · 重试 开 · 代理 关              上游故障，等退避后重试（与剩余额度无关）
V2EX 空闲 | 续跑 关 · 重试 关 · 代理 关                  没有有效窗口，发下一条消息时开新窗口
V2EX -- | 续跑 关 · 重试 关 · 代理 关                    还没取到数据
```

**配额段**：进度条与百分比都表示**剩余**额度（不是已用），后面的时间是距窗口重置（重试中则是距下次重试）。进度条八格，实心是剩余、空心会压暗一档；只有真正满额才画满格，否则 97% 也会画成满格，比旁边的数字还误导。

**开关段**：`续跑` / `重试` / `代理` 分别对应 `/v2ex wait`、`/v2ex retry`、`/v2ex proxy`。关着的也照常显示 —— 状态栏本来就是为了不用再敲一条命令去确认。代理只报开关不报地址，那一行放不下，地址在 `/v2ex` 面板里看。

颜色只看配额段：正常情况下暗色，剩余不足 15% 转告警色，用尽转错误色，等待与重试中为强调色。开关是静态配置，不该让状态栏变色。改开关时状态栏立刻刷新，不用等下一次轮询。

## 自动续跑的工作方式

1. **判定配额用尽**：HTTP 429 且 `x-ai-chat-token-remaining` 为 0。只看状态码不够 —— 每分钟请求限流也是 429，那时余额头仍大于 0，不该误判成配额墙。
2. **立刻中止**：调用 `ctx.abort()`。pi 把 429 归为可重试错误，会退避重试三次，而配额墙后面重试没有任何意义。
3. **排期**：本轮彻底结束后，用窗口重置时间加 `resumeBufferSeconds` 作为续跑时刻。拿不到重置时间时兜底 5 分钟后重试。
4. **到点先复核**：重新查一次配额。如果只是时间到了但服务端还没刷新，会顺延并计入一次尝试，超过 `maxResumeAttempts` 就停下来通知。
5. **注入续跑**：`pi.sendUserMessage(resumePrompt)`，agent 空闲时立即触发，忙时按 `followUp` 排队。

等待计划会写进 `~/.pi/agent/v2ex-quota-pending.json`，所以等待期间重启 pi 还能接着等。重启后如果项目目录变了、或自动续跑已被关掉，这份计划会被丢弃。

用户自己发消息会取消等待中的自动续跑（你已经上手了，不该再自动插一条）。如果这一轮又撞上配额墙，等待会在本轮结束后按窗口重置时间重新排上 —— **取消并不会丢掉续跑，只是让它等你这一轮结束**，实测见「真机自检」一节。

### 三种进入等待的方式

| 怎么进来 | 触发时机 | 适用场景 |
| --- | --- | --- |
| 自动 | 某轮真的撞到配额墙，本轮结束后排期 | 正常干活时被墙拦下 |
| 手动 `/v2ex start` | 立刻查一次配额，确认用尽才排 | 刚重开会话，已经知道没额度，不想再撞一次 |
| 恢复 | 启动时读磁盘上的等待计划 | 等待期间重启了 pi |

`/v2ex start` 不凭感觉排期，一切以查询结果为准：

- **仍有额度** → 不排，并告诉你当前用量（这时候直接干活就行）
- **没有活跃窗口** → 不排，发一条消息就会开新窗口
- **配额查询失败** → 不排，避免拿着过期快照空等一轮
- **已经在等待中** → 只提示，不覆盖既有计划

如果排期时自动续跑开关是关着的，会一并打开 —— 否则续跑一轮之后再撞墙就没人接手了。`/v2ex start 接着改状态栏` 可以指定这一轮续跑注入什么，它会随等待计划落盘，重启也还在。

`/v2ex start` 全程不产生 agent 轮次，所以它**本身不消耗额度**（实测见「真机自检」一节）。

### 等待期间你会看到什么

**pi 的「working」指示会消失，这是正常的**：`ctx.abort()` 之后本轮就已经结束了，没有任何东西在跑，等待是由扩展自己的定时器承担的，跟 agent 的运行状态无关。它还在等你的依据是状态栏的 `V2EX 等待 <倒计时>`（每 60 秒刷新一次），以及排期时收到的那两条通知。

等待期间不要在那个会话里发消息：你自己发起任何一轮都会取消等待。只滚动、翻记录、看状态都不影响。

## 上游故障自动重试

配额墙之外还有一类中断：上游 5xx、请求超时、连接断掉。这类故障重试往往就能成，但 pi 自己的重试只覆盖开头的十几秒。

**默认关闭**，`/v2ex retry on` 打开。判定口径只认「再试一次有可能成」的错误：

| 认 | 不认 |
| --- | --- |
| 5xx（含 522）与 429 限流 | 其它 4xx（400 / 401 / 404…） |
| 请求超时 | 配额用尽（归自动续跑管） |
| 连接中断（`ECONNRESET`、`socket hang up`、`Connection error.`） | 识别不出来的报错 |

几条边界：

- **不与 pi 内建重试打架**。pi 自己会先做三次快速重试（2s / 4s / 8s，每次都重跑一轮 agent），扩展接的是它放弃之后的那一刻 —— `agent_settled`。所以真实节奏是：pi 快速试三次（约 55 秒），还不行才轮到扩展的分钟级退避。
- **退避翻倍**。首次等 `errorRetrySeconds`，之后每次翻倍，封顶 15 分钟；累计到 `maxErrorRetries` 次就停下来告诉你。
- **跟额度无关**。到点即重试，不做配额预检 —— 上游挂了和有没有额度是两件事。真撞上配额墙，配额那条路会另行接手。
- **一次成功就清零**。某个请求真的走通了，连续故障的计数归零；你自己接管本轮也会归零。
- **等待计划同样落盘**。重启 pi 能接着等；但如果 `retry off` 关掉了，「启动时恢复计划」也会一并跳过。

状态栏的配额段会切成 `V2EX 重试 45s`（开关段照旧），通知里写清是哪一类故障（`HTTP 522` / 请求超时 / 连接中断）与第几次重试。

## 让查询走本地代理

配额查询可以单独走一个本地代理，只影响这一件事：

```bash
/v2ex proxy 127.0.0.1:37777          # 只写主机和端口，协议自动试
/v2ex proxy                          # 查看当前值
/v2ex proxy off                      # 关掉，回到直连
```

**协议不用你查**：只写 `127.0.0.1:37777` 就行，扩展会按 `http` → `socks5` → `socks4a` 的顺序挨个试，以**真能建起隧道**的那个为准，并把认出来的协议写回配置（`socks5://127.0.0.1:1080`），下次启动就不必再试。三种都不通时设置**失败**、原配置不动 —— 静默存下一个连不通的地址，比当场告诉你更糟。

探测的目标就是你真正要连的那个接口（`edge.v2ex.com:443`），不是另找一个好连的网址：要判断的是「能不能用它连上目标」，代理规则恰好不放行这个接口时，换个网址试通只会给出通过的假象。

想省掉探测也可以显式写协议：`http://`、`socks5://`（`socks://` 同义）、`socks4a://` 都认，带凭据的 `http://user:pass@host:port` 也支持；写了协议就只试那一种。`https://` 之类的代理协议会当场判成无法识别，而不是静默直连 —— 静默失效最难查。

设好之后状态栏的开关段里就有它：显示成 `代理 开`，关掉回到 `代理 关`，具体地址在 `/v2ex` 面板里看。**凭据只说明「有」，不回显** —— 地址里写了 `user:pass` 时，面板与通知显示成 `http://127.0.0.1:8080（含认证）`；存进配置的那一份仍然带凭据，否则代理根本连不上。

**为什么不读 `HTTPS_PROXY`**：环境变量会连带影响同一个 shell 里的所有程序，而你多半只想解决「配额接口连不上」这一件事。pi 的模型请求要不要走代理是另一回事，这里不替它做决定，也不受它影响。

**实现上没绕开 Node 的限制**：内置的 `fetch` 是 undici，既不读 `HTTPS_PROXY`（那是 Node 24 的 `NODE_USE_ENV_PROXY` 之后才有），也没把 `ProxyAgent` 暴露成可 import 的模块。所以这里用 `node:net` 手搭隧道：http 代理走 CONNECT，socks5 与 socks4a 各跑一遍握手，HTTPS 目标再补一层 TLS，最后照常交给 `http.request` 发字节。零依赖，代价是这几套握手得自己写、自己测。

## 协议依据

全部来自 <https://edge.v2ex.com/help/quota> 与本机实测。

查配额（只读，不会开始新窗口）：

```bash
curl -H "Authorization: Bearer <models.json 里的 v2ex apiKey>" \
     https://edge.v2ex.com/api/v2/chat/quota
```

实测响应：

```json
{
  "success": true,
  "message": "Current AI Chat 5h quota",
  "result": {
    "active": true,
    "total_tokens": 8020000,
    "used_tokens": 8020000,
    "remaining_tokens": 0,
    "used_percent": 100,
    "period_start": 1790057684,
    "period_end": 1790075684,
    "extra_usage": { "pack_count": 0, "total_tokens": 0, "used_tokens": 0, "remaining_tokens": 0 }
  }
}
```

配额用尽时发消息（实测）：

```
HTTP/2 429
x-ai-chat-token-limit: 8020000
x-ai-chat-token-remaining: 0
x-ai-chat-token-reset: 1790075684
x-ai-chat-extra-usage-remaining: 0

{"error":{"message":"AI Chat quota exhausted","type":"rate_limit_error","param":null,"code":"rate_limit_exceeded"}}
```

窗口语义：每 5 小时一个窗口，窗口内用完即止、不累积，**没有有效窗口时下一条消息才开始新窗口，查询本身不开窗**。所以重置时间一过直接续跑即可，新消息会带一个完整额度。

`models.json` 里那把 chat apiKey 可以直接当 Personal Access Token 用，不需要另配一个。

## 实测发现与已知限制

- **`after_provider_response` 只在成功响应上触发，429 时一次都不触发**。配额用尽的那几次请求，这个钩子从未回调，所以检测实际上靠 `message_end` 上的 `errorMessage`；而成功响应会回调 —— 日志里有 `provider response: status=200 tokenRemaining=4479645` 这样一行，`tokenRemaining` 就是从响应的 `X-AI-Chat-*` 头读出来的（实测于 2026-09-22）。也就是说这一个钩子覆盖不了两种响应，成功侧用它更新余额、失败侧必须另找落点。
- **中止之后 pi 还要收尾约 15 秒**。扩展自身的工作在检测到用尽后约 1.8 秒就结束了，剩下的时间是 pi 处理 abort 的过程，扩展层无法干预。
- **一次性运行不接管等待**。`pi -p`（print）和 json 模式下不会写状态栏、也不排自动续跑，只做中止。原因是这类运行结束时会销毁 extension runner，之后任何 UI 调用都会抛 ctx 失效，而且留下等待计划会污染下一次交互启动。
- **ctx 会失效**。`ctx` 捕获后在 `await` 之后使用可能抛 `This extension ctx is stale`。本扩展只在 `tui` / `rpc` 模式下写 UI，并且任何一次 UI 报错后就停止尝试写入。
- **等待定时器是 unref 的**。等待动辄几小时，如果让它成为事件循环里最后一个句柄，pi 退出时会被它拖住 —— 写测试时的表现就是 `node --test` 一直不结束。计划已经落盘、重启能恢复，所以让定时器不阻塞进程退出是安全的。
- **拿不到配额快照时会先退化成 5 分钟兜底**。`agent_settled` 排期用的重置时间来自最近一次配额查询；如果会话刚起、第一次轮询还没回来，那一刻就没有重置时间可用，只能先按 5 分钟排一次。到点 `resumeNow` 会重新查配额，发现仍在同一个用尽的窗口里就顺延到真正的重置时间 —— 代价是白跑一次检查、消耗一次 `maxResumeAttempts`。长时间开着的会话不会遇到（实测：会话起 1.3 秒就撞墙时排到 `+5m`，等快照落地后同样场景排到窗口重置时间）。

- **pi 自己有 auto retry，但只覆盖十几秒**。上游报错时 pi 会把整个 agent 轮次重跑一遍，退避 2s → 4s → 8s 共三次，全失败后才发 `auto_retry_end` 与 `agent_settled`（实测于 2026-09-22 的 RPC 事件流）。所以「上游故障重试」这个开关是补在它后面，不是替掉它：一次 522 从发消息到扩展排期，实际间隔约 55 秒。
- **同一个 522，pi 给出的措辞不止一种**。真机上观察到的是 `522 status code (no body)`；假上游固定返回空 body 的 522 时，pi 给的是 `Connection error.` —— 字面里没有任何可用细节。故障分类必须两种都认，否则重试路径永远不会触发（第一次跑 `verify:retry` 就是这么失败的）。
- **`http.request` 对非 200 的 CONNECT 响应既不报 `response` 也不报 `connect`**。拿它去发 CONNECT 时，代理回 407 只会得到一句 `socket hang up`，代理要求认证这件事直接从错误信息里消失。所以代理传输层是自己拼 CONNECT 请求并解析状态行（`test/proxy.test.ts` 里两条错误路径的用例就是钉这个的）。
- **把自建 socket 交给 `http.request` 当传输层，只能传 `createConnection`、不能传 `agent`**。Node 仅在 agent 未指定时才用它包一个一次性 agent，这条没有文档保证，靠真起假代理 + 真隧道验出来。
- **IPv6 压缩写法补零要按「组」算，不能按字符串段数算**。点分四段（`::ffff:1.2.3.4`）占两个组共 4 字节，按段数当 1 个数就会补出 18 字节、编码直接失败。`test/proxy.test.ts` 里有三条字节级用例钉住 v4 / v6 / 域名三种目标。

## 开发

### 让编辑器与测试能找到 pi 的类型

`node_modules/@earendil-works/` 下放两个指向本机 pi 安装的软链即可（`node_modules` 已在 `.gitignore` 里）：

```bash
mkdir -p node_modules/@earendil-works
cd node_modules/@earendil-works
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent" pi-coding-agent
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui" pi-tui
```

### 跑测试

```bash
npm test
```

Node 22 自带类型擦除与测试运行器，测试直接跑 `.ts`，不需要构建，也不需要装依赖。测试覆盖协议解析与格式化，以及用假 pi、假上下文、假配额接口跑通整个扩展的注册、状态显示、中止、等待、续跑、上限停止等路径。

脚本里写的是 `node --test "test/**/*.test.ts"`。**别写成 `node --test test/`** —— Node 22 不会把目录展开成测试文件，而是当成模块去 `require`，报 `Cannot find module '<项目>\test'`，并且伪装成「1 个用例失败」。加引号走 Node 自己的 glob，才能同时脱离 shell 展开。

### 类型检查

需要 `typescript` 与 `@types/node`。注意不要把它们装进本项目的 `node_modules`：npm 会顺手清掉上面那两个软链。装到别处再显式指定 `typeRoots`：

```bash
node <别处>/node_modules/typescript/bin/tsc \
  --noEmit --strict --skipLibCheck --target es2023 \
  --module nodenext --moduleResolution nodenext --allowImportingTsExtensions \
  --types node --typeRoots <别处>/node_modules/@types \
  src/index.ts src/config.ts src/v2ex.ts src/format.ts
```

### 追事件序列

写一个只往文件里追加事件名的临时扩展，用 `-e` 挂上，就能看清 pi 到底发了哪些事件、发了多少次：

```bash
pi -p "hi" --provider v2ex --model coder --no-session --offline \
   -ne -e ./trace.ts < /dev/null
```

**`< /dev/null` 不能省**。在非交互 shell 里跑 `pi -p`，pi 会挂在等 stdin 的 EOF，表现为完全不输出、进程不退出，看上去像是网络卡住了。

### 真机自检：续跑、重新排期、手动排队与代理探测

`npm test` 用的是假 pi，证明的是扩展自身的逻辑。而真正依赖 pi 生命周期的那几件事 —— `sendUserMessage` 在**会话空闲**时会不会开新一轮、用户接管后等待会不会重新排上、`/v2ex start` 能不能在零 agent 轮次下排期、上游故障之后能不能按退避接着跑、只写主机端口能不能认出代理协议 —— 只有真 pi 能回答。这些由 `tools/verify-resume.mjs` 覆盖：

```bash
npm run verify:resume          # 到点后能不能真的把一轮对话拉起来
npm run verify:rearm           # 用户接管本轮后，等待会不会重新排期
npm run verify:start           # /v2ex start 能不能直接排上（需要当时配额已用尽）
npm run verify:start-live      # /v2ex start 排上后，到点能不能真的接上
npm run verify:retry           # 上游 522 之后能不能按退避自动重试
npm run verify:proxy           # 只写主机端口能不能自动认出代理协议（需要本机有可用代理）
```

六条 case 都：

1. 用 `PI_CODING_AGENT_DIR` 把 agent 目录整个挪到临时目录，**不碰你真实的配置与等待计划**；
2. 以 `--mode rpc` 起真 pi 并盯事件流／调试日志；
3. 带断言与退出码，跑完自动清理临时目录。

脚本自己找 pi 的入口：先看本仓库 `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`（开发时那个软链就是），再退到 npm 全局目录。都不在时用环境变量指定：

```bash
PI_CLI=$(npm root -g)/@earendil-works/pi-coding-agent/dist/bundle/cli.js npm run verify:resume
```

临时 agent 目录里会有一份你 `models.json` 的副本（查配额要用它里面的 key），脚本结束时会删掉整个临时目录。

`rearm`、`start` 与 `proxy` 走**真实**配额接口（`proxy` 还要连你本地那个真代理），需要本机能连上 `edge.v2ex.com`。只能走代理出网的网络里这样跑：

```bash
# 扩展的配额查询走代理
V2EX_VERIFY_PROXY=http://127.0.0.1:37777 npm run verify:start
V2EX_VERIFY_PROXY=http://127.0.0.1:37777 npm run verify:proxy

# rearm 还要发一条真消息去撞配额墙，那一步是 pi 自己的请求，所以 pi 也得能出网
HTTPS_PROXY=http://127.0.0.1:37777 V2EX_VERIFY_PROXY=http://127.0.0.1:37777 npm run verify:rearm
```

两个变量的作用面不同，别混：`V2EX_VERIFY_PROXY` 写进临时配置的 `proxy` 字段，只管扩展的配额查询；`HTTPS_PROXY` 是给 pi 子进程的，管它自己的模型请求。少了后者，`rearm` 会表现成「消息发出去了但撞不到配额墙」—— 日志里是一串 `transient error: 请求超时`，看着像扩展坏了，其实 pi 压根没连上上游。其余三条用的是本地假服务，两个变量都不要设。

**别为了跑通 `rearm` 去烧额度**：它靠「发一条真消息、上游回 429」推进，配额还有余量时那条消息会真的发出去、链路却根本不会触发。所以它现在先看配额快照，不是归零状态就打印原因并以退出码 2 跳过（`start` 遇到同类情况会反向验证「不擅自排队」那一支）。

`resume` 额外起一个只伪造 `GET /api/v2/chat/quota` 的本地服务，把「配额已恢复」造出来（真实窗口往往几十分钟后才刷新，等不起；LLM 请求不经过它），再预置一份十几秒后到期的等待计划，走 `restorePending → armWait → resumeNow` 真路径。实测输出（2026-09-22）：

```
+ 12038ms agent_start
+ 12039ms 会话内出现用户消息: "配额已刷新，继续完成任务。"
通过：agent_start=true 续跑消息进入会话=true
```

`rearm` 用**真实**配额接口，先预置一份等待计划，再发一条必然撞墙的消息，验证「取消 → 撞墙 → 重新排期」这条链。实测输出（2026-09-22）：

```
wait cleared: 用户已接管本轮
quota exhausted via 错误文案; autoWait=true
abort requested (streaming=true)
wait armed: resume at 2026-09-22T11:15:04.000Z (in 1h12m)
与窗口重置一致=true 不是 5 分钟兜底=true → 通过
```

`start` 同样用**真实**配额接口，但比另两条更干净：不预置计划、不发消息，只发一条 `/v2ex start <提示词>` 命令。配额归零时会排上等待，实测输出（2026-09-22，当时还没有进度条、代理一项显示的也还是端口，保留原样）：

```
+     4ms 配额接口走代理: http://127.0.0.1:37777
+  3023ms setStatus v2ex-quota = "V2EX 0% · 3h15m | 续跑 开 · 重试 关 · 代理 37777"
+  3140ms 真实配额：active=true remaining=0 extra=0 reset=1790093705
+  3140ms 执行 /v2ex start 验证用提示词：接着把状态栏对齐修掉
+  3841ms setStatus v2ex-quota = "V2EX 等待 3h15m | 续跑 开 · 重试 关 · 代理 37777"
+  3841ms notify[info] 已排入自动续跑：3h15m 后继续（窗口于 2026-09-23 00:15 重置）
+  7145ms 等待计划：{"resumeAt":1790093725000,...,"prompt":"验证用提示词：接着把状态栏对齐修掉"}
与窗口重置一致=true 提示词随计划落盘=true 状态栏进入等待=true 未产生 agent 轮次=true → 通过
```

排期时刻正好是 `reset + resumeBufferSeconds`；自定义提示词随计划落盘；`未产生 agent 轮次=true` 说明这个命令本身不消耗额度。配额还有余量时会走另一支，实测输出（2026-09-23，新文案）：

```
+  2225ms 真实配额：active=true remaining=1888708 extra=0 reset=1790167590
+  2225ms 执行 /v2ex start 验证用提示词：接着把状态栏对齐修掉
+  3408ms notify[info] 当前仍有额度（V2EX ██░░░░░░ 24% · 3h57m），未排入等待
+  6227ms 等待计划：(无)
通过：配额仍有余量，start 未排等待并说明了原因（提示=true 无计划=true 无 agent 轮次=true）
```

`start-live` 是 `start` 与 `resume` 的合体 —— 入口是命令、出口是新的 agent 轮次。**两条分开验过不等于链路成立**，所以专门跑一次：用假配额服务把「窗口重置」压到 8 秒后（真窗口要等几十分钟到几小时），一分钟内跑完全程。实测输出（2026-09-22）：

```
+    30ms 假配额：余额 0、窗口 10:18:01Z 重置（8 秒后）
+  1683ms 已排期：2026-09-22T10:18:01.000Z（窗口重置 2026-09-22T10:18:01.000Z）
+  6699ms 额度已恢复（假的），等它到点续跑
+  7237ms agent_start
+  7238ms 会话内出现用户消息: "开始改状态栏对齐"
排期与窗口重置一致=true 到点复核后注入=true agent 起了一轮=true 注入内容=自定义提示词=true → 通过
```

`retry` 起一个「配额正常、补全固定 522」的假上游，把上游故障演出来。pi 自己要先重试三次才交棒，所以这条 case 要跑一分多钟。实测输出（2026-09-22）：

```
+  1654ms agent_start（第 1 次）
+ 11751ms pi 自己的重试：第 1/3 次，2000ms 后
+ 55836ms pi 自己的重试结束：success=false
+ 56190ms 已排期: 2026-09-22T11:52:43.164Z（5s 后，reason=error）
+ 60907ms agent_start（第 5 次）
+ 60907ms 会话内出现用户消息: "配额已刷新，继续完成任务。"
计划 reason=error=true（值 error）退避约 5s=true／到点注入=true 注入后又起一轮=true（4 → 5）→ 通过
```

扩展日志里同一件事的三条证据也能对上：`transient error: 连接中断 (Connection error.) retryOnError=true`（pi 的四次失败各记一条）、`wait armed: resume at ... (error, in 5s)`、`resume: injecting continuation (error)`。

`proxy` 把 `V2EX_VERIFY_PROXY` 里的协议**故意剥掉**再喂给扩展（`http://127.0.0.1:37777` → `127.0.0.1:37777`），走的就是用户实际会走的那条路：先说清此刻直连取不到配额，再让扩展自己认协议，最后验关闭也能退回去。实测输出（2026-09-23，本机直连确实不通）：

```
+     6ms 只写主机端口来设置代理: 127.0.0.1:37777
+ 10668ms setStatus v2ex-quota = "V2EX -- | 续跑 开 · 重试 关 · 代理 关"
+ 10912ms 启动时的直连查询：失败（预期）
+ 10937ms setStatus v2ex-quota = "V2EX -- | 续跑 开 · 重试 关 · 代理 开"
+ 11810ms setStatus v2ex-quota = "V2EX ██░░░░░░ 24% · 3h55m | 续跑 开 · 重试 关 · 代理 开"
+ 11810ms notify[info] 配额查询已走 http://127.0.0.1:37777，连接正常
+ 12247ms 配置里存下的代理：http://127.0.0.1:37777
+ 12272ms setStatus v2ex-quota = "V2EX ██░░░░░░ 24% · 3h55m | 续跑 开 · 重试 关 · 代理 关"
直连失败=true 设置前配置为空=true
探测出协议=http 写回配置=http://127.0.0.1:37777
设置后查询成功=true 状态栏有配额进度条=true 代理=开=true
关闭后配置=「」状态栏代理=关=true
通过：只写主机端口即可自动认协议并接通
探测日志：proxy probe: 127.0.0.1:37777 -> edge.v2ex.com:443
```

日志里 `proxy probe: 127.0.0.1:37777 -> edge.v2ex.com:443` 是探测目标，`proxy set: http://127.0.0.1:37777（试过 http）` 说明第一个协议就试通了。

**RPC 模式还能当 UI 断言的通道**：`setStatus` / `notify` 在 RPC 下会以 `extension_ui_request` 事件推到 stdout（见 pi 的 `docs/rpc.md` 的 Extension UI Protocol），所以状态栏文案与通知内容都是可断言的。注意 `theme.fg()` 会在文本前后包 ANSI 转义，比对前先剥离 —— 脚本里的 `stripAnsi()` 就是干这个的。

`--mode rpc` 是关键：它是持久会话，`ctx.mode` 为 `rpc`，会走完整的状态栏与续跑分支，同时能按行喂 JSON 命令（`{"type":"prompt","message":"/v2ex start"}` 即可执行扩展命令）、按行读事件。`print` 模式是一次性运行，扩展在里面主动什么都不做，验不了这些路径。
