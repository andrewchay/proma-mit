import { afterEach, beforeEach, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentWorkspace, OwnerRuntimeBinding } from '@gravitas/shared'
import { createOwnerDesignSystemInstaller, readBundledReference } from './opendesign-install-service'

let tempRoot = ''
const projectId = 'project-1'
const workspace: AgentWorkspace = { id: 'workspace-1', name: 'Owner 项目工作区', slug: 'owner-project', createdAt: 1, updatedAt: 1 }
const binding: OwnerRuntimeBinding = {
  schemaVersion: 1,
  projectId,
  revision: 4,
  ownerRole: 'project_owner',
  ownerName: '项目 Owner',
  carrierId: 'owner-1',
  workspaceId: workspace.id,
  channelId: 'channel-1',
  modelId: 'glm-5.3-flash',
  runtime: 'ai-sdk',
  carrierFingerprint: 'a'.repeat(64),
  actor: 'local-user',
  savedAt: 1,
  changeReason: 'test',
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'opendesign-install-'))
  mkdirSync(join(tempRoot, workspace.slug, 'workspace-files'), { recursive: true })
})

afterEach(() => rmSync(tempRoot, { recursive: true, force: true }))

test('Given Electron extraResources 下的 OpenDesign 资源 When 安装服务读取品牌 Then 从打包资源目录加载目录和参考包', () => {
  const packagedResources = join(tempRoot, 'resources')
  const openDesignDir = join(packagedResources, 'opendesign')
  mkdirSync(openDesignDir, { recursive: true })
  const sourceDir = new URL('../../../resources/', import.meta.url)
  for (const file of ['opendesign-brand-catalog.json', 'opendesign-references-0.json', 'opendesign-references-1.json', 'opendesign-references-2.json', 'opendesign-references-3.json']) {
    copyFileSync(new URL(file, sourceDir), join(openDesignDir, file))
  }

  expect(readBundledReference('stripe', packagedResources)).toMatchObject({ brandName: 'Stripe', reference: { design: expect.stringContaining('#'), tokens: expect.stringContaining(':root') } })
})

function createInstaller(currentBinding: OwnerRuntimeBinding | null = binding) {
  return createOwnerDesignSystemInstaller({
    getBinding: () => currentBinding,
    getWorkspace: id => id === workspace.id ? workspace : undefined,
    getWorkspacePath: slug => join(tempRoot, slug),
    getWorkspaceFilesDir: slug => join(tempRoot, slug, 'workspace-files'),
    loadReference: brandId => {
      if (brandId !== 'stripe') throw new Error('目录不存在')
      return { revision: 'r1', brandName: 'Stripe', reference: { design: '# Stripe Design System\n', tokens: ':root { --brand: blue; }\n' } }
    },
    now: () => 123,
  })
}

test('Given Owner 已绑定工作区 When 预览安装 Then 返回精确工作区、版本和无冲突状态', () => {
  const preview = createInstaller().preview(projectId, 'stripe')
  expect(preview).toMatchObject({ projectId, brandId: 'stripe', brandName: 'Stripe', ownerBindingRevision: 4, workspaceId: workspace.id, workspaceName: workspace.name, canInstall: true, conflictNames: [] })
})

test('Given 用户确认当前 Owner 工作区 When 安装 Then 保存完整来源与哈希供后续上下文读取', () => {
  const installer = createInstaller()
  const preview = installer.preview(projectId, 'stripe')
  const result = installer.install({ projectId, brandId: 'stripe', expectedOwnerBindingRevision: preview.ownerBindingRevision, expectedWorkspaceId: preview.workspaceId, expectedReferenceRevision: preview.referenceRevision, confirmed: true })
  expect(result).toMatchObject({ brandId: 'stripe', workspaceId: workspace.id, referenceRevision: 'r1' })
  expect(result.fileHashes['DESIGN.md']).toHaveLength(64)
  expect(installer.readInstalled(workspace.slug)).toEqual({ brandName: 'Stripe', design: '# Stripe Design System\n', tokens: ':root { --brand: blue; }\n', referenceRevision: 'r1' })
  expect(readdirSync(join(tempRoot, workspace.slug, 'workspace-files', '.opendesign', 'active')).sort()).toEqual(['DESIGN.md', 'tokens.css'])
  writeFileSync(join(tempRoot, workspace.slug, 'workspace-files', '.opendesign', 'active', 'DESIGN.md'), 'tampered')
  expect(installer.readInstalled(workspace.slug)).toBeUndefined()
})

test('Given 未确认或 Owner 工作区绑定已变化 When 安装 Then 拒绝写入', () => {
  const installer = createInstaller()
  expect(() => installer.install({ projectId, brandId: 'stripe', expectedOwnerBindingRevision: 4, expectedWorkspaceId: workspace.id, expectedReferenceRevision: 'r1', confirmed: false as true })).toThrow('用户确认')
  expect(() => createInstaller({ ...binding, revision: 5 }).install({ projectId, brandId: 'stripe', expectedOwnerBindingRevision: 4, expectedWorkspaceId: workspace.id, expectedReferenceRevision: 'r1', confirmed: true })).toThrow('已变化')
  expect(() => installer.install({ projectId, brandId: 'stripe', expectedOwnerBindingRevision: 4, expectedWorkspaceId: workspace.id, expectedReferenceRevision: 'stale', confirmed: true })).toThrow('参考版本已变化')
})

test('Given 工作区已有设计文件或安装记录 When 预览/安装 Then 拒绝覆盖并保留原内容', () => {
  const designPath = join(tempRoot, workspace.slug, 'workspace-files', 'DESIGN.md')
  writeFileSync(designPath, 'USER DESIGN')
  const installer = createInstaller()
  const preview = installer.preview(projectId, 'stripe')
  expect(preview.canInstall).toBe(false)
  expect(preview.conflictNames).toContain('DESIGN.md')
  expect(() => installer.install({ projectId, brandId: 'stripe', expectedOwnerBindingRevision: 4, expectedWorkspaceId: workspace.id, expectedReferenceRevision: 'r1', confirmed: true })).toThrow('未覆盖')
  expect(readFileSync(designPath, 'utf8')).toBe('USER DESIGN')
})

test('Given 目标是悬空符号链接 When 预览 Then 将其视为冲突而不是空目录', () => {
  const target = join(tempRoot, workspace.slug, 'workspace-files', '.opendesign', 'active')
  mkdirSync(join(tempRoot, workspace.slug, 'workspace-files', '.opendesign'))
  symlinkSync(join(tempRoot, 'missing'), target)
  const preview = createInstaller().preview(projectId, 'stripe')
  expect(preview.canInstall).toBe(false)
  expect(preview.conflictNames).toContain('OpenDesign 安装目录')
})

test('Given Owner 尚未绑定工作区 When 预览安装 Then 不猜测目标', () => {
  expect(() => createInstaller(null).preview(projectId, 'stripe')).toThrow('尚未绑定')
})
