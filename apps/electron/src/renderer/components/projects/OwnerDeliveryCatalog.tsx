import type { OwnerManagementMessage } from '@gravitas/shared'

/** Owner 交付消息与项目交付链是不同记录；目录保持准确来源与版本。 */
export function OwnerDeliveryCatalog({ messages, loading, error, onSelect }: { messages: readonly OwnerManagementMessage[]; loading: boolean; error: string; onSelect: (reference: { messageId: string; stepKey: string; artifactHash: string }) => void }): React.ReactElement {
  const deliveries = messages.filter(message => message.kind === 'delivery' && message.delivery).slice().reverse()
  return <section aria-label="Owner 已交付成果" className="space-y-3">
    <h3 className="text-base font-semibold">Owner 已交付成果</h3>
    {loading ? <p className="text-sm text-muted-foreground">正在读取成果…</p> : error ? <p role="alert" className="text-sm text-destructive">成果读取失败，请重新读取 Owner 对话。</p> : deliveries.length ? deliveries.flatMap(message => (message.delivery?.items ?? []).map(item => <button key={JSON.stringify([message.id, item.stepKey, item.artifactHash])} type="button" className="block w-full rounded-xl bg-card p-4 text-left shadow-sm hover:bg-muted/40" onClick={() => onSelect({ messageId: message.id, stepKey: item.stepKey, artifactHash: item.artifactHash })}>
      <span className="block text-sm font-medium">{item.title}</span><span className="mt-1 block text-xs text-muted-foreground">方案 v{message.delivery?.planVersion} · {new Date(message.createdAt).toLocaleString('zh-CN')} · 版本 {item.artifactHash.slice(0, 12)}</span>
    </button>)) : <p className="text-sm text-muted-foreground">尚无 Owner 已交付成果。项目交付链记录见下方。</p>}
  </section>
}
