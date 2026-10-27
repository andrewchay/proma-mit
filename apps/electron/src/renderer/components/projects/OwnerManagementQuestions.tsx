import { useEffect, useMemo } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { getOwnerMessageComposer, ownerMessageComposersAtom, editOwnerMessageAtom, answerOwnerManagementQuestionAtom, editOwnerManagementAnswerAtom, getOwnerManagementEditor, loadOwnerManagementAtom, ownerManagementEditorsAtom } from '../../atoms/project-owner-management-atoms'

/** 问题及答复均来自持久会话；保存后由后台推进，不依赖当前组件继续挂载。 */
export function OwnerManagementQuestions({ projectId, taskId, embedded = false }: { projectId: string; taskId?: string; embedded?: boolean }): React.ReactElement | null {
  const viewAtom = useMemo(() => atom(get => getOwnerManagementEditor(get(ownerManagementEditorsAtom), projectId)), [projectId])
  const editor = useAtomValue(viewAtom)
  const compose = useSetAtom(editOwnerMessageAtom), composers = useAtomValue(ownerMessageComposersAtom)
  const subject = { projectId, ...(taskId ? { taskId } : {}) }
  const suggestAnswer = (text: string) => { const draft = getOwnerMessageComposer(composers, subject).text; compose({ subject, text: draft.trim() ? `${draft}\n${text}` : text }) }
  const load = useSetAtom(loadOwnerManagementAtom), edit = useSetAtom(editOwnerManagementAnswerAtom), answer = useSetAtom(answerOwnerManagementQuestionAtom)
  useEffect(() => {
    if (embedded) return
    void load(projectId)
    const refresh = () => { void load(projectId) }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [load, projectId, embedded])
  const questions = editor.view?.questions.filter(question => question.state === 'open' && question.taskId === taskId) ?? []
  const stale = editor.view?.questions.filter(question => question.state === 'stale' && question.taskId === taskId) ?? []
  if (!questions.length && !stale.length && !editor.error) return null
  return <section className="space-y-4" aria-label="Owner主动协商">
    {editor.error && <div className="rounded-xl bg-destructive/10 p-3 text-sm"><p role="alert">{editor.error}</p><button type="button" className="mt-2 underline" onClick={() => void load(projectId)}>重新读取对话（保留答复）</button></div>}
    {stale.map(question => <details key={question.id} className="rounded-xl bg-muted/40 p-3 text-sm"><summary className="cursor-pointer">此前问题的来源已变化（只读）</summary><p className="mt-2 text-xs text-muted-foreground">目标、配置或较新的规划请求已变化，旧答复不会套用到当前方案。</p><p className="mt-2">{question.reason}</p>{question.questions.map(item => <p key={item.key} className="mt-1">{item.question}</p>)}</details>)}
    {questions.map(question => <form key={question.id} className="space-y-3 rounded-2xl bg-primary/5 p-4 shadow-sm" onSubmit={event => { event.preventDefault(); void answer({ projectId, questionId: question.id }) }}>
      <h3 className="font-medium">有件事需要和你确认</h3><p className="text-sm leading-6">{question.reason}</p>
      {embedded && <div className="space-y-3 text-sm"><p className="text-muted-foreground">直接在下方对话告诉我你的选择或想法，我会整理理解供你确认。</p>{question.questions.map(item => <div key={item.key} className="space-y-2"><p className="font-medium">{item.question}</p><p className="text-xs text-muted-foreground">{item.why}{item.recommended ? ` · 建议：${item.recommended}` : ''}</p>{item.options.length > 0 && <div className="flex flex-wrap gap-2">{item.options.map(option => <button type="button" key={option} className="rounded-lg bg-background px-3 py-2 shadow-sm" onClick={() => suggestAnswer(`${item.question}：${option}`)}>{option}</button>)}</div>}</div>)}</div>}
      <details open={!embedded}><summary className={embedded ? 'cursor-pointer text-xs text-muted-foreground' : 'hidden'}>逐项填写答复（可选）</summary>
      <fieldset disabled={editor.savingQuestionId !== null} className="space-y-4">
        {question.questions.map(item => <div key={item.key} className="space-y-2">
          <label className="block text-sm font-medium" htmlFor={`owner-question-${question.id}-${item.key}`}>{item.question}</label>
          <p className="text-xs leading-5 text-muted-foreground">{item.why}{item.recommended ? ` · 建议：${item.recommended}` : ''}</p>
          {item.sourceReferences?.map(source => <blockquote key={source.sourceId} className="rounded-lg bg-background p-2 text-xs">{source.quote}</blockquote>)}
          {item.options.length > 0 && <div className="flex flex-wrap gap-2">{item.options.map(option => <button type="button" key={option} className="rounded-lg bg-background px-3 py-2 text-sm shadow-sm" aria-pressed={editor.drafts[question.id]?.[item.key] === option} onClick={() => edit({ projectId, questionId: question.id, key: item.key, value: option })}>{option}</button>)}</div>}
          <textarea id={`owner-question-${question.id}-${item.key}`} className="w-full rounded-xl bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" rows={2} required maxLength={1800} value={editor.drafts[question.id]?.[item.key] ?? ''} onChange={event => edit({ projectId, questionId: question.id, key: item.key, value: event.target.value })} placeholder="也可以直接说明你的想法" />
        </div>)}
        <button type="submit" className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={!question.questions.every(item => editor.drafts[question.id]?.[item.key]?.trim())}>{editor.savingQuestionId === question.id ? '正在保存答复…' : '答复，让 Owner 继续'}</button>
      </fieldset></details>
    </form>)}
  </section>
}
