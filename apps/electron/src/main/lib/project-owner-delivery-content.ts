import type { ProjectOwnerGoalBrief } from '@gravitas/shared'
import { createHash } from 'node:crypto'
import type { DevelopmentSnapshotFile } from '@gravitas/shared'

/** 仅识别步骤冻结标准中，针对交付全文的明确字数上限。 */
export function ownerTextDeliveryCharacterLimit(criteria: readonly string[]): number | null {
  const limits = criteria.flatMap(criterion => criterion.normalize('NFKC').split(/[。!?;,\n]+/).flatMap(clause => {
    const standalone = /^\s*(?:控制在|限制在)?\s*(\d+)\s*(?:字|个?字符)\s*(?:内|以内|之内)\s*$/.exec(clause)
    const inside = /(?:全文|完整正文)\s*(?:控制在|限制在)?\s*(\d+)\s*(?:字|个?字符)\s*(?:内|以内|之内)/.exec(clause)
    const atMost = /(?:^\s*|全文|完整正文)\s*(?:不超过|至多|最多)\s*(\d+)\s*(?:字|个?字符)(?!\d)/.exec(clause)
    const limit = Number(standalone?.[1] ?? inside?.[1] ?? atMost?.[1])
    return Number.isSafeInteger(limit) && limit > 0 ? [limit] : []
  }))
  return limits.length ? Math.min(...limits) : null
}

export const OWNER_TEXT_HANDOFF_HEADER = 'Owner文本上游成果交接 v2。'
export const OWNER_SINGLE_TEXT_RESPONSE_INSTRUCTION = '交付时返回 JSON 对象 {"body":"给读者的完整正文","selfCheck":null}。如需留下内部自检，把它写在 selfCheck 字段。body 只给读者使用，不包含自检、进度状态、字数说明或交付摘要。正文计数由系统完成。'

export const OWNER_NOTICE_BODY_ONLY_INSTRUCTION = '原目标只交付通知正文；内部核对只留在 selfCheck 或独立评审回执，不能放进通知正文。'

export function ownerRequiresNoticeBodyOnly(goal: Pick<ProjectOwnerGoalBrief, 'objective' | 'constraints' | 'acceptanceCriteria'>): boolean {
  const sources = [goal.objective, ...goal.constraints, ...goal.acceptanceCriteria]
  return sources.some(source => /(?:只|仅)(?:需)?(?:交付|提交|输出)\s*(?:一份)?\s*通知正文(?=$|[。！？；，,\n])/.test(source))
    && !sources.some(source => /(?:附上|附带|另附|随正文|随通知|正文(?:中|后)(?:包含|提供|附)|(?:通知|正文)(?:末尾|结尾))[^。！？；，,\n]{0,16}(?:核对|核查|自检|评审)/.test(source))
}

function readOwnerNoticeBody(body: string): string {
  // 只剥离由分隔线引出的内部核对尾注；原始回包仍可追溯。
  const heading = /\r?\n[ \t]*\r?\n[ \t]*(?:——+|---+)[ \t]*\r?\n[ \t]*(?:核对说明|核对记录|核对结果|自检记录)[ \t]*[（(](?:独立核对|内部核对|自检)[^）)\r\n]*[）)][ \t]*[:：][ \t]*\r?\n/
  const match = heading.exec(body)
  if (!match) return body
  const notes = body.slice(match.index + match[0].length).trimEnd().split(/\r?\n/)
  const isReviewNote = /^[ \t]*(?:\d+[.、][ \t]+\S|核对结论[：:][ \t]*\S)/
  const notice = body.slice(0, match.index)
  return notice.trim() && notes.every(line => isReviewNote.test(line)) ? notice : body
}

/** 原回包留在执行会话和 messageId；评审及交付绑定独立正文。 */
export function readOwnerSingleTextBody(raw: string, noticeBodyOnly = false): string {
  const bodyForDelivery = noticeBodyOnly ? readOwnerNoticeBody : (body: string) => body
  const response = raw.trim()
  const json = /^```(?:json)?[ \t]*\r?\n([\s\S]+)\r?\n```$/i.exec(response)?.[1] ?? response
  try {
    const value: unknown = JSON.parse(json)
    if (value && typeof value === 'object' && !Array.isArray(value) && 'body' in value
      && typeof value.body === 'string' && value.body.trim()
      && Object.keys(value).every(key => key === 'body' || key === 'selfCheck')
      && (!('selfCheck' in value) || value.selfCheck === null || typeof value.selfCheck === 'string')) return bodyForDelivery(value.body)
  } catch { /* 旧员工或模型可能仍直接输出正文。 */ }

  // 只拆分独立末段，以及正文末尾明确的机器计数标签。
  const sections = raw.trimEnd().split(/(\r?\n[ \t]*\r?\n+)/)
  const selfCheck = /^[ \t]*(?:(?:[🟢🟡🔴]\s*)?返工完成\s*[:：][^\r\n]*\d+\s*字[^\r\n]*|(?:自核|自检|字数核对)\s*[:：][^\r\n]*(?:共|全文|含说明)\s*\d+\s*字[^\r\n]*|[（(]字数\s*[:：]\s*\d+\s*字[^）)\r\n]*[）)][ \t]*)$/u
  while (sections.length > 2 && selfCheck.test(sections.at(-1)!)) sections.splice(-2)
  return bodyForDelivery(sections.join('').replace(/[（(]全文(?:含标点)?共\s*\d+\s*字[）)]$/, ''))
}

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

/** 只有用户逐字引用插入位置和新增行时，才使用本地修订。 */
export function parseOwnerLocalTextInsertion(feedback: string): { insertAfter: string; line: string } | null {
  const text = feedback.trim().replace(/^这个成果版本需要修改。\s+/, '')
  const match = /^(?:请)?(?:只|仅)在(?:「([^」\r\n]{1,240})」|“([^”\r\n]{1,240})”)(?:之后|后|下方|下面)(?:新增|添加|插入|增加)一行[：: \t]*(?:「([^」\r\n]{1,240})」|“([^”\r\n]{1,240})”)(?:[。！]?(?:\s*(?:原有内容全部保留|其余内容保持不变)[。！]?)?)$/.exec(text)
  const insertAfter = match?.[1] ?? match?.[2]
  const line = match?.[3] ?? match?.[4]
  return insertAfter?.trim() && line?.trim() ? { insertAfter, line } : null
}

/** 只处理唯一的原文行；保留换行风格与结尾换行，保护代码围栏。 */
export function applyOwnerLocalTextInsertion(original: string, rule: { insertAfter: string; line: string }): string | null {
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const rows = original.split(newline)
  if (/^(?: {4}|\t)|^\s*(?:[=-]+|(?:\*\s*){3,})$/.test(rule.line)
    || rows.some(row => /[\r\n]/.test(row)) || rows.includes(rule.line)
    || /^\s*(?:[#>|<`~]|[-+*]\s|\d+[.)]\s)/.test(rule.line)) return null
  const index = rows.indexOf(rule.insertAfter)
  if (index < 0 || rows.lastIndexOf(rule.insertAfter) !== index
    || /^\s*(?:[>|<`~]|[-+*]\s|\d+[.)]\s)/.test(rows[index]!)
    || /^\s*(?:[=-]+\s*$|\|)/.test(rows[index + 1] ?? '')) return null
  let fence: string | undefined
  for (const row of rows.slice(0, index + 1)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(row)
    if (!marker) continue
    if (!fence) fence = marker[1]
    else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined
  }
  if (fence) return null
  return applyOwnerTextInsertionProposal(JSON.stringify({ insertAfter: rule.insertAfter }), { original, line: rule.line })?.content ?? null
}

type OwnerLocalTextEdit =
  | { kind: 'insert'; insertAfter: string; line: string }
  | { kind: 'replace'; before: string; after: string }
  | { kind: 'move'; line: string; insertAfter: string }
  | { kind: 'move_total' }

/** 本地修订只识别一条明确、可重放的修改指令。 */
export function parseOwnerLocalTextEdit(feedback: string): OwnerLocalTextEdit | null {
  const insertion = parseOwnerLocalTextInsertion(feedback)
  if (insertion) return { kind: 'insert', ...insertion }
  const text = feedback.trim().replace(/^这个成果版本需要修改。\s+/, '')
  const replacement = /^(?:请)?(?:只|仅)把(?:「([^」\r\n]{1,240})」|“([^”\r\n]{1,240})”)(?:替换为|改为|改成)(?:「([^」\r\n]{1,240})」|“([^”\r\n]{1,240})”)(?:[，,。]\s*)?(?:(?:其他|其余)内容保持不变[。！]?)?$/.exec(text)
  if (replacement) {
    const before = replacement[1] ?? replacement[2]!
    const after = replacement[3] ?? replacement[4]!
    return before.trim() && after.trim() && before !== after ? { kind: 'replace', before, after } : null
  }
  const movement = /^(?:请)?(?:只|仅)(?:把|将)(?:「([^」\r\n]{1,240})」|“([^”\r\n]{1,240})”)一行(?:移动|移)到(?:「([^」\r\n]{1,240})」|“([^”\r\n]{1,240})”)(?:之后|后|下方)(?:[，,。]\s*)?(?:(?:其他|其余)内容保持不变[。！]?)?$/.exec(text)
  if (movement) return { kind: 'move', line: movement[1] ?? movement[2]!, insertAfter: movement[3] ?? movement[4]! }
  return /^(?:请)?(?:只|仅)(?:把|将)合计行(?:移动|移)到(?:主)?标题(?:之后|后|下方|下面)(?:[，,。]\s*)?(?:(?:其他|其余)内容保持不变[。！]?)?$/.test(text)
    ? { kind: 'move_total' } : null
}

export function applyOwnerLocalTextEdit(original: string, edit: OwnerLocalTextEdit): string | null {
  if (edit.kind === 'insert') return applyOwnerLocalTextInsertion(original, edit)
  // 复杂 Markdown 结构的文本保留原评审路径。
  if (/^ {0,3}(?:`{3,}|~{3,}|<)/m.test(original) || /<!--|-->/.test(original)) return null
  if (edit.kind === 'replace') {
    const { before, after } = edit
    const index = original.indexOf(before)
    if (index < 0 || index !== original.lastIndexOf(before) || /[<>|*_`~#\[\]\\]/.test(before + after)) return null
    const lineStart = original.lastIndexOf('\n', index - 1) + 1
    const end = original.indexOf('\n', index)
    const line = original.slice(lineStart, end < 0 ? undefined : end)
    const revisedLine = line.slice(0, index - lineStart) + after + line.slice(index - lineStart + before.length)
    const markup = /^(?: {4}|\t)|^\s*(?:[<>|#]|[-+*]\s|\d+[.)]\s)|^\s*[=-]+\s*$/
    const nextEnd = end < 0 ? -1 : original.indexOf('\n', end + 1)
    const nextLine = end < 0 ? '' : original.slice(end + 1, nextEnd < 0 ? undefined : nextEnd)
    if (markup.test(line) || markup.test(revisedLine) || /^\s*[=-]+\s*$/.test(nextLine)
      || line.includes('|') || revisedLine.includes('|')) return null
    return original.slice(0, index) + after + original.slice(index + before.length)
  }
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const rows = original.split(newline)
  if (rows.some(row => /[\r\n]/.test(row))) return null
  const totalRows = edit.kind === 'move_total' ? rows.filter(row => /^ {0,3}(?:\*\*)?(?:预算)?合计(?:\*\*)?[：:]\s*\S/.test(row)) : []
  const line = edit.kind === 'move' ? edit.line : totalRows.length === 1 ? totalRows[0] : undefined
  const title = edit.kind === 'move' ? edit.insertAfter : rows.find(row => row.trim())
  if (!line || !title || line === title || !/^ {0,3}#{1,6} +\S/.test(title)
    || /^(?: {4}|\t)|^\s*(?:[#>|<`~]|[-+*]\s|\d+[.)]\s)|^\s*[=-]+\s*$/.test(line)) return null
  const from = rows.indexOf(line), anchor = rows.indexOf(title)
  if (from < 1 || anchor < 0 || rows.lastIndexOf(line) !== from || rows.lastIndexOf(title) !== anchor
    || rows[from - 1] !== '' || rows[from + 1] !== '' || rows[anchor + 1] !== ''
    || from === anchor + 2 || from + 1 === rows.length - 1) return null
  // 独立段落连同其后的空行移动，保留原有换行分隔。
  rows.splice(from, 2)
  rows.splice(rows.indexOf(title) + 2, 0, line, '')
  return rows.join(newline)
}

/** 原目标明确封闭工作清单时，不把独立签字确认当作通用模板字段。 */
export function findOwnerClosedWorklistConflict(goal: ProjectOwnerGoalBrief, content: string): string | null {
  const source = [goal.objective, ...goal.constraints, ...goal.acceptanceCriteria].join('\n')
  if (!/(?:只有|仅有|只做|只包含|仅包含)[一二三四五六七八九十0-9]+项(?:工作|任务|事项)/.test(source)) return null
  const signatureAllowed = /(?:签字|签名|签署)/.test(source) && !/(?:禁止|不得|不要|不需|无需|不要求)[^。；，,\n]{0,12}(?:签字|签名|签署)/.test(source)
  const signoffSectionAllowed = /(?:提供|增加|保留|设置|填写)[^。；，,\n]{0,6}签收栏/.test(source)
    && !/(?:禁止|不得|不要|不需|无需|不要求)[^。；，,\n]{0,12}签收栏/.test(source)
  const signature = /^(?:[ \t]*[-*#]+[ \t]*)?(?:\*\*)?(?:[\p{L}]{0,12})?(?:签字|签名|签署)(?:确认)?(?:\*\*)?[ \t]*[：:]?[ \t]*(?:[_＿]{2,})?(?:[ \t　]*(?:签字)?(?:日期|时间)[：:][ \t]*[_＿]{2,})?[ \t]*$/mu
  const signatureSection = /^ {0,3}#{1,6}[ \t]+(?:签收|签字|签名|签署)(?:栏|确认)[ \t]*$/m
  return (!signatureAllowed && signature.test(content)) || (!signatureAllowed && !signoffSectionAllowed && signatureSection.test(content))
    ? '封闭的工作清单之外新增了单独的签字确认。请去掉这个额外动作，并保留用户列出的原有工作。'
    : null
}
