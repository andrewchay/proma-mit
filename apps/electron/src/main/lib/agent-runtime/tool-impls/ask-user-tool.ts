/**
 * AskUserQuestion 工具（Provider-Agnostic Runtime）
 *
 * 允许 Agent 在运行中向用户发起交互式提问，等待用户回答后继续。
 * 结果以 JSON 形式返回给模型，便于模型解析 answers 字段。
 */

import type { ToolResult } from '@proma/core'
import type { AskUserQuestion, AskUserQuestionOption } from '@proma/shared'
import type { ToolContext } from '../types'

export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

export function createAskUserQuestionToolDefinition() {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    description:
      '向用户提出一个或多个问题以澄清需求或收集必要信息。问题可以包含单选/多选选项。调用后必须等待用户回答，answers 会出现在工具结果中。',
    parameters: {
      type: 'object' as const,
      properties: {
        questions: {
          type: 'array',
          description: '问题列表',
          items: {
            type: 'object',
            properties: {
              question: {
                type: 'string',
                description: '问题内容',
              },
              header: {
                type: 'string',
                description: '短标签/标题',
              },
              multiSelect: {
                type: 'boolean',
                description: '是否允许多选（仅当提供 options 时有效）',
              },
              options: {
                type: 'array',
                description: '可选项列表',
                items: {
                  type: 'object',
                  properties: {
                    label: {
                      type: 'string',
                      description: '选项显示文本',
                    },
                    description: {
                      type: 'string',
                      description: '选项说明',
                    },
                    preview: {
                      type: 'string',
                      description: '选项预览内容',
                    },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
  }
}

export async function executeAskUserQuestionTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.onAskUser) {
    return {
      toolCallId: '',
      content: '当前 Runtime 未配置 AskUser 回调，无法发起提问',
      isError: true,
    }
  }

  const questions = parseQuestions(input)
  if (questions.length === 0) {
    return {
      toolCallId: '',
      content: '未提供有效问题',
      isError: true,
    }
  }

  const signal = ctx.abortSignal ?? new AbortController().signal
  const result = await ctx.onAskUser(input as Record<string, unknown>, signal)

  if (result.behavior === 'deny') {
    return {
      toolCallId: '',
      content: result.message || '用户拒绝了提问',
      isError: true,
    }
  }

  const answers = result.answers ?? {}
  const answerBlocks = questions
    .map((q, index) => {
      const key = String(index)
      const answer = answers[key] ?? answers[q.question] ?? '(未回答)'
      return `Q: ${q.question}\nA: ${answer}`
    })
    .join('\n\n')

  return {
    toolCallId: '',
    content: `用户回答如下：\n\n${answerBlocks}\n\nanswers JSON: ${JSON.stringify(answers)}`,
    isError: false,
  }
}

function parseQuestions(input: unknown): AskUserQuestion[] {
  if (!input || typeof input !== 'object') return []
  const rawQuestions = (input as Record<string, unknown>).questions
  if (!Array.isArray(rawQuestions)) return []

  return rawQuestions.map((q: unknown): AskUserQuestion => {
    const raw = q as Record<string, unknown>
    const rawOptions = Array.isArray(raw.options) ? raw.options : []
    const options: AskUserQuestionOption[] = rawOptions.map((o: unknown) => {
      const opt = o as Record<string, unknown>
      return {
        label: typeof opt.label === 'string' ? opt.label : '',
        description: typeof opt.description === 'string' ? opt.description : undefined,
        preview: typeof opt.preview === 'string' ? opt.preview.slice(0, 10_000) : undefined,
      }
    })

    return {
      question: typeof raw.question === 'string' ? raw.question : '',
      header: typeof raw.header === 'string' ? raw.header : undefined,
      options,
      multiSelect: raw.multiSelect === true,
    }
  })
}
