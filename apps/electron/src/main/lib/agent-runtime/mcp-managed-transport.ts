import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { startManagedMcpProcess, type ManagedMcpProcess, type ManagedMcpProcessOptions, type ManagedMcpStopResult } from './mcp-managed-process'

/** 受管进程的 stdio 协议适配；尚未作为默认 MCP transport 启用。 */
export class ManagedMcpStdioTransport implements Transport {
  onclose?: Transport['onclose']
  onerror?: Transport['onerror']
  onmessage?: Transport['onmessage']
  stopResult?: ManagedMcpStopResult
  private readonly buffer = new ReadBuffer()
  private managed?: ManagedMcpProcess
  private starting?: Promise<ManagedMcpProcess>
  private started = false
  private closed = false
  private closing?: Promise<void>

  constructor(private readonly options: ManagedMcpProcessOptions) {}

  get pid(): number | null { return this.managed?.pid ?? null }

  async start(): Promise<void> {
    if (this.started) throw new Error('受管 MCP transport 已启动')
    this.started = true
    this.starting = startManagedMcpProcess(this.options)
    const managed = await this.starting
    this.managed = managed
    if (this.closed) { await managed.close(); return }
    // 避免无人读取 stderr 时阻塞服务；不将服务输出写入应用日志。
    managed.stderr.resume()
    managed.stdout.on('data', (chunk: Buffer) => {
      try { this.buffer.append(chunk) } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
        void this.close()
        return
      }
      for (;;) {
        try {
          const message = this.buffer.readMessage()
          if (!message) break
          if ('method' in message && message.method === 'notifications/gravitas-supervisor-eof' &&
            message.params && message.params.token === managed.eofToken) {
            void this.close()
            break
          }
          this.onmessage?.(message)
        } catch (error) { this.onerror?.(error instanceof Error ? error : new Error(String(error))) }
      }
    })
    managed.stdout.on('error', (error: Error) => this.onerror?.(error))
    managed.stdin.on('error', (error: Error) => this.onerror?.(error))
    managed.stdout.once('end', () => { void this.close().catch((error: unknown) => this.onerror?.(error instanceof Error ? error : new Error(String(error)))) })
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const managed = this.managed
    if (!managed || this.closed) throw new Error('受管 MCP 连接不可用')
    await new Promise<void>((resolve, reject) => {
      managed.stdin.write(serializeMessage(message), (error?: Error | null) => error ? reject(error) : resolve())
    })
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = (async () => {
      const managed = this.managed ?? await this.starting?.catch(() => undefined)
      if (managed) this.stopResult = await managed.close()
      this.buffer.clear()
      this.onclose?.()
    })()
    return this.closing
  }
}
