import {
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { QuotaConfig } from "./config.ts";
import { formatTokens } from "./format.ts";
import { SMART_COMPACT_MIN_CONTEXT_PERCENT } from "pi-smart-compact/extension-api";

type Model = NonNullable<ExtensionContext["model"]>;

/** 临时窗口对外可见的四种状态。 */
type CompactWindowState = "off" | "paused" | "pending" | "active";

/** 支持整数 tokens、k 和 m，例如 400k、0.4m。 */
export function parseWindow(input: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(input);
  if (!match) return undefined;
  const value = Number(match[1]) * (match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 只替换会话模型的副本，模型目录中的对象始终保留原值。 */
export class CompactWindow {
  private original?: Model;
  private replacement?: Model;
  private paused = false;

  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  private settings(model: Model) {
    // 让 pi 自己解析默认值及逐模型覆盖，扩展不复制它的解析规则。
    return SettingsManager.inMemory(this.pi.getSettings()).getCompactionSettings(model);
  }

  /** Smart Compact 的全局设置。它自己的分支级开关不反映在这里。 */
  private smartSettings(): { autoTrigger?: boolean; minContextPercent?: number } {
    const effective = this.pi.getSettings() as {
      smartCompact?: { autoTrigger?: boolean; minContextPercent?: number };
    };
    return effective.smartCompact ?? {};
  }

  private state(config: QuotaConfig): CompactWindowState {
    if (!config.compactWindowEnabled) return "off";
    if (this.paused) return "paused";
    return this.replacement ? "active" : "pending";
  }

  /** 状态栏用的短标签，形如 `400K`。 */
  label(config: QuotaConfig): string {
    const state = this.state(config);
    if (state === "active") return formatTokens(config.compactWindowTokens);
    return { off: "关", paused: "暂停", pending: "待启用" }[state];
  }

  /** 详情面板用的一行说明。 */
  detail(config: QuotaConfig): string {
    const state = this.state(config);
    if (state === "active") return `${config.compactWindowTokens.toLocaleString()} tokens`;
    return {
      off: "已关闭",
      paused: "已暂停，/v2ex compact on 可重试",
      pending: "待启用",
    }[state];
  }

  validate(model: Model, window: number): void {
    const original = model === this.replacement ? this.original! : model;
    const settings = this.settings(original);
    const effective = this.pi.getSettings();
    if (!SettingsManager.inMemory(effective).getCompactionEnabled()) {
      throw new Error("pi 的自动压缩已关闭，请先开启自动压缩，再设置临时窗口");
    }
    if (!this.pi.getCommands().some((command) => command.name === "smart-compact")) {
      throw new Error("请先安装并加载 pi-smart-compact，再设置临时窗口");
    }
    const smart = this.smartSettings();
    if (smart.autoTrigger === false) {
      throw new Error("Smart Compact 的自动压缩已关闭，请在 /smart-compact settings 中开启后重试");
    }
    const minPercent = smart?.minContextPercent ?? SMART_COMPACT_MIN_CONTEXT_PERCENT;
    const triggerPercent = (1 - settings.reserveTokens / window) * 100;
    if (triggerPercent < minPercent) {
      throw new Error(
        `此窗口会在 ${triggerPercent.toFixed(1)}% 时触发，低于 Smart Compact 的 ${minPercent}% 门槛。` +
        "请增大临时窗口，或在 /smart-compact settings 中降低最低占比",
      );
    }
    if (window > original.contextWindow) {
      throw new Error(`临时窗口应不超过模型原始窗口 ${original.contextWindow.toLocaleString()} tokens`);
    }
    if (window <= settings.reserveTokens + settings.keepRecentTokens) {
      throw new Error(
        `临时窗口应大于 ${(settings.reserveTokens + settings.keepRecentTokens).toLocaleString()} tokens，` +
        "为压缩后的近期对话和回复留出空间",
      );
    }
  }

  async sync(ctx: ExtensionContext, config: QuotaConfig): Promise<void> {
    const model = ctx.model;
    if (model !== this.replacement) {
      this.original = undefined;
      this.replacement = undefined;
    }
    if (!model || model.provider !== "v2ex") return;
    if (!config.compactWindowEnabled || this.paused) {
      await this.restore(ctx);
      return;
    }
    this.validate(model, config.compactWindowTokens);
    const original = this.original ?? model;
    if (model === this.replacement && model.contextWindow === config.compactWindowTokens) return;
    const replacement = { ...original, contextWindow: config.compactWindowTokens };
    if (!(await this.pi.setModel(replacement))) {
      throw new Error("V2EX 模型认证不可用，请检查登录或 API 密钥后重试");
    }
    this.original = original;
    this.replacement = replacement;
  }

  async restore(ctx: ExtensionContext): Promise<void> {
    if (ctx.model === this.replacement && this.original) {
      if (!(await this.pi.setModel(this.original))) {
        throw new Error("模型原始窗口恢复失败，请检查 V2EX 认证后执行 /reload");
      }
    }
    this.original = undefined;
    this.replacement = undefined;
  }

  async pause(ctx: ExtensionContext): Promise<void> {
    this.paused = true;
    await this.restore(ctx);
  }

  resume(): void {
    this.paused = false;
  }

  status(ctx: ExtensionContext, config: QuotaConfig): string {
    const model = ctx.model;
    if (!model) return "请先选择 V2EX 模型，再查看临时窗口";
    const original = model === this.replacement ? this.original! : model;
    const settings = this.settings(model);
    const smart = this.smartSettings();
    const minPercent = smart.minContextPercent ?? SMART_COMPACT_MIN_CONTEXT_PERCENT;
    return `V2EX 临时窗口：${this.detail(config)}\n` +
      `原始窗口 ${original.contextWindow.toLocaleString()}，当前窗口 ${model.contextWindow.toLocaleString()}，` +
      `目标窗口 ${config.compactWindowTokens.toLocaleString()} tokens\n` +
      `自动压缩触发点：超过 ${Math.max(0, model.contextWindow - settings.reserveTokens).toLocaleString()} tokens` +
      `（窗口的 ${((1 - settings.reserveTokens / model.contextWindow) * 100).toFixed(1)}%）\n` +
      (smart.autoTrigger === false
        ? `Smart Compact 自动压缩：已关闭，低于最低占比 ${minPercent}% 也不会触发，请在 /smart-compact settings 中开启`
        : `Smart Compact 自动压缩：已开启，最低占比 ${minPercent}%（可在 /smart-compact settings 中调整）`);
  }
}
