import type { ContextItem, ContextRepresentation } from '@gravitas/shared'
import { isVerified } from './context-policy'

export interface RenderedContextItem {
  representation: ContextRepresentation
  block: string
}

/**
 * 将一个 item 的单一 representation 渲染为可审阅 prompt block。
 * Projector 每个 item 只调用一次，避免 summary/full 在同一层无标记重复。
 */
export function renderContextItem(item: ContextItem, representation: ContextRepresentation): RenderedContextItem {
  const content = representation === 'summary'
    ? item.summary ?? item.content
    : representation === 'locator'
      ? renderLocator(item)
      : item.content
  const markers = representation === 'summary'
    ? ['[SUMMARY]', classificationMarker(item)]
    : [classificationMarker(item)]

  return {
    representation,
    block: `${markers.join('')} id=${item.id} kind=${item.kind}\n${content}`,
  }
}

function classificationMarker(item: ContextItem): '[FACT]' | '[INFERENCE]' | '[UNVERIFIED]' {
  if (isVerified(item)) return '[FACT]'
  if (item.evidence.some((evidence) => !evidence.verified) || item.evidence.length === 0) return '[UNVERIFIED]'
  return '[INFERENCE]'
}

function renderLocator(item: ContextItem): string {
  const locators = item.evidence.flatMap((evidence) => evidence.locator ? [evidence.locator] : [])
  return locators.length > 0
    ? `来源定位：${locators.join(', ')}`
    : `来源标识：${item.source.kind}:${item.source.id}`
}
