/** 设计修改与交接准备共用草稿级串行锁，防止交接遗漏正在生成的封面。 */
const tails = new Map<string, Promise<void>>()

export async function withDirectorDraftLock<T>(draftId: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(draftId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  tails.set(draftId, current)
  await previous
  try { return await operation() }
  finally {
    release()
    if (tails.get(draftId) === current) tails.delete(draftId)
  }
}
