import type { ProjectOwnerGoalBrief, ProjectOwnerPlanProposal } from '@gravitas/shared'

const ITEMIZED_BUDGET = /(?:逐项预算|分项预算|预算明细|itemized budget)/i
const BUDGET_TOTAL = /(?:合计|总计|总额|\btotal\b)/i
const MAX_BUDGET = /(?:总?预算(?:上限)?(?:为|是)?\s*(?:不超过|不得超过|最多|≤|为)?)[ \t]*([\d,]+(?:\.\d{1,2})?)\s*(?:元|人民币)/
const MARKDOWN_PATH = '(?:[a-z0-9_.-]+/)*[a-z0-9_.-]+\\.md\\b'
const QUOTED_MARKDOWN_PATH = '[`“「"]?' + MARKDOWN_PATH + '[`”」"]?'
const DOCUMENT_OUTPUTS = new RegExp(
  '(?:交付|输出|生成|保存(?:为|到)?|写入|\\bdeliver\\b|\\bsave (?:as|to)\\b)\\s*(' + QUOTED_MARKDOWN_PATH
  + '(?:\\s*(?:和|及|与|、|，|,|\\band\\b)\\s*' + QUOTED_MARKDOWN_PATH + ')*)', 'gi',
)

function amountInCents(value: string): number | undefined {
  const normalized = value.trim().replace(/\*\*/g, '').replace(/^[¥￥]\s*/, '').replace(/\s*元$/, '')
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(normalized)) return undefined
  const cents = Math.round(Number(normalized.replaceAll(',', '')) * 100)
  return Number.isSafeInteger(cents) ? cents : undefined
}

/** 只复算已给齐人数、逐条单价和上限的预算，跳过含估算或额外约束的目标。 */
export function readOwnerFixedBudget(goal: ProjectOwnerGoalBrief): { total: number; balance: number } | null {
  const objective = goal.objective
  const count = /^(?:为|按|共)?([1-9]\d?|[一二两三四五六七八九十])\s*人[^。；\n]{0,40}预算/.exec(objective)?.[1]
  const words: Readonly<Record<string, number>> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const people = count ? (words[count] ?? Number(count)) : 0
  if (!people || !/(?:计算|核算|写清|列出|对照)[^。\n]{0,38}(?:余额|剩余预算)/.test(objective)
    || /估算|待定|约为|折扣|税费|另加|额外|可选/.test(objective)
    || [...goal.constraints, ...goal.acceptanceCriteria].some(text => /元|人数|\d\s*人|费用|折扣|税费/.test(text))) return null
  const cap = /(?:对照\s*)?([\d,]+(?:\.\d{1,2})?)\s*元\s*(?:预算)?上限/.exec(objective)?.[1] ?? MAX_BUDGET.exec(objective)?.[1]
  const maximum = cap === undefined ? undefined : amountInCents(cap)
  if (maximum === undefined) return null
  const item = /^([^\d，,。：:]+?)\s*([\d,]+(?:\.\d{1,2})?)\s*元(\s*[/／]\s*人)?$/
  const rows = objective.split(/[。；;\n]/).map(line => line.split(/[，,、]/).map(part => item.exec(part.trim())))
    .filter(line => line.length >= 2 && line.every(row => row !== null))
  if (rows.length !== 1) return null
  const entries = rows[0]!
  if (entries.length + 1 !== (objective.match(/\d(?:[\d,.]*\d)?\s*元/g)?.length ?? 0)) return null
  const names = new Set<string>()
  let total = 0
  for (const row of entries) {
    const label = row![1]!.trim()
    const perPerson = Boolean(row![3]) || /^(?:每人|人均)|(?:每人|人均)$/.test(label)
    const name = label.replace(/^(?:每人|人均)|(?:每人|人均)$/g, '').trim()
    const amount = amountInCents(row![2]!)
    if (!name || /每|人均|按[次餐天批套]|\/|／|或|起步/.test(name) || names.has(name) || amount === undefined) return null
    names.add(name)
    total += amount * (perPerson ? people : 1)
  }
  return Number.isSafeInteger(total) && total <= maximum ? { total, balance: maximum - total } : null
}

/** 派工前只修正规划模型写入的合计和余额，用户原文和逐项标准原样保留。 */
export function applyOwnerFixedBudgetCriteria(plan: ProjectOwnerPlanProposal, budget: { total: number; balance: number }): ProjectOwnerPlanProposal {
  const correct = (text: string) => text.replace(
    /(^|[，,、。；;：:\n（(]|(?:及|并|与)\s*)(\s*(?:实际|全部项目|项目|最终)?)(总计|总支出|合计|余额|剩余预算)(\s*(?:为|是|应为|[:：=＝])?\s*)[\d,]+(?:\.\d{1,2})?\s*元/g,
    (_match, boundary: string, qualifier: string, label: string, separator: string) => `${boundary}${qualifier}${label}${separator}${(/余额|剩余/.test(label) ? budget.balance : budget.total) / 100}元`,
  )
  return { ...plan, summary: correct(plan.summary), steps: plan.steps.map(step => ({
    ...step, outcome: correct(step.outcome), acceptanceCriteria: [...new Set(step.acceptanceCriteria.map(correct))],
  })) }
}

export function ownerGoalRequiresItemizedBudget(goal: ProjectOwnerGoalBrief): boolean {
  const goalText = [goal.objective, ...goal.constraints, ...goal.acceptanceCriteria].join('\n')
  return ITEMIZED_BUDGET.test(goalText) && BUDGET_TOTAL.test(goalText)
}

function budgetTableIssue(markdown: string, maximum: number | undefined): string | null {
  const lines = markdown.split(/\r?\n/)
  const cells = (line: string) => line.trim().replace(/^\|\s*|\s*\|$/g, '').split('|').map(value => value.trim())
  for (let i = 0; i + 2 < lines.length; i++) {
    if (!lines[i]!.trimStart().startsWith('|')) continue
    const header = cells(lines[i]!)
    const subtotal = header.findIndex(cell => /^(?:小计|金额|小计金额|subtotal|amount)(?:\s*[（(].+[)）])?$/i.test(cell))
    if (subtotal < 1 || !cells(lines[i + 1]!).every(cell => /^:?-{3,}:?$/.test(cell))) continue
    const entries: number[] = []
    for (const line of lines.slice(i + 2)) {
      if (!line.trimStart().startsWith('|')) break
      const row = cells(line)
      const amount = amountInCents(row[subtotal] ?? '')
      if (amount === undefined) break
      if (row.slice(0, subtotal).some(cell => /^(?:合计|总计|总额|total)$/i.test(cell.replace(/\*\*/g, '').trim()))) {
        if (entries.length && entries.reduce((sum, entry) => sum + entry, 0) === amount) {
          return maximum !== undefined && amount > maximum ? '逐项预算的实算合计超过用户确认的预算上限。' : null
        }
        break
      }
      entries.push(amount)
    }
  }
  let budgetSection = false
  const entries: number[] = []
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading) {
      budgetSection = /预算|budget/i.test(heading[1]!)
      entries.length = 0
      continue
    }
    if (!budgetSection) continue
    const row = /^\s*(?:[-*+] |\d+[.)] )?(.+?)[：:]\s*(.+)$/.exec(line)
    if (!row) continue
    const amount = amountInCents(row[2]!)
    if (amount === undefined) {
      entries.length = 0
      continue
    }
    if (BUDGET_TOTAL.test(row[1]!)) {
      if (entries.length && entries.reduce((sum, entry) => sum + entry, 0) === amount) {
        return maximum !== undefined && amount > maximum ? '逐项预算的实算合计超过用户确认的预算上限。' : null
      }
      break
    }
    entries.push(amount)
  }
  return '原目标要求交付逐项预算和可复算的合计。需要给出各项具体金额，并以相同金额加总；待定金额和预算上限不能作为合计。'
}

/** 按原目标检查最终文本中的金额和算术，预算上限不能代替实际预算表。 */
export function findOwnerItemizedBudgetIssue(goal: ProjectOwnerGoalBrief, markdown: string): string | null {
  if (!ownerGoalRequiresItemizedBudget(goal)) return null
  const limits = [goal.objective, ...goal.constraints, ...goal.acceptanceCriteria].flatMap(text => {
    const amount = MAX_BUDGET.exec(text)?.[1]
    const parsed = amount === undefined ? undefined : amountInCents(amount)
    return parsed === undefined ? [] : [parsed]
  })
  const maximum = limits.length ? Math.min(...limits) : undefined
  return budgetTableIssue(markdown, maximum)
}

export interface OwnerDocumentEvidenceItem {
  content: string
  fileSnapshot?: true
  stepKey?: string
  dependencies?: readonly string[]
}

/** 只从已验收的文件快照读取原件；同一路径由实际依赖链上的最终写入者提供。 */
export function readOwnerFinalMarkdown(goal: ProjectOwnerGoalBrief, items: readonly OwnerDocumentEvidenceItem[]): { missingRequired: boolean; ambiguous: boolean; documents: string[] } {
  const goalText = [goal.objective, ...goal.constraints, ...goal.acceptanceCriteria].join('\n')
  const paths = new Set([...goalText.matchAll(DOCUMENT_OUTPUTS)].flatMap(match => match[1]!.match(new RegExp(MARKDOWN_PATH, 'gi')) ?? []))
  const snapshots = new Map<string, Array<{ item: OwnerDocumentEvidenceItem; content: string | null }>>()
  for (const item of items) {
    if (!item.fileSnapshot) continue
    try {
      const snapshot = JSON.parse(item.content) as { files?: Array<{ file: { path: string }; newContent: string | null }> }
      for (const entry of snapshot.files ?? []) {
        const path = entry.file.path
        if (!/\.md$/i.test(path) || paths.size && !paths.has(path)) continue
        const versions = snapshots.get(path) ?? []
        versions.push({ item, content: entry.newContent })
        snapshots.set(path, versions)
      }
    } catch { /* 非法快照无法提供原件。 */ }
  }
  const byStep = new Map(items.flatMap(item => item.stepKey ? [[item.stepKey, item] as const] : []))
  const dependsOn = (item: OwnerDocumentEvidenceItem, stepKey: string | undefined) => {
    if (!stepKey) return false
    const pending = [...(item.dependencies ?? [])]
    const seen = new Set<string>()
    while (pending.length) {
      const key = pending.pop()!
      if (key === stepKey) return true
      if (seen.has(key)) continue
      seen.add(key)
      pending.push(...(byStep.get(key)?.dependencies ?? []))
    }
    return false
  }
  const final = new Map<string, string>()
  let ambiguous = false
  for (const [path, versions] of snapshots) {
    const contents = new Set(versions.filter(version => !versions.some(other => other !== version && dependsOn(other.item, version.item.stepKey))).map(version => version.content))
    if (contents.size > 1) ambiguous = true
    const content = contents.values().next().value
    if (contents.size === 1 && typeof content === 'string' && content.trim()) final.set(path, content)
  }
  const documents = [...final.values()]
  if (!snapshots.size && !paths.size) documents.push(...items.filter(item => !item.fileSnapshot).map(item => item.content))
  return { missingRequired: [...paths].some(path => !final.has(path)), ambiguous, documents }
}

/** 只核对最终 Markdown 原件；有原件时，初稿不能替它通过验收。 */
export function findOwnerDeliveredBudgetIssue(goal: ProjectOwnerGoalBrief, items: readonly OwnerDocumentEvidenceItem[], requireOriginal = true): string | null {
  if (!ownerGoalRequiresItemizedBudget(goal)) return null
  const { missingRequired, ambiguous, documents } = readOwnerFinalMarkdown(goal, items)
  if (ambiguous) return '同一路径存在多个互不承接的 Markdown 版本，无法确认最终预算。请先合并并核验最终原件。'
  if (missingRequired && requireOriginal) return '原目标需要交付的 Markdown 原件尚未核验，无法确认逐项预算和合计。'
  if (!documents.length) return null
  const issues = documents.map(text => findOwnerItemizedBudgetIssue(goal, text))
  return issues.every(Boolean) ? issues[0]! : null
}
