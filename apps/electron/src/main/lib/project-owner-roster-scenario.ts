import type { ProjectOwnerGoalBrief, ProjectOwnerPlanProposal } from '@gravitas/shared'
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

function rosterSource(goal: ProjectOwnerGoalBrief): string {
  return [goal.objective, ...goal.constraints, ...goal.acceptanceCriteria].join('\n')
}

// “前完成才可补位”是资格截止，不只是开场名单的记录时点。
function readFormalAdmissionCutoff(goal: ProjectOwnerGoalBrief): string | undefined {
  const source = rosterSource(goal)
  if (!/候补|递补/.test(source)) return undefined
  const rule = new RegExp(`(${clockText})\\s*(?:之)?前\\s*(?:完成(?:补位)?确认|确认完成|确认完毕|完成)\\s*[，,]?\\s*(?:才(?:能|可|允许)|方(?:可|能))\\s*(?:正式)?(?:补位|递补)`, 'g')
  const cutoffs = new Map([...source.matchAll(rule)].map(match => [timeInMinutes(match[1]!), match[1]!]))
  return cutoffs.size === 1 && !cutoffs.has(NaN) ? cutoffs.values().next().value : undefined
}

function readLateCandidate(goal: ProjectOwnerGoalBrief, cutoff: string) {
  const timedCandidate = new RegExp(`候补(?:人员)?\\s*[「“"]?([\\p{L}]{1,12}?)[」”"]?\\s*(?:于|在)?\\s*(${clockText})\\s*到场[,，、\\s]*(?:候补)?确认(?:耗时|用时|需要|需)\\s*([1-9]\\d{0,2})\\s*分钟`, 'gu')
  const candidates = new Map([...rosterSource(goal).matchAll(timedCandidate)]
    .map(match => [JSON.stringify([match[1], timeInMinutes(match[2]!), Number(match[3])]), match] as const))
  if (candidates.size !== 1) return null
  const [, person, arrival, minutes] = candidates.values().next().value!
  const earliest = timeInMinutes(arrival!) + Number(minutes)
  if (!Number.isFinite(earliest) || earliest < timeInMinutes(cutoff) || earliest >= 24 * 60) return null
  const time = [Math.floor(earliest / 60), earliest % 60].map(value => String(value).padStart(2, '0')).join(':')
  return { person: person!, arrival: arrival!, minutes: Number(minutes), time }
}

export function readOwnerRosterDeadlineInstruction(goal: ProjectOwnerGoalBrief): string | null {
  const cutoff = readFormalAdmissionCutoff(goal)
  const candidate = cutoff ? readLateCandidate(goal, cutoff) : null
  return candidate ? `按原目标复算：候补「${candidate.person}」${candidate.arrival} 到场，确认需 ${candidate.minutes} 分钟，即刻开始也最早于 ${candidate.time} 完成。原规则要求在 ${cutoff} 前完成确认，因此该候补不能正式补位。请同时核对正文、示例名单、人数和核对表；登记确认结果或旁听均不改变正式名单；即使后来离席空出座位，除非原目标有明确例外，也不能为该候补另开补位窗口。` : null
}

const fixedOpening = new RegExp(`(${clockText})\\s*(?:整\\s*)?(?:准时\\s*)?(?:由主持人\\s*)?(?:宣布\\s*)?开场(?!提醒|准备|流程|时间|前|后)`, 'g')

export function readOwnerRosterOpeningInstruction(goal: ProjectOwnerGoalBrief): string | null {
  const opening = readRosterOpeningTime(goal)
  return opening ? `原目标要求 ${opening} 开场。候补确认、换桌或落座可以单独安排，但不能把开场时间改写为另一时点，也不能等候补完成后再开场。` : null
}

function readRosterOpeningTime(goal: ProjectOwnerGoalBrief): string | undefined {
  if (!readFormalAdmissionCutoff(goal)) return undefined
  const times = new Map([...rosterSource(goal).matchAll(fixedOpening)].map(match => [timeInMinutes(match[1]!), match[1]!]))
  return times.size === 1 && !times.has(NaN) ? times.values().next().value : undefined
}

function findRosterOpeningConflict(goal: ProjectOwnerGoalBrief, markdown: string): string | null {
  const opening = readRosterOpeningTime(goal)
  if (!opening) return null
  const content = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/[*_]/g, '')
  const afterOtherAction = new RegExp(`(${clockText})\\s*前[^0-9。；\\n，,]{0,60}[，,]\\s*(再|随后)?\\s*(?:主持人|由主持人)?\\s*宣布开场`, 'g')
  const expected = timeInMinutes(opening)
  const explicit = [...content.matchAll(fixedOpening)]
  const conflict = explicit.find(match => Number.isFinite(timeInMinutes(match[1]!)) && timeInMinutes(match[1]!) !== expected)
    ?? [...content.matchAll(afterOtherAction)].find(match => timeInMinutes(match[1]!) > expected
      && (match[2] || !explicit.some(candidate => timeInMinutes(candidate[1]!) === expected)))
  return conflict ? `原目标要求 ${opening} 开场。请将开场写为固定时点，换桌、落座和候补登记另列。冲突原文：${conflict[0]}` : null
}

/** 用户要求走查正式名单时，不把模型推测的人数当作预设验收值。 */
export function groundOwnerRosterPlan(goal: ProjectOwnerGoalBrief, plan: ProjectOwnerPlanProposal): ProjectOwnerPlanProposal {
  const cutoff = readFormalAdmissionCutoff(goal)
  if (!cutoff || !readLateCandidate(goal, cutoff)) return plan
  const plannedCount = new RegExp(`${cutoff}\\s*(?:时点|时|开场)?\\s*(?:的)?\\s*(?:正式)?(?:名单(?:与人数|人数)?|人数)\\s*(?:为|应为|是|共|[:：])\\s*(?:[^，,；;。\\n\\d]{1,32}?(?:共|计)\\s*)?(?:\\d+|[一二两三四五六七八九十]+)\\s*人`, 'g')
  if ([...rosterSource(goal).matchAll(plannedCount)].length > 0) return plan
  const ground = (value: string) => value.replace(plannedCount, `${cutoff} 正式名单及人数按原目标和确认截止规则复算`)
  return { ...plan, summary: ground(plan.summary), steps: plan.steps.map(step => ({
    ...step, outcome: ground(step.outcome), acceptanceCriteria: [...new Set(step.acceptanceCriteria.map(ground))],
  })) }
}

function findLateFormalAdmission(goal: ProjectOwnerGoalBrief, cutoff: string, markdown: string): string | null {
  const deadline = timeInMinutes(cutoff)
  const candidate = readLateCandidate(goal, cutoff)
  const candidateName = candidate
    ? new RegExp(`(?:^|[^\\p{L}]|候补)[「“"]?${candidate.person}[」”"]?(?=[^\\p{L}]|已|未|于|为|到|在|获|$)`, 'u')
    : null
  const content = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
  const confirmationTime = new RegExp(`(${clockText})\\s*(?:才|已|刚|方)?\\s*(?:完成(?:候补|补位)?确认|确认完成|确认完毕)|(?:确认完成|确认完毕|完成确认)(?:时间)?\\s*[:：于为]\\s*(${clockText})`, 'g')
  const formalAdmission = /正式(?:补位|递补)|(?:补入|纳入|列入)正式名单|转为正式(?:成员|人员)|(?:允许|同意|批准)\s*递补/g
  const afterDeadline = new RegExp(`(${clockText})\\s*(?:以|之)?后`, 'g')
  const deferredException = /(?:若|如果|如)[^。；;]{0,48}(?:离席|空位|缺额)[^。；;]{0,36}是否(?:正式)?(?:递补|补位)(?:[^。；;]{0,20}(?:另行|再定|按现场规则))/
  const hasSourceException = deferredException.test(rosterSource(goal))
  let lateHeadingLevel = 0
  for (const line of content.split('\n')) {
    const heading = /^\s*(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      const level = heading[1]!.length
      if (lateHeadingLevel && level <= lateHeadingLevel) lateHeadingLevel = 0
      const time = [...heading[2]!.matchAll(afterDeadline)].at(-1)?.[1]
      if (!lateHeadingLevel && time && timeInMinutes(time) >= deadline) lateHeadingLevel = level
      continue
    }
    if (candidate && !hasSourceException) {
      const exception = deferredException.exec(line)
      if (exception) {
        const beforeException = line.slice(0, exception.index)
        const inlineDeadline = [...beforeException.matchAll(afterDeadline)].at(-1)?.[1]
        if (lateHeadingLevel || (inlineDeadline && timeInMinutes(inlineDeadline) >= deadline)) {
          return `原目标规定候补必须在 ${cutoff} 前完成确认才能正式补位。请删除原目标未授权的逾期补位例外；后续离席或出现空位也不改变该候补的资格。冲突原文：${exception[0]}`
        }
      }
    }
    for (const action of line.matchAll(formalAdmission)) {
      const prefix = line.slice(0, action.index)
      const statement = prefix.split(/[。；;]/).at(-1)!
      const clause = statement.split(/[，,]/).at(-1)!
      const suffix = line.slice(action.index + action[0].length)
      if (/^(?:资格|条件|规则|记录|说明|流程|状态)/.test(suffix)) continue
      if (/(?:未(?:能|获)?|不(?:能|可|得|再|予|应|允许)?|禁止|无权|取消|放弃)\s*(?:被|予以|执行)?\s*$/.test(clause)
        || /(?:不得|不能|不允许|不具备|不满足|禁止)[^|]{0,24}$/.test(clause)) continue
      // 后半句明确换了人时，不能沿用前半句的人员或确认时点。
      const explicitSubject = /^\s*(?:但|而|则)?\s*(?:候补(?:人员)?\s*)?(?:[甲乙丙丁戊己庚辛壬癸](?=\s|于|在|仍|已|未|可|将|获|$)|[「“"][^」”"]{1,12}[」”"])/.test(clause)
      const subjectStatement = explicitSubject ? clause : statement
      const confirmed = [...subjectStatement.matchAll(confirmationTime)].at(-1)
      // 明确给出的耗时可推导最早完成时点，正文不能靠把完成时点写早绕过截止。
      const contradictsKnownTiming = candidateName?.test(subjectStatement)
        && !/(?:若|如果|假设|仅当)/.test(subjectStatement)
      const afterCutoff = confirmed ? timeInMinutes(confirmed[1] ?? confirmed[2]!) >= deadline
        : Boolean(lateHeadingLevel && /确认(?:完成|完毕)|完成(?:候补|补位)?确认/.test(subjectStatement)
          && !/(?:截止|开场|\d:\d\d)\s*(?:之)?前\s*(?:已)?(?:确认|完成)/.test(subjectStatement))
      if (!afterCutoff && !contradictsKnownTiming) continue
      return `原目标规定候补必须在 ${cutoff} 前完成确认才能正式补位。正文允许在截止时或截止后确认的候补正式补位。请删除该安排；迟确认只能按未补位处理，可另记确认或列席状态，不能加入正式名单。冲突原文：${line.trim().slice(0, 240)}`
    }
  }
  return null
}

function hasNamedArrivalScenario(source: string): boolean {
  return /报名[^。；\n]{1,48}(?:未到|缺席)/.test(source) && /候补[^。；\n]{0,30}到场/.test(source)
}

/** 只核对具名报名场景里被当作事实填写的到场时间。 */
function findUnsupportedRosterArrival(goal: ProjectOwnerGoalBrief, markdown: string): string | null {
  const source = rosterSource(goal)
  if (!hasNamedArrivalScenario(source)) return null
  const content = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
  let personIndex = -1
  let arrivalIndex = -1
  for (const line of content.split('\n')) {
    if (!line.trimStart().startsWith('|')) {
      personIndex = arrivalIndex = -1
      continue
    }
    const cells = line.trim().split('|').slice(1).map(cell => cell.replace(/[*`]/g, '').trim())
    if (cells.some(cell => /^(?:到场|签到)(?:时间|时点)$/.test(cell))) {
      personIndex = cells.findIndex(cell => /^(?:人员|姓名|参与者|人名)$/.test(cell))
      arrivalIndex = cells.findIndex(cell => /^(?:到场|签到)(?:时间|时点)$/.test(cell))
      continue
    }
    if (personIndex < 0 || arrivalIndex < 0) continue
    const person = cells[personIndex]
    const arrival = cells[arrivalIndex]
    if (!person || !arrival || !/^[\p{L}]{1,12}$/u.test(person) || /假设|示意|假定|待核|未记录|未知/.test(arrival)) continue
    const time = new RegExp(`^${clockText}`).exec(arrival)?.[0]
    if (!time) continue
    const arrivalFact = new RegExp(`(?:^|[^\\p{L}]|候补|递补|报名者|人员)[「“"]?${person}[」”"]?\\s*(?:于|在)?\\s*(${clockText})\\s*(?:已)?(?:到场|签到)`, 'gu')
    const mentioned = [...source.matchAll(arrivalFact)].some(match => timeInMinutes(match[1]!) === timeInMinutes(time))
    if (!mentioned) return `原目标未提供「${person}」在 ${time} 的到场时间。示例和核对表应保留已知的到场状态，未给出的时刻留空或写未提供。`
  }
  return null
}

export function findOwnerRosterScenarioConflict(goal: ProjectOwnerGoalBrief, markdown: string): string | null {
  const cutoff = readFormalAdmissionCutoff(goal)
  return (cutoff ? findLateFormalAdmission(goal, cutoff, markdown) : null)
    ?? findRosterOpeningConflict(goal, markdown) ?? findUnsupportedRosterArrival(goal, markdown) ?? (requiresRosterScenario(goal) ? findRosterScenarioConflict(markdown) : null)
}

export function findOwnerDeliveredRosterConflict(goal: ProjectOwnerGoalBrief, items: readonly OwnerDocumentEvidenceItem[], requireOriginal = true): string | null {
  if (!readFormalAdmissionCutoff(goal) && !requiresRosterScenario(goal) && !hasNamedArrivalScenario(rosterSource(goal))) return null
  const { missingRequired, ambiguous, documents } = readOwnerFinalMarkdown(goal, items)
  if (ambiguous) return '示例所在 Markdown 有多个互不承接的版本，请先合并并核验最终原件。'
  if (missingRequired && requireOriginal) return '原目标需要交付的 Markdown 原件尚未核验，无法核对迟到与候补示例。'
  for (const document of documents) {
    const issue = findOwnerRosterScenarioConflict(goal, document)
    if (issue) return issue
  }
  return null
}
