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

/**
 * 会话目录安装：设计说明与令牌写进本次会话目录，同名冲突时另存（不覆盖已有文件）。
 *
 * 与工作区共享安装的区别：共享安装是「这个工作区用哪套品牌」，冲突即拒绝；
 * 会话安装是「这次会话里放了什么」，同名文件可能是用户自己的设计说明，因此改成
 * 带品牌前缀的另存名，并在 manifest 记录实际文件名，注入时按 manifest 读取。
 */
export interface OpenDesignSessionInstallManifest {
  schemaVersion: 1
  source: 'OpenDesign'
  license: 'Apache-2.0'
  projectId: string
  sessionId: string
  workspaceSlug: string
  brandId: string
  brandName: string
  referenceRevision: string
  installedAt: number
  actor: 'local-user'
  /** 实际写入的文件名：同名文件已存在时是另存名，不是 DESIGN.md / tokens.css。 */
  files: { design: string; tokens: string; designSha256: string; tokensSha256: string }
}

export interface InstalledSessionOpenDesign {
  brandId: string
  brandName: string
  design: string
  tokens: string
  referenceRevision: string
  designFile: string
  tokensFile: string
  fileHashes: { design: string; tokens: string }
}

const SESSION_MANIFEST_PATH = '.opendesign/session-installation.json'
const SESSION_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/
const MAX_ALIAS_ATTEMPTS = 20
const sessionManifestPath = (sessionDir: string): string => join(sessionDir, SESSION_MANIFEST_PATH)

function sessionBasenameSafe(name: string): boolean {
  return SESSION_BASENAME.test(name) && !name.includes('..')
}

/** 选取不冲突的文件名：首选原名，冲突时按品牌前缀另存，仍冲突则加序号。 */
function pickSessionFileName(sessionDir: string, preferred: string, brandId: string, kind: 'design' | 'tokens'): string {
  const extension = preferred.slice(preferred.lastIndexOf('.'))
  const candidates = [preferred, `${brandId}-${kind === 'design' ? 'design' : 'tokens'}${extension}`]
  for (let index = 2; index <= MAX_ALIAS_ATTEMPTS; index++) {
    candidates.push(`${brandId}-${kind === 'design' ? 'design' : 'tokens'}-${index}${extension}`)
  }
  for (const candidate of candidates) {
    if (!sessionBasenameSafe(candidate)) throw new Error('OpenDesign 会话目录文件名不安全')
    if (!pathExists(join(sessionDir, candidate))) return candidate
  }
  throw new Error('OpenDesign 会话目录另存名已用尽，请先清理旧的设计系统文件')
}

function writeSessionFile(sessionDir: string, name: string, content: string): void {
  try {
    writeFileSync(join(sessionDir, name), content, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new Error(`OpenDesign 会话目录目标已存在：${name}`)
    throw error
  }
}

/**
 * 把设计说明与令牌写入会话目录；同名冲突时另存，manifest 记录实际文件名。
 *
 * 只写不改：已存在的文件一律不动，写失败时回滚本次新文件，避免留下半套规范。
 */
export function installOpenDesignIntoSessionDir(
  sessionDir: string,
  manifest: Omit<OpenDesignSessionInstallManifest, 'files'>,
  design: string,
  tokens: string,
): InstalledSessionOpenDesign {
  const root = resolve(sessionDir)
  if (!safeDirectory(root)) throw new Error('OpenDesign 会话目录不可用')
  if (!/^[a-z0-9]{1,100}$/.test(manifest.brandId)) throw new Error('设计系统身份无效')
  if (Buffer.byteLength(design, 'utf8') > MAX_RESOURCE_BYTES || Buffer.byteLength(tokens, 'utf8') > MAX_RESOURCE_BYTES) {
    throw new Error('OpenDesign 安装内容超出允许大小')
  }
  if (!design.trim() || !tokens.trim()) throw new Error('OpenDesign 安装内容为空')
  const designFile = pickSessionFileName(root, 'DESIGN.md', manifest.brandId, 'design')
  const tokensFile = pickSessionFileName(root, 'tokens.css', manifest.brandId, 'tokens')
  const designSha256 = sha256(design)
  const tokensSha256 = sha256(tokens)
  const written: string[] = []
  const manifestDirectory = join(root, '.opendesign')
  try {
    if (!pathExists(manifestDirectory)) mkdirSync(manifestDirectory, { mode: 0o700 })
    else if (!safeDirectory(manifestDirectory)) throw new Error('OpenDesign 会话安装记录目录不是普通文件夹')
    writeSessionFile(root, designFile, design)
    written.push(designFile)
    writeSessionFile(root, tokensFile, tokens)
    written.push(tokensFile)
    const payload: OpenDesignSessionInstallManifest = { ...manifest, files: { design: designFile, tokens: tokensFile, designSha256, tokensSha256 } }
    // 独占创建也会拒绝符号链接，避免覆盖已有记录或链接指向的文件。
    writeFileSync(sessionManifestPath(root), `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    for (const name of written) rmSync(join(root, name), { force: true })
    throw error
  }
  return { brandId: manifest.brandId, brandName: manifest.brandName, design, tokens, referenceRevision: manifest.referenceRevision, designFile, tokensFile, fileHashes: { design: designSha256, tokens: tokensSha256 } }
}

/** 读取会话目录安装；记录缺失、指纹不符或文件被改动时返回 undefined（不降级成可信资源）。 */
export function readInstalledOpenDesignFromSession(sessionDir: string): InstalledSessionOpenDesign | undefined {
  const root = resolve(sessionDir)
  if (!safeDirectory(root)) return undefined
  try {
    const manifestPath = sessionManifestPath(root)
    const manifestStat = lstatSync(manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_RESOURCE_BYTES) return undefined
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as OpenDesignSessionInstallManifest
    if (manifest.schemaVersion !== 1 || manifest.source !== 'OpenDesign' || manifest.license !== 'Apache-2.0'
      || manifest.actor !== 'local-user' || !Number.isSafeInteger(manifest.installedAt)
      || typeof manifest.projectId !== 'string' || !manifest.projectId
      || typeof manifest.sessionId !== 'string' || !manifest.sessionId
      || typeof manifest.brandName !== 'string' || !manifest.brandName
      || typeof manifest.referenceRevision !== 'string' || !manifest.referenceRevision
      || !/^[a-z0-9-]{1,100}$/.test(manifest.brandId)
      || !sessionBasenameSafe(manifest.files?.design ?? '') || !sessionBasenameSafe(manifest.files?.tokens ?? '')
      || !/^[a-f0-9]{64}$/.test(manifest.files?.designSha256 ?? '') || !/^[a-f0-9]{64}$/.test(manifest.files?.tokensSha256 ?? '')) return undefined
    const readArtifact = (name: string): string | undefined => {
      const filePath = join(root, name)
      const stat = lstatSync(filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RESOURCE_BYTES) return undefined
      return readFileSync(filePath, 'utf8')
    }
    const design = readArtifact(manifest.files.design)
    const tokens = readArtifact(manifest.files.tokens)
    if (design === undefined || tokens === undefined) return undefined
    if (sha256(design) !== manifest.files.designSha256 || sha256(tokens) !== manifest.files.tokensSha256) return undefined
    return {
      brandId: manifest.brandId,
      brandName: manifest.brandName,
      design,
      tokens,
      referenceRevision: manifest.referenceRevision,
      designFile: manifest.files.design,
      tokensFile: manifest.files.tokens,
      fileHashes: { design: manifest.files.designSha256, tokens: manifest.files.tokensSha256 },
    }
  } catch {
    return undefined
  }
}
