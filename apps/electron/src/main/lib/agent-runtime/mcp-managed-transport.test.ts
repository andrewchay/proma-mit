import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ManagedMcpStdioTransport } from './mcp-managed-transport'

describe('受管 MCP stdio 传输', () => {
  test.skipIf(process.platform === 'win32')('Given 受管本地服务 When 完成握手与工具查询 Then 协议可用且关闭后保留未确认边界', async () => {
    const server = `
      const readline = require('node:readline')
      const input = readline.createInterface({ input: process.stdin })
      input.on('line', line => {
        const request = JSON.parse(line)
        if (request.id === undefined) return
        const result = request.method === 'initialize'
          ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
          : { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
      })
    `
    const transport = new ManagedMcpStdioTransport({ command: process.execPath, args: ['-e', server], cwd: process.cwd(), env: { ...process.env } })
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} })
    try {
      await client.connect(transport)
      expect((await client.listTools()).tools.map((item) => item.name)).toContain('echo')
    } finally {
      await client.close()
    }
    expect(transport.stopResult?.status).toBe('unconfirmed')
  }, 15_000)
  test.skipIf(process.platform === 'win32')('Given 服务启动后立即退出 When 监听关闭 Then 调用方收到关闭而不是挂起', async () => {
    const transport = new ManagedMcpStdioTransport({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(), env: { ...process.env } })
    let closed = false
    transport.onclose = () => { closed = true }
    await transport.start()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(closed).toBe(true)
    expect(transport.stopResult?.status).toBe('unconfirmed')
  }, 10_000)

  test.skipIf(process.platform === 'win32')('Given 启动尚未完成 When 立即关闭 Then 监督进程被收口', async () => {
    const transport = new ManagedMcpStdioTransport({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), env: { ...process.env } })
    const starting = transport.start()
    const closing = transport.close()
    await Promise.all([starting, closing])
    expect(transport.stopResult?.status).toBe('unconfirmed')
  }, 10_000)

  test.skipIf(process.platform === 'win32')('Given 服务发送大响应后退出 When 查询工具 Then 响应完整接收', async () => {
    const server = `const readline=require('node:readline');const input=readline.createInterface({input:process.stdin});input.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:{tools:[{name:'echo',description:'x'.repeat(500000),inputSchema:{type:'object',properties:{}}}]};const out=JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n';if(q.method==='tools/list')process.stdout.write(out,()=>process.exit(0));else process.stdout.write(out)})`
    const transport = new ManagedMcpStdioTransport({ command: process.execPath, args: ['-e', server], cwd: process.cwd(), env: { ...process.env } })
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} })
    try {
      await client.connect(transport)
      expect((await client.listTools()).tools[0]?.description?.length).toBe(500_000)
    } finally { await client.close() }
  }, 15_000)

  test.skipIf(process.platform === 'win32')('Given 服务写入大量 stderr When 随后处理 MCP 请求 Then 不因日志管道阻塞', async () => {
    const server = `const readline=require('node:readline');const input=readline.createInterface({input:process.stdin});input.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:{tools:[]};process.stderr.write('x'.repeat(500000),()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n'))})`
    const transport = new ManagedMcpStdioTransport({ command: process.execPath, args: ['-e', server], cwd: process.cwd(), env: { ...process.env } })
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} })
    try { await client.connect(transport); expect((await client.listTools()).tools).toEqual([]) }
    finally { await client.close() }
  }, 15_000)

})
