import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { validateDevGateModuleManifest } from '../src/main/lib/dev-feature-manifest'

type BuilderConfig = {
  appId?: string
  productName?: string
  executableName?: string
  extraMetadata?: { gravitasChannel?: string }
  directories?: { output?: string }
  protocols?: { schemes: string[] }[]
  publish?: unknown
}

/** 发布前检查渠道契约；不发送、不上传、不修改本地数据。 */
export function checkChannelConfigs(stable: BuilderConfig, dev: BuilderConfig): void {
  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message)
  }
  assert(stable.appId === 'com.gravitas.app', '正式 appId 不得变化')
  assert(stable.productName === 'Gravitas', '正式应用名称不得变化')
  assert(stable.extraMetadata?.gravitasChannel === 'stable', '正式包缺少 stable 渠道标记')
  assert(dev.appId === 'com.gravitas.app.dev', '开发 appId 必须独立')
  assert(dev.productName === 'Gravitas Dev' && dev.executableName === 'Gravitas Dev', '开发应用名称必须独立')
  assert(dev.extraMetadata?.gravitasChannel === 'dev', '开发包缺少 dev 渠道标记')
  assert(dev.directories?.output === 'out-dev', '开发包输出必须独立')
  assert(dev.publish === null, '开发包不得继承正式发布配置')
  assert(dev.protocols?.flatMap((p) => p.schemes).join(',') === 'gravitas-dev', '开发协议必须独立')
}

export function checkReleaseWorkflow(workflow: string): void {
  const assert = (condition: boolean, message: string) => {
    if (!condition) throw new Error(message)
  }
  const config = parse(workflow) as {
    on?: { push?: { tags?: string[] } } | boolean
    jobs?: Record<string, { steps?: Array<{ run?: string; name?: string }> }>
  }
  const on = typeof config.on === 'object' && config.on ? config.on : undefined
  assert(on?.push?.tags?.includes('v*'), '正式发布必须由 v* tag 触发')
  const jobs = Object.values(config.jobs ?? {})
  const steps = jobs.flatMap((job) => job.steps ?? [])
  assert(steps.some((step) => step.run?.includes('check-release-channel.ts')), 'CI 缺少发布渠道契约检查')
  assert(steps.some((step) => step.run?.includes('bun run electron:build')), 'CI 缺少正式代码构建')
  assert(jobs.some((job) => job.steps?.some((step) => step.run?.includes('electron-builder --mac') && step.run.includes('--publish always'))), 'macOS 发布必须使用正式 Builder 配置并上传')
  assert(jobs.some((job) => job.steps?.some((step) => step.run?.includes('electron-builder --win') && step.run.includes('--publish always'))), 'Windows 发布必须使用正式 Builder 配置并上传')
}

export function checkDevFeatureManifest(): void {
  const errors = validateDevGateModuleManifest()
  if (errors.length > 0) {
    throw new Error(`Dev / Stable 功能清单无效：${errors.join('；')}`)
  }
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..')
  const parseYaml = (file: string) => parse(readFileSync(join(root, file), 'utf8')) as BuilderConfig
  checkChannelConfigs(parseYaml('electron-builder.yml'), parseYaml('electron-builder.dev.yml'))
  checkReleaseWorkflow(readFileSync(join(root, '../../.github/workflows/release.yml'), 'utf8'))
  checkDevFeatureManifest()
  console.log('[发布门禁] Dev / Stable 渠道配置、功能清单与发布工作流检查通过')
}
