# pi-v2ex-quota

[English](README.en.md) | [简体中文](README.md)

Surfaces your V2EX AI Chat quota in pi's status line, automatically continues the task after the quota window resets, and can retry after a transient upstream failure.

## What it does

1. **Status line**: remaining quota percentage and a countdown to the window reset.
2. **Immediate takeover**: when the quota is exhausted (HTTP 429 with a zero token balance) it aborts the current turn at once, instead of sitting through pi's three backoff retries.
3. **Auto-resume** (optional toggle): waits until the window resets, re-checks the quota, then injects a message so the agent picks up the unfinished work.
4. **Upstream retry** (optional toggle, off by default): when a 5xx, timeout or dropped connection kills the turn, waits out a backoff and picks the work up again.

## Installation

Install straight from GitHub:

```bash
pi install git:github.com/huaxianyan/pi-v2ex-quota
```

If you intend to modify the code, mounting by local path is handier — after editing, `/reload` picks it up, no republishing needed:

```bash
pi install /path/to/pi-v2ex-quota
```

One-off load for a single run:

```bash
pi -e /path/to/pi-v2ex-quota/src/index.ts
```

To remove: `pi remove git:github.com/huaxianyan/pi-v2ex-quota` (for a local mount, swap in that path).

There is exactly one prerequisite: `providers.v2ex` configured in `~/.pi/agent/models.json` — both the quota endpoint and the key are read from there.

Run `/v2ex` after installing and the quota shows up.

## Commands

| Command | Effect |
| --- | --- |
| `/v2ex` | Fetch the quota now, and expand/collapse the details panel |
| `/v2ex refresh` | Just re-fetch the quota |
| `/v2ex status on\|off` | Whether the status line shows the quota |
| `/v2ex wait on\|off` | Whether auto-resume is enabled |
| `/v2ex retry on\|off` | Whether retry after transient upstream failures is enabled (off by default) |
| `/v2ex start [prompt]` | Quota is known to be exhausted — queue a wait and auto-resume right away (no need to burn a message against the wall first) |
| `/v2ex cancel` | Cancel a pending auto-resume or upstream retry |
| `/v2ex debug on\|off` | Write a debug log to `v2ex-quota.log` in the agent directory |

## Configuration

A single global file, `~/.pi/agent/v2ex-quota.json`. There is no per-project override: quota is an account-level property, unrelated to the project, and an extra layer of override only makes "is it on right now?" harder to answer.

| Field | Default | Description |
| --- | --- | --- |
| `status` | `true` | Show the quota in the status line |
| `autoWait` | `false` | Wait for the reset and auto-resume when the quota is exhausted |
| `retryOnError` | `false` | Retry with backoff on upstream 5xx / timeout / connection loss |
| `errorRetrySeconds` | `60` | First retry delay in seconds; doubles afterwards; range 5–3600 |
| `maxErrorRetries` | `3` | Consecutive retry cap; a successful response or you taking over the turn resets it; range 1–10 |
| `pollSeconds` | `60` | Poll interval, also the status line refresh interval; range 15–3600 |
| `resumeBufferSeconds` | `20` | How long to wait past the reset time, to absorb clock skew between the server and the local machine |
| `maxResumeAttempts` | `3` | Maximum resumes within one window, to prevent spinning |
| `resumePrompt` | `配额已刷新，继续完成任务。` | The message injected when resuming |
| `baseUrl` | unset | Overrides the value read from `models.json` |
| `apiKey` | unset | Overrides the value read from `models.json` |
| `debug` | `false` | Write the debug log |

When `baseUrl` and `apiKey` are unset, they are read from `providers.v2ex` in `~/.pi/agent/models.json`; `apiKey` supports `$VAR` and `${VAR}` forms.

## Reading the status line

```
v2ex 87% · 4h12m        87% remaining, resets in 4h12m
v2ex 0% · 2h41m         Quota exhausted, no wait queued yet
v2ex 等待 2h41m         Auto-resume queued, continues when the countdown ends
v2ex 重试 45s           Upstream failed, waiting out a backoff (unrelated to remaining quota)
v2ex 空闲               No active window; the next message opens one
v2ex --                 No data fetched yet
```

Note that the visible status text is in Chinese (`等待` = waiting, `重试` = retrying, `空闲` = idle, `--` = unknown). The percentage is the **remaining** quota, not the used amount. Colors: dim in the normal case, warning color below 15% remaining, error color when exhausted, accent color while waiting or retrying.

## Automatic retry on upstream failures

Beyond the quota wall there is a second class of interruption: upstream 5xx, request timeouts, dropped connections. A retry usually gets through, but pi's own retries only cover the first dozen seconds.

**Off by default**; turn it on with `/v2ex retry on`. Only errors where "try again" could plausibly work are recognised:

| Recognised | Not recognised |
| --- | --- |
| 5xx (including 522) and 429 rate limiting | Other 4xx (400 / 401 / 404…) |
| Request timeout | Quota exhaustion (that belongs to auto-resume) |
| Dropped connection (`ECONNRESET`, `socket hang up`, `Connection error.`) | Anything unrecognisable |

A few boundaries:

- **It does not fight pi's built-in retries.** pi first does three fast retries of its own (2s / 4s / 8s, re-running the whole agent turn each time); the extension takes over at the moment pi gives up — `agent_settled`. So the real rhythm is: pi tries three times quickly (about 55 seconds), and only then do the extension's minute-scale backoffs start.
- **Backoff doubles.** `errorRetrySeconds` for the first wait, doubling each time, capped at 15 minutes; after `maxErrorRetries` attempts it stops and tells you.
- **Quota is irrelevant here.** It retries when the time is up, with no quota pre-check — the upstream being down and how much quota you have are two separate things. If it does hit the quota wall, the quota path takes over instead.
- **One success resets the count.** As soon as a request actually goes through, the consecutive-failure count goes back to zero; so does you taking over the turn manually.
- **The wait plan is persisted too.** Restarting pi resumes it; but if you turned `/v2ex retry off`, restoring the plan at startup is skipped as well.

The status line switches from the quota percentage to `v2ex 重试 45s`, and the notification names the failure class (`HTTP 522` / request timeout / connection loss) and which attempt this is.

## How auto-resume works

1. **Detect exhaustion**: HTTP 429 **and** `x-ai-chat-token-remaining` is 0. The status code alone is not enough — the per-minute rate limit is also a 429, but the token-remaining header stays above 0 then, and that must not be mistaken for the quota wall.
2. **Abort immediately**: calls `ctx.abort()`. pi classifies 429 as retryable and will back off three times, which is pointless behind a quota wall.
3. **Schedule**: once the turn has fully settled, the resume time is the window reset time plus `resumeBufferSeconds`. If no reset time is available, it falls back to retrying in 5 minutes.
4. **Re-check on arrival**: fetch the quota again. If the clock has passed but the server has not reset yet, it defers and counts an attempt; past `maxResumeAttempts` it stops and tells you.
5. **Inject the resume**: `pi.sendUserMessage(resumePrompt)` — fires immediately when the agent is idle, queues as a `followUp` when busy.

The wait plan is written to `~/.pi/agent/v2ex-quota-pending.json`, so restarting pi during the wait resumes it. After a restart, the plan is dropped if the project directory changed or auto-resume has been turned off.

Sending a message yourself cancels a pending auto-resume (you have taken over; it should not inject another one). If that turn hits the quota wall again, the wait is re-armed after the turn settles, using the window reset time — **cancelling does not lose the resume, it only delays it until your turn ends**. See "On-device self-checks" for measured evidence.

### Three ways to enter a wait

| How | Trigger | Fits |
| --- | --- | --- |
| Automatic | A turn actually hits the quota wall; scheduled once the turn settles | Interrupted mid-work by the wall |
| Manual `/v2ex start` | Checks the quota immediately, only queues if exhausted | You just reopened a session and already know there is no quota, without wanting to hit the wall again |
| Restore | Reads the on-disk wait plan at startup | pi was restarted during the wait |

`/v2ex start` does not schedule on a hunch; the query result decides:

- **Quota remaining** → does not queue, and reports your current usage (just get to work).
- **No active window** → does not queue; sending a message opens a new window.
- **Quota query failed** → does not queue, so it does not idle through a stale snapshot.
- **Already waiting** → only notifies, does not overwrite the existing plan.

If the auto-resume toggle happens to be off when scheduling, it is turned on as well — otherwise a resume that hits the wall again would have nobody to take over. `/v2ex start 接着改状态栏` lets you choose what this resume injects; it is persisted with the wait plan and survives a restart.

`/v2ex start` never produces an agent turn, so it **does not consume quota itself** (see "On-device self-checks").

### What you will see while waiting

**pi's "working" indicator disappears, and that is normal**: after `ctx.abort()` the turn is already over, nothing is running, and the wait is carried by the extension's own timer, independent of the agent's run state. The evidence that it is still waiting is the status line (`v2ex 等待 <countdown>`, refreshed every 60 seconds) plus the two notifications you get when the wait is queued.

Do not send a message in that session while waiting: any turn you start cancels the wait. Scrolling, paging through history and checking the status are all fine.

## Protocol basis

Everything below comes from <https://edge.v2ex.com/help/quota> plus measurements on this machine.

Query the quota (read-only; it does not start a new window):

```bash
curl -H "Authorization: Bearer <the v2ex apiKey from models.json>" \
     https://edge.v2ex.com/api/v2/chat/quota
```

Measured response:

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

Sending a message with the quota exhausted (measured):

```
HTTP/2 429
x-ai-chat-token-limit: 8020000
x-ai-chat-token-remaining: 0
x-ai-chat-token-reset: 1790075684
x-ai-chat-extra-usage-remaining: 0

{"error":{"message":"AI Chat quota exhausted","type":"rate_limit_error","param":null,"code":"rate_limit_exceeded"}}
```

Window semantics: one window every 5 hours; within a window the quota is spent and does not accumulate, **the next message opens a new window when there is no active one, and querying itself does not open a window**. So resuming right after the reset time yields a full quota for the new message.

The chat apiKey in `models.json` can be used directly as a Personal Access Token; no separate one is needed.

## Findings and known limits

- **`after_provider_response` fires on successful responses only, never on a 429.** Across the measured quota-exhausted requests this hook never called back, so detection actually relies on the `errorMessage` carried by `message_end`. Successful responses do fire it — the log shows a line like `provider response: status=200 tokenRemaining=4479645`, where `tokenRemaining` came straight from the response's `X-AI-Chat-*` headers (measured 2026-09-22). A single hook therefore does not cover both kinds of response: the success side uses it to refresh the balance, while the failure side needs a different landing spot.
- **pi still needs ~15 seconds to wrap up after an abort.** The extension's own work finishes about 1.8 seconds after detecting exhaustion; the rest is pi processing the abort, which the extension layer cannot influence.
- **One-shot runs do not take over the wait.** In `pi -p` (print) and json modes it does not write the status line and does not schedule an auto-resume; it only aborts. The reason is that these runs destroy the extension runner when they end, after which any UI call throws a stale-ctx error, and leaving a wait plan behind would pollute the next interactive startup.
- **`ctx` can go stale.** A captured `ctx` used after an `await` can throw `This extension ctx is stale`. This extension only writes UI in `tui` / `rpc` mode, and stops trying after the first UI error.
- **The wait timer is unref'd.** Waits run for hours; if the timer were the last handle in the event loop, it would hold up pi's exit — in tests the symptom is `node --test` never finishing. The plan is already on disk and recoverable after a restart, so not blocking process exit is safe.
- **Without a quota snapshot it degrades to a 5-minute fallback first.** The reset time used when scheduling on `agent_settled` comes from the most recent quota query; if the session just started and the first poll has not returned, there is no reset time to use, so it schedules 5 minutes out first. On arrival `resumeNow` queries again and, finding itself still inside the same exhausted window, defers to the real reset time — the cost is one wasted check and one `maxResumeAttempts` slot. Long-running sessions never hit this (measured: hitting the wall 1.3 seconds into a session scheduled `+5m`; the same scenario schedules the window reset time once the snapshot has landed).

- **pi has auto-retry of its own, but it only covers the first dozen seconds.** On an upstream error pi re-runs the whole agent turn, backing off 2s → 4s → 8s for three attempts, and only then emits `auto_retry_end` and `agent_settled` (measured on 2026-09-22 from the RPC event stream). So the upstream-retry toggle is an addition behind it, not a replacement: for one 522, the gap between sending the message and the extension scheduling is about 55 seconds.
- **The same 522 comes out of pi in more than one phrasing.** On device the observed `errorMessage` was `522 status code (no body)`; with a fake upstream that returns an empty-bodied 522, pi reports `Connection error.` — with no usable detail in the text at all. The failure classifier has to accept both, otherwise the retry path never fires (which is exactly how the first `verify:retry` run failed).

## Development

### Making the editor and the tests find pi's types

Two symlinks under `node_modules/@earendil-works/` pointing at the local pi installation are enough (`node_modules` is in `.gitignore`):

```bash
mkdir -p node_modules/@earendil-works
cd node_modules/@earendil-works
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent" pi-coding-agent
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui" pi-tui
```

### Running the tests

```bash
npm test
```

Node 22 ships type stripping and a test runner, so the tests run `.ts` directly — no build, no dependencies to install. They cover protocol parsing and formatting, and drive the whole extension (registration, status display, abort, wait, resume, attempt-limit stop) through a fake pi, fake context and fake quota endpoint.

The script uses `node --test "test/**/*.test.ts"`. **Do not write `node --test test/`** — Node 22 does not expand a directory into test files; it treats it as a module to `require`, fails with `Cannot find module '<project>\test'`, and disguises that as "1 test failed". The quotes route through Node's own glob, which also keeps it independent of shell expansion.

### Type checking

You need `typescript` and `@types/node`. Do not install them into this project's `node_modules`: npm will happily remove the two symlinks above. Install them elsewhere and pass `typeRoots` explicitly:

```bash
node <elsewhere>/node_modules/typescript/bin/tsc \
  --noEmit --strict --skipLibCheck --target es2023 \
  --module nodenext --moduleResolution nodenext --allowImportingTsExtensions \
  --types node --typeRoots <elsewhere>/node_modules/@types \
  src/index.ts src/config.ts src/v2ex.ts src/format.ts
```

### Tracing the event sequence

Write a throwaway extension that only appends event names to a file, attach it with `-e`, and you can see exactly which events pi emits and how many times:

```bash
pi -p "hi" --provider v2ex --model coder --no-session --offline \
   -ne -e ./trace.ts < /dev/null
```

**`< /dev/null` is not optional.** Running `pi -p` in a non-interactive shell, pi blocks waiting for EOF on stdin, which looks like no output at all and a process that never exits — easy to misread as a network problem.

### On-device self-checks: resume, re-arm, manual queueing and upstream retry

`npm test` uses a fake pi, so it proves the extension's own logic. But the things that genuinely depend on pi's lifecycle — whether `sendUserMessage` opens a new turn when the **session is idle**, whether the wait is re-armed after the user takes over, whether `/v2ex start` can schedule with zero agent turns, and whether the task really continues after an upstream failure — can only be answered by a real pi. `tools/verify-resume.mjs` covers those layers:

```bash
npm run verify:resume          # does it really start a turn when the time arrives
npm run verify:rearm           # is the wait re-armed after the user takes over
npm run verify:start           # can /v2ex start schedule directly (requires quota to be exhausted at the time)
npm run verify:start-live      # after /v2ex start schedules, does it really connect when the time arrives
npm run verify:retry           # does it retry with backoff after an upstream 522
```

All five cases:

1. Move the whole agent directory to a temp dir via `PI_CODING_AGENT_DIR`, so **your real config and wait plan are never touched**;
2. Start a real pi with `--mode rpc` and watch the event stream / debug log;
3. Assert and exit with a status code, cleaning up the temp directory afterwards.

The script finds pi's entry point itself: first this repo's `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` (the dev symlink), then the npm global directory. If neither exists, point at it with an environment variable:

```bash
PI_CLI=$(npm root -g)/@earendil-works/pi-coding-agent/dist/bundle/cli.js npm run verify:resume
```

The temp agent directory gets a copy of your `models.json` (the quota query needs the key from it), and the script deletes the whole temp directory when it finishes.

`rearm` and `start` go through the **real** quota endpoint, so they only work where the machine can reach `edge.v2ex.com` directly. On a network that needs a proxy, those two report `quota fetch failed: ... aborted due to timeout` — the extension's own `fetch` does not read `HTTPS_PROXY` (a limitation of Node's built-in fetch). The other three cases use local fake services and are unaffected.

`resume` additionally starts a local service that fakes only `GET /api/v2/chat/quota`, to create the "quota restored" condition (the real window often takes tens of minutes to reset, which is too long to wait for; LLM requests do not go through it), then pre-places a wait plan due in a dozen seconds and takes the real `restorePending → armWait → resumeNow` path. Measured output (2026-09-22):

```
+ 12038ms agent_start
+ 12039ms 会话内出现用户消息: "配额已刷新，继续完成任务。"
通过：agent_start=true 续跑消息进入会话=true
```

`rearm` uses the **real** quota endpoint: it pre-places a wait plan, then sends a message guaranteed to hit the wall, verifying the "cancel → hit the wall → re-arm" chain. Measured output (2026-09-22):

```
wait cleared: 用户已接管本轮
quota exhausted via 错误文案; autoWait=true
abort requested (streaming=true)
wait armed: resume at 2026-09-22T11:15:04.000Z (in 1h12m)
与窗口重置一致=true 不是 5 分钟兜底=true → 通过
```

`start` also uses the **real** quota endpoint, but is cleaner than the other two: no pre-placed plan, no message, just one `/v2ex start <prompt>` command. Measured output (2026-09-22, quota happened to be exactly zero):

```
+ 1830ms setStatus v2ex-quota = "v2ex 0% · 1h"
+ 1954ms 真实配额：active=true remaining=0 extra=0 reset=1790075684
+ 2219ms setStatus v2ex-quota = "v2ex 等待 1h"
+ 2220ms notify[info] 已排入自动续跑：1h 后继续（窗口于 2026-09-22 19:14 重置）
+ 5970ms 等待计划：{"resumeAt":1790075704000,...,"prompt":"验证用提示词：接着把状态栏对齐修掉"}
与窗口重置一致=true 提示词随计划落盘=true 状态栏进入等待=true 未产生 agent 轮次=true → 通过
```

The scheduled time is exactly `reset + resumeBufferSeconds`; the custom prompt is persisted with the plan; `未产生 agent 轮次=true` shows the command itself consumes no quota. When quota remains, this case verifies the opposite branch — "does not queue on its own".

`start-live` is `start` and `resume` combined — the entry is a command, the exit is a new agent turn. **Verifying the two separately does not prove the chain holds**, so there is a dedicated run: a fake quota service compresses the "window reset" to 8 seconds out (a real window is tens of minutes to hours away), and the whole thing completes within a minute. Measured output (2026-09-22):

```
+    30ms 假配额：余额 0、窗口 10:18:01Z 重置（8 秒后）
+  1683ms 已排期：2026-09-22T10:18:01.000Z（窗口重置 2026-09-22T10:18:01.000Z）
+  6699ms 额度已恢复（假的），等它到点续跑
+  7237ms agent_start
+  7238ms 会话内出现用户消息: "开始改状态栏对齐"
排期与窗口重置一致=true 到点复核后注入=true agent 起了一轮=true 注入内容=自定义提示词=true → 通过
```

`retry` starts a fake upstream whose quota endpoint is healthy while completions always return 522, acting the upstream failure out. pi insists on three retries of its own before handing over, so this case takes over a minute. Measured output (2026-09-22):

```
+  1654ms agent_start（第 1 次）
+ 11751ms pi 自己的重试：第 1/3 次，2000ms 后
+ 55836ms pi 自己的重试结束：success=false
+ 56190ms 已排期: 2026-09-22T11:52:43.164Z（5s 后，reason=error）
+ 60907ms agent_start（第 5 次）
+ 60907ms 会话内出现用户消息: "配额已刷新，继续完成任务。"
计划 reason=error=true（值 error）退避约 5s=true／到点注入=true 注入后又起一轮=true（4 → 5）→ 通过
```

Three lines in the extension's own log corroborate the same story: `transient error: 连接中断 (Connection error.) retryOnError=true` (one per pi failure, four in total), `wait armed: resume at ... (error, in 5s)`, and `resume: injecting continuation (error)`.

**RPC mode also works as a channel for UI assertions**: under RPC, `setStatus` / `notify` are pushed to stdout as `extension_ui_request` events (see pi's `docs/rpc.md`, Extension UI Protocol), so the status line text and notification content are both assertable. Note that `theme.fg()` wraps the text in ANSI escapes, so strip them before comparing — that is what `stripAnsi()` in the script is for.

`--mode rpc` is the key: it is a persistent session, `ctx.mode` is `rpc`, so it goes through the full status line and resume branches, and it accepts JSON commands line by line (`{"type":"prompt","message":"/v2ex start"}` runs an extension command) while emitting events line by line. `print` mode is a one-shot run in which the extension deliberately does nothing, so none of these paths can be verified there.
