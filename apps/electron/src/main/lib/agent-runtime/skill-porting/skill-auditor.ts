/**
 * Skill 安全审计（启发式）。
 *
 * 逐文件检查 skill 目录里的脚本/文本，标记风险：
 * - 脚本回连 / 窃取 / 外传（curl|bash、webhook、读取 env/secrets 发到远端）
 * - 混淆 / 编码载荷（base64/hex/反混淆器、极长单行、被 minify）
 * - 覆盖安全（禁用权限、绕过审批、改系统提示/工具白名单）
 * - 破坏性命令（install/hook 里的 rm -rf、chmod 危险文件）
 * - 已知可疑域名 / 回连端点
 *
 * 结论：'safe' 无风险；'review' 有可疑，需人工放行；'blocked' 明显恶意，禁止安装。
 * 纯启发式，不替代人工审查——高风险一律进 review 让用户决定。
 */

import { readdirSync, readFileSync, statSync, existsSync, type Dirent } from 'node:fs'
import { join, extname } from 'node:path'

export type AuditSeverity = 'info' | 'warning' | 'danger'
export type AuditVerdict = 'safe' | 'review' | 'blocked'

export interface AuditFinding {
  file: string
  severity: AuditSeverity
  rule: string
  detail: string
}

export interface AuditReport {
  verdict: AuditVerdict
  findings: AuditFinding[]
  auditedFiles: number
}

/** 应重点审计的文件扩展（脚本/可执行）。 */
const SCRIPT_EXTS = new Set(['.sh', '.py', '.js', '.ts', '.mjs', '.cjs', '.rb', '.pl', '.bats', '.zsh', '.fish', '.ps1'])
const SCRIPT_NAMES = new Set(['install', 'setup', 'init', 'run', 'postinstall', 'download'])

/** 安全的 shell 操作（用于排除误报）。 */
function isBenignLine(line: string): boolean {
  const t = line.trim()
  if (!t || t.startsWith('#')) return true
  // 常见无害：输出/注释/简单赋值/本地文件操作
  if (/^(echo|printf|cat|ls|mkdir|cd|set -e|export .+=)/.test(t)) return true
  return false
}

/** 检查单个文件，返回该文件的 findings。 */
function auditFile(file: string, relPath: string): AuditFinding[] {
  const findings: AuditFinding[] = []
  let content: string
  try {
    content = readFileSync(file, 'utf-8')
  } catch {
    return findings
  }
  const lines = content.split('\n')
  const isScript = SCRIPT_EXTS.has(extname(file).toLowerCase()) || SCRIPT_NAMES.has(file.split('/').pop()!.toLowerCase().replace(/\.[^.]+$/, ''))

  const push = (severity: AuditSeverity, rule: string, detail: string): void => {
    findings.push({ file: relPath, severity, rule, detail })
  }

  // 1) 下载执行（curl|bash / wget -O- | sh）—— 高险
  if (isScript) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (isBenignLine(line)) continue
      if (/(curl|wget)[^\n]*\|\s*(ba)?sh\b/.test(line)) {
        push('danger', 'remote-exec', `第${i + 1}行：远程脚本直接执行 (${line.trim().slice(0, 80)})`)
      }
    }
  }

  // 2) 回连 / 外传（webhook/远程 POST/读取密钥外发）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/(webhook\.site|hooks\.slack|api\.telegram|discord\.com\/api|https?:\/\/[^\s'"]*\/(ingest|collect|beacon|pixel|callback))/.test(line)) {
      push('warning', 'phone-home', `第${i + 1}行：发现疑似回连端点`)
    }
    if (/(\.env|api[_-]?key|token|secret)\b[^\n]*(curl|wget|fetch|http\.post|https?:\/\/)/i.test(line)) {
      push('danger', 'exfil', `第${i + 1}行：疑似读取密钥/环境变量并外发`)
    }
  }

  // 3) 混淆 / 编码载荷
  if (/content: *[a-zA-Z0-9+/=]{80,}/.test(content) || /YmFzZ|ZXZhbHxk|L2Jpbi9zaA/.test(content)) {
    push('warning', 'obfuscation', '发现疑似 base64/编码载荷')
  }
  if (lines.length === 1 && content.length > 2000) {
    push('warning', 'minified', '单行超长脚本（疑似压缩/混淆）')
  }

  // 4) 覆盖安全 / 破坏
  if (/\b(rm\s+-rf\s+\/|chmod\s+-R\s+777\s+\/|\bkill\s+-9\b)/.test(content)) {
    push('danger', 'destructive', '发现高危破坏性命令（rm -rf / 或 chmod /）')
  }
  if (/permissionMode\s*[:=]\s*['"]?bypass|disablePermission|skipApproval|allowAll|--yes\b/i.test(content)) {
    push('warning', 'safety-bypass', '疑似绕过权限/审批')
  }

  return findings
}

/**
 * 审计整个 skill 目录。返回报告：verdict + findings。
 * danger 级 → blocked；warning 级 → review；仅 info/无 → safe。
 */
export function auditSkill(skillRoot: string): AuditReport {
  const findings: AuditFinding[] = []
  let auditedFiles = 0

  const walk = (dir: string, rel: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      const relP = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        // 跳过版本控制/构建产物
        if (['.git', 'node_modules', 'dist', '.cache'].includes(e.name)) continue
        walk(p, relP)
        continue
      }
      if (!e.isFile()) continue
      auditedFiles++
      const maxSize = 2 * 1024 * 1024
      try {
        if (statSync(p).size > maxSize) continue // 跳过超大二进制
      } catch {
        continue
      }
      const fileFindings = auditFile(p, relP)
      if (fileFindings.length > 0) findings.push(...fileFindings)
    }
  }
  walk(skillRoot, '')

  const danger = findings.filter((f) => f.severity === 'danger').length
  const warning = findings.filter((f) => f.severity === 'warning').length
  const verdict: AuditVerdict = danger > 0 ? 'blocked' : warning > 0 ? 'review' : 'safe'
  return { verdict, findings, auditedFiles }
}
