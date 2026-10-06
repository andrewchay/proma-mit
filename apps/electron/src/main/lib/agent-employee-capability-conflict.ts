/**
 * 员工组合能力校验：在激活前发现治理越权与矛盾约束。
 *
 * 判定基于确定性规则与文本规范化，不做语义推断，也不声称两条规则在语义上等价。
 * 结果分两类：
 * - blocking：越权或直接矛盾，必须在激活前修正。
 * - advisory：重复或冗余，只提示，不阻断。
 */

export interface CapabilityConflictFinding {
  severity: 'blocking' | 'advisory'
  code: 'governance_override' | 'contradictory_constraint' | 'duplicate_rule'
  message: string
  /** 命中规则的原文片段，便于人工核对。 */
  evidence: string
}

export interface CapabilityCombinationInput {
  /** 同一员工 role 级能力内容（可为空）。 */
  roleContent?: string
  /** 同一员工工作区级能力内容（可为空）。 */
  workspaceContent?: string
}

/** 治理类能力不得由候选定义或放宽，出现即阻断。 */
const GOVERNANCE_PATTERNS: Array<{ code: 'governance_override'; pattern: RegExp; message: string }> = [
  { code: 'governance_override', pattern: /(绕过|跳过|忽略|关闭|禁用)[^。\n]{0,12}(审批|权限|确认|沙箱)/, message: '候选试图绕过审批或权限边界' },
  { code: 'governance_override', pattern: /(自动|无需确认|不经确认)[^。\n]{0,10}(提交|推送|合并|发布|删除|部署)/, message: '候选试图自动执行提交/推送/合并/发布/删除' },
  { code: 'governance_override', pattern: /(提高|扩大|解除|取消)[^。\n]{0,10}(预算|额度|上限|配额)/, message: '候选试图修改预算或额度上限' },
  { code: 'governance_override', pattern: /(访问|读取|跨出|越过)[^。\n]{0,12}(其他工作区|其他项目|工作区外|项目外)/, message: '候选试图扩大工作区或项目访问范围' },
  { code: 'governance_override', pattern: /(密钥|api[_\s-]?key|token|凭据|密码)[^。\n]{0,10}(读取|输出|打印|记录|上传)/, message: '候选涉及读取或输出凭据' },
]

interface ConstraintPair {
  id: string
  /** 正向要求（要求执行某动作） */
  positive: RegExp
  /** 反向要求（禁止执行某动作） */
  negative: RegExp
  message: string
}

/** 同一组能力里正反指令同时出现即视为矛盾。 */
const CONTRADICTION_PAIRS: ConstraintPair[] = [
  { id: 'commit', positive: /(必须|应当|需要|主动)[^。\n]{0,8}(提交代码|执行提交|git commit)/, negative: /(禁止|不得|不要|不允许)[^。\n]{0,8}(提交|commit)/, message: '提交行为同时被要求与禁止' },
  { id: 'push', positive: /(必须|应当|需要|主动)[^。\n]{0,8}(推送|push)/, negative: /(禁止|不得|不要|不允许)[^。\n]{0,8}(推送|push)/, message: '推送行为同时被要求与禁止' },
  { id: 'publish', positive: /(必须|应当|需要|主动)[^。\n]{0,8}(发布|上线)/, negative: /(禁止|不得|不要|不允许)[^。\n]{0,8}(发布|上线)/, message: '发布行为同时被要求与禁止' },
  { id: 'delete', positive: /(必须|应当|需要|主动)[^。\n]{0,8}(删除)[^。\n]{0,8}(文件|数据|记录|分支)/, negative: /(禁止|不得|不要|不允许)[^。\n]{0,8}删除/, message: '删除行为同时被要求与禁止' },
  { id: 'approval', positive: /(必须|应当|需要)[^。\n]{0,8}(人工|用户)[^。\n]{0,6}(确认|审批)/, negative: /(无需|不必|不需要|跳过)[^。\n]{0,8}(确认|审批)/, message: '人工确认同时被要求与免除' },
]

/** 规范化：统一空白，便于重复行比较；不做语义改写。 */
function normalizeLine(line: string): string {
  return line.replace(/^[\s>*\-+\d.、)）]+/, '').replace(/\s+/g, ' ').trim()
}

function toLines(content: string | undefined): string[] {
  if (!content) return []
  return content.split('\n').map(normalizeLine).filter((line) => line.length >= 4)
}

/**
 * 校验一组组合能力。
 * roleContent 与 workspaceContent 会合并检查，因为它们会同时作用于同一员工的执行。
 */
export function detectCapabilityConflicts(input: CapabilityCombinationInput): CapabilityConflictFinding[] {
  const findings: CapabilityConflictFinding[] = []
  const texts = [input.roleContent ?? '', input.workspaceContent ?? ''].filter(Boolean)
  if (texts.length === 0) return findings
  const combined = texts.join('\n')

  for (const rule of GOVERNANCE_PATTERNS) {
    const match = rule.pattern.exec(combined)
    if (match) findings.push({ severity: 'blocking', code: rule.code, message: rule.message, evidence: match[0] })
  }

  const lines = [...toLines(input.roleContent), ...toLines(input.workspaceContent)]
  for (const pair of CONTRADICTION_PAIRS) {
    const flagged = (pattern: RegExp, line: string): boolean => new RegExp(pattern.source).test(line)
    const positive = lines.find((line) => flagged(pair.positive, line))
    const negative = lines.find((line) => flagged(pair.negative, line))
    if (positive && negative) {
      findings.push({ severity: 'blocking', code: 'contradictory_constraint', message: pair.message, evidence: `${positive} ／ ${negative}` })
    }
  }

  const seen = new Map<string, number>()
  for (const line of lines) {
    const key = line.toLowerCase()
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  for (const [key, count] of seen) {
    if (count > 1) findings.push({ severity: 'advisory', code: 'duplicate_rule', message: `同一规则出现 ${count} 次`, evidence: key })
  }

  return findings
}

export function hasBlockingConflict(findings: CapabilityConflictFinding[]): boolean {
  return findings.some((item) => item.severity === 'blocking')
}

export function formatConflictMessage(findings: CapabilityConflictFinding[]): string {
  return findings.map((item) => `[${item.severity}] ${item.message}：${item.evidence}`).join('\n')
}
