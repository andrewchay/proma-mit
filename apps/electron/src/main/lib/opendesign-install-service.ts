import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentWorkspace, OwnerRuntimeBinding, ProjectOwnerDesignSystemInstallPreview, ProjectOwnerDesignSystemInstallRequest, ProjectOwnerDesignSystemInstallResult } from '@gravitas/shared'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getAgentWorkspacePath, getWorkspaceFilesDir } from './config-paths'
import { getOwnerRuntimeBinding } from './project-owner-runtime-binding'
import { getOpenDesignInstallPath, installOpenDesignFiles, readInstalledOpenDesign, type OpenDesignInstallManifest } from './opendesign-install-store'

interface DesignReference { design: string; tokens: string }
interface DesignCatalog { revision: string; entries: Array<{ id: string; name: string }> }
interface DesignReferenceBundle { revision: string; entries: Record<string, DesignReference> }
const MAX_RESOURCE_BYTES = 512_000
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

export interface OwnerDesignSystemInstallerDependencies {
  getBinding: (projectId: string) => OwnerRuntimeBinding | null
  getWorkspace: (workspaceId: string) => AgentWorkspace | undefined
  getWorkspacePath: (slug: string) => string
  getWorkspaceFilesDir: (slug: string) => string
  loadReference: (brandId: string) => { revision: string; brandName: string; reference: DesignReference }
  now: () => number
}

function safeDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink() } catch { return false }
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function readBundledReference(brandId: string): { revision: string; brandName: string; reference: DesignReference } {
  const resourcesDir = [join(__dirname, 'resources'), resolve(__dirname, '../../../resources')].find(path => pathExists(join(path, 'opendesign-brand-catalog.json')))
  if (!resourcesDir) throw new Error('OpenDesign 本地资源不可用')
  const catalog = JSON.parse(readFileSync(join(resourcesDir, 'opendesign-brand-catalog.json'), 'utf8')) as DesignCatalog
  const index = catalog.entries.findIndex(entry => entry.id === brandId)
  const brand = catalog.entries[index]
  if (!brand || !Number.isSafeInteger(index) || !catalog.revision) throw new Error('所选设计系统不在随包目录中')
  const bundlePath = join(resourcesDir, `opendesign-references-${Math.floor(index / 38)}.json`)
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as DesignReferenceBundle
  const reference = bundle.entries[brandId]
  if (bundle.revision !== catalog.revision || !reference || typeof reference.design !== 'string' || typeof reference.tokens !== 'string') {
    throw new Error('OpenDesign 参考版本或内容不完整')
  }
  if (Buffer.byteLength(reference.design, 'utf8') > MAX_RESOURCE_BYTES || Buffer.byteLength(reference.tokens, 'utf8') > MAX_RESOURCE_BYTES) {
    throw new Error('OpenDesign 参考超出允许大小')
  }
  return { revision: catalog.revision, brandName: brand.name, reference }
}

function workspaceConflicts(workspace: AgentWorkspace, filesDir: string, installPath: string): string[] {
  const conflicts = [installPath, join(filesDir, 'DESIGN.md'), join(filesDir, 'tokens.css')]
  if (workspace.rootPath) conflicts.push(join(workspace.rootPath, 'DESIGN.md'), join(workspace.rootPath, 'tokens.css'))
  return conflicts.filter(pathExists)
}

function makePreview(
  projectId: string,
  brandId: string,
  binding: OwnerRuntimeBinding,
  workspace: AgentWorkspace,
  filesDir: string,
  referenceRevision: string,
  brandName: string,
): ProjectOwnerDesignSystemInstallPreview {
  const installPath = getOpenDesignInstallPath(filesDir)
  const conflicts = workspaceConflicts(workspace, filesDir, installPath)
  return {
    projectId,
    brandId,
    brandName,
    referenceRevision,
    ownerBindingRevision: binding.revision,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    canInstall: conflicts.length === 0,
    conflictNames: conflicts.map(path => path.endsWith('DESIGN.md') ? 'DESIGN.md' : path.endsWith('tokens.css') ? 'tokens.css' : 'OpenDesign 安装目录'),
  }
}

export function createOwnerDesignSystemInstaller(deps: OwnerDesignSystemInstallerDependencies) {
  const target = (projectId: string, brandId: string) => {
    if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 128) throw new Error('Owner 项目身份无效')
    if (typeof brandId !== 'string' || !/^[a-z0-9-]{1,100}$/.test(brandId)) throw new Error('设计系统身份无效')
    const binding = deps.getBinding(projectId)
    if (!binding) throw new Error('Owner 尚未绑定执行工作区')
    const workspace = deps.getWorkspace(binding.workspaceId)
    if (!workspace || workspace.id !== binding.workspaceId || !/^[a-z0-9-]{1,100}$/.test(workspace.slug)) throw new Error('Owner 执行工作区不可用')
    const workspaceRoot = resolve(deps.getWorkspacePath(workspace.slug))
    const filesDir = resolve(deps.getWorkspaceFilesDir(workspace.slug))
    if (!filesDir.startsWith(`${workspaceRoot}/`) || !safeDirectory(workspaceRoot) || !safeDirectory(filesDir)) throw new Error('Owner 工作区共享目录不安全')
    const loaded = deps.loadReference(brandId)
    return { binding, workspace, workspaceRoot, filesDir, loaded }
  }

  return {
    preview(projectId: string, brandId: string): ProjectOwnerDesignSystemInstallPreview {
      const value = target(projectId, brandId)
      return makePreview(projectId, brandId, value.binding, value.workspace, value.filesDir, value.loaded.revision, value.loaded.brandName)
    },

    install(input: ProjectOwnerDesignSystemInstallRequest): ProjectOwnerDesignSystemInstallResult {
      if (!input || input.confirmed !== true || !Number.isSafeInteger(input.expectedOwnerBindingRevision)
        || typeof input.expectedReferenceRevision !== 'string' || !input.expectedReferenceRevision
        || typeof input.expectedWorkspaceId !== 'string' || !input.expectedWorkspaceId) throw new Error('安装必须经过用户确认并携带当前工作区版本')
      const value = target(input.projectId, input.brandId)
      if (value.binding.revision !== input.expectedOwnerBindingRevision || value.workspace.id !== input.expectedWorkspaceId) throw new Error('Owner 执行工作区已变化，请重新核对安装目标')
      if (value.loaded.revision !== input.expectedReferenceRevision) throw new Error('OpenDesign 参考版本已变化，请重新预览安装')
      const preview = makePreview(input.projectId, input.brandId, value.binding, value.workspace, value.filesDir, value.loaded.revision, value.loaded.brandName)
      if (!preview.canInstall) throw new Error(`目标已有内容，未覆盖：${preview.conflictNames.join('、')}`)

      const { design, tokens } = value.loaded.reference
      const manifest: OpenDesignInstallManifest = {
        schemaVersion: 1,
        source: 'OpenDesign',
        license: 'Apache-2.0',
        projectId: input.projectId,
        workspaceId: value.workspace.id,
        workspaceSlug: value.workspace.slug,
        brandId: input.brandId,
        brandName: value.loaded.brandName,
        referenceRevision: value.loaded.revision,
        installedAt: deps.now(),
        actor: 'local-user',
        files: { 'DESIGN.md': sha256(design), 'tokens.css': sha256(tokens) },
      }
      const installed = installOpenDesignFiles(value.filesDir, manifest, design, tokens)
      return { brandId: input.brandId, brandName: value.loaded.brandName, referenceRevision: value.loaded.revision, workspaceId: value.workspace.id, workspaceName: value.workspace.name, fileHashes: installed.fileHashes }
    },

    readInstalled(workspaceSlug: string): { brandName: string; design: string; tokens: string; referenceRevision: string } | undefined {
      if (typeof workspaceSlug !== 'string' || !/^[a-z0-9-]{1,100}$/.test(workspaceSlug)) return undefined
      const installed = readInstalledOpenDesign(deps.getWorkspaceFilesDir(workspaceSlug), workspaceSlug)
      return installed ? { brandName: installed.brandName, design: installed.design, tokens: installed.tokens, referenceRevision: installed.referenceRevision } : undefined
    },
  }
}

const installer = createOwnerDesignSystemInstaller({
  getBinding: getOwnerRuntimeBinding,
  getWorkspace: getAgentWorkspace,
  getWorkspacePath: getAgentWorkspacePath,
  getWorkspaceFilesDir,
  loadReference: readBundledReference,
  now: Date.now,
})

export const previewOwnerDesignSystemInstall = installer.preview
export const installOwnerDesignSystem = installer.install
export const readInstalledOwnerDesignSystem = installer.readInstalled
