/**
 * STE 简化写作插件（com.gravitas.ste-writing）
 *
 * 把 ASD-STE100 简化写作 + 反 AI 腔的底线规则，以「插件贡献系统提示片段」
 * （contributePrompts）的方式注入每一个 Agent 会话，使输出风格成为会话级
 * 硬约束，而不依赖 skill 的按需触发。
 *
 * 与工作区 skill `ste-writing` 的分层关系：
 * - 本插件注入精简版底线规则（每个会话常驻必读）；
 * - skill 承载完整规则库与改写/写作/体检工作流（按需触发）。
 */

import type { BuiltinPluginRuntime } from '../plugin-manager'

/** 插件注入的常驻提示片段（精简版底线规则；完整版见工作区 skill ste-writing） */
export const STE_WRITING_PROMPT_SECTION = `**STE 简化写作规范（默认生效，适用于所有面向人的输出：回复、报告、文档、发布说明）**

1. 一句一个意思：英文 ≤ 25 词，中文 ≤ 40 字，超了就拆句
2. 主动语态，动作者在前；指令用祈使句，一步一个动作
3. 答案先行（BLUF）：第一句给结论；不写空洞开场和升华收尾
4. 选最常见的词；删 very / absolutely / 非常 / 极大地 类冗余修饰
5. 禁 AI 高频词：delve / leverage / unlock / empower / seamless / robust / landscape；赋能 / 闭环 / 抓手 / 颗粒度（确指技术含义除外）
6. 列表只列真正并列的项，最多 2 层嵌套；能用一句话说清的不拆列表
7. 加粗只用于术语定义和关键警告；破折号每段最多一个；不用 emoji
8. 数字写具体：写「快 3 倍」「2 秒内」，不写「显著提升」
9. 结尾要么是下一步动作，要么直接停；不写「总结的总结」；不写免责腔
10. 代码、命令、配置、报错原文不改造；用户明确要求其他文风时用户优先

完整规则与改写/体检工作流见工作区 skill「ste-writing」。`

/** 纯函数：按启用状态返回应注入的提示段落（导出便于单测） */
export function steWritingPromptSections(enabled: boolean): string[] {
  return enabled ? [STE_WRITING_PROMPT_SECTION] : []
}

/** STE 简化写作插件运行时（内置插件，由 plugin-manager 管理） */
export function steWritingPluginRuntime(): BuiltinPluginRuntime {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'com.gravitas.ste-writing',
      version: '1.0.0',
      name: 'STE 简化写作',
      description: '向每个 Agent 会话注入 ASD-STE100 简化写作 + 反 AI 腔底线规则（输出风格硬约束，可在扩展中心停用）',
      publisher: 'Proma',
      platforms: ['darwin', 'win32', 'linux'],
      activationEvents: ['onAppReady'],
      subscriptions: [],
      surfaces: ['settings'],
      permissions: {},
      entrypoints: {},
    },
    isEnabled: () => getHostSteWritingConfig().enabled,
    setEnabled: async (enabled) => {
      const current = getHostSteWritingConfig()
      setHostSteWritingConfig({ enabled })
      return current.enabled !== enabled
    },
    isSupported: () => true,
    // 插件启用时向每个 Agent 会话贡献常驻提示片段；停用时不贡献
    contributePrompts: () => steWritingPromptSections(getHostSteWritingConfig().enabled),
  }
}

/** 读取宿主配置（settings.steWriting）；缺省 enabled=true（写作约束默认生效）。 */
function getHostSteWritingConfig(): { enabled: boolean } {
  try {
    // 延迟 require 避免循环依赖
    const { getSettings } = require('../settings-service') as { getSettings: () => { steWriting?: { enabled?: boolean } } }
    return { enabled: getSettings().steWriting?.enabled ?? true }
  } catch {
    return { enabled: true }
  }
}

/** 写入宿主配置。返回成功与否。 */
function setHostSteWritingConfig(updates: { enabled?: boolean }): boolean {
  try {
    const { getSettings, updateSettings } = require('../settings-service') as {
      getSettings: () => { steWriting?: Record<string, unknown> }
      updateSettings: (u: { steWriting?: Record<string, unknown> }) => unknown
    }
    const current = getSettings().steWriting ?? {}
    updateSettings({ steWriting: { ...current, ...updates } })
    return true
  } catch {
    return false
  }
}
