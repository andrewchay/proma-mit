/**
 * ResearchWorkspace - 研究工作台最小视图（M1 第二批）
 *
 * 覆盖研究概览的最小闭环：项目列表、创建、Brief 展示/编辑、
 * 状态推进与旧数据迁移 dry-run。文献/证据/协议等后续视图随
 * M2/M3 增加；本组件刻意保持展示与交互简单，复杂逻辑在
 * atoms 与主进程服务层。样式仅用现有 ui 原语（button/input/
 * textarea/badge），不引入本项目没有的组件依赖。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { FlaskConical, Loader2, Plus, FileSearch } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  archiveResearchProjectAtom,
  changeResearchStatusAtom,
  createResearchProjectAtom,
  currentResearchProjectAtom,
  loadResearchProjectsAtom,
  migrationReportAtom,
  researchCreateDialogOpenAtom,
  researchProjectsAtom,
  researchProjectsErrorAtom,
  researchProjectsLoadingAtom,
  runMigrationDryRunAtom,
  updateResearchBriefAtom,
} from '@/atoms/academic-atoms'
import { SourceLibraryPanel } from '@/components/academic/SourceLibraryPanel'
import type {
  CreateResearchProjectInput,
  ResearchDomain,
  ResearchMethodPath,
  ResearchProject,
} from '@gravitas/shared'

const DOMAIN_LABELS: Record<ResearchDomain, string> = {
  audiology: '听力学',
  'medical-humanities': '医学人文',
  statistics: '统计学',
  ai: '人工智能',
  ontology: '本体',
  'enterprise-ai': '企业 AI 改造',
  'data-science': '数据分析与科学',
}

const METHOD_LABELS: Record<ResearchMethodPath, string> = {
  quantitative: '定量/计算',
  qualitative: '质性/人文',
  formal: '形式/本体',
  'mixed-practice': '实践/混合',
}

const STATUS_LABELS: Record<ResearchProject['status'], string> = {
  defining: '问题定义',
  literature: '文献综述',
  designing: '研究设计',
  executing: '研究执行',
  analyzing: '分析论证',
  writing: '写作',
  reviewing: '审查修订',
  completed: '已完成',
  archived: '已归档',
}

/** 主干推进路径（UI 快捷键；回流在详情里按需开放） */
const MAIN_PATH: Partial<Record<ResearchProject['status'], ResearchProject['status']>> = {
  defining: 'literature',
  literature: 'designing',
  designing: 'executing',
  executing: 'analyzing',
  analyzing: 'writing',
  writing: 'reviewing',
  reviewing: 'completed',
}

export function ResearchWorkspace(): React.ReactElement {
  const projects = useAtomValue(researchProjectsAtom)
  const loading = useAtomValue(researchProjectsLoadingAtom)
  const error = useAtomValue(researchProjectsErrorAtom)
  const current = useAtomValue(currentResearchProjectAtom)
  const migrationReport = useAtomValue(migrationReportAtom)

  const loadProjects = useSetAtom(loadResearchProjectsAtom)
  const runDryRun = useSetAtom(runMigrationDryRunAtom)
  const [createOpen, setCreateOpen] = useAtom(researchCreateDialogOpenAtom)

  React.useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">研究工作台</h1>
          <span className="text-xs text-muted-foreground">从文献到稿件的可追溯研究过程</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void runDryRun()}>
            <FileSearch className="mr-1 h-4 w-4" />
            迁移预检
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            新建研究
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {migrationReport && migrationReport.totalPapers > 0 && (
          <div className="mb-4 rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
            <div className="mb-1 text-sm font-medium">旧论文迁移预检（只读）</div>
            <div className="text-sm text-muted-foreground">
              发现 {migrationReport.totalPapers} 篇旧论文：
              {migrationReport.mappings.filter((m) => m.action === 'migrate').length} 篇可直接迁移，
              {migrationReport.mappings.filter((m) => m.action === 'needs_review').length}{' '}
              篇需人工复核。实际迁移将在你确认后执行（后续里程碑）。
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载研究项目…
          </div>
        ) : projects.length === 0 ? (
          <div className="py-20 text-center text-muted-foreground">
            <p className="mb-2">还没有研究项目</p>
            <p className="text-sm">点击右上角「新建研究」开始：先定义研究问题，再进入文献综述。</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} active={current?.id === project.id} />
            ))}
          </div>
        )}
      </div>

      {createOpen && <CreateProjectDialog onClose={() => setCreateOpen(false)} />}
      {current && (
        <div className="px-6 pb-6">
          <ProjectDetailPanel project={current} />
          <SourceLibraryPanel project={current} />
        </div>
      )}
    </div>
  )
}

function ProjectCard({
  project,
  active,
}: {
  project: ResearchProject
  active: boolean
}): React.ReactElement {
  const setCurrent = useSetAtom(currentResearchProjectAtom)
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'cursor-pointer rounded-lg border bg-card p-4 text-card-foreground shadow-sm transition-colors hover:border-primary/40',
        active && 'border-primary/60',
      )}
      onClick={() => setCurrent(project)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') setCurrent(project)
      }}
    >
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <span className="truncate font-medium">{project.title}</span>
            <Badge variant="outline">{DOMAIN_LABELS[project.domain]}</Badge>
            <Badge variant="secondary">{METHOD_LABELS[project.methodPath]}</Badge>
          </div>
          {project.brief && (
            <p className="truncate text-sm text-muted-foreground">{project.brief.question}</p>
          )}
        </div>
        <Badge>{STATUS_LABELS[project.status]}</Badge>
      </div>
    </div>
  )
}

function ProjectDetailPanel({ project }: { project: ResearchProject }): React.ReactElement {
  const [briefDraft, setBriefDraft] = React.useState(project.brief)
  const [changeReason, setChangeReason] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const updateBrief = useSetAtom(updateResearchBriefAtom)
  const changeStatus = useSetAtom(changeResearchStatusAtom)
  const archive = useSetAtom(archiveResearchProjectAtom)

  const nextStatus = MAIN_PATH[project.status]

  return (
    <div className="mt-4 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-base font-semibold">{project.title}</div>
        <div className="flex items-center gap-2">
          {nextStatus && (
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={async () => {
                setSaving(true)
                try {
                  await changeStatus({ id: project.id, to: nextStatus })
                } finally {
                  setSaving(false)
                }
              }}
            >
              进入{STATUS_LABELS[nextStatus]}
            </Button>
          )}
          {project.status !== 'archived' && project.status !== 'completed' && (
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={async () => {
                setSaving(true)
                try {
                  await archive({ id: project.id, reason: '从工作台归档' })
                } finally {
                  setSaving(false)
                }
              }}
            >
              归档
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2 text-sm">
          <div>
            <span className="text-muted-foreground">领域：</span>
            {DOMAIN_LABELS[project.domain]}
          </div>
          <div>
            <span className="text-muted-foreground">方法：</span>
            {METHOD_LABELS[project.methodPath]}
          </div>
          <div>
            <span className="text-muted-foreground">状态：</span>
            {STATUS_LABELS[project.status]}
          </div>
        </div>

        {briefDraft ? (
          <div className="space-y-2">
            <div className="text-sm font-medium">研究问题定义</div>
            <Input
              value={briefDraft.question}
              onChange={(e) => setBriefDraft({ ...briefDraft, question: e.target.value })}
              placeholder="研究问题"
            />
            <Input
              value={briefDraft.goals}
              onChange={(e) => setBriefDraft({ ...briefDraft, goals: e.target.value })}
              placeholder="研究目标"
            />
            <Textarea
              value={briefDraft.scope}
              onChange={(e) => setBriefDraft({ ...briefDraft, scope: e.target.value })}
              placeholder="范围边界"
              rows={2}
            />
            <Input
              value={changeReason}
              onChange={(e) => setChangeReason(e.target.value)}
              placeholder="修改理由（必填）"
            />
            <Button
              size="sm"
              disabled={saving || !changeReason.trim()}
              onClick={async () => {
                setSaving(true)
                try {
                  await updateBrief({ id: project.id, brief: briefDraft, changeReason })
                  setChangeReason('')
                } finally {
                  setSaving(false)
                }
              }}
            >
              保存问题定义
            </Button>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">
            尚未定义研究问题。创建后可在上方补充；每次修改都需填写理由并留痕。
          </div>
        )}
      </div>
    </div>
  )
}

function CreateProjectDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const createProject = useSetAtom(createResearchProjectAtom)
  const [title, setTitle] = React.useState('')
  const [domain, setDomain] = React.useState<ResearchDomain>('audiology')
  const [methodPath, setMethodPath] = React.useState<ResearchMethodPath>('quantitative')
  const [question, setQuestion] = React.useState('')
  const [goals, setGoals] = React.useState('')
  const [scope, setScope] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [errorText, setErrorText] = React.useState<string | null>(null)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[520px] rounded-lg border bg-card p-6 text-card-foreground shadow-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 text-base font-semibold">新建研究项目</div>
        <div className="space-y-3">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="研究项目标题" />
          <div className="grid grid-cols-2 gap-2">
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={domain}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setDomain(e.target.value as ResearchDomain)}
            >
              {Object.entries(DOMAIN_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={methodPath}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                setMethodPath(e.target.value as ResearchMethodPath)
              }
            >
              {Object.entries(METHOD_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="研究问题（可稍后补充）"
          />
          <Input value={goals} onChange={(e) => setGoals(e.target.value)} placeholder="研究目标" />
          <Textarea value={scope} onChange={(e) => setScope(e.target.value)} placeholder="范围边界" rows={2} />
          {errorText && <p className="text-sm text-destructive">{errorText}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              disabled={submitting || !title.trim()}
              onClick={async () => {
                setSubmitting(true)
                setErrorText(null)
                try {
                  const input: CreateResearchProjectInput = {
                    title,
                    domain,
                    methodPath,
                    brief:
                      question.trim() && goals.trim() && scope.trim()
                        ? { question, goals, scope }
                        : undefined,
                  }
                  await createProject(input)
                  onClose()
                } catch (err) {
                  setErrorText(err instanceof Error ? err.message : String(err))
                } finally {
                  setSubmitting(false)
                }
              }}
            >
              创建
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
