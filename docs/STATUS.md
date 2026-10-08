# 开发进度

## 2026-10-08 / 01：V2EX 临时上下文窗口

状态：本地开发完成，基于 `main` 的 `3e7a26a`，本轮改动尚未提交和部署。

### 本轮完成

- 新增 `/v2ex compact window <tokens>`、`on`、`off` 和 `status`。
- 使用当前会话的模型副本调整窗口，关闭、切换模型和重载时恢复或重新应用。
- 开关与目标值持久化到扩展配置，默认关闭、目标窗口 400,000 tokens。
- 读取 pi 的实际预留量与逐模型覆盖，检查 Smart Compact 的安装及全局触发门槛。
- 压缩失败后暂停临时窗口、恢复原值并停止自动任务，手动压缩后可重新启用。

### 验证与边界

- `node tools/verify-compact-window.mjs` 通过：真实 pi 和 Smart Compact 自动生成并应用摘要，模型及 pi 设置文件保持原样。包含关闭恢复、模型切换和重载。
- 模型响应使用固定 fixture，未调用 V2EX 上游。临时 agent 目录已由验收脚本清理。
- 全量测试首次运行有 54 项通过，两个测试文件因 Node strip-only 不支持参数属性而未加载。修正语法后，仅重跑这两个文件，28 项通过。共验证 82 项测试。
- `npm test` 在当前 Bash 环境遇到 npm 命令入口路径问题，因此使用等价的 Node 命令执行测试。
- Smart Compact 仍可能回退到 pi 原生摘要。扩展在收到失败事件后暂停，不能通过当前公开接口阻止第一次原生回退。
- Smart Compact 的分支级开关由该扩展自己管理，本扩展检查全局设置。手动 Apply 设置保持原有值。
- 历史记录曾实测 V2EX 单条消息上限为 160,000 字符。本轮未重复探测上限，不能据此断言上游目前仍完全相同。

### 下一步

该阶段已由下方无人值守补救实现取代。

## 2026-10-08 / 02：无人值守压缩恢复

状态：实现与验证完成。发布目标为 V2EX `main` 和 Smart Compact fork 的 `v2ex-recovery` 分支。

### 本轮完成

- 创建 `huaxianyan/pi-smart-compact` fork，补丁基于上游 `v9.7.1`，不混入升级到最新主线。
- Smart Compact 提供公开的 `extension-api` 协议模块，由唯一加载的扩展运行既有 EESV 管线。
- 自动压缩失败后结束本轮，空闲时请求 `fast` 补救，默认时限 300 秒；更低的全局预算仍生效。
- 补救应用必须匹配本次已验证摘要的 run ID，成功后自动继续原任务，无需 Apply 确认。
- 配额用尽等待刷新，网络或超时错误有界退避。恢复计划沿用已有落盘协议，绑定原会话、模型和任务分支。
- 取消、关闭、切换任务会取消进行中的补救。恢复检查最多 `1 + maxErrorRetries` 次，包含配额复核；终止时保留原记录、恢复原窗口。
- V2EX 从公开模块读取 Smart Compact 默认占比，不再复制外部默认常量。

### 验证记录

- V2EX 全量 Node 测试 84 项通过。
- Smart Compact 定向检查共 8 项通过：接口成功及超时两项，现有工具回归六项。补齐测试 fixture 的事件总线后仅重跑此前失败的一项。
- 相关源码严格 TypeScript 检查通过，库目标与既有代码对齐为 ES2024。
- 真实 pi 集成 `SMART_COMPACT_EXTENSION=E:/dev/pi-smart-compact/dist/index.js node tools/verify-compact-window.mjs --recovery` 通过：初次自动压缩失败、保存计划、配额等待、重载恢复、补救摘要应用、任务续跑。
- 模型及配额响应均为 fixture，未请求真实 V2EX。模型和 pi 设置文件保持原样，验收临时目录已清理。
- Git 安装使用 fork 中预构建的入口及协议模块，不直接修改已安装 npm 包。

### 安装来源与接续

- V2EX：`git:github.com/huaxianyan/pi-v2ex-quota`。
- Smart Compact：`git:github.com/huaxianyan/pi-smart-compact@v2ex-recovery`。移除旧 npm 来源，避免加载两个实例。
- 重启或 `/reload` 后，按需执行 `/v2ex compact window 400k`。默认仍关闭，不修改 `models.json`。
- 下一步只需在真实 V2EX 长会话中观察摘要质量及上游成功率。现有 fixture 验收不替代该检查。
