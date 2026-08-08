/**
 * FileMentionSuggestion — TipTap Mention Suggestion 配置
 *
 * 工厂函数，创建用于 @ 引用文件的 TipTap Suggestion 配置。
 * 输入 @ 后异步搜索工作区文件，弹出 FileMentionList 浮动列表。
 * 弹窗底部锚定在光标上方，展开文件夹时向上生长。
 */

import type React from 'react'
import { ReactRenderer } from '@tiptap/react'
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion'
import { toast } from 'sonner'
import { FileMentionList } from './FileMentionList'
import type { FileMentionRef } from './FileMentionList'
import type { FileIndexEntry, FileSearchResult, MemberResult } from '@gravitas/shared'
import { createMentionPopup, positionPopup } from '@/components/agent/mention-popup-utils'
import { resolveTriggerContext, shouldAllowMentionTrigger } from '@/components/ai-elements/mention-utils'

export function createFileMentionSuggestion(
  workspacePathRef: React.RefObject<string | null>,
  mentionActiveRef: React.MutableRefObject<boolean>,
  attachedDirsRef?: React.RefObject<string[]>,
  mentionItemCountRef?: React.MutableRefObject<number>,
  sessionAttachedDirsRef?: React.RefObject<string[]>,
): Omit<SuggestionOptions<FileIndexEntry>, 'editor'> {
  let lastResult: FileSearchResult | null = null
  let lastEmployees: MemberResult[] = []
  let missingWorkspaceToastShown = false

  return {
    char: '@',
    allowSpaces: false,

    // 防误触发：输入/粘贴邮箱或 npm scope 等场景中，@ 是普通字符，不弹文件引用。
    shouldShow: ({ transaction, range }) => {
      const uiEvent = transaction.getMeta('uiEvent')
      if (uiEvent === 'paste' || uiEvent === 'drop') return false
      const ctx = resolveTriggerContext(transaction.doc, range.from)
      if (!ctx) return true
      return shouldAllowMentionTrigger({
        paragraphText: ctx.paragraphText,
        triggerOffset: ctx.triggerOffset,
        trigger: '@',
      })
    },

    items: async ({ query }): Promise<FileIndexEntry[]> => {
      // @goal 是 Agent 的保留命令，不能被同名文件引用覆盖。
      if (query.trim().toLowerCase() === 'goal') return []
      const wsPath = workspacePathRef.current
      if (!wsPath) {
        console.warn('[FileMention] workspacePath is null, mention disabled')
        if (!missingWorkspaceToastShown) {
          toast.warning('暂时无法引用文件', {
            description: '当前 Agent 会话没有可用的工作区路径。请在顶部选择工作区，或新建 Agent 会话后重试。',
          })
          missingWorkspaceToastShown = true
        }
        return []
      }
      missingWorkspaceToastShown = false

      try {
        const additionalPaths = attachedDirsRef?.current ?? []
        const sessionPaths = sessionAttachedDirsRef?.current ?? []

        const [result, employees] = await Promise.all([
          window.electronAPI.searchWorkspaceFiles(
            wsPath,
            query ?? '',
            200,
            additionalPaths.length > 0 ? additionalPaths : undefined,
            sessionPaths.length > 0 ? sessionPaths : undefined,
          ),
          // AI 员工作为 @ 引用的另一种来源；名称/角色按查询词过滤。
          window.electronAPI.paa.project.listMemberDirectory({ kind: 'agent', q: query ?? '' }).catch(() => [] as MemberResult[]),
        ])
        lastResult = result
        lastEmployees = employees
        return result.entries
      } catch(e) {
        console.error('[FileMention] search failed:', e)
        lastResult = null
        lastEmployees = []
        return []
      }
    },

    render: () => {
      let renderer: ReactRenderer<FileMentionRef> | null = null
      let popup: HTMLDivElement | null = null
      let resizeObserver: ResizeObserver | null = null
      let latestClientRect: (() => DOMRect | null) | null | undefined = null

      function splitEntries(result: FileSearchResult | null) {
        return {
          sessionEntries: result?.sessionEntries ?? [],
          workspaceEntries: result?.workspaceEntries ?? [],
        }
      }

      function createRenderer(props: SuggestionProps<FileIndexEntry>) {
        const { sessionEntries, workspaceEntries } = splitEntries(lastResult)
        renderer = new ReactRenderer(FileMentionList, {
          props: {
            sessionEntries,
            workspaceEntries,
            employeeEntries: lastEmployees,
            onSelect: (item: { name: string; path: string; type: 'file' | 'dir' }) => {
              props.command({ id: item.path, label: item.name })
            },
            onSelectEmployee: (member: MemberResult) => {
              // 员工引用：id = memberId（agent-*），referenceType 标记为 agent_employee。
              props.command({
                id: member.memberId,
                label: member.displayName,
                mentionSuggestionChar: '@',
                referenceType: 'agent_employee',
              } as Record<string, unknown>)
            },
          },
          editor: props.editor,
        })
      }

      function anchorPopup() {
        if (!popup) return
        positionPopup(popup, latestClientRect?.(), { anchorBottom: true })
      }

      return {
        onStart(props) {
          mentionActiveRef.current = true
          if (mentionItemCountRef) mentionItemCountRef.current = props.items.length

          try {
            latestClientRect = props.clientRect
            createRenderer(props)
            popup = createMentionPopup(renderer!.element)
            anchorPopup()

            resizeObserver = new ResizeObserver(() => {
              anchorPopup()
            })
            resizeObserver.observe(popup!)
          } catch (e) {
            console.error('[FileMention] render popup failed:', e)
          }
        },

        onUpdate(props) {
          if (mentionItemCountRef) mentionItemCountRef.current = props.items.length
          latestClientRect = props.clientRect

          const { sessionEntries, workspaceEntries } = splitEntries(lastResult)
          renderer?.updateProps({
            sessionEntries,
            workspaceEntries,
            employeeEntries: lastEmployees,
            onSelect: (item: { name: string; path: string; type: 'file' | 'dir' }) => {
              props.command({ id: item.path, label: item.name })
            },
            onSelectEmployee: (member: MemberResult) => {
              props.command({
                id: member.memberId,
                label: member.displayName,
                mentionSuggestionChar: '@',
                referenceType: 'agent_employee',
              } as Record<string, unknown>)
            },
          })
          anchorPopup()
        },

        onKeyDown(props) {
          if (renderer?.ref) {
            return renderer.ref.onKeyDown({ event: props.event })
          }
          return false
        },

        onExit() {
          mentionActiveRef.current = false
          if (mentionItemCountRef) mentionItemCountRef.current = 0
          lastResult = null
          lastEmployees = []
          latestClientRect = null
          resizeObserver?.disconnect()
          resizeObserver = null
          popup?.remove()
          popup = null
          renderer?.destroy()
          renderer = null
        },
      }
    },
  }
}
