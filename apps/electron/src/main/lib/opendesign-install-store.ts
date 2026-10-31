import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface OpenDesignInstallManifest {
  schemaVersion: 1
  source: 'OpenDesign'
  license: 'Apache-2.0'
  projectId: string
  workspaceId: string
  workspaceSlug: string
  brandId: string
  brandName: string
  referenceRevision: string
  installedAt: number
  actor: 'local-user'
  files: { 'DESIGN.md': string; 'tokens.css': string }
}

export interface InstalledOpenDesign {
  brandId: string
  brandName: string
  design: string
  tokens: string
  referenceRevision: string
  fileHashes: OpenDesignInstallManifest['files']
}

const MAX_RESOURCE_BYTES = 512_000
const INSTALL_RELATIVE_PATH = '.opendesign/active'
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const safeDirectory = (path: string): boolean => {
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink() } catch { return false }
}
const pathExists = (path: string): boolean => {
  try { lstatSync(path); return true } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function manifestFrom(path: string, workspaceSlug: string): { manifest: OpenDesignInstallManifest; design: string; tokens: string } | undefined {
  if (!safeDirectory(path)) return undefined
  try {
    const manifestPath = getOpenDesignManifestPath(join(path, '..', '..'))
    const designPath = join(path, 'DESIGN.md')
    const tokensPath = join(path, 'tokens.css')
    for (const file of [manifestPath, designPath, tokensPath]) {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RESOURCE_BYTES) return undefined
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as OpenDesignInstallManifest
    const design = readFileSync(designPath, 'utf8')
    const tokens = readFileSync(tokensPath, 'utf8')
    if (manifest.schemaVersion !== 1 || manifest.source !== 'OpenDesign' || manifest.license !== 'Apache-2.0'
      || manifest.actor !== 'local-user' || !Number.isSafeInteger(manifest.installedAt)
      || typeof manifest.projectId !== 'string' || !manifest.projectId
      || typeof manifest.workspaceId !== 'string' || !manifest.workspaceId
      || typeof manifest.brandName !== 'string' || !manifest.brandName
      || typeof manifest.referenceRevision !== 'string' || !manifest.referenceRevision
      || manifest.workspaceSlug !== workspaceSlug || !/^[a-z0-9-]{1,100}$/.test(manifest.brandId)
      || !/^[a-f0-9]{64}$/.test(manifest.files?.['DESIGN.md'] ?? '') || !/^[a-f0-9]{64}$/.test(manifest.files?.['tokens.css'] ?? '')
      || sha256(design) !== manifest.files['DESIGN.md'] || sha256(tokens) !== manifest.files['tokens.css']) return undefined
    return { manifest, design, tokens }
  } catch { return undefined }
}

export function installOpenDesignFiles(workspaceFilesDir: string, manifest: OpenDesignInstallManifest, design: string, tokens: string): InstalledOpenDesign {
  if (Buffer.byteLength(design, 'utf8') > MAX_RESOURCE_BYTES || Buffer.byteLength(tokens, 'utf8') > MAX_RESOURCE_BYTES
    || manifest.files['DESIGN.md'] !== sha256(design) || manifest.files['tokens.css'] !== sha256(tokens)) {
    throw new Error('OpenDesign 安装内容或摘要无效')
  }
  const filesDir = resolve(workspaceFilesDir)
  const workspaceRoot = resolve(filesDir, '..')
  const realWorkspaceFiles = resolve(filesDir)
  if (!filesDir.startsWith(`${workspaceRoot}/`) || !safeDirectory(workspaceRoot) || !safeDirectory(realWorkspaceFiles)) throw new Error('Owner 工作区共享目录不安全')
  const opendesignDir = join(filesDir, '.opendesign')
  if (pathExists(opendesignDir) && !safeDirectory(opendesignDir)) throw new Error('OpenDesign 工作区目录不是普通文件夹')
  if (!pathExists(opendesignDir)) mkdirSync(opendesignDir, { mode: 0o700 })
  const installPath = join(filesDir, INSTALL_RELATIVE_PATH)
  if (pathExists(installPath)) throw new Error('OpenDesign 安装目录已存在，拒绝覆盖')
  const stagingPath = join(opendesignDir, `.install-${randomUUID()}`)
  mkdirSync(stagingPath, { mode: 0o700 })
  let installedDirectory = false
  try {
    writeFileSync(join(stagingPath, 'DESIGN.md'), design, { flag: 'wx', mode: 0o600 })
    writeFileSync(join(stagingPath, 'tokens.css'), tokens, { flag: 'wx', mode: 0o600 })
    if (pathExists(installPath) || pathExists(getOpenDesignManifestPath(filesDir))) throw new Error('OpenDesign 安装目录已存在，拒绝覆盖')
    renameSync(stagingPath, installPath)
    installedDirectory = true
    writeFileSync(getOpenDesignManifestPath(filesDir), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true })
    if (installedDirectory) rmSync(installPath, { recursive: true, force: true })
    throw error
  }
  return { brandId: manifest.brandId, brandName: manifest.brandName, design, tokens, referenceRevision: manifest.referenceRevision, fileHashes: manifest.files }
}

export function readInstalledOpenDesign(workspaceFilesDir: string, workspaceSlug: string): InstalledOpenDesign | undefined {
  if (!/^[a-z0-9-]{1,100}$/.test(workspaceSlug)) return undefined
  const installed = manifestFrom(join(workspaceFilesDir, INSTALL_RELATIVE_PATH), workspaceSlug)
  return installed ? {
    brandId: installed.manifest.brandId,
    brandName: installed.manifest.brandName,
    design: installed.design,
    tokens: installed.tokens,
    referenceRevision: installed.manifest.referenceRevision,
    fileHashes: installed.manifest.files,
  } : undefined
}

export function getOpenDesignInstallPath(workspaceFilesDir: string): string {
  return join(workspaceFilesDir, INSTALL_RELATIVE_PATH)
}

function getOpenDesignManifestPath(workspaceFilesDir: string): string {
  return join(workspaceFilesDir, '.opendesign', 'installation.json')
}
