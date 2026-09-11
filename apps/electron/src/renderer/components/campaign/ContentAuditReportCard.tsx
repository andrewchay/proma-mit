import * as React from 'react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { AuditScoreRadar } from './AuditScoreRadar'
import type { ContentAudit } from '@gravitas/shared'

interface ContentAuditReportCardProps {
  audit: ContentAudit
  className?: string
}

function ScoreBar({ label, score, weight, color }: { label: string; score: number; weight: number; color: string }) {
  const isHigh = score >= 70
  const isLow = score < 50

  return (
    <div className="flex items-center gap-3">
      <div className="w-20 text-xs text-muted-foreground shrink-0">{label}</div>
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500 ease-out',
            isHigh && 'bg-emerald-500',
            isLow && 'bg-red-500',
            !isHigh && !isLow && 'bg-amber-500'
          )}
          style={{ width: `${score}%` }}
        />
      </div>
      <div className={cn(
        'w-10 text-right text-sm font-semibold tabular-nums',
        isHigh && 'text-emerald-600 dark:text-emerald-400',
        isLow && 'text-red-600 dark:text-red-400',
        !isHigh && !isLow && 'text-amber-600 dark:text-amber-400'
      )}>
        {score}
      </div>
      <div className="w-8 text-right text-[10px] text-muted-foreground tabular-nums">
        {weight}%
      </div>
    </div>
  )
}

function StatusBadge({ status, score }: { status: ContentAudit['auditStatus']; score: number }) {
  const config = {
    passed: { label: '通过', variant: 'default' as const, className: 'bg-emerald-500 hover:bg-emerald-600 text-white' },
    pending: { label: '需修改', variant: 'secondary' as const, className: 'bg-amber-500 hover:bg-amber-600 text-white' },
    failed: { label: '不通过', variant: 'destructive' as const, className: '' },
    reviewing: { label: '审核中', variant: 'outline' as const, className: '' },
  }

  const c = config[status]
  return (
    <Badge variant={c.variant} className={cn('text-xs font-semibold', c.className)}>
      {c.label} · {score}分
    </Badge>
  )
}

export function ContentAuditReportCard({ audit, className }: ContentAuditReportCardProps) {
  const reportLines = audit.auditReport.split('\n').filter(Boolean)

  // Parse sections from markdown report
  const sections: Array<{ title: string; icon: string; lines: string[] }> = []
  let currentSection: typeof sections[0] | null = null

  for (const line of reportLines) {
    const match = line.match(/^##\s+(.+)$/)
    if (match) {
      const title = match[1]!.trim()
      const icon = title.includes('结论') ? '📋' :
        title.includes('合规') ? '⚖️' :
        title.includes('品牌') ? '🏷️' :
        title.includes('质量') ? '✨' :
        title.includes('形象') ? '🎨' :
        title.includes('数据') ? '📊' :
        title.includes('建议') ? '📝' : '•'
      currentSection = { title: `${icon} ${title}`, icon, lines: [] }
      sections.push(currentSection)
    } else if (currentSection) {
      currentSection.lines.push(line)
    }
  }

  const dimensionScores = [
    { label: '合规性', score: audit.complianceScore, weight: 20 },
    { label: '品牌契合', score: audit.brandAlignmentScore, weight: 25 },
    { label: '内容质量', score: audit.qualityScore, weight: 25 },
    { label: '形象一致', score: audit.brandImageScore, weight: 20 },
    { label: '数据验证', score: audit.dataVerifiabilityScore, weight: 10 },
  ]

  return (
    <div className={cn('rounded-xl border bg-card text-card-foreground shadow-sm', className)}>
      {/* Header */}
      <div className="px-5 py-4 border-b">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold">内容审核报告</h3>
            <StatusBadge status={audit.auditStatus} score={audit.overallScore} />
          </div>
          <span className="text-xs text-muted-foreground">
            {audit.auditor === 'ai' ? '🤖 AI审核' : '📏 规则审核'}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
          <span>达人: {audit.kolName}</span>
          <span>·</span>
          <span>平台: {audit.platform}</span>
          <span>·</span>
          <span>{new Date(audit.createdAt).toLocaleString('zh-CN')}</span>
        </div>
      </div>

      {/* Body */}
      <div className="p-5">
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left: Radar + Score Bars */}
          <div className="flex flex-col items-center gap-4">
            <AuditScoreRadar
              complianceScore={audit.complianceScore}
              brandAlignmentScore={audit.brandAlignmentScore}
              qualityScore={audit.qualityScore}
              brandImageScore={audit.brandImageScore}
              dataVerifiabilityScore={audit.dataVerifiabilityScore}
              size={240}
            />
            <div className="w-full max-w-[260px] space-y-2">
              {dimensionScores.map((dim) => (
                <ScoreBar
                  key={dim.label}
                  label={dim.label}
                  score={dim.score}
                  weight={dim.weight}
                  color=""
                />
              ))}
            </div>
          </div>

          {/* Right: Report Sections */}
          <div className="flex-1 space-y-3">
            {sections.length > 0 ? (
              sections.map((section, i) => (
                <div key={i} className="rounded-lg bg-muted/40 p-3">
                  <h4 className="text-sm font-medium mb-1.5">{section.title}</h4>
                  <div className="space-y-1">
                    {section.lines.map((line, j) => {
                      const isItem = line.trim().startsWith('-') || line.trim().startsWith('•')
                      const isNumbered = /^\d+\./.test(line.trim())
                      const cleanLine = line.replace(/^\s*[-•]\s*/, '').replace(/^\d+\.\s*/, '')

                      if (isItem || isNumbered) {
                        return (
                          <div key={j} className="flex items-start gap-2 text-sm">
                            <span className="mt-1.5 w-1 h-1 rounded-full bg-primary shrink-0" />
                            <span className="text-muted-foreground">{cleanLine}</span>
                          </div>
                        )
                      }

                      // Bold text detection
                      const boldMatch = cleanLine.match(/\*\*(.+?)\*\*/g)
                      if (boldMatch) {
                        const parts = cleanLine.split(/(\*\*.+?\*\*)/g)
                        return (
                          <p key={j} className="text-sm">
                            {parts.map((part, k) => {
                              if (part.startsWith('**') && part.endsWith('**')) {
                                return <strong key={k} className="font-medium text-foreground">{part.slice(2, -2)}</strong>
                              }
                              return <span key={k} className="text-muted-foreground">{part}</span>
                            })}
                          </p>
                        )
                      }

                      return (
                        <p key={j} className="text-sm text-muted-foreground">
                          {cleanLine}
                        </p>
                      )
                    })}
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-lg bg-muted/40 p-3">
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {audit.auditReport}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t bg-muted/20 rounded-b-xl">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>审核ID: {audit.auditId}</span>
          {audit.contentUrl && (
            <a
              href={audit.contentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              查看原文 ↗
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
