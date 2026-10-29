import type { OwnerManagementMessage } from '@gravitas/shared'
import { extractDeliveredHtml } from './OwnerDeliveredArtifact'

export function designDeliveryAnchor(messageId: string, stepKey: string, artifactHash: string): string {
  return `owner-design-${encodeURIComponent(JSON.stringify([messageId, stepKey, artifactHash]))}`
}

/** 目录仅指向已保存的交付消息；预览和引用仍使用原成果内容与标识。 */
export function OwnerDesignHistory({ messages }: { messages: readonly OwnerManagementMessage[] }): React.ReactElement | null {
  const versions = messages.flatMap(message => message.role === 'assistant' && message.kind === 'delivery'
    ? (message.delivery?.items ?? []).filter(item => extractDeliveredHtml(item.content)).map(item => ({ message, item })) : []).reverse()
  if (!versions.length) return null
  return <details className="rounded-xl bg-background/70 p-4 shadow-sm" aria-label="设计成果版本">
    <summary className="cursor-pointer text-sm font-medium">设计成果版本 · {versions.length}</summary>
    <p className="mt-2 text-xs text-muted-foreground">选择已交付的版本查看原文、预览和修改意见；历史版本不会自动覆盖当前成果。</p>
    <ol className="mt-3 max-h-64 space-y-2 overflow-y-auto">{versions.map(({ message, item }) => <li key={JSON.stringify([message.id, item.stepKey, item.artifactHash])}>
      <button type="button" className="w-full rounded-lg bg-muted/50 p-3 text-left text-sm hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => {
        const target = document.getElementById(designDeliveryAnchor(message.id, item.stepKey, item.artifactHash))
        target?.scrollIntoView({ behavior: 'smooth', block: 'center' }); target?.focus({ preventScroll: true })
      }}>
        <span className="block font-medium">{item.title}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{new Date(message.createdAt).toLocaleString()} · 方案版本 {message.delivery!.planVersion} · {item.artifactHash.slice(0, 12)}</span>
      </button>
    </li>)}</ol>
  </details>
}
