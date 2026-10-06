/**
 * StudyRunsPanel - 研究运行面板（M4.2）
 *
 * 发起计算运行（解释器白名单 + 脚本相对路径 + 参数 + 超时）、
 * 登记手工观察、查看日志尾、取消运行、登记产物。
 *
 * 展示上刻意区分：
 * - 运行「完成」只说明进程正常结束，不代表结论成立
 * - 产物分「已校验（本地 sha256）」与「未校验（外部引用）」
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Loader2, Play, ScrollText, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  allowedInterpretersAtom,
  cancelRunAtom,
  createRunAtom,
  loadRunsAtom,
  readRunLogAtom,
  recordArtifactAtom,
  recordObservationAtom,
  runArtifactsAtom,
  runLogAtom,
  runObservationsAtom,
  runsAtom,
  runsLoadingAtom,
} from '@/atoms/academic-atoms'
import type { ResearchProject, ResearchRun } from '@gravitas/shared'

const STATUS_LABELS: Record<ResearchRun['status'], string> = {
  queued: '已入队',
  running: '执行中',
  completed: '进程已完成',
  failed: '失败',
  cancelled: '已取消',
  'timed-out': '超时',
}

const TERMINAL: Array<ResearchRun['status']> = ['completed', 'failed', 'cancelled', 'timed-out']

export function StudyRunsPanel({ project }: { project: ResearchProject }): React.ReactElement {
  const runs = useAtomValue(runsAtom)
  const observations = useAtomValue(runObservationsAtom)
  const artifacts = useAtomValue(runArtifactsAtom)
  const loading = useAtomValue(runsLoadingAtom)
  const loadRuns = useSetAtom(loadRunsAtom)

  React.useEffect(() => {
    void loadRuns(project.id)
  }, [project.id, loadRuns])

  return (
    <div className="mt-4 space-y-3 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-primary" />
          <span className="text-base font-semibold">研究运行</span>
          <span className="text-xs text-muted-foreground">
            「进程已完成」仅代表正常退出，不代表结论成立
          </span>
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      <RunComposer project={project} />
      <ManualObservationComposer project={project} runs={runs} />

      {runs.length === 0 ? (
        <div className="text-sm text-muted-foreground">还没有运行记录。</div>
      ) : (
        runs.map((run) => (
          <RunRow key={run.id} run={run} projectId={project.id} />
        ))
      )}

      {observations.length > 0 && (
        <div className="space-y-1">
          <div className="text-sm font-medium">观察记录（{observations.length}）</div>
          {observations.slice(0, 5).map((o) => (
            <div key={o.id} className="rounded-md border p-2 text-xs">
              <div className="text-muted-foreground">{o.text}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {o.recordedBy.displayName} · {new Date(o.recordedAt).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {artifacts.length > 0 && (
        <div className="space-y-1">
          <div className="text-sm font-medium">产物（{artifacts.length}）</div>
          {artifacts.slice(0, 5).map((a) => (
            <div key={a.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={a.integrity === 'verified' ? 'default' : 'outline'}>
                {a.integrity === 'verified' ? '已校验' : '未校验'}
              </Badge>
              <span className="truncate">{a.ref}</span>
              {a.sizeBytes !== undefined && <span>{a.sizeBytes} B</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RunComposer({ project }: { project: ResearchProject }): React.ReactElement {
  const interpreters = useAtomValue(allowedInterpretersAtom)
  const createRun = useSetAtom(createRunAtom)
  const [open, setOpen] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [interpreter, setInterpreter] = React.useState('python3')
  const [scriptPath, setScriptPath] = React.useState('')
  const [args, setArgs] = React.useState('')
  const [timeoutSec, setTimeoutSec] = React.useState('600')
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (interpreters.length > 0 && !interpreters.includes(interpreter)) {
      setInterpreter(interpreters[0]!)
    }
  }, [interpreters, interpreter])

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">发起计算运行</div>
        <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '新建运行'}
        </Button>
      </div>

      {message && <p className="text-xs text-muted-foreground">{message}</p>}

      {open && (
        <div className="space-y-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="运行标题" />
          <div className="flex gap-2">
            <select
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={interpreter}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setInterpreter(e.target.value)}
            >
              {interpreters.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
            <Input
              value={scriptPath}
              onChange={(e) => setScriptPath(e.target.value)}
              placeholder="脚本相对路径（项目目录内，如 sim.py）"
            />
          </div>
          <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="参数（空格分隔，不经 shell）" />
          <Input value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} placeholder="超时（秒）" />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || !title.trim() || !scriptPath.trim()}
              onClick={async () => {
                setBusy(true)
                setMessage(null)
                try {
                  const sec = parseInt(timeoutSec, 10)
                  const run = await createRun({
                    projectId: project.id,
                    request: {
                      kind: 'compute',
                      title,
                      input: {
                        interpreter,
                        scriptPath,
                        args: args.trim() ? args.split(/\s+/).filter(Boolean) : [],
                      },
                      budget: Number.isFinite(sec) && sec > 0 ? { timeoutMs: sec * 1000 } : undefined,
                    },
                  })
                  setMessage(`运行结束：${STATUS_LABELS[run.status]}（退出码 ${run.exitCode ?? '—'}）`)
                } catch (err) {
                  setMessage(err instanceof Error ? err.message : String(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              执行
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function ManualObservationComposer({
  project,
  runs,
}: {
  project: ResearchProject
  runs: ResearchRun[]
}): React.ReactElement {
  const createRun = useSetAtom(createRunAtom)
  const recordObservation = useSetAtom(recordObservationAtom)
  const [open, setOpen] = React.useState(false)
  const [title, setTitle] = React.useState('')
  const [text, setText] = React.useState('')
  const [targetRunId, setTargetRunId] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  const manualRuns = runs.filter((r) => r.kind !== 'compute')

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">登记手工观察（访谈/现场/湿实验）</div>
        <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '登记'}
        </Button>
      </div>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}

      {open && (
        <div className="space-y-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="本次观察批次标题" />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !title.trim()}
            onClick={async () => {
              setBusy(true)
              try {
                const run = await createRun({
                  projectId: project.id,
                  request: { kind: 'manual-observation', title, input: {} },
                })
                setTargetRunId(run.id)
                setMessage('已创建观察批次，可在下方填写记录')
              } finally {
                setBusy(false)
              }
            }}
          >
            创建观察批次
          </Button>

          <select
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={targetRunId}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTargetRunId(e.target.value)}
          >
            <option value="">选择批次…</option>
            {manualRuns.map((r) => (
              <option key={r.id} value={r.id}>{r.title}</option>
            ))}
          </select>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="原始观察记录（逐字记录，不要由模型代写）" />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy || !targetRunId || !text.trim()}
              onClick={async () => {
                setBusy(true)
                setMessage(null)
                try {
                  await recordObservation({ projectId: project.id, runId: targetRunId, text })
                  setText('')
                  setMessage('已保存观察记录')
                } catch (err) {
                  setMessage(err instanceof Error ? err.message : String(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              保存记录
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function RunRow({ run, projectId }: { run: ResearchRun; projectId: string }): React.ReactElement {
  const log = useAtomValue(runLogAtom)
  const readLog = useSetAtom(readRunLogAtom)
  const cancelRun = useSetAtom(cancelRunAtom)
  const recordArtifact = useSetAtom(recordArtifactAtom)
  const [artifactRef, setArtifactRef] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const isTerminal = TERMINAL.includes(run.status)
  const showLog = log?.runId === run.id

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{run.title}</span>
            <Badge variant={run.status === 'completed' ? 'default' : isTerminal ? 'destructive' : 'secondary'}>
              {STATUS_LABELS[run.status]}
            </Badge>
            <Badge variant="outline" className="text-[10px]">{run.kind}</Badge>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {run.input.interpreter && <span>{run.input.interpreter} </span>}
            {run.input.scriptPath && <span>{run.input.scriptPath} </span>}
            {run.exitCode !== undefined && <span>· 退出码 {run.exitCode} </span>}
            <span>· 超时 {Math.round(run.budget.timeoutMs / 1000)}s</span>
          </div>
          {run.statusReason && (
            <div className="mt-1 text-xs text-amber-600">{run.statusReason}</div>
          )}
        </div>

        <div className="flex shrink-0 gap-1">
          {run.kind === 'compute' && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => void readLog({ projectId, runId: run.id })}
            >
              日志
            </Button>
          )}
          {!isTerminal && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await cancelRun({ projectId, runId: run.id })
                } finally {
                  setBusy(false)
                }
              }}
            >
              <Square className="mr-1 h-3 w-3" />
              取消
            </Button>
          )}
        </div>
      </div>

      {showLog && (
        <div className="space-y-1">
          {log.exists ? (
            <>
              {log.truncated && (
                <div className="text-[11px] text-amber-600">日志过大，仅显示尾部</div>
              )}
              <pre className="max-h-48 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-snug">
                {log.content || '（空日志）'}
              </pre>
            </>
          ) : (
            <div className="text-[11px] text-muted-foreground">该运行没有日志文件（非计算运行不产生日志）</div>
          )}
        </div>
      )}

      {isTerminal && (
        <div className="flex gap-2">
          <Input
            value={artifactRef}
            onChange={(e) => setArtifactRef(e.target.value)}
            placeholder="登记产物：项目内相对路径，或 doi:/dvc:/https: 外部引用"
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2 text-xs"
            disabled={busy || !artifactRef.trim()}
            onClick={async () => {
              setBusy(true)
              try {
                await recordArtifact({ projectId, runId: run.id, ref: artifactRef })
                setArtifactRef('')
              } finally {
                setBusy(false)
              }
            }}
          >
            登记
          </Button>
        </div>
      )}
    </div>
  )
}
