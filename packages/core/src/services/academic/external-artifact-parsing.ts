/**
 * 外部产物引用解析（M6.2，纯函数无 IO）
 *
 * DVC `.dvc` 指针文件是 YAML，只记录哈希与路径，实体数据在远端/缓存中。
 * 因此解析结果只作为**引用**登记，并明确标注「实体数据不在此处」——
 * 不得把指针当作已获取的数据（方案 §7 DVC 行）。
 */

import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'

/** DVC 指针中的单个输出 */
export interface DvcPointerOutput {
  path: string
  /** 内容哈希（md5 或 hash 字段） */
  hash?: string
  /** 哈希算法（DVC 3+ 使用 hash: md5） */
  hashAlgorithm?: string
  sizeBytes?: number
  /** 远端存储名（存在表示实体在远端） */
  remote?: string
}

export interface DvcPointer {
  /** 指针文件路径（相对项目） */
  pointerPath: string
  /** 被跟踪的数据路径 */
  dataPath: string
  hash?: string
  hashAlgorithm?: string
  sizeBytes?: number
  remote?: string
  /** 数据实体是否随仓库提供（DVC 指针本身不包含数据） */
  dataAvailableLocally: false
  /** 需要用户执行什么才能取到数据 */
  fetchHint: string
}

/** 极简 YAML 子集解析：只处理 DVC 指针用到的顶层键与嵌套 outs 列表 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = text.split(/\r?\n/)
  let currentListKey: string | null = null
  let currentItem: Record<string, unknown> | null = null

  const commitItem = () => {
    if (currentListKey && currentItem) {
      const list = (result[currentListKey] as Record<string, unknown>[]) ?? []
      list.push(currentItem)
      result[currentListKey] = list
    }
    currentItem = null
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue

    const listItemMatch = line.match(/^\s*-\s+(.*)$/)
    if (listItemMatch) {
      commitItem()
      currentItem = {}
      const rest = listItemMatch[1]!.trim()
      if (rest) {
        const kv = rest.match(/^([\w-]+):\s*(.*)$/)
        if (kv) currentItem[kv[1]!] = stripQuotes(kv[2]!)
      }
      continue
    }

    const indentMatch = line.match(/^(\s*)([\w-]+):\s*(.*)$/)
    if (indentMatch) {
      const [, indent, key, value] = indentMatch
      if (indent!.length === 0) {
        // 任何顶层键都结束此前的列表上下文：
        // DVC 指针里 remote 等键常出现在 outs 列表之后。
        commitItem()
        if (!value!.trim()) {
          currentListKey = key!
          continue
        }
        currentListKey = null
        result[key!] = stripQuotes(value!)
        continue
      }
      if (currentItem) {
        currentItem[key!] = stripQuotes(value!)
      } else if (currentListKey) {
        currentItem = { [key!]: stripQuotes(value!) }
      }
      continue
    }
  }
  commitItem()
  return result
}

function stripQuotes(value: string): string {
  const v = value.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

/**
 * 解析 `.dvc` 指针文件内容。
 *
 * @param pointerPath 指针文件相对路径（用于展示与去重）
 * @param content 文件内容
 */
export function parseDvcPointer(pointerPath: string, content: string): DvcPointer {
  if (!pointerPath.endsWith('.dvc')) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `不是 DVC 指针文件（应以 .dvc 结尾）: ${pointerPath}`)
  }
  if (!content?.trim()) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `DVC 指针文件为空: ${pointerPath}`)
  }

  const parsed = parseSimpleYaml(content)
  const outs = parsed.outs as Array<Record<string, string>> | undefined
  const first = Array.isArray(outs) && outs.length > 0 ? outs[0] : undefined

  const dataPath = first?.path ?? (typeof parsed.path === 'string' ? parsed.path : undefined)
  if (!dataPath) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.INVALID_INPUT,
      `DVC 指针缺少数据路径（outs[].path）: ${pointerPath}`,
    )
  }

  const hash = first?.md5 ?? first?.hash ?? (typeof parsed.md5 === 'string' ? parsed.md5 : undefined)
  const hashAlgorithm = first?.hash ? 'md5' : undefined
  const sizeRaw = first?.size ?? (typeof parsed.size === 'string' ? parsed.size : undefined)
  const sizeBytes = sizeRaw ? parseInt(sizeRaw, 10) : undefined
  // remote 可能出现在顶层，也可能写在 outs 条目内；两处都接受
  const remote =
    (typeof first?.remote === 'string' ? first.remote : undefined) ??
    (typeof parsed.remote === 'string' ? parsed.remote : undefined)

  return {
    pointerPath,
    dataPath,
    hash,
    hashAlgorithm,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : undefined,
    remote,
    // 指针只描述数据身份，实体数据不在仓库内
    dataAvailableLocally: false,
    fetchHint: remote
      ? `数据在远端「${remote}」：请执行 dvc pull 获取后再引用实体`
      : '数据实体需执行 dvc pull（或已在本机 DVC 缓存）后才能引用',
  }
}

/** DVC 指针可登记为产物引用的 ref 形式 */
export function dvcRefOf(pointer: DvcPointer): string {
  return pointer.hash ? `dvc:${pointer.hash}` : `dvc:${pointer.dataPath}`
}
