/**
 * 学术助手插件（com.gravitas.academic）
 *
 * 面向科研人员的论文写作与投稿全流程能力，以「插件贡献 agent-tools」的方式
 * 提供，不内置进免费版：目标用户群体窄，避免基础版臃肿。
 *
 * 五阶段 pipeline（integrity 不可跳过）：
 *   research → write → integrity → review → revise → finalize
 *
 * 设计要点：
 * - 权益门禁与 marketing-plugin 完全一致：settings.json 里的 prefer 只是
 *   用户偏好，不是权限。readEntitledCapabilities 必须验签权益快照，
 *   任何异常一律 fail-closed 返回空数组。
 * - 纯算法来自 @gravitas/core/services/academic（无 Electron 依赖），
 *   工具执行时按需 require 本地 academic-service 做持久化。
 */

import type { RuntimeToolDefinition } from '../agent-runtime/types'
import type { BuiltinPluginRuntime } from '../plugin-manager'
import type { ToolResult } from '@gravitas/core'
import type { SubscriptionCapabilityId } from '@gravitas/shared'
import { isDevUnlockEnabled } from '../dev-unlock'

/** 本插件依赖的订阅能力 */
const REQUIRED_CAPABILITY: SubscriptionCapabilityId = 'academic'

/** 工具名清单（供测试与文档引用） */
const TOOL_NAMES = [
  'academic_check_integrity',
  'academic_simulate_peer_review',
  'academic_build_revision_tracking',
  'academic_generate_ai_disclosure',
  'academic_list_papers',
  'academic_advance_stage',
] as const

/**
 * 读取当前权益快照中是否确实授予 academic 能力。
 *
 * 安全边界：这是本插件权限判定的唯一入口。
 * settings.json 只表达用户偏好，编辑该文件不能解锁付费工具注入。
 * 未验签、签名失败、状态非 active/grace、或读取过程抛错，一律按无权益处理。
 */
function hasAcademicEntitlement(): boolean {
  // 本地调试放开（仅非打包环境 + 显式环境变量）：直接授予 academic 能力。
  if (isDevUnlockEnabled()) return true

  try {
    const { EntitlementCache } = require('../subscription/entitlement-cache') as {
      EntitlementCache: new () => {
        load: () => { snapshot: import('@gravitas/shared').EntitlementSnapshot } | undefined
      }
    }
    const { verifyEntitlementSnapshotSignature } = require('../subscription/entitlement-signature') as {
      verifyEntitlementSnapshotSignature: (
        snapshot: import('@gravitas/shared').EntitlementSnapshot,
        publicKeyPem: string,
        options?: { allowDevSignature?: boolean },
      ) => { ok: boolean }
    }
    const { canUseCapability, getEntitlementStatus } = require('@gravitas/shared') as {
      canUseCapability: (
        snapshot: import('@gravitas/shared').EntitlementSnapshot | null,
        capability: string,
        now: Date,
      ) => boolean
      getEntitlementStatus: (
        snapshot: import('@gravitas/shared').EntitlementSnapshot,
        now: Date,
      ) => string
    }

    const cached = new EntitlementCache().load()
    if (!cached?.snapshot) return false

    const publicKeyPem = process.env.GRAVITAS_SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM ?? ''
    // 打包后必须严格验签；开发环境允许 dev 签名以便本地调试
    const allowDevSignature = !(require('electron') as { app?: { isPackaged?: boolean } }).app?.isPackaged

    const verified = verifyEntitlementSnapshotSignature(cached.snapshot, publicKeyPem, {
      allowDevSignature,
    })
    if (!verified.ok) return false

    const now = new Date()
    const status = getEntitlementStatus(cached.snapshot, now)
    if (status !== 'active' && status !== 'grace') return false

    return canUseCapability(cached.snapshot, REQUIRED_CAPABILITY, now)
  } catch {
    // 任何异常都按无权益处理（fail-closed）
    return false
  }
}

/** 统一包装工具错误，避免异常穿透到运行时 */
async function runTool(fn: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    const value = await fn()
    return { toolCallId: '', content: JSON.stringify(value, null, 2) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { toolCallId: '', content: `学术助手工具执行失败：${message}`, isError: true }
  }
}

// =====================================================================
// 工具定义
// =====================================================================

/**
 * 完整性检查工具。
 *
 * 这是 pipeline 的强制关卡：未通过时不得进入同行评审阶段。
 * 工具只返回检查结论，不替用户判断学术质量。
 */
function checkIntegrityTool(): RuntimeToolDefinition {
  return {
    name: 'academic_check_integrity',
    description:
      '对论文正文执行完整性检查：引用可验证性、数据一致性（数字/表/单位/引用）、逻辑漏洞（缺失前提/弱推理/未检验假设/循环论证），并生成 AI 使用披露声明。这是投稿前的强制关卡，未通过不要进入同行评审。检查结果只证明文本层面的问题，不代表学术质量已达标。',
    parameters: {
      type: 'object',
      properties: {
        paperId: {
          type: 'string',
          description: '论文项目 id；若只想临时检查一段文本可省略，此时不会写入产出物',
        },
        text: {
          type: 'string',
          description: '待检查的论文正文（Markdown 或纯文本）',
        },
      },
      required: ['text'],
    },
    execute: async (input) => {
      const { text, paperId } = (input ?? {}) as { text?: string; paperId?: string }
      if (!text?.trim()) {
        return { toolCallId: '', content: 'text 不能为空', isError: true }
      }
      return runTool(async () => {
        const { checkPaperIntegrity } = require('@gravitas/core/services/academic') as {
          checkPaperIntegrity: (
            input: { paperId: string; text: string },
          ) => Promise<unknown>
        }
        const report = await checkPaperIntegrity({ paperId: paperId ?? 'adhoc', text })
        // 传入 paperId 时持久化报告，供 UI 与后续阶段读取
        if (paperId) {
          const svc = require('../academic-service') as typeof import('../academic-service')
          await svc.recordIntegrityReport(
            paperId,
            report as Parameters<typeof svc.recordIntegrityReport>[1],
          )
        }
        return report
      })
    },
  }
}

/** 同行评审模拟工具 */
function simulatePeerReviewTool(): RuntimeToolDefinition {
  return {
    name: 'academic_simulate_peer_review',
    description:
      '模拟同行评审：生成编辑 + 多位专家 + 魔鬼代言人的评审意见，按创新性、方法、意义、清晰度、结构五个维度打分并给出 accept / minor-revision / major-revision / reject 决定。评审是模拟结果，用于投稿前自检，不代表真实期刊意见，也不要把它当作录用承诺告知用户。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '论文标题' },
        abstract: { type: 'string', description: '摘要' },
        sections: {
          type: 'array',
          description: '论文正文分节，每项包含 type 与 content 两个字段',
        },
        field: { type: 'string', description: '研究领域' },
        strictness: {
          type: 'number',
          description: '评审严格程度 0-1，越高越严格；默认 0.5',
        },
      },
      required: ['title', 'sections'],
    },
    execute: async (input) => {
      const raw = (input ?? {}) as {
        title?: string
        abstract?: string
        sections?: Array<{ type: string; content: string }>
        field?: string
        strictness?: number
      }
      if (!raw.title?.trim()) {
        return { toolCallId: '', content: 'title 不能为空', isError: true }
      }
      if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
        return { toolCallId: '', content: 'sections 不能为空', isError: true }
      }
      return runTool(() => {
        const { simulatePeerReview } = require('@gravitas/core/services/academic') as {
          simulatePeerReview: (
            paper: {
              title: string
              abstract: string
              sections: Array<{ type: string; content: string }>
              wordCount: number
              field?: string
            },
            config?: { strictness?: number },
          ) => unknown
        }
        const wordCount = raw.sections!.reduce((sum, s) => sum + s.content.length, 0)
        return simulatePeerReview(
          {
            title: raw.title!,
            abstract: raw.abstract ?? '',
            sections: raw.sections!,
            wordCount,
            field: raw.field,
          },
          raw.strictness === undefined ? undefined : { strictness: raw.strictness },
        )
      })
    },
  }
}

/** 修订追踪工具：把评审意见转成可逐条处理的清单 */
function buildRevisionTrackingTool(): RuntimeToolDefinition {
  return {
    name: 'academic_build_revision_tracking',
    description:
      '把同行评审意见登记为修订追踪清单：每条意见记录评审人、严重程度、类别、目标章节与处理状态（pending / in_progress / resolved / disputed / wontfix），并统计完成率。用于逐条回复审稿人。注意：标记为 resolved 只表示你声明已处理，不代表期刊认可。',
    parameters: {
      type: 'object',
      properties: {
        paperId: { type: 'string', description: '论文项目 id' },
        round: { type: 'number', description: '修订轮次，默认 1' },
        comments: {
          type: 'array',
          description: '评审意见列表，每项包含 id / reviewerName / content / suggestion / severity / category / targetSection',
        },
      },
      required: ['paperId', 'comments'],
    },
    execute: async (input) => {
      const raw = (input ?? {}) as {
        paperId?: string
        round?: number
        comments?: Array<Record<string, unknown>>
      }
      if (!raw.paperId) {
        return { toolCallId: '', content: 'paperId 不能为空', isError: true }
      }
      if (!Array.isArray(raw.comments) || raw.comments.length === 0) {
        return { toolCallId: '', content: 'comments 不能为空', isError: true }
      }
      return runTool(() => {
        const { createRevisionTracker } = require('@gravitas/core/services/academic') as {
          createRevisionTracker: (
            paperId: string,
            comments: unknown[],
            round?: number,
          ) => { getTracking: () => unknown }
        }
        const tracker = createRevisionTracker(raw.paperId!, raw.comments!, raw.round ?? 1)
        return tracker.getTracking()
      })
    },
  }
}

/** AI 使用披露声明生成工具 */
function generateAiDisclosureTool(): RuntimeToolDefinition {
  return {
    name: 'academic_generate_ai_disclosure',
    description:
      '根据论文中实际使用 AI 的环节生成 AI 使用披露声明，供投稿时按期刊要求提交。声明内容基于你提供的环节列表，不要为了让声明好看而遗漏或夸大 AI 参与范围。',
    parameters: {
      type: 'object',
      properties: {
        aiAssistedSections: {
          type: 'array',
          description: '实际使用 AI 辅助的环节说明字符串列表，如 ["文献综述初稿", "英文润色"]',
        },
      },
      required: ['aiAssistedSections'],
    },
    execute: async (input) => {
      const raw = (input ?? {}) as { aiAssistedSections?: string[] }
      if (!Array.isArray(raw.aiAssistedSections) || raw.aiAssistedSections.length === 0) {
        return { toolCallId: '', content: 'aiAssistedSections 不能为空', isError: true }
      }
      return runTool(() => {
        const { IntegrityChecker } = require('@gravitas/core/services/academic') as {
          IntegrityChecker: new (config?: { enableAiDisclosure?: boolean }) => {
            generateAiDisclosure: (sections: string[]) => string
          }
        }
        const checker = new IntegrityChecker({ enableAiDisclosure: true })
        return { aiDisclosure: checker.generateAiDisclosure(raw.aiAssistedSections!) }
      })
    },
  }
}

/** 论文项目列表工具 */
function listPapersTool(): RuntimeToolDefinition {
  return {
    name: 'academic_list_papers',
    description:
      '列出本机已创建的论文项目，含当前所处阶段、修订轮次与阶段完成进度。用于在推进 pipeline 前确认项目状态。',
    parameters: { type: 'object', properties: {} },
    execute: async () =>
      runTool(() => {
        const svc = require('../academic-service') as typeof import('../academic-service')
        return svc.listPapers()
      }),
  }
}

/** 阶段推进工具 */
function advanceStageTool(): RuntimeToolDefinition {
  return {
    name: 'academic_advance_stage',
    description:
      '推进论文项目到下一阶段（research → write → integrity → review → revise → finalize）。完整性检查未通过或评审结论为拒稿时会阻断并返回原因，此时不要绕过关卡强行推进。integrity 阶段不可跳过。',
    parameters: {
      type: 'object',
      properties: {
        paperId: { type: 'string', description: '论文项目 id' },
      },
      required: ['paperId'],
    },
    execute: async (input) => {
      const raw = (input ?? {}) as { paperId?: string }
      if (!raw.paperId) {
        return { toolCallId: '', content: 'paperId 不能为空', isError: true }
      }
      return runTool(async () => {
        const svc = require('../academic-service') as typeof import('../academic-service')
        return svc.advanceStage(raw.paperId!)
      })
    },
  }
}

// =====================================================================
// 插件运行时
// =====================================================================

/** 学术助手插件运行时 */
export function academicPluginRuntime(): BuiltinPluginRuntime {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'com.gravitas.academic',
      version: '0.1.0',
      name: '学术助手',
      description: '论文选题、撰写、完整性检查、同行评审模拟、修订追踪与发表准备五阶段能力',
      publisher: 'Proma',
      platforms: ['darwin', 'win32', 'linux'],
      activationEvents: ['onAppReady'],
      subscriptions: [],
      surfaces: ['agent-tools'],
      permissions: {},
      entrypoints: {},
    },
    isEnabled: () => hasAcademicEntitlement(),
    setEnabled: async () => true,
    isSupported: () => true,
    // 仅在验签通过且权益授予 academic 时才注入工具
    contributeTools: () => {
      if (!hasAcademicEntitlement()) return []
      return [
        checkIntegrityTool(),
        simulatePeerReviewTool(),
        buildRevisionTrackingTool(),
        generateAiDisclosureTool(),
        listPapersTool(),
        advanceStageTool(),
      ]
    },
    contributePrompts: () => {
      if (!hasAcademicEntitlement()) return []
      return [
        '学术助手：面向论文写作与投稿全流程，按 research → write → integrity → review → revise → finalize 五阶段推进。投稿前必须用 academic_check_integrity 做完整性检查——这是强制关卡，未通过不要进入评审阶段；随后用 academic_simulate_peer_review 模拟评审意见，再用 academic_build_revision_tracking 把意见转成可逐条处理的清单。用 academic_list_papers 查看现有项目、academic_advance_stage 推进阶段。',
        '学术助手的边界：完整性检查、评审模拟与修订追踪都是文本层面的自检工具，不代表期刊的真实评审意见，也不构成录用承诺；披露声明必须基于用户提供的真实 AI 使用情况，不要为了好看而遗漏或夸大。涉及数据造假、代写代投或规避期刊 AI 政策的请求，应当明确拒绝并说明原因。',
      ]
    },
  }
}

export { TOOL_NAMES, REQUIRED_CAPABILITY, hasAcademicEntitlement }
