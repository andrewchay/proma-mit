import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { OwnerManagementMessage } from '@gravitas/shared'
import { OwnerDesignHistory, designDeliveryAnchor } from './OwnerDesignHistory'

test('Given 多次设计交付 When 展示版本目录 Then 仅列出HTML成果并保留每次交付的标识', () => {
  const item = { stepKey: 'design', title: '页面', artifactHash: 'a'.repeat(64), content: '```html\n<!DOCTYPE html><html></html>\n```', acceptanceCriteria: [], ownerDecision: '', reviewerSummary: '' }
  const message: OwnerManagementMessage = { id: 'm1', projectId: 'p', conversationId: 'c', eventId: 'e', role: 'assistant', kind: 'delivery', content: '', createdAt: 1, delivery: { schemaVersion: 1, planVersion: 1, items: [item, { ...item, stepKey: 'text', content: '普通文本' }] } }
  const later = { ...message, id: 'm2', createdAt: 2, delivery: { ...message.delivery!, planVersion: 2, items: [{ ...item, artifactHash: 'b'.repeat(64) }] } }
  const html = renderToStaticMarkup(createElement(OwnerDesignHistory, { messages: [message, later] }))
  expect(html).toContain('设计成果版本 · 2')
  expect(html).toContain('bbbbbbbbbbbb')
  expect(html).toContain('aaaaaaaaaaaa')
  expect(html.indexOf('bbbbbbbbbbbb')).toBeLessThan(html.indexOf('aaaaaaaaaaaa'))
  expect(designDeliveryAnchor('a-b', 'c', 'x')).not.toBe(designDeliveryAnchor('a', 'b-c', 'x'))
})
