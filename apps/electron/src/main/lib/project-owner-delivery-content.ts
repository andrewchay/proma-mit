import { createHash } from 'node:crypto'
import type { DevelopmentSnapshotFile } from '@gravitas/shared'

/** 文本按正文哈希，代码按冻结文件集合哈希；传输JSON不是源码版本的哈希域。 */
export function deliveryContentMatchesArtifact(content: string, artifactHash: string): boolean {
  const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
  if (sha(content) === artifactHash) return true
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  try {
    const value: unknown = JSON.parse(content)
    if (!record(value) || value.contentHash !== artifactHash || !Array.isArray(value.files) || !value.files.length
      || Object.keys(value).some(key => !['executionId', 'workspaceId', 'baseCommit', 'contentHash', 'files'].includes(key))
      || typeof value.executionId !== 'string' || !value.executionId || typeof value.workspaceId !== 'string' || !value.workspaceId
      || typeof value.baseCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseCommit)) return false
    const files: DevelopmentSnapshotFile[] = [], paths = new Set<string>()
    for (const entry of value.files as unknown[]) {
      if (!record(entry) || !record(entry.file)) return false
      const file = entry.file, before = entry.oldContent, after = entry.newContent
      if (typeof file.path !== 'string' || !file.path || file.path.includes('\0') || paths.has(file.path)
        || !['add', 'modify', 'delete'].includes(String(file.changeType))
        || !(before === null || typeof before === 'string') || !(after === null || typeof after === 'string')
        || (file.changeType === 'add' ? before !== null || after === null : file.changeType === 'delete' ? before === null || after !== null : before === null || after === null)
        || (before === null ? null : sha(before)) !== file.oldSha256 || (after === null ? null : sha(after)) !== file.newSha256
        || Buffer.byteLength(after ?? '', 'utf8') !== file.newBytes) return false
      paths.add(file.path)
      files.push({ path: file.path, changeType: file.changeType as DevelopmentSnapshotFile['changeType'], oldSha256: file.oldSha256 as string | null,
        newSha256: file.newSha256 as string | null, newBytes: Number(file.newBytes) })
    }
    const hash = createHash('sha256')
    for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) hash.update(`${file.path}\0${file.changeType}\0${file.oldSha256 ?? ''}\0${file.newSha256 ?? ''}\n`)
    return hash.digest('hex') === artifactHash
  } catch { return false }
}

/** 只识别开头明确限定的带引文单行新增；追加其他编辑指令的反馈仍走原评审。 */
export function parseOwnerExactTextInsertion(feedback: string): { line: string; placement?: string } | null {
  const request = feedback.trim().match(/^(?:(?:这份|刚交付的|已交付的)[^。！？；，\r\n「」“”]{0,32}?请|请?)(?:只|仅需|仅)(?:在([^。！？；，\r\n「」“”]{1,40}?)(?:下方|下面|之后|后))?(?:新增|添加|插入|增加)一行[：: \t]*(?:「([^」\r\n]{1,240})」|“([^”\r\n]{1,240})”)(.*)$/s)
  const line = request?.[2] ?? request?.[3]
  if (!line?.trim() || !request) return null
  const trailing = request[4]!.split(/[。！？；，\r\n]+/).map(part => part.trim()).filter(Boolean)
  if (trailing.some(part => !/^(?:原[有文]|只做|仍按|不要外发|别外发)|(?:全部保留|保持不变|原样保留)$/.test(part))
    || trailing.some(part => /(?:还要|另外|并且|同时)?(?:改成|替换|删除|重写|重排|再新增|同时修改)/.test(part))) return null
  return { line, ...(request[1] ? { placement: request[1] } : {}) }
}

export function matchesOwnerExactTextInsertion(original: string, revised: string, line: string, placement?: string): boolean {
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const before = original.split(newline)
  const after = revised.split(newline)
  if (after.length !== before.length + 1) return false
  let cursor = 0
  while (cursor < before.length && before[cursor] === after[cursor]) cursor++
  if (after[cursor] !== line || !before.slice(cursor).every((originalLine, index) => originalLine === after[cursor + index + 1])) return false
  // 可唯一定位的 Markdown 标题按标题区间核对；语义位置由独立评审核对。
  const heading = placement?.replace(/标题$/, '').replace(/^[《【]|[》】]$/g, '').trim()
  if (!heading) return true
  let fence: string | undefined
  let insertionInsideFence = false
  const headings = before.flatMap((value, index) => {
    if (index === cursor && fence) insertionInsideFence = true
    const marker = value.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
      return []
    }
    if (marker) { fence = marker[1]; return [] }
    const match = value.match(/^ {0,3}(#{1,6}) +(.+)$/)
    return match ? [{ index, level: match[1]!.length, title: match[2]!.replace(/[ \t]+#+[ \t]*$/, '').trim() }] : []
  })
  const anchors = headings.filter(item => item.title === heading)
  if (anchors.length !== 1) return true
  const anchor = anchors[0]!
  const nextHeading = headings.find(item => item.index > anchor.index && item.level <= anchor.level)
  return !insertionInsideFence && !(cursor === before.length && fence) && cursor > anchor.index && cursor <= (nextHeading?.index ?? before.length)
}

export const OWNER_TEXT_INSERTION_RESPONSE_INSTRUCTION = '本次只输出 JSON {"insertAfter":"从已验收原文逐字复制、仅出现一次的完整非空行"}，用这行指明新增位置。系统将在锚点后插入用户指定行并保留原文。不要输出重写后的文档。'

/** 员工只负责定位原文锚点，系统执行用户已经限定的单行插入。 */
export function applyOwnerTextInsertionProposal(
  response: string, rule: { original: string; line: string; placement?: string },
): { content: string; insertAfter: string } | null {
  const raw = response.trim()
  const body = raw.replace(/\r?\n[ \t]*\r?\n(?:🟢[ \t]*)?(?:锚点说明|需求已达成|已按冻结任务要求仅输出锚点 JSON)[：:][^{}\r\n]{1,600}$/, '')
  const json = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(body)?.[1] ?? body
  const proposal = json.match(/^\s*\{\s*"insertAfter"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}\s*$/s)
  if (!proposal) return null
  let insertAfter: unknown
  try { insertAfter = JSON.parse(proposal[1]!) } catch { return null }
  if (typeof insertAfter !== 'string' || !insertAfter.trim() || insertAfter.length > rule.original.length) return null
  const newline = rule.original.includes('\r\n') ? '\r\n' : '\n'
  const rows = rule.original.split(newline)
  const anchors = rows.flatMap((row, index) => row === insertAfter ? [index] : [])
  if (anchors.length !== 1) return null
  rows.splice(anchors[0]! + 1, 0, rule.line)
  const content = rows.join(newline)
  if (!matchesOwnerExactTextInsertion(rule.original, content, rule.line, rule.placement)) return null
  return { content, insertAfter }
}
