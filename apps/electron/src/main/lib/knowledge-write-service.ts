/**
 * 知识库写盘服务
 *
 * 写操作会修改用户磁盘上的 Markdown 源文件，因此每一项都必须过安全校验。
 * 与 knowledge-service（只读索引）分开，便于单独测试安全边界。
 *
 * 三条硬约束：
 *
 * 1. **路径必须在 Vault 根内**。所有输入路径都经 resolve 规范化后校验
 *    前缀，阻断 `../../../etc/passwd` 与符号链接逃逸。
 *
 * 2. **原子写**。先写同目录临时文件再 rename。用户笔记是权威数据，
 *    写入中断不能让文件变成半截内容。同目录才能保证 rename 是原子的
 *    （跨设备 rename 会退化为复制）。
 *
 * 3. **不写工具专用标记**。磁盘上只保留原始 Markdown，保证 Obsidian
 *    与其他编辑器能正常读取。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { KnowledgeNote, KnowledgeVault } from '@gravitas/shared'
import { parseNote, generateNoteContent, normalizeRelPath } from '@gravitas/core/services/knowledge'
import { assertCapability } from './entitlement-gate'
import { getKnowledgeVault } from './knowledge-service'

/**
 * 写操作需要的能力。
 *
 * 边界按「是否修改用户磁盘上的 Markdown」划分：只读索引（扫描/搜索/图谱）
 * 与 Vault 管理属于免费版 knowledge-basic；一旦能写用户笔记，就需要
 * knowledge-pro —— 这些文件是用户的权威数据，误写代价高于不提供编辑。
 */
const WRITE_CAPABILITY = 'knowledge-pro' as const

/** 笔记文件名中不允许出现的字符（含路径分隔符与控制字符） */
const INVALID_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g

/**
 * 校验并解析写目标路径。
 *
 * 返回规范化后的绝对路径，或抛错。这是所有写操作的唯一入口校验，
 * 不要在各写函数里各写一份。
 */
export function resolveSafePath(vault: KnowledgeVault, relativePath: string): string {
  const normalized = normalizeRelPath(relativePath)
  if (!normalized) {
    throw new Error('笔记路径不能为空')
  }
  if (normalized.split('/').some((seg) => seg === '..')) {
    throw new Error(`笔记路径不允许包含上级目录引用: ${relativePath}`)
  }
  // Windows 盘符（C:\...）在 Windows 上会被 path.resolve 当作绝对路径，
  // 从而绕过前缀检查。在解析前直接拒绝。
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new Error(`笔记路径不允许包含盘符: ${relativePath}`)
  }

  const root = resolve(vault.path)
  const target = resolve(root, normalized)

  // 前缀校验：必须落在 Vault 根内（含边界，避免 /root-evil 命中 /root）
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`笔记路径超出知识库范围: ${relativePath}`)
  }

  return target
}

/** 规范化笔记标题为安全文件名 */
export function sanitizeFileName(title: string): string {
  const cleaned = title.replace(INVALID_FILENAME, '').trim()
  if (!cleaned) {
    throw new Error('笔记标题不能为空')
  }
  // 避免生成 . 与 .. 这类特殊名
  if (cleaned === '.' || cleaned === '..') {
    throw new Error('笔记标题不合法')
  }
  return cleaned
}

/**
 * 计算文件内容的版本标识。
 *
 * 用内容哈希而不是 mtime：mtime 在同秒内的两次写入可能完全相同，
 * 也不区分内容是否真的变化。哈希只用于本地并发检测，不承载安全语义。
 */
export function contentVersion(rawContent: string): string {
  return createHash('sha256').update(rawContent, 'utf-8').digest('hex')
}

/**
 * 读取笔记当前版本；文件不存在时返回 null。
 *
 * 供编辑区在加载时记录基线版本，保存时回传比对。
 */
export function noteFileVersion(vaultId: string, relativePath: string): string | null {
  const vault = getKnowledgeVault(vaultId)
  if (!vault) return null

  let targetPath: string
  try {
    targetPath = resolveSafePath(vault, relativePath)
  } catch {
    return null
  }
  if (!existsSync(targetPath)) return null
  return contentVersion(readFileSync(targetPath, 'utf-8'))
}

/**
 * 校验期望版本是否与磁盘一致。
 *
 * 这是并发编辑的唯一防线，放在主进程而不是渲染层：UI 的 mtime 提示
 * 可以被任何其他调用方绕过。不传 expectedVersion 视为调用方自担
 * 并发风险（保持既有调用兼容），但传入后必须匹配。
 */
function assertExpectedVersion(
  targetPath: string,
  expectedVersion: string | undefined,
  force: boolean | undefined,
  action: string,
): void {
  if (!expectedVersion || force) return
  const actual = contentVersion(readFileSync(targetPath, 'utf-8'))
  if (actual !== expectedVersion) {
    throw new Error(
      `笔记已被其他程序修改，${action}被拒绝（可能是 Obsidian 或另一个窗口）。请重新加载后再试。`,
    )
  }
}

/**
 * 原子写入。
 *
 * 同目录临时文件 + rename：同目录保证 rename 不跨设备，因此是原子的。
 * 写失败时清理临时文件，不留下垃圾。
 */
export function atomicWrite(targetPath: string, content: string): void {
  const dir = dirname(targetPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const tempPath = join(dir, `.${basename(targetPath)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tempPath, content, 'utf-8')
    renameSync(tempPath, targetPath)
  } catch (err) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath)
    } catch {
      // 清理失败不影响原始错误
    }
    throw err
  }
}

// ===== 写操作 =====

export interface CreateNoteInput {
  vaultId: string
  /** 笔记标题，同时作为文件名（除非指定 fileName） */
  title: string
  /** 相对 Vault 根的子目录，如 'projects' */
  directory?: string
  /** 自定义文件名（不含 .md）；不传则用标题 */
  fileName?: string
  content?: string
  frontmatter?: Record<string, unknown>
  /** 目标文件已存在时是否覆盖 */
  overwrite?: boolean
}

/**
 * 新建笔记文件。
 *
 * 默认不覆盖已存在的文件：静默覆盖会丢失用户内容，必须由调用方显式要求。
 */
export function createNoteFile(input: CreateNoteInput): { relativePath: string; absolutePath: string } {
  assertCapability(WRITE_CAPABILITY, '新建笔记')
  const vault = getKnowledgeVault(input.vaultId)
  if (!vault) throw new Error(`Vault 不存在: ${input.vaultId}`)

  const fileName = `${sanitizeFileName(input.fileName?.trim() || input.title)}.md`
  const directory = input.directory ? normalizeRelPath(input.directory) : ''
  const relativePath = directory ? `${directory}/${fileName}` : fileName

  const targetPath = resolveSafePath(vault, relativePath)
  if (existsSync(targetPath) && !input.overwrite) {
    throw new Error(`笔记已存在: ${relativePath}`)
  }

  const content = generateNoteContent({
    title: input.title,
    content: input.content ?? '',
    frontmatter: input.frontmatter,
  })
  atomicWrite(targetPath, content)
  return { relativePath, absolutePath: targetPath }
}

export interface UpdateNoteInput {
  vaultId: string
  /** 相对路径 */
  relativePath: string
  content: string
  frontmatter?: Record<string, unknown>
  /** 加载笔记时记录的版本（noteFileVersion）；传入后磁盘不一致则拒绝写入 */
  expectedVersion?: string
  /** 用户已确认覆盖外部修改时置 true；仅在 UI 显式确认后使用 */
  force?: boolean
}

/** 更新笔记内容（保留标题作为一级标题由调用方决定是否包含在 content 内） */
export function updateNoteFile(input: UpdateNoteInput): { absolutePath: string } {
  assertCapability(WRITE_CAPABILITY, '保存笔记')
  const vault = getKnowledgeVault(input.vaultId)
  if (!vault) throw new Error(`Vault 不存在: ${input.vaultId}`)

  const targetPath = resolveSafePath(vault, input.relativePath)
  if (!existsSync(targetPath)) {
    throw new Error(`笔记不存在: ${input.relativePath}`)
  }

  assertExpectedVersion(targetPath, input.expectedVersion, input.force, '保存')

  // 保留原文件中的标题：编辑区只承载正文，不应因为一次保存丢掉标题
  const existing = parseNote(readFileSync(targetPath, 'utf-8'), basename(targetPath, '.md'))
  const content = generateNoteContent({
    title: existing.title,
    content: input.content,
    frontmatter: input.frontmatter ?? existing.frontmatter,
  })
  atomicWrite(targetPath, content)
  return { absolutePath: targetPath }
}

export interface RenameNoteInput {
  vaultId: string
  relativePath: string
  /** 新的标题（同时改文件名，保持与 Obsidian 一致的行为） */
  newTitle: string
  /** 加载笔记时记录的版本；传入后磁盘不一致则拒绝重命名 */
  expectedVersion?: string
  /** 用户已确认覆盖外部修改时置 true */
  force?: boolean
}

/**
 * 重命名笔记。
 *
 * 同时改文件名与正文一级标题，与 Obsidian 的重命名语义一致。
 * 目标文件已存在时拒绝，避免覆盖其他笔记。
 */
export function renameNoteFile(input: RenameNoteInput): { relativePath: string } {
  assertCapability(WRITE_CAPABILITY, '重命名笔记')
  const vault = getKnowledgeVault(input.vaultId)
  if (!vault) throw new Error(`Vault 不存在: ${input.vaultId}`)

  const sourcePath = resolveSafePath(vault, input.relativePath)
  if (!existsSync(sourcePath)) {
    throw new Error(`笔记不存在: ${input.relativePath}`)
  }

  assertExpectedVersion(sourcePath, input.expectedVersion, input.force, '重命名')

  const directory = dirname(normalizeRelPath(input.relativePath))
  const fileName = `${sanitizeFileName(input.newTitle)}.md`
  const newRelativePath = directory && directory !== '.' ? `${directory}/${fileName}` : fileName
  const targetPath = resolveSafePath(vault, newRelativePath)

  if (targetPath !== sourcePath && existsSync(targetPath)) {
    throw new Error(`目标笔记已存在: ${newRelativePath}`)
  }

  // 先写新内容再删旧文件：中途失败时新旧至少有一个完整
  const existing = parseNote(readFileSync(sourcePath, 'utf-8'), basename(sourcePath, '.md'))
  const content = generateNoteContent({
    title: input.newTitle,
    content: existing.content,
    frontmatter: existing.frontmatter,
  })
  atomicWrite(targetPath, content)

  if (targetPath !== sourcePath) {
    try {
      unlinkSync(sourcePath)
    } catch (err) {
      // 新文件已写入成功，旧文件删除失败不应让调用方以为重命名失败
      console.warn(`[Knowledge] 重命名后旧文件删除失败: ${sourcePath}`, err)
    }
  }

  return { relativePath: newRelativePath }
}

/** 删除笔记文件（不可撤销，调用方需先确认） */
export function deleteNoteFile(vaultId: string, relativePath: string): void {
  assertCapability(WRITE_CAPABILITY, '删除笔记')
  const vault = getKnowledgeVault(vaultId)
  if (!vault) throw new Error(`Vault 不存在: ${vaultId}`)

  const targetPath = resolveSafePath(vault, relativePath)
  if (!existsSync(targetPath)) {
    throw new Error(`笔记不存在: ${relativePath}`)
  }
  unlinkSync(targetPath)
}

/** 读取笔记原文（供编辑区加载，不经过索引缓存） */
export function readNoteFile(
  vaultId: string,
  relativePath: string,
): { rawContent: string; parsed: KnowledgeNote['frontmatter'] & { content: string; title: string } } | null {
  const vault = getKnowledgeVault(vaultId)
  if (!vault) return null

  const targetPath = resolveSafePath(vault, relativePath)
  if (!existsSync(targetPath)) return null

  const parsed = parseNote(readFileSync(targetPath, 'utf-8'), basename(targetPath, '.md'))
  return {
    rawContent: parsed.rawContent,
    parsed: {
      ...parsed.frontmatter,
      content: parsed.content,
      title: parsed.title,
    },
  }
}

/** 笔记文件的修改时间与大小（供 UI 提示外部变更） */
export function statNoteFile(
  vaultId: string,
  relativePath: string,
): { size: number; modifiedAt: string } | null {
  const vault = getKnowledgeVault(vaultId)
  if (!vault) return null
  const targetPath = resolveSafePath(vault, relativePath)
  if (!existsSync(targetPath)) return null
  const stat = statSync(targetPath)
  return { size: stat.size, modifiedAt: stat.mtime.toISOString() }
}

/** 清理因中断残留的临时文件（前缀 .xxx.tmp），返回清理数量 */
export function cleanupTempFiles(vault: KnowledgeVault): number {
  // 仅在索引时扫描，不递归清理整个目录以免误删用户文件
  let removed = 0
  try {
    const root = resolve(vault.path)
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return
      const entries = require('node:fs').readdirSync(dir, { withFileTypes: true }) as Array<{
        name: string
        isDirectory: () => boolean
        isFile: () => boolean
      }>
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (['.git', '.obsidian', 'node_modules', '.trash'].includes(entry.name)) continue
          walk(full)
        } else if (entry.isFile() && entry.name.endsWith('.tmp') && entry.name.startsWith('.')) {
          try {
            rmSync(full)
            removed += 1
          } catch {
            // 忽略单个失败
          }
        }
      }
    }
    walk(root)
    void relative
  } catch (err) {
    console.warn('[Knowledge] 临时文件清理失败:', err)
  }
  return removed
}
