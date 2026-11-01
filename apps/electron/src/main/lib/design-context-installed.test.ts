/**
 * OpenDesign 安装 → 上下文组装的链路测试（包内 smoke 的本机等价版本）。
 *
 * 打包 smoke 负责在真实打包渲染器里跑同一套断言；本文件用隔离目录验证同一逻辑，
 * 覆盖：安装后能读出、未声明需求不注入、本地文件优先、安装内容损坏时提示缺项。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeOdDesignContext, resolveActiveDesignSystem } from './design-context'
import { installOpenDesignFiles, readInstalledOpenDesign } from './opendesign-install-store'
import { createHash } from 'node:crypto'

const design = '# Stripe Design System\n\nUse the Stripe palette.\n'
const tokens = ':root { --brand: #635bff; }\n'
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

let root = ''
let filesDir = ''
const slug = 'opendesign-chain-ws'

const deps = () => ({ readWorkspaceInstall: (workspaceSlug: string) => workspaceSlug === slug ? readInstalledOpenDesign(filesDir, slug) : undefined })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opendesign-chain-'))
  filesDir = join(root, slug, 'workspace-files')
  mkdirSync(filesDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function install(): void {
  installOpenDesignFiles(filesDir, {
    schemaVersion: 1, source: 'OpenDesign', license: 'Apache-2.0', projectId: 'project-1', workspaceId: 'workspace-1',
    workspaceSlug: slug, brandId: 'stripe', brandName: 'Stripe', referenceRevision: 'catalog-r1', installedAt: 1,
    actor: 'local-user', files: { 'DESIGN.md': sha256(design), 'tokens.css': sha256(tokens) },
  }, design, tokens)
}

describe('安装后进入上下文组装', () => {
  test('Given 已安装 OpenDesign When 会话目录无本地规范 Then 解析与组装都读到完整参考', () => {
    install()
    const sessionDir = join(root, 'session-clean')
    mkdirSync(sessionDir, { recursive: true })
    const resolved = resolveActiveDesignSystem(sessionDir, slug, deps())
    expect(resolved).toMatchObject({ title: 'Stripe', body: design, tokensCss: tokens })
    expect(resolved?.origin).toContain('OpenDesign stripe catalog-r1')

    const context = composeOdDesignContext({
      requirements: { craftRequires: [], designSystemRequires: true },
      cwd: sessionDir, workspaceSlug: slug, designSystemDeps: deps(),
    })
    expect(context).toContain('<od_design_system')
    expect(context).toContain(tokens)
    expect(context).not.toContain('od_missing_resource')
  })

  test('Given Skill 未声明设计系统需求 When 组装 Then 不注入任何设计内容', () => {
    install()
    const sessionDir = join(root, 'session-nodecl')
    mkdirSync(sessionDir, { recursive: true })
    const context = composeOdDesignContext({
      requirements: { craftRequires: [], designSystemRequires: false },
      cwd: sessionDir, workspaceSlug: slug, designSystemDeps: deps(),
    })
    expect(context).toBe('')
    expect(context).not.toContain('--brand')
  })

  test('Given 会话目录已有本地设计文件 When 组装 Then 本地优先且不带 OpenDesign 来源', () => {
    install()
    const sessionDir = join(root, 'session-local')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'DESIGN.md'), '# Local Brand\n\nLOCAL_CANARY\n')
    const resolved = resolveActiveDesignSystem(sessionDir, slug, deps())
    expect(resolved?.title).toBe('Local Brand')
    expect(resolved?.body).toContain('LOCAL_CANARY')
    expect(resolved?.origin).toBeUndefined()
    expect(resolved?.tokensCss).toBeUndefined()
  })

  test('Given 安装内容被改写 When 解析与组装 Then 视为读不到并提示缺项', () => {
    install()
    writeFileSync(join(filesDir, '.opendesign/active/tokens.css'), ':root { --tampered: 1; }\n')
    const sessionDir = join(root, 'session-tampered')
    mkdirSync(sessionDir, { recursive: true })
    expect(resolveActiveDesignSystem(sessionDir, slug, deps())).toBeUndefined()
    const context = composeOdDesignContext({
      requirements: { craftRequires: [], designSystemRequires: true },
      cwd: sessionDir, workspaceSlug: slug, designSystemDeps: deps(),
    })
    expect(context).toContain('<od_missing_resource type="design_system">')
    expect(context).not.toContain('<od_design_system')
  })

  test('Given 未安装任何参考 When 组装 Then 明确提示缺项而不是空白规范', () => {
    const sessionDir = join(root, 'session-none')
    mkdirSync(sessionDir, { recursive: true })
    const context = composeOdDesignContext({
      requirements: { craftRequires: [], designSystemRequires: true },
      cwd: sessionDir, workspaceSlug: slug, designSystemDeps: deps(),
    })
    expect(context).toContain('<od_missing_resource type="design_system">')
    expect(context).toContain('不要声称成果符合品牌规范')
  })
})
