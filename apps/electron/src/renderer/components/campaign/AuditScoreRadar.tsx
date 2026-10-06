import * as React from 'react'
import { cn } from '@/lib/utils'

interface AuditScoreRadarProps {
  complianceScore: number
  brandAlignmentScore: number
  qualityScore: number
  brandImageScore: number
  dataVerifiabilityScore: number
  className?: string
  size?: number
}

const DIMENSIONS = [
  { key: 'compliance', label: '合规性', weight: 20, scoreKey: 'complianceScore' as const },
  { key: 'brandAlignment', label: '品牌契合', weight: 25, scoreKey: 'brandAlignmentScore' as const },
  { key: 'quality', label: '内容质量', weight: 25, scoreKey: 'qualityScore' as const },
  { key: 'brandImage', label: '形象一致', weight: 20, scoreKey: 'brandImageScore' as const },
  { key: 'data', label: '数据验证', weight: 10, scoreKey: 'dataVerifiabilityScore' as const },
] as const

const COLORS = {
  grid: 'hsl(var(--muted-foreground) / 0.15)',
  axis: 'hsl(var(--muted-foreground) / 0.25)',
  fill: 'hsl(var(--primary) / 0.20)',
  stroke: 'hsl(var(--primary))',
  dot: 'hsl(var(--primary))',
  label: 'hsl(var(--foreground))',
  score: 'hsl(var(--primary))',
}

export function AuditScoreRadar({
  complianceScore,
  brandAlignmentScore,
  qualityScore,
  brandImageScore,
  dataVerifiabilityScore,
  className,
  size = 280,
}: AuditScoreRadarProps) {
  const scores = {
    complianceScore,
    brandAlignmentScore,
    qualityScore,
    brandImageScore,
    dataVerifiabilityScore,
  }

  const center = size / 2
  const radius = size * 0.36
  const angleStep = (Math.PI * 2) / DIMENSIONS.length
  const startAngle = -Math.PI / 2

  // Calculate polygon points for each score
  const scorePoints = DIMENSIONS.map((dim, i) => {
    const angle = startAngle + i * angleStep
    const score = scores[dim.scoreKey]
    const r = (score / 100) * radius
    return {
      x: center + r * Math.cos(angle),
      y: center + r * Math.sin(angle),
      score,
      label: dim.label,
      angle,
    }
  })

  // Grid levels (20, 40, 60, 80, 100)
  const levels = [20, 40, 60, 80, 100]

  const polygonPoints = scorePoints.map((p) => `${p.x},${p.y}`).join(' ')

  return (
    <div className={cn('relative inline-flex flex-col items-center', className)}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="overflow-visible"
      >
        {/* Background grid levels */}
        {levels.map((level) => {
          const r = (level / 100) * radius
          const points = DIMENSIONS.map((_, i) => {
            const angle = startAngle + i * angleStep
            return `${center + r * Math.cos(angle)},${center + r * Math.sin(angle)}`
          }).join(' ')
          return (
            <polygon
              key={level}
              points={points}
              fill="none"
              stroke={COLORS.grid}
              strokeWidth={1}
              strokeDasharray={level === 100 ? undefined : '3,3'}
            />
          )
        })}

        {/* Axis lines */}
        {DIMENSIONS.map((_, i) => {
          const angle = startAngle + i * angleStep
          const x = center + radius * Math.cos(angle)
          const y = center + radius * Math.sin(angle)
          return (
            <line
              key={`axis-${i}`}
              x1={center}
              y1={center}
              x2={x}
              y2={y}
              stroke={COLORS.axis}
              strokeWidth={1}
            />
          )
        })}

        {/* Score polygon */}
        <polygon
          points={polygonPoints}
          fill={COLORS.fill}
          stroke={COLORS.stroke}
          strokeWidth={2}
          className="transition-all duration-500 ease-out"
        />

        {/* Score dots */}
        {scorePoints.map((p, i) => (
          <g key={`dot-${i}`}>
            <circle
              cx={p.x}
              cy={p.y}
              r={4}
              fill={COLORS.dot}
              stroke="hsl(var(--background))"
              strokeWidth={2}
            />
          </g>
        ))}

        {/* Labels */}
        {DIMENSIONS.map((dim, i) => {
          const angle = startAngle + i * angleStep
          const labelRadius = radius + 22
          const x = center + labelRadius * Math.cos(angle)
          const y = center + labelRadius * Math.sin(angle)
          const score = scores[dim.scoreKey]
          const isHigh = score >= 70
          const isLow = score < 50

          return (
            <g key={`label-${i}`}>
              <text
                x={x}
                y={y - 6}
                textAnchor="middle"
                dominantBaseline="middle"
                className="text-[11px] font-medium fill-foreground"
              >
                {dim.label}
              </text>
              <text
                x={x}
                y={y + 8}
                textAnchor="middle"
                dominantBaseline="middle"
                className={cn(
                  'text-[10px] font-bold',
                  isHigh && 'fill-emerald-500',
                  isLow && 'fill-red-500',
                  !isHigh && !isLow && 'fill-primary'
                )}
              >
                {score}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
