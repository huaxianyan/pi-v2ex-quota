/**
 * 扩展配置的读写。配置只有全局一份，放在 pi agent 目录下。
 *
 * 之所以不提供项目级配置：配额是账号维度的，跟项目无关，
 * 多一层覆盖只会让「现在到底是开还是关」变难判断。
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { normalizeProxy } from "./proxy.ts";

export const CONFIG_FILE = "v2ex-quota.json";
export const PENDING_FILE = "v2ex-quota-pending.json";

export interface QuotaConfig {
  /** 在 pi 状态栏显示配额。 */
  status: boolean;
  /** 配额用尽时不结束任务，等到窗口刷新后自动继续。 */
  autoWait: boolean;
  /**
   * 上游 5xx / 超时 / 连接中断等瞬时故障时，等待一段时间后自动重试。
   * 这是相对 autoWait 的额外能力，默认关闭：网络抖一下就自动重发消息，
   * 对多数人来说是意外行为，得显式开启。
   */
  retryOnError: boolean;
  /** 上游故障后的首次重试等待秒数，之后按次数指数退避。 */
  errorRetrySeconds: number;
  /** 连续重试次数上限；一次成功响应或用户接管本轮都会清零。 */
  maxErrorRetries: number;
  /** 状态栏刷新间隔（秒），同时也是后台轮询间隔。 */
  pollSeconds: number;
  /** 到达重置时间后再多等几秒，避免服务端时间与本地时钟的偏差。 */
  resumeBufferSeconds: number;
  /** 同一窗口内最多自动续跑几次，防止反复空转。 */
  maxResumeAttempts: number;
  /** 自动续跑时注入的消息。 */
  resumePrompt: string;
  /**
   * 查询配额时走的本地 HTTP 代理，空串表示直连。
   *
   * 单独开这一项而不是读 HTTPS_PROXY：环境变量会影响同 shell 里的所有程序，
   * 而这里要解决的只是「配额接口连不上」这一个问题。
   */
  proxy: string;
  /** 覆盖从 models.json 读到的 baseUrl。 */
  baseUrl?: string;
  /** 覆盖从 models.json 读到的 apiKey。 */
  apiKey?: string;
  /** 把内部事件写进 agent 目录下的 v2ex-quota.log。 */
  debug: boolean;
}

export const DEFAULT_CONFIG: QuotaConfig = {
  status: true,
  autoWait: false,
  retryOnError: false,
  errorRetrySeconds: 60,
  maxErrorRetries: 3,
  pollSeconds: 60,
  resumeBufferSeconds: 20,
  maxResumeAttempts: 3,
  resumePrompt: "配额已刷新，继续完成任务。",
  proxy: "",
  baseUrl: undefined,
  apiKey: undefined,
  debug: false,
};

/**
 * 这次等待在等什么：配额窗口刷新（quota），还是上游故障后的重试（error）。
 * 两者的到点行为不同 —— 前者要先复核额度，后者直接续跑。
 */
export type WaitReason = "quota" | "error";

export interface PendingResume {
  /** 计划续跑的时刻（毫秒时间戳）。 */
  resumeAt: number;
  /** 本窗口内已经自动续跑过的次数。 */
  attempts: number;
  /** 记录建立时所在的项目目录，用于判断重启后是否还该续跑。 */
  cwd: string;
  /** 本次续跑注入的消息，缺省时用配置里的 resumePrompt。 */
  prompt?: string;
  /** 等待原因。缺省视为等配额刷新，兼容更早版本留下的计划文件。 */
  reason?: WaitReason;
}

export function configPath(agentDir: string): string {
  return join(agentDir, CONFIG_FILE);
}

export function pendingPath(agentDir: string): string {
  return join(agentDir, PENDING_FILE);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalWaitReason(value: unknown): WaitReason | undefined {
  return value === "quota" || value === "error" ? value : undefined;
}

/** 把任意来源的对象收敛成合法配置，越界的值就地夹紧而不是报错。 */
export function normalizeConfig(raw: unknown): QuotaConfig {
  const source = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const resumePrompt = optionalString(source["resumePrompt"]);
  return {
    status: source["status"] === undefined ? DEFAULT_CONFIG.status : source["status"] === true,
    autoWait: source["autoWait"] === undefined ? DEFAULT_CONFIG.autoWait : source["autoWait"] === true,
    retryOnError: source["retryOnError"] === true,
    errorRetrySeconds: clampInt(
      source["errorRetrySeconds"],
      5,
      3600,
      DEFAULT_CONFIG.errorRetrySeconds,
    ),
    maxErrorRetries: clampInt(source["maxErrorRetries"], 1, 10, DEFAULT_CONFIG.maxErrorRetries),
    pollSeconds: clampInt(source["pollSeconds"], 15, 3600, DEFAULT_CONFIG.pollSeconds),
    resumeBufferSeconds: clampInt(
      source["resumeBufferSeconds"],
      0,
      3600,
      DEFAULT_CONFIG.resumeBufferSeconds,
    ),
    maxResumeAttempts: clampInt(
      source["maxResumeAttempts"],
      0,
      10,
      DEFAULT_CONFIG.maxResumeAttempts,
    ),
    resumePrompt: resumePrompt ?? DEFAULT_CONFIG.resumePrompt,
    proxy: normalizeProxy(source["proxy"]),
    baseUrl: optionalString(source["baseUrl"]),
    apiKey: optionalString(source["apiKey"]),
    debug: source["debug"] === true,
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function loadConfig(agentDir: string): QuotaConfig {
  return normalizeConfig(readJson(configPath(agentDir)));
}

/** 原子写：先写同目录临时文件再改名，避免中断留下半个 JSON。 */
function writeJsonAtomic(agentDir: string, file: string, value: unknown): void {
  mkdirSync(agentDir, { recursive: true });
  const tempDir = mkdtempSync(join(agentDir, ".v2ex-quota-"));
  try {
    const tempFile = join(tempDir, CONFIG_FILE);
    writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempFile, file);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** 读取现有配置、合并补丁、落盘，返回合并后的完整配置。 */
export function saveConfig(agentDir: string, patch: Partial<QuotaConfig>): QuotaConfig {
  const merged = normalizeConfig({ ...loadConfig(agentDir), ...patch });
  writeJsonAtomic(agentDir, configPath(agentDir), merged);
  return merged;
}

export function readPending(agentDir: string): PendingResume | undefined {
  const raw = readJson(pendingPath(agentDir));
  if (typeof raw !== "object" || raw === null) return undefined;
  const source = raw as Record<string, unknown>;
  const resumeAt = source["resumeAt"];
  if (typeof resumeAt !== "number" || !Number.isFinite(resumeAt)) return undefined;
  return {
    resumeAt,
    attempts: clampInt(source["attempts"], 0, 10, 0),
    cwd: typeof source["cwd"] === "string" ? source["cwd"] : "",
    prompt: optionalString(source["prompt"]),
    reason: optionalWaitReason(source["reason"]),
  };
}

export function writePending(agentDir: string, pending: PendingResume): void {
  writeJsonAtomic(agentDir, pendingPath(agentDir), pending);
}

export function clearPending(agentDir: string): void {
  rmSync(pendingPath(agentDir), { force: true });
}
