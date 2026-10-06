/**
 * 外部工具真实探测 smoke（M6，G4 同类：联网/依赖本机环境，须显式执行）
 *
 *   bun scripts/academic-external-tools-smoke.ts
 *
 * 只做只读版本探测（`<binary> --version`），不安装、不执行研究任务。
 * 未安装属正常结果，不代表缺陷。
 */

import { probeAllTools } from '../apps/electron/src/main/lib/academic/external-tool-service'

const views = await probeAllTools()

console.log('\n=== 外部工具探测（只读，不安装）===')
for (const v of views) {
  console.log(`[${v.status}] ${v.descriptor.name}（${v.descriptor.role}）`)
  if (v.detectedVersion) console.log(`  版本: ${v.detectedVersion}`)
  if (v.detail) console.log(`  说明: ${v.detail}`)
}
console.log('\n未安装的工具属正常结果；本插件不内置任何上游产物。')
