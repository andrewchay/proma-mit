/**
 * STE 简化写作插件（com.gravitas.ste-writing）
 *
 * 把 ASD-STE100 简化写作 + 反 AI 腔的底线规则，以「插件贡献系统提示片段」
 * （contributePrompts）的方式注入每一个 Agent 会话，使输出风格成为会话级
 * 写作指导，而不依赖 skill 的按需触发；提示词不保证模型硬性遵守。
 *
 * 与工作区 skill `ste-writing` 的分层关系：
 * - 本插件注入精简版底线规则（每个会话常驻必读）；
 * - skill 承载完整规则库与改写/写作/体检工作流（按需触发）。
 */

import type { BuiltinPluginRuntime } from '../plugin-manager'
import { getSettings, updateSettings } from '../settings-service'

/** 插件注入的常驻提示片段（精简版底线规则；完整版见工作区 skill ste-writing） */
export const STE_WRITING_PROMPT_SECTION = `**STE 简化写作规范（自然语言写作指导）**

本规范只约束面向人的自然语言回复、报告、文档和发布说明，不改造代码、命令、配置、报错原文或引用。
安全规则、事实准确性、用户指定文风和输出协议优先；schema、JSON、XML、工具调用格式及必需字段不得为文风而删改。
这是提示词指导，不是机制硬强制，也不改变任何工具权限或授权规则。

1. 一句一个意思：英文尽量不超过 25 词，中文尽量不超过 40 字；必要的专业解释不强行拆断
2. 优先主动语态；指令一步一个动作
3. 答案先行（BLUF）：先给结论；避免空洞开场和重复收尾
4. 选清楚、准确的词，删无依据的强化修饰；保留必要的专业术语
5. 避免空泛套话（如赋能、抓手）；有明确技术含义时可正常使用
6. 列表只列真正并列的项，尽量不超过 2 层嵌套
7. 加粗用于重点，避免无意义的装饰；用户指定格式优先
8. 数字必须有证据和来源；没有数据就说明缺口，不编造「快 3 倍」「2 秒内」等指标
9. 保留与判断相关的风险、限制和不确定性；不把猜测写成事实，不为简洁删除安全警告
10. 结尾给必要的下一步动作，或直接结束；避免重复总结

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
      description: '向每个 Agent 会话注入 ASD-STE100 简化写作 + 反 AI 腔底线规则（自然语言写作指导，可在扩展中心停用）',
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
      try {
        // strictRead 避免配置损坏时以默认值覆盖原配置；updateSettings 成功才表示落盘成功。
        const persisted = updateSettings({ steWriting: { enabled } }, { strictRead: true })
        return persisted.steWriting?.enabled === enabled
      } catch (error) {
        console.error('[STE 写作] 更新配置失败:', error)
        return false
      }
    },
    isSupported: () => true,
    // 插件启用时向每个 Agent 会话贡献常驻提示片段；停用时不贡献
    contributePrompts: () => steWritingPromptSections(getHostSteWritingConfig().enabled),
  }
}

/** 缺省启用；读取失败不注入提示，也不把默认状态冒充已持久化状态。 */
function getHostSteWritingConfig(): { enabled: boolean } {
  try {
    return { enabled: getSettings({ strictRead: true }).steWriting?.enabled ?? true }
  } catch (error) {
    console.error('[STE 写作] 读取配置失败:', error)
    return { enabled: false }
  }
}
