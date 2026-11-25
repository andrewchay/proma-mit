import type { ProjectOwnerGoalBrief } from '@gravitas/shared'
import { readOwnerFinalMarkdown, type OwnerDocumentEvidenceItem } from './project-owner-budget-deliverable'

const clockText = '[0-2]?[0-9]:[0-5][0-9]'
const namedPerson = '[「“]([^」”\n]{1,30})[」”]'
const lateArrival = new RegExp(`已报名者\\s*${namedPerson}\\s*(${clockText})\\s*到场`, 'g')
const soleAbsence = new RegExp(`截至\\s*(${clockText})[^。\\n]{0,80}?(?:缺席|未到场)\\s*1\\s*人\\s*[（(]\\s*${namedPerson}\\s*未到场[）)]`)
const timedLine = new RegExp(`^\\s*(?:\\d+[.、)]\\s*)?(?:[-*]\\s*)?(${clockText})\\s*[：:](.*)$`)
const contactWithDuration = /联系\s*(候补\s*\d+)(?:\s*号)?[^。]{0,60}?用时\s*(\d+)\s*分钟[^。]{0,60}?确认入场/
const fullRoster = /(?:(?:名单|人数|席位)已满|确认人数\s*(\d+)\s*\/\s*\1(?=\D|$))[^。；（(]*[（(]([^）)]+)[）)]/
const candidateTerm = /^(候补\s*\d+)\s*(?:号)?\s*(?:[×x*]?\s*1\s*人)?$/
const reservationStarted = /开始确认(?:计时|流程)[^\n]*?席位(?:暂计为|仍为|计为)候补预留/
const reservationTable = /^\|\s*(?:时点|时间)\s*\|\s*已确认\s*\|\s*候补预留\s*\|[^\n]*\n\|[^\n]*\n((?:\|[^\n]*\n?)*)/m

function timeInMinutes(value: string): number {
  const hour = Number(value.slice(0, -3))
  return hour < 24 ? hour * 60 + Number(value.slice(-2)) : NaN
}

function requiresRosterScenario(goal: ProjectOwnerGoalBrief): boolean {
  const requirements = [goal.objective, ...goal.constraints, ...goal.acceptanceCriteria].join('\n')
  return /迟到/.test(requirements) && /候补|递补/.test(requirements) && /示例|例子|情境|案例|走查/.test(requirements)
}

/** 只在同一示例明确给出冲突事实时阻拦，不从不完整的叙述推断缺席或确认状态。 */
function findRosterScenarioConflict(markdown: string): string | null {
  const content = markdown.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, '')
  const examples = content.split(/^#{1,6}\s+/m).filter(section => /(?:示例|情境|案例|走查)/.test(section.split('\n', 1)[0]!))
  for (const example of examples) {
    const rows = reservationTable.exec(example)?.[1]?.split('\n') ?? []
    const zeroReservations = new Set(rows.flatMap(row => {
      const [, time, , reserved, description] = row.split('|').map(cell => cell.trim())
      return time && reserved === '0' && description && /开始联系|开始确认/.test(description)
        && !/(?:之前|联系前|确认前|未接通|等待接通)/.test(description) ? [time] : []
    }))
    const confirmations = new Map<string, { start: string; duration: number }>()
    for (const line of example.split('\n')) {
      const timed = timedLine.exec(line)
      if (!timed) continue
      const [, time, event] = timed
      if (zeroReservations.has(time!) && reservationStarted.test(event!)) {
        return `同一个候补示例里，正文在 ${time} 开始确认时已预留席位，但人数表在同一动作后写候补预留 0 席。请把联系前和开始确认后的状态分开，或将同一时点的预留数写一致。`
      }
      const contact = contactWithDuration.exec(event!)
      if (contact) confirmations.set(contact[1]!.replace(/\s/g, ''), { start: time!, duration: Number(contact[2]) })
      const terms = fullRoster.exec(event!)?.[2]?.split(/[+＋]/)
      if (contact || !terms || terms.length < 2) continue
      for (const term of terms) {
        const candidate = candidateTerm.exec(term.trim())?.[1]
        if (!candidate) continue
        const confirmation = confirmations.get(candidate.replace(/\s/g, ''))
        if (!confirmation) continue
        const start = timeInMinutes(confirmation.start)
        const at = timeInMinutes(time!)
        if (at >= start && at < start + confirmation.duration) {
          return `同一个候补示例里，${candidate} 从 ${confirmation.start} 开始确认且用时 ${confirmation.duration} 分钟，但 ${time} 已被计入满员名单。请按确认完成时点更新人数，并明确确认期间的席位预留状态。`
        }
      }
    }
    const absence = soleAbsence.exec(example)
    if (!absence) continue
    const [, cutoff, absentPerson] = absence
    for (const [, latePerson, arrival] of example.matchAll(lateArrival)) {
      if (latePerson !== absentPerson && timeInMinutes(arrival!) > timeInMinutes(cutoff!)) {
        return `同一个候补示例里，${cutoff} 的唯一缺席者是「${absentPerson}」，但另一位已报名者「${latePerson}」到 ${arrival} 才到场。请统一签到人数、释放的席位及迟到与候补人员的身份，再按实际时点复算最终名单。`
      }
    }
  }
  return null
}

export function findOwnerRosterScenarioConflict(goal: ProjectOwnerGoalBrief, markdown: string): string | null {
  return requiresRosterScenario(goal) ? findRosterScenarioConflict(markdown) : null
}

export function findOwnerDeliveredRosterConflict(goal: ProjectOwnerGoalBrief, items: readonly OwnerDocumentEvidenceItem[], requireOriginal = true): string | null {
  if (!requiresRosterScenario(goal)) return null
  const { missingRequired, ambiguous, documents } = readOwnerFinalMarkdown(goal, items)
  if (ambiguous) return '示例所在 Markdown 有多个互不承接的版本，请先合并并核验最终原件。'
  if (missingRequired && requireOriginal) return '原目标需要交付的 Markdown 原件尚未核验，无法核对迟到与候补示例。'
  for (const document of documents) {
    const issue = findRosterScenarioConflict(document)
    if (issue) return issue
  }
  return null
}
