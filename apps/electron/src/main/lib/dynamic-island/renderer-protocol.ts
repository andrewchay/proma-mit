/**
 * 灵动岛渲染协议工具（无 electron 依赖，可单测）。
 *
 * 三层之间统一用「JSON + 换行」按行传输：
 * - 主进程 → 渲染子进程 stdin：serializeCmd
 * - 渲染子进程 → 主进程 stdout：parseStdout（按行解析，容忍粘包/拆包）
 */

/** 序列化一条命令为「JSON + 换行」 */
export function serializeCmd(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`
}

/** 按行解析 stdout；prevBuffer=上次残留，chunk=新数据。返回剩余缓冲 + 解析出的事件。 */
export function parseStdout(
  prevBuffer: string,
  chunk: string,
): { buffer: string; events: Record<string, unknown>[] } {
  const lines = (prevBuffer + chunk).split('\n')
  const buffer = lines.pop() ?? ''
  const events: Record<string, unknown>[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length !== 0) {
      try {
        events.push(JSON.parse(trimmed) as Record<string, unknown>)
      } catch {
        // 解析失败静默丢弃
      }
    }
  }
  return { buffer, events }
}
