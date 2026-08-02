/**
 * AskUserBanner — Agent AskUserQuestion 交互式问答横幅
 *
 * 视觉参考：选项采用卡片式 Radio / Checkbox 排版，label 与 description 纵向堆叠，
 * 选中态以蓝色边框 + 浅蓝背景呈现，与单选/多选语义一致。
 * 多问题用顶部 Tab 切换，选项竖向排列。
 * 键盘：↑↓ 选择选项，Enter 确认当前问题（最后一题提交，否则翻页）。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { CheckCircle2, Circle, CheckSquare2, Square, Hand, Send, X, ArrowRight } from 'lucide-react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { allPendingAskUserRequestsAtom, agentStreamingStatesAtom, finalizeStreamingActivities } from '@/atoms/agent-atoms'
import type { AskUserQuestion } from '@proma/shared'

interface QuestionAnswer {
  selected: string[]
  customText: string
  showCustom: boolean
}

const EMPTY_ANSWER: QuestionAnswer = { selected: [], customText: '', showCustom: false }

const PREVIEW_REMARK_PLUGINS = [remarkGfm]

function safeUrlTransform(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  return defaultUrlTransform(url)
}

/** AskUserBanner 属性接口 */
interface AskUserBannerProps {
  sessionId: string
}

export function AskUserBanner({ sessionId }: AskUserBannerProps): React.ReactElement | null {
  const [allRequests, setAllRequests] = useAtom(allPendingAskUserRequestsAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const requests = allRequests.get(sessionId) ?? []
  const [answers, setAnswers] = React.useState<Map<number, QuestionAnswer>>(new Map())
  const [submitting, setSubmitting] = React.useState(false)
  const [activeTab, setActiveTab] = React.useState(0)
  const [focusedOptIdx, setFocusedOptIdx] = React.useState(-1)

  const request = requests[0] ?? null
  const questions = request?.questions ?? []
  const isTakeover = request?.kind === 'computer_use_takeover'
  const isLastTab = activeTab >= questions.length - 1

  // ===== Refs：确保 keydown handler 始终读取最新值，消除闭包过期问题 =====
  const activeTabRef = React.useRef(activeTab)
  activeTabRef.current = activeTab
  const questionsRef = React.useRef(questions)
  questionsRef.current = questions
  const focusedOptIdxRef = React.useRef(focusedOptIdx)
  focusedOptIdxRef.current = focusedOptIdx
  const submitRef = React.useRef<(() => void) | null>(null)
  const autoAdvanceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearAutoAdvanceTimer = React.useCallback((): void => {
    if (autoAdvanceTimerRef.current != null) {
      clearTimeout(autoAdvanceTimerRef.current)
      autoAdvanceTimerRef.current = null
    }
  }, [])

  const toggleOptionByState = React.useCallback((qIdx: number, q: AskUserQuestion, label: string): void => {
    setAnswers((prev) => {
      const map = new Map(prev)
      const cur = map.get(qIdx) ?? EMPTY_ANSWER
      const selected = q.multiSelect
        ? (cur.selected.includes(label) ? cur.selected.filter((s) => s !== label) : [...cur.selected, label])
        : [label]
      map.set(qIdx, { ...cur, selected, showCustom: false, customText: '' })
      return map
    })
  }, [])

  const toggleCustomByState = React.useCallback((qIdx: number): void => {
    setAnswers((prev) => {
      const map = new Map(prev)
      const cur = map.get(qIdx) ?? EMPTY_ANSWER
      map.set(qIdx, { ...cur, showCustom: !cur.showCustom, selected: cur.showCustom ? cur.selected : [] })
      return map
    })
  }, [])

  // 组件卸载时清理未触发的跳转定时器
  React.useEffect(() => clearAutoAdvanceTimer, [clearAutoAdvanceTimer])

  React.useEffect(() => {
    clearAutoAdvanceTimer()
    setActiveTab(0)
    setFocusedOptIdx(-1)
    const firstOpt = questions[0]?.options[0]
    setAnswers(firstOpt
      ? new Map([[0, { ...EMPTY_ANSWER, selected: [firstOpt.label] }]])
      : new Map())
  }, [clearAutoAdvanceTimer, questions[0]?.options[0]])

  // 切换 Tab 时重置焦点并默认选中第一个选项
  React.useEffect(() => {
    setFocusedOptIdx(-1)
    setAnswers((prev) => {
      if (prev.has(activeTab)) return prev
      const firstOpt = questions[activeTab]?.options[0]
      if (!firstOpt) return prev
      const map = new Map(prev)
      map.set(activeTab, { ...EMPTY_ANSWER, selected: [firstOpt.label] })
      return map
    })
  }, [activeTab, questions])

  // 键盘导航：只在 requestId 变化时重建 handler，内部通过 ref 读取最新值
  React.useEffect(() => {
    if (!request || questions.length === 0) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      const curTab = activeTabRef.current
      const qs = questionsRef.current
      const curFocusIdx = focusedOptIdxRef.current
      const q = qs[curTab]
      if (!q) return
      const itemCount = q.options.length + 1
      const lastTab = curTab >= qs.length - 1

      // 自由文本输入框内：仅 Enter 生效（输入法组合中跳过）
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault()
          if (lastTab) submitRef.current?.()
          else setActiveTab((prev) => prev + 1)
        }
        return
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const nextIdx = curFocusIdx === -1
          ? (e.key === 'ArrowDown' ? 0 : itemCount - 1)
          : e.key === 'ArrowDown'
            ? (curFocusIdx + 1) % itemCount
            : (curFocusIdx - 1 + itemCount) % itemCount
        setFocusedOptIdx(nextIdx)
        // 移动焦点同时选中
        if (nextIdx < q.options.length) {
          const opt = q.options[nextIdx]
          if (opt) toggleOptionByState(curTab, q, opt.label)
        } else {
          toggleCustomByState(curTab)
        }
      } else if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        if (lastTab) submitRef.current?.()
        else setActiveTab((prev) => prev + 1)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [request, toggleCustomByState, toggleOptionByState, questions.length])

  /** 关闭问题 & 终止 Agent */
  const handleDismiss = (): void => {
    // 立即标记 streaming 停止，避免 UI 残留
    setStreamingStates((prev) => {
      const current = prev.get(sessionId)
      if (!current || !current.running) return prev
      const map = new Map(prev)
      map.set(sessionId, {
        ...current,
        running: false,
        ...finalizeStreamingActivities(current.toolActivities),
      })
      return map
    })
    // 清除当前 session 所有待处理的 AskUser 请求
    setAllRequests((prev) => {
      const map = new Map(prev)
      map.delete(sessionId)
      return map
    })
    // 终止 Agent
    window.electronAPI.stopAgent(sessionId).catch(console.error)
  }

  if (!request) return null

  const getAnswer = (idx: number): QuestionAnswer => answers.get(idx) ?? EMPTY_ANSWER

  const buildAnswersRecord = (): Record<string, string> => {
    const answersRecord: Record<string, string> = {}
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      if (!q) continue
      const answer = getAnswer(i)
      const key = q.question || String(i)
      if (answer.showCustom && answer.customText.trim()) {
        answersRecord[key] = answer.customText.trim()
      } else if (answer.selected.length > 0) {
        answersRecord[key] = answer.selected.join(', ')
      }
    }
    return answersRecord
  }

  const handleSubmit = async (skip = false): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      const answersRecord = skip ? {} : buildAnswersRecord()
      await window.electronAPI.respondAskUser({ requestId: request.requestId, answers: answersRecord })
      setAllRequests((prev) => {
        const map = new Map(prev)
        const current = map.get(sessionId) ?? []
        const newValue = current.filter((r) => r.requestId !== request.requestId)
        if (newValue.length === 0) map.delete(sessionId)
        else map.set(sessionId, newValue)
        return map
      })
    } catch (error) {
      console.error('[AskUserBanner] 响应失败:', error)
    } finally {
      setSubmitting(false)
    }
  }

  submitRef.current = () => void handleSubmit(false)

  const hasValidAnswers = questions.some((_, idx) => {
    const a = getAnswer(idx)
    return a.selected.length > 0 || (a.showCustom && a.customText.trim().length > 0)
  })

  const currentQuestion = questions[activeTab]
  if (!currentQuestion) return null

  const goNextTab = (): void => {
    if (!isLastTab) setActiveTab((prev) => prev + 1)
  }

  return (
    <div className={`mx-4 mb-3 rounded-xl bg-card shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-200 border border-border/50 ${isTakeover ? 'ring-1 ring-amber-500/40' : ''}`}>
      {/* 头部 + Tab 栏 */}
      <div className="px-4 pt-3 pb-2">
        <div className="flex items-center justify-between mb-2">
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            {isTakeover && <Hand className="size-4 text-amber-600" />}
            {isTakeover ? '请你接管敏感操作' : 'Proma Agent 需要你的输入'}
          </span>
          <div className="flex items-center gap-1.5">
            {requests.length > 1 && (
              <span className="text-xs text-muted-foreground">(+{requests.length - 1})</span>
            )}
            <button
              type="button"
              className="size-5 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
              onClick={handleDismiss}
              title="关闭并终止 Agent"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>

        {/* Tab 栏（多问题时显示） */}
        {questions.length > 1 && (
          <div className="flex gap-1">
            {questions.map((q, idx) => {
              const isActive = idx === activeTab
              const hasAnswer = getAnswer(idx).selected.length > 0
                || (getAnswer(idx).showCustom && getAnswer(idx).customText.trim().length > 0)
              return (
                <button
                  key={idx}
                  type="button"
                  className={`
                    px-2.5 py-1 rounded-lg text-xs font-medium transition-all outline-none
                    ${isActive
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : hasAnswer
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                    }
                  `}
                  onClick={() => setActiveTab(idx)}
                >
                  {`${idx + 1}-${q.multiSelect ? '多选' : '单选'}：${q.header || `问题 ${idx + 1}`}`}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {isTakeover && (
        <div className="mx-4 mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-200">
          Agent 已暂停。请自行完成密码、验证码、支付、授权或最终提交；不要把敏感信息发给 Agent。完成后选择“我已完成，可继续”。
        </div>
      )}

      {/* 当前问题内容 */}
      <div className="px-4 pb-2">
        <QuestionCard
          question={currentQuestion}
          questionIndex={activeTab}
          answer={getAnswer(activeTab)}
          focusedIndex={focusedOptIdx}
          showBadge={questions.length === 1}
          onToggleOption={(label) => {
            toggleOptionByState(activeTab, currentQuestion, label)
            if (!currentQuestion.multiSelect && !isLastTab) {
              clearAutoAdvanceTimer()
              autoAdvanceTimerRef.current = setTimeout(() => {
                autoAdvanceTimerRef.current = null
                setActiveTab((prev) => prev + 1)
              }, 150)
            }
          }}
          onToggleCustom={() => toggleCustomByState(activeTab)}
          onCustomTextChange={(text) => setAnswers((prev) => {
            const map = new Map(prev)
            const cur = map.get(activeTab) ?? EMPTY_ANSWER
            map.set(activeTab, { ...cur, customText: text })
            return map
          })}
          onSubmit={isLastTab ? () => void handleSubmit(false) : goNextTab}
        />
      </div>

      {/* 底部 */}
      <div className="flex items-center justify-between gap-2 px-4 pb-3">
        <span className="text-[10px] text-muted-foreground/40">
          ↑↓ 选择 · Enter {isLastTab ? '提交' : '下一个'}
        </span>
        <div className="flex items-center gap-1.5">
          {isLastTab && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleSubmit(true)}
                disabled={submitting}
                className="h-7 px-3 text-xs text-muted-foreground hover:text-foreground"
              >
                跳过
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => void handleSubmit(false)}
                disabled={submitting || !hasValidAnswers}
                className="h-7 px-3 text-xs"
              >
                {isTakeover ? '完成并继续' : '提交'}
                <ArrowRight className="size-3 ml-1" />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** 单个问题卡片（卡片式 Radio / Checkbox） */
function QuestionCard({
  question,
  questionIndex,
  answer,
  focusedIndex,
  showBadge,
  onToggleOption,
  onToggleCustom,
  onCustomTextChange,
  onSubmit,
}: {
  question: AskUserQuestion
  questionIndex: number
  answer: QuestionAnswer
  focusedIndex: number
  showBadge: boolean
  onToggleOption: (label: string) => void
  onToggleCustom: () => void
  onCustomTextChange: (text: string) => void
  onSubmit: () => void
}): React.ReactElement {
  const optionCount = question.options.length
  const previewOption = focusedIndex >= 0 && focusedIndex < optionCount
    ? question.options[focusedIndex]
    : question.options.find((o) => answer.selected.includes(o.label))
  const previewContent = previewOption?.preview

  return (
    <div className="space-y-2">
      {/* 问题标签 + 文本（分行显示） */}
      <div className="space-y-1">
        {showBadge && (
          <span className="shrink-0 inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium bg-primary text-primary-foreground shadow-sm">
            {`${questionIndex + 1}-${question.multiSelect ? '多选' : '单选'}${question.header ? `：${question.header}` : ''}`}
          </span>
        )}
        <p className="text-sm text-foreground">{question.question}</p>
      </div>

      {/* 选项卡片列表 */}
      <div className="flex flex-col gap-1.5">
        {question.options.map((option, idx) => {
          const isSelected = answer.selected.includes(option.label)
          const isFocused = focusedIndex === idx
          return (
            <OptionRow
              key={option.label}
              index={idx}
              multiSelect={!!question.multiSelect}
              selected={isSelected}
              focused={isFocused}
              label={option.label}
              description={option.description}
              onClick={() => onToggleOption(option.label)}
            />
          )
        })}

        {/* "其他" */}
        <OptionRow
          index={optionCount}
          multiSelect={!!question.multiSelect}
          selected={answer.showCustom}
          focused={focusedIndex === optionCount}
          label="其他..."
          onClick={onToggleCustom}
        />
      </div>

      {/* 自由文本输入 */}
      {answer.showCustom && (
        <input
          type="text"
          className="w-full px-3 py-2 rounded-lg text-xs bg-muted/40 focus:bg-muted/60 focus:outline-none focus:ring-2 focus:ring-primary/30 placeholder:text-muted-foreground/40 transition-colors"
          placeholder="输入自定义答案..."
          value={answer.customText}
          onChange={(e) => onCustomTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              e.stopPropagation() // 阻止冒泡到 document handler，避免重复触发 setActiveTab
              onSubmit()
            }
          }}
          autoFocus
        />
      )}

      {/* 选项 Preview（聚焦或选中时展示） */}
      {previewContent && (
        <div className="mt-2 rounded-lg bg-muted/40 p-3 text-xs prose prose-sm dark:prose-invert max-w-none prose-p:my-0 prose-headings:my-0.5 prose-li:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Markdown remarkPlugins={PREVIEW_REMARK_PLUGINS} urlTransform={safeUrlTransform}>
            {previewContent}
          </Markdown>
        </div>
      )}
    </div>
  )
}

/** 选项卡片行（Radio / Checkbox） */
function OptionRow({
  index,
  multiSelect,
  selected,
  focused,
  label,
  description,
  onClick,
}: {
  index: number
  multiSelect: boolean
  selected: boolean
  focused: boolean
  label: string
  description?: string
  onClick: () => void
}): React.ReactElement {
  const Indicator = multiSelect
    ? (selected ? CheckSquare2 : Square)
    : (selected ? CheckCircle2 : Circle)

  return (
    <button
      type="button"
      className={`
        group flex items-start gap-3 w-full px-3 py-2.5 rounded-lg border text-left transition-all outline-none
        ${selected
          ? 'bg-primary/5 border-primary text-primary-foreground shadow-sm'
          : 'bg-card border-border/60 text-foreground/80 hover:border-primary/40 hover:bg-muted/30'
        }
        ${focused ? 'ring-2 ring-primary/40 ring-offset-1 ring-offset-card' : ''}
      `}
      onClick={onClick}
    >
      <span className={`mt-0.5 shrink-0 ${selected ? 'text-primary' : 'text-muted-foreground/50 group-hover:text-primary/60'}`}>
        <Indicator className="size-4" />
      </span>
      <div className="flex-1 min-w-0">
        <div className={`text-xs font-medium ${selected ? 'text-foreground' : 'text-foreground/90'}`}>
          {label}
        </div>
        {description && (
          <div className={`text-[11px] mt-0.5 leading-relaxed ${selected ? 'text-primary/80' : 'text-muted-foreground'}`}>
            {description}
          </div>
        )}
      </div>
      <span className={`text-[10px] shrink-0 mt-0.5 ${selected ? 'text-primary/60' : 'text-muted-foreground/40'}`}>
        {index + 1}
      </span>
    </button>
  )
}
