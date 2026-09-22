import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  clearPending,
  configPath,
  DEFAULT_CONFIG,
  loadConfig,
  normalizeConfig,
  pendingPath,
  readPending,
  saveConfig,
  writePending,
} from "../src/config.ts";

const roots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-v2ex-config-"));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

test("空配置落到默认值", () => {
  assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig("nonsense"), DEFAULT_CONFIG);
});

test("越界的数值被夹紧而不是报错", () => {
  assert.equal(normalizeConfig({ pollSeconds: 1 }).pollSeconds, 15);
  assert.equal(normalizeConfig({ pollSeconds: 99_999 }).pollSeconds, 3_600);
  assert.equal(normalizeConfig({ pollSeconds: 62.4 }).pollSeconds, 62);
  assert.equal(normalizeConfig({ maxResumeAttempts: 99 }).maxResumeAttempts, 10);
  assert.equal(normalizeConfig({ resumeBufferSeconds: -5 }).resumeBufferSeconds, 0);
  assert.equal(normalizeConfig({ errorRetrySeconds: 0 }).errorRetrySeconds, 5);
  assert.equal(normalizeConfig({ errorRetrySeconds: 99_999 }).errorRetrySeconds, 3_600);
  assert.equal(normalizeConfig({ maxErrorRetries: 0 }).maxErrorRetries, 1);
  assert.equal(normalizeConfig({ maxErrorRetries: 99 }).maxErrorRetries, 10);
  assert.equal(normalizeConfig({ pollSeconds: "60" }).pollSeconds, DEFAULT_CONFIG.pollSeconds);
});

test("开关只认真正的布尔值", () => {
  assert.equal(normalizeConfig({ status: true }).status, true);
  assert.equal(normalizeConfig({ status: false }).status, false);
  assert.equal(normalizeConfig({ status: "on" }).status, false);
  assert.equal(normalizeConfig({ autoWait: true }).autoWait, true);
  assert.equal(normalizeConfig({ autoWait: "yes" }).autoWait, false);
  assert.equal(normalizeConfig({}).autoWait, false);
  // 上游故障重试是额外能力，默认必须是关的。
  assert.equal(normalizeConfig({}).retryOnError, false);
  assert.equal(normalizeConfig({ retryOnError: true }).retryOnError, true);
  assert.equal(normalizeConfig({ retryOnError: "on" }).retryOnError, false);
});

test("空的续跑文案退回默认值", () => {
  assert.equal(normalizeConfig({ resumePrompt: "  " }).resumePrompt, DEFAULT_CONFIG.resumePrompt);
  assert.equal(normalizeConfig({ resumePrompt: " 接着做 " }).resumePrompt, "接着做");
});

test("代理只留合法地址，写错了退回直连", () => {
  assert.equal(normalizeConfig({ proxy: "http://127.0.0.1:37777" }).proxy, "http://127.0.0.1:37777");
  assert.equal(normalizeConfig({ proxy: " 127.0.0.1:37777 " }).proxy, "127.0.0.1:37777");
  // 非法值当没配，配置里不该留一个会让查询永远失败的值；
  // 要报错的是输入命令的那一刻，不是每次查询。
  assert.equal(normalizeConfig({ proxy: "socks5://127.0.0.1:1080" }).proxy, "");
  assert.equal(normalizeConfig({ proxy: "http://" }).proxy, "");
  assert.equal(normalizeConfig({ proxy: 42 }).proxy, "");
  assert.equal(normalizeConfig({}).proxy, "");
});

test("配置缺失时读到默认值", () => {
  assert.deepEqual(loadConfig(tempDir()), DEFAULT_CONFIG);
});

test("损坏的配置文件不炸，退回默认值", () => {
  const dir = tempDir();
  writeFileSync(configPath(dir), "{ 半个 json");
  assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
});

test("保存后能读回，且补丁只覆盖指定字段", () => {
  const dir = tempDir();
  saveConfig(dir, { autoWait: true });
  assert.equal(loadConfig(dir).autoWait, true);
  assert.equal(loadConfig(dir).status, DEFAULT_CONFIG.status);

  saveConfig(dir, { status: false });
  const reloaded = loadConfig(dir);
  assert.equal(reloaded.status, false);
  assert.equal(reloaded.autoWait, true);
});

test("保存时抹掉未设置的覆盖项", () => {
  const dir = tempDir();
  saveConfig(dir, { baseUrl: "https://edge.v2ex.com/chat/v1", apiKey: "k" });
  assert.equal(loadConfig(dir).baseUrl, "https://edge.v2ex.com/chat/v1");

  saveConfig(dir, { baseUrl: undefined, apiKey: undefined });
  assert.equal(loadConfig(dir).baseUrl, undefined);
  assert.equal(readFileSync(configPath(dir), "utf8").includes("baseUrl"), false);
});

test("目录不存在时会按需创建", () => {
  const nested = join(tempDir(), "deep", "agent");
  saveConfig(nested, { autoWait: true });
  assert.equal(loadConfig(nested).autoWait, true);
});

test("等待计划的读写与清除", () => {
  const dir = tempDir();
  assert.equal(readPending(dir), undefined);

  writePending(dir, { resumeAt: 1_790_075_684_000, attempts: 2, cwd: "E:/dev/pi" });
  assert.deepEqual(readPending(dir), {
    resumeAt: 1_790_075_684_000,
    attempts: 2,
    cwd: "E:/dev/pi",
    prompt: undefined,
    reason: undefined,
  });

  writePending(dir, {
    resumeAt: 1_790_075_684_000,
    attempts: 0,
    cwd: "E:/dev/pi",
    prompt: "接着改状态栏",
  });
  assert.equal(readPending(dir)?.prompt, "接着改状态栏");

  clearPending(dir);
  assert.equal(readPending(dir), undefined);
});

test("等待原因会落盘，缺省或非法值退回「等配额刷新」", () => {
  const dir = tempDir();
  writePending(dir, {
    resumeAt: 1_790_075_684_000,
    attempts: 1,
    cwd: "E:/dev/pi",
    reason: "error",
  });
  assert.equal(readPending(dir)?.reason, "error");

  writePending(dir, {
    resumeAt: 1_790_075_684_000,
    attempts: 1,
    cwd: "E:/dev/pi",
    reason: "quota",
  });
  assert.equal(readPending(dir)?.reason, "quota");

  // 更早版本写的计划文件里没有这个字段，不该被当成坏数据。
  writeFileSync(
    pendingPath(dir),
    JSON.stringify({ resumeAt: 1_790_075_684_000, attempts: 0, cwd: "E:/dev/pi" }),
  );
  assert.equal(readPending(dir)?.reason, undefined);

  writeFileSync(
    pendingPath(dir),
    JSON.stringify({ resumeAt: 1_790_075_684_000, attempts: 0, cwd: "E:/dev/pi", reason: "??" }),
  );
  assert.equal(readPending(dir)?.reason, undefined);
});

test("损坏的等待计划当作不存在", () => {
  const dir = tempDir();
  writeFileSync(pendingPath(dir), JSON.stringify({ resumeAt: "later" }));
  assert.equal(readPending(dir), undefined);
});
