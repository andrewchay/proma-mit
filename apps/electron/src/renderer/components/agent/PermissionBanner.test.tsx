import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { PermissionRequest } from '@gravitas/shared'
import { allPendingPermissionRequestsAtom } from '../../atoms/agent-atoms'
import { PermissionBanner } from './PermissionBanner'

function render(request: PermissionRequest): string {
  const store = createStore()
  store.set(allPendingPermissionRequestsAtom, new Map([[request.sessionId, [request]]]))
  return renderToStaticMarkup(createElement(Provider, { store }, createElement(PermissionBanner, { sessionId: request.sessionId })))
}

test('Given Owner敏感工具待审批 When渲染权限横幅 Then显示精确参数且没有总是允许或批量放行', () => {
  const request: PermissionRequest = {
    requestId: 'owner-action-1',
    requiresPerActionApproval: true,
    sessionId: 'owner-session',
    toolName: 'Write',
    toolInput: { file_path: '/tmp/synthetic-output.md', content: 'synthetic only' },
    description: '写入合成测试文件',
    dangerLevel: 'dangerous',
  }

  const html = render(request)

  expect(html).toContain('Owner 动作需要逐次确认')
  expect(html).toContain('只批准下面这一次精确操作')
  expect(html).toContain('/tmp/synthetic-output.md')
  expect(html).toContain('synthetic only')
  expect(html).toContain('拒绝')
  expect(html).toContain('允许')
  expect(html).not.toContain('始终允许')
  expect(html).not.toContain('全部允许')
})

test('Given普通工具待审批 When渲染权限横幅 Then保留既有会话白名单选项', () => {
  const request: PermissionRequest = {
    requestId: 'ordinary-action-1',
    sessionId: 'ordinary-session',
    toolName: 'Read',
    toolInput: { file_path: '/tmp/readme.md' },
    description: '读取文件',
    dangerLevel: 'normal',
  }

  expect(render(request)).toContain('始终允许')
})
