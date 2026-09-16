/**
 * 学习样本摘要的敏感内容扫描。
 *
 * 只做提示，不自动改写或拒绝：人工审核者仍需自行判断并删除。
 * 判定基于确定性模式，存在误报，因此不声称结果是完整或精确的脱敏结论。
 */

export type SampleSensitiveKind = 'absolute_path' | 'credential' | 'email' | 'url_with_credentials' | 'session_reference' | 'long_token'

export interface SampleSensitiveFinding {
  kind: SampleSensitiveKind
  message: string
  /** 命中片段（截断后返回），用于人工定位，不用于对外传输。 */
  excerpt: string
}

interface ScanRule {
  kind: SampleSensitiveKind
  pattern: RegExp
  message: string
}

const RULES: ScanRule[] = [
  { kind: 'absolute_path', pattern: /(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\Users\\)[^\s"'`)]{2,}/, message: '疑似本机绝对路径' },
  { kind: 'credential', pattern: /(?:api[_-]?key|secret|token|password|passwd|authorization)\s*[:=]\s*\S+/i, message: '疑似凭据或密钥赋值' },
  { kind: 'credential', pattern: /(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,})/, message: '疑似密钥字面量' },
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, message: '疑似邮箱地址' },
  { kind: 'url_with_credentials', pattern: /https?:\/\/[^\s/@]+:[^\s/@]+@\S+/i, message: '疑似带凭据的 URL' },
  { kind: 'session_reference', pattern: /(?:session[_-]?id|会话\s*ID)\s*[:=]\s*\S+/i, message: '疑似会话标识引用' },
  { kind: 'long_token', pattern: /\b[A-Za-z0-9_-]{32,}\b/, message: '疑似长随机串（可能是 token 或 hash）' },
]

function excerptOf(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 12)
  const raw = text.slice(start, index + length + 12).replace(/\s+/g, ' ').trim()
  return raw.length > 120 ? `${raw.slice(0, 117)}…` : raw
}

/** 扫描一条样本摘要，返回需要人工确认的敏感片段。 */
export function scanSampleForSensitiveContent(text: string): SampleSensitiveFinding[] {
  const findings: SampleSensitiveFinding[] = []
  const seen = new Set<SampleSensitiveKind>()
  for (const rule of RULES) {
    const match = rule.pattern.exec(text)
    if (!match) continue
    // 同类问题只提示一次，避免摘要里多个路径刷屏。
    if (seen.has(rule.kind) && rule.kind !== 'credential') continue
    seen.add(rule.kind)
    findings.push({ kind: rule.kind, message: rule.message, excerpt: excerptOf(text, match.index, match[0].length) })
  }
  return findings
}

/** 生成审核提示语；没有命中时返回 null，便于 UI 直接判断。 */
export function describeSampleScan(findings: SampleSensitiveFinding[]): string | null {
  if (findings.length === 0) return null
  return `检测到 ${findings.length} 类疑似敏感内容，请人工确认并删除后再标记可用于评测：\n${findings.map((item) => `· ${item.message}（${item.excerpt}）`).join('\n')}`
}
