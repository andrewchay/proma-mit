import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { AskUserRequest } from '@gravitas/shared'
import { allPendingAskUserRequestsAtom } from '@/atoms/agent-atoms'
import { AskUserBanner } from './AskUserBanner'

function render(request: AskUserRequest): string {
  const store = createStore()
  store.set(allPendingAskUserRequestsAtom, new Map([[request.sessionId, [request]]]))
  return renderToStaticMarkup(createElement(Provider, { store }, createElement(AskUserBanner, { sessionId: request.sessionId })))
}

test('Given 未知动作结果待核对 When 显示AskUser横幅 Then 明确警示动作可能已生效并要求独立核对', () => {
  const request: AskUserRequest = {
    requestId: 'unknown-action-1',
    sessionId: 'owner-session',
    kind: 'unknown_action_resolution',
    questions: [{
      question: '请核对动作是否已生效',
      header: '未知动作待核对',
      options: [{ label: '未生效，允许重试' }, { label: '已生效，继续拦截' }],
    }],
    toolInput: { interactionType: 'unknown_action_resolution' },
  }

  const html = render(request)

  expect(html).toContain('未知动作需要人工核对')
  expect(html).toContain('动作可能已经生效')
  expect(html).toContain('到目标系统独立核对')
})
