/**
 * OpenDesign 会话目录安装：写入会话目录、同名冲突另存、按 manifest 读回。
 *
 * 核心层实验功能，尚未接入用户安装入口。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installOpenDesignIntoSessionDir, readInstalledOpenDesignFromSession } from './opendesign-install-store'

const design = '# Stripe Design System\n\nUse Stripe palette.\n'
const tokens = ':root { --brand: #635bff; }\n'

const manifestBase = {
  schemaVersion: 1 as const,
  source: 'OpenDesign' as const,
  license: 'Apache-2.0' as const,
  projectId: 'project-1',
  sessionId: 'session-1',
  workspaceSlug: 'design-ws',
  brandId: 'stripe',
  brandName: 'Stripe',
  referenceRevision: 'catalog-r1',
  installedAt: 123,
  actor: 'local-user' as const,
}

let sessionDir = ''

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), 'opendesign-session-'))
})

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true })
})

describe('会话目录安装', () => {
  test('Given 空会话目录 When 安装 Then 写入 DESIGN.md 与 tokens.css 并可读回', () => {
    const installed = installOpenDesignIntoSessionDir(sessionDir, manifestBase, design, tokens)
    expect(installed.designFile).toBe('DESIGN.md')
    expect(installed.tokensFile).toBe('tokens.css')
    expect(readFileSync(join(sessionDir, 'DESIGN.md'), 'utf8')).toBe(design)
    const readBack = readInstalledOpenDesignFromSession(sessionDir)
    expect(readBack).toMatchObject({ brandId: 'stripe', brandName: 'Stripe', design, tokens, referenceRevision: 'catalog-r1' })
    expect(readBack?.designFile).toBe('DESIGN.md')
  })

  test('Given 会话目录已有同名设计说明 When 安装 Then 另存为品牌前缀名且不改原文件', () => {
    writeFileSync(join(sessionDir, 'DESIGN.md'), '# 用户自己的规范\n')
    writeFileSync(join(sessionDir, 'tokens.css'), ':root { --user: 1; }\n')
    const installed = installOpenDesignIntoSessionDir(sessionDir, manifestBase, design, tokens)
    expect(installed.designFile).toBe('stripe-design.md')
    expect(installed.tokensFile).toBe('stripe-tokens.css')
    expect(readFileSync(join(sessionDir, 'DESIGN.md'), 'utf8')).toBe('# 用户自己的规范\n')
    expect(readFileSync(join(sessionDir, 'tokens.css'), 'utf8')).toBe(':root { --user: 1; }\n')
    expect(readInstalledOpenDesignFromSession(sessionDir)?.designFile).toBe('stripe-design.md')
  })

  test('Given 另存名也被占用 When 再次安装 Then 继续加序号并且不覆盖任何已有文件', () => {
    writeFileSync(join(sessionDir, 'DESIGN.md'), '# user\n')
    writeFileSync(join(sessionDir, 'stripe-design.md'), '# older brand\n')
    const installed = installOpenDesignIntoSessionDir(sessionDir, manifestBase, design, tokens)
    expect(installed.designFile).toBe('stripe-design-2.md')
    expect(readFileSync(join(sessionDir, 'stripe-design.md'), 'utf8')).toBe('# older brand\n')
    expect(readdirSync(sessionDir).sort()).toEqual(['.opendesign', 'DESIGN.md', 'stripe-design-2.md', 'stripe-design.md', 'tokens.css'])
  })

  test('Given 安装后文件被改写 When 读回 Then 指纹不符返回未安装', () => {
    installOpenDesignIntoSessionDir(sessionDir, manifestBase, design, tokens)
    writeFileSync(join(sessionDir, 'DESIGN.md'), '# 被换掉的规范\n')
    expect(readInstalledOpenDesignFromSession(sessionDir)).toBeUndefined()
  })

  test('Given 记录里的文件名指向目录外 When 读回 Then 忽略该记录', () => {
    installOpenDesignIntoSessionDir(sessionDir, manifestBase, design, tokens)
    const manifestPath = join(sessionDir, '.opendesign', 'session-installation.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: { design: string } }
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, files: { ...manifest.files, design: '../escape.md' } }))
    expect(readInstalledOpenDesignFromSession(sessionDir)).toBeUndefined()
  })

  test('Given 另存目标是指向外部文件的符号链接 When 读回 Then 不把它当受信资源', () => {
    const outside = join(sessionDir, 'outside.md')
    writeFileSync(outside, design)
    installOpenDesignIntoSessionDir(sessionDir, manifestBase, design, tokens)
    rmSync(join(sessionDir, 'DESIGN.md'))
    symlinkSync(outside, join(sessionDir, 'DESIGN.md'))
    // 链接指向内容相同，但符号链接本身不被接受
    expect(readInstalledOpenDesignFromSession(sessionDir)).toBeUndefined()
  })

  test('Given 会话目录不存在 When 安装 Then 拒绝而不是隐式创建', () => {
    expect(() => installOpenDesignIntoSessionDir(join(sessionDir, 'missing'), manifestBase, design, tokens)).toThrow('会话目录不可用')
  })

  test('Given 已有安装记录 When 再次安装 Then 拒绝覆盖并回滚本次文件', () => {
    installOpenDesignIntoSessionDir(sessionDir, manifestBase, design, tokens)
    const original = readFileSync(join(sessionDir, '.opendesign', 'session-installation.json'), 'utf8')
    expect(() => installOpenDesignIntoSessionDir(sessionDir, { ...manifestBase, brandId: 'linear', brandName: 'Linear' }, '# Linear\n', ':root { --l: 1; }\n')).toThrow()
    expect(readFileSync(join(sessionDir, '.opendesign', 'session-installation.json'), 'utf8')).toBe(original)
    expect(readInstalledOpenDesignFromSession(sessionDir)?.brandId).toBe('stripe')
    expect(readdirSync(sessionDir).sort()).toEqual(['.opendesign', 'DESIGN.md', 'tokens.css'])
  })

  test('Given 安装记录是指向其他文件的符号链接 When 安装 Then 拒绝且不改写目标', () => {
    const target = join(sessionDir, 'target.json')
    writeFileSync(target, 'USER_CONTENT')
    mkdirSync(join(sessionDir, '.opendesign'))
    symlinkSync(target, join(sessionDir, '.opendesign', 'session-installation.json'))
    expect(() => installOpenDesignIntoSessionDir(sessionDir, manifestBase, design, tokens)).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('USER_CONTENT')
    expect(readdirSync(sessionDir).sort()).toEqual(['.opendesign', 'target.json'])
  })
})
