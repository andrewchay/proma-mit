import { expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectOwnerDeliveryConversation } from './ProjectOwnerDeliveryConversation'

function render(ownerConversation: boolean): string {
  return renderToStaticMarkup(createElement(Provider, { store: createStore() }, createElement(ProjectOwnerDeliveryConversation, {
    projectId: 'project-1', managed: true, singleConfirmation: true, ownerConversation,
  })))
}

test('Given Owner普通对话 When展示交付确认 Then不暴露流程刷新和诊断入口', () => {
  const ownerMarkup = render(true)
  expect(ownerMarkup).not.toContain('重新读取流程状态')
  expect(ownerMarkup).not.toContain('登记与核验高级记录')
  expect(ownerMarkup).not.toContain('完整登记范围与现有任务变更')

  const managementMarkup = render(false)
  expect(managementMarkup).toContain('重新读取流程状态')
  expect(managementMarkup).toContain('登记与核验高级记录')
})
