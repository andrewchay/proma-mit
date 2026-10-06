/**
 * 学术研究模块发布检查（M7）
 *
 *   bun scripts/academic-release-check.ts
 *
 * 检查的是**离线可判定的发布前置条件**，不是"功能已完成"的结论：
 * 1. 计划声明的模块文件都存在
 * 2. 所有声明的研究 IPC 通道都有 handler 注册
 * 3. preload 暴露了对应的桥接方法
 * 4. 台账存在且缺口状态被记录
 *
 * 真机联调、打包产物启动、真实数据验收**不在本脚本范围内**，
 * 通过本脚本不代表可以发布。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const results: CheckResult[] = []

function check(name: string, fn: () => { ok: boolean; detail: string }): void {
  try {
    results.push({ name, ...fn() })
  } catch (err) {
    results.push({ name, ok: false, detail: `检查抛错: ${err instanceof Error ? err.message : String(err)}` })
  }
}

function fileExists(rel: string): boolean {
  return existsSync(join(ROOT, rel))
}

function readFile(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8')
}

// 1) 模块文件清单
const REQUIRED_FILES = [
  // 领域层
  'packages/shared/src/types/academic-research.ts',
  'packages/core/src/services/academic/research-rules.ts',
  'packages/core/src/services/academic/research-profiles.ts',
  'packages/core/src/services/academic/protocol-rules.ts',
  'packages/core/src/services/academic/topic-rules.ts',
  'packages/core/src/services/academic/run-rules.ts',
  'packages/core/src/services/academic/claim-rules.ts',
  'packages/core/src/services/academic/evidence-policy.ts',
  'packages/core/src/services/academic/source-identity.ts',
  'packages/core/src/services/academic/bibliography-import.ts',
  'packages/core/src/services/academic/external-tool-rules.ts',
  'packages/core/src/services/academic/external-artifact-parsing.ts',
  // 主进程服务
  'apps/electron/src/main/lib/academic/research-store.ts',
  'apps/electron/src/main/lib/academic/research-service.ts',
  'apps/electron/src/main/lib/academic/access-guard.ts',
  'apps/electron/src/main/lib/academic/source-service.ts',
  'apps/electron/src/main/lib/academic/evidence-service.ts',
  'apps/electron/src/main/lib/academic/protocol-service.ts',
  'apps/electron/src/main/lib/academic/proposal-service.ts',
  'apps/electron/src/main/lib/academic/run-service.ts',
  'apps/electron/src/main/lib/academic/run-executor.ts',
  'apps/electron/src/main/lib/academic/claim-service.ts',
  'apps/electron/src/main/lib/academic/external-tool-service.ts',
  'apps/electron/src/main/lib/academic/migration.ts',
  'apps/electron/src/main/lib/academic/zotero-config.ts',
  'apps/electron/src/main/lib/academic/academic-ipc-handlers.ts',
  // 渲染层
  'apps/electron/src/renderer/atoms/academic-atoms.ts',
  'apps/electron/src/renderer/components/academic/ResearchWorkspace.tsx',
  'apps/electron/src/renderer/components/academic/ProtocolPanel.tsx',
  'apps/electron/src/renderer/components/academic/ProposalPanel.tsx',
  'apps/electron/src/renderer/components/academic/SourceLibraryPanel.tsx',
  'apps/electron/src/renderer/components/academic/StudyRunsPanel.tsx',
  'apps/electron/src/renderer/components/academic/ClaimPanel.tsx',
  'apps/electron/src/renderer/components/academic/ManuscriptPanel.tsx',
  'apps/electron/src/renderer/components/academic/ExternalToolsPanel.tsx',
]

check('计划声明的模块文件齐全', () => {
  const missing = REQUIRED_FILES.filter((f) => !fileExists(f))
  return {
    ok: missing.length === 0,
    detail: missing.length === 0 ? `${REQUIRED_FILES.length} 个文件全部存在` : `缺失: ${missing.join(', ')}`,
  }
})

// 2) IPC 通道 → handler 注册
check('研究 IPC 通道均有 handler 注册', () => {
  const shared = readFile('packages/shared/src/types/academic-research.ts')
  const block = shared.slice(
    shared.indexOf('export const ACADEMIC_RESEARCH_IPC_CHANNELS'),
    shared.indexOf('} as const', shared.indexOf('export const ACADEMIC_RESEARCH_IPC_CHANNELS')),
  )
  // 常量名（如 LIST_PROJECTS）而非字面通道字符串——handler 用常量注册
  const constants = [...block.matchAll(/^\s*(\w+):\s*'academic-research:/gm)].map((m) => m[1]!)
  const handlers = readFile('apps/electron/src/main/lib/academic/academic-ipc-handlers.ts')
  const missing = constants.filter((c) => !handlers.includes(`ACADEMIC_RESEARCH_IPC_CHANNELS.${c}`))
  return {
    ok: missing.length === 0 && constants.length > 0,
    detail:
      missing.length === 0
        ? `${constants.length} 个通道常量均有 handler 注册`
        : `未注册: ${missing.join(', ')}`,
  }
})

// 3) preload 桥接
check('preload 暴露 academicResearch 桥接', () => {
  const preload = readFile('apps/electron/src/preload/index.ts')
  const hasApi = preload.includes('academicResearch:')
  const methodCount = (preload.match(/ACADEMIC_RESEARCH_IPC_CHANNELS\./g) ?? []).length
  return {
    ok: hasApi && methodCount > 20,
    detail: hasApi ? `academicResearch 桥接存在，引用通道 ${methodCount} 处` : '未找到 academicResearch 桥接',
  }
})

// 4) 安全边界守卫存在
check('安全边界守卫未被移除', () => {
  const store = readFile('apps/electron/src/main/lib/academic/research-store.ts')
  const guard = readFile('apps/electron/src/main/lib/academic/access-guard.ts')
  const executor = readFile('apps/electron/src/main/lib/academic/run-executor.ts')
  const issues: string[] = []
  if (!store.includes('未完成的写入')) issues.push('事件流缺少半写尾行恢复')
  if (!guard.includes('LOCAL_USER_ACTOR')) issues.push('缺少 actor 单一来源')
  if (!executor.includes('shell: false')) issues.push('执行器未显式禁用 shell')
  return {
    ok: issues.length === 0,
    detail: issues.length === 0 ? '恢复语义、actor 来源、无 shell 执行均在位' : issues.join('；'),
  }
})

// 5) 台账与缺口状态
check('M0-M7 台账存在且记录缺口', () => {
  const path = 'docs/plans/academic-research-m0-tasks.md'
  if (!fileExists(path)) return { ok: false, detail: `台账缺失: ${path}` }
  const ledger = readFile(path)
  const open = (ledger.match(/开放/g) ?? []).length
  const fixed = (ledger.match(/已修复/g) ?? []).length
  return {
    ok: fixed > 0,
    detail: `缺口记录：已修复 ${fixed} 处，仍标注开放 ${open} 处`,
  }
})

// 输出
console.log('\n=== 学术研究模块发布检查 ===\n')
let failed = 0
for (const r of results) {
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}`)
  console.log(`       ${r.detail}`)
  if (!r.ok) failed++
}
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed}，未通过 ${failed}`)
console.log('\n注意：本脚本只检查离线可判定的发布前置条件。')
console.log('真机联调（orx/dvc）、打包产物启动、真实数据与伦理相关验收均不在此范围。')
console.log('通过本脚本不代表可以发布。')
