/** 实际安装包中的 PTY、Agent 停止与 MCP 进程回收验收；只使用临时配置和本地夹具。 */
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAgentSession } from './agent-session-manager'
import { createTerminal, getTerminalSnapshot, killTerminal, writeTerminal } from './terminal-service'
import { acquireMcpClientManager, clearMcpClientCache } from './agent-runtime/mcp-client-cache'
import { listProcessTable, snapshotProcessTree } from './agent-runtime/mcp-process-reaper'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(50)
  }
  throw new Error(`安装包验收超时：${description}`)
}

function processGone(pid: number): boolean {
  try { process.kill(pid, 0); return false } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function runTerminalSmoke(workspaceId: string): Promise<Record<string, unknown>> {
  const previousHome = process.env.HOME
  const previousShell = process.env.SHELL
  process.env.HOME = process.env.PROMA_TEST_CONFIG_DIR
  process.env.SHELL = '/bin/bash'
  const session = createAgentSession('Package Terminal Smoke', undefined, workspaceId, undefined, 'ai-sdk')
  const terminalId = 'package-smoke-terminal'
  let pid: number | undefined
  try {
    const terminal = createTerminal({ terminalId, sessionId: session.id, cols: 100, rows: 24 })
    pid = terminal.pid
    writeTerminal({ terminalId, data: "printf '\\nGRAVITAS_PTY_OK\\n'; sleep 60\n" })
    await waitFor(() => getTerminalSnapshot(terminalId).output.includes('GRAVITAS_PTY_OK'), 'PTY 输出')
    killTerminal(terminalId)
    await waitFor(() => processGone(pid!), 'PTY 进程退出')
    assert.throws(() => getTerminalSnapshot(terminalId), '终端关闭后仍可读取快照')
    return { outputConfirmed: true, stopConfirmed: true, pid }
  } finally {
    killTerminal(terminalId)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousShell === undefined) delete process.env.SHELL
    else process.env.SHELL = previousShell
  }
}

const MCP_FIXTURE = String.raw`
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const readline = require('node:readline')
let child
function startChild() {
  if (child) return
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore',
  })
  writeFileSync(process.env.MCP_SMOKE_PID_FILE, JSON.stringify({ server: process.pid, child: child.pid }))
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'package-smoke', version: '1.0.0' },
    } }) + '\n')
  } else if (message.method === 'notifications/initialized') startChild()
  else if (message.method === 'tools/list') {
    startChild()
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }) + '\n')
  }
})
setInterval(() => {}, 1000)
`

async function runMcpSmoke(root: string, workspaceSlug: string): Promise<Record<string, unknown>> {
  const fixturePath = join(root, 'package-mcp-fixture.cjs')
  const pidPath = join(root, 'package-mcp-pids.json')
  writeFileSync(fixturePath, MCP_FIXTURE, { mode: 0o700 })
  let supervisorPid: number | undefined
  let observedPids: number[] = []
  try {
    const lease = await acquireMcpClientManager(workspaceSlug, {
      'package-smoke': {
        type: 'stdio', command: process.execPath, args: [fixturePath], enabled: true,
        env: { ELECTRON_RUN_AS_NODE: '1', MCP_SMOKE_PID_FILE: pidPath },
      },
    }, root, {})
    await lease.manager.listAllTools()
    await waitFor(() => {
      try { return readFileSync(pidPath, 'utf8').length > 0 } catch { return false }
    }, 'MCP 服务及后代启动')
    const fixture = JSON.parse(readFileSync(pidPath, 'utf8')) as { server: number; child: number }
    const serverRow = (await listProcessTable()).find(row => row.pid === fixture.server)
    assert(serverRow, '找不到 MCP 服务父进程')
    supervisorPid = serverRow.ppid
    const snapshot = await snapshotProcessTree(supervisorPid)
    assert(snapshot, '无法快照 MCP 进程树')
    observedPids = [...new Set([...snapshot.descendants, supervisorPid, fixture.server, fixture.child])]
    assert(observedPids.includes(fixture.child), 'MCP 后代不在受管进程树中')
    lease.release()
    await clearMcpClientCache()
    await waitFor(() => observedPids.every(processGone), 'MCP 整组进程回收', 8_000)
    const reapStatuses = lease.manager.getReapEvidence().map(item => item.status)
    assert(reapStatuses.every(status => status !== 'confirmed'), '不能把未核验的内部证据标记为 confirmed')
    return { observedPids, externallyReaped: true, internalReapStatuses: reapStatuses }
  } finally {
    await clearMcpClientCache()
    const survivors = observedPids.filter(pid => !processGone(pid))
    if (supervisorPid && survivors.length > 0) {
      // 只清理本探针创建的独立进程组；不把清理后的结果算作生产回收通过。
      try { process.kill(-supervisorPid, 'SIGKILL') } catch { /* 已退出 */ }
    }
  }
}

async function runAgentStopSmoke(workspaceId: string): Promise<Record<string, unknown>> {
  let requestStarted!: () => void
  const started = new Promise<void>(resolve => { requestStarted = resolve })
  const responses = new Set<ServerResponse>()
  let requestAborted = false
  const server = createServer((request, response) => {
    responses.add(response)
    response.on('close', () => { requestAborted = true; responses.delete(response) })
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write(`data: ${JSON.stringify({
      id: 'package-smoke', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'package-smoke',
      choices: [{ index: 0, delta: { role: 'assistant', content: '等待停止' }, finish_reason: null }],
    })}\n\n`)
    requestStarted()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const { createChannel } = await import('./channel-manager')
  const channel = createChannel({
    name: 'Package Stop Smoke', provider: 'custom', baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'package-smoke-not-a-secret', models: [{ id: 'package-smoke', name: 'Package Smoke', enabled: true }], enabled: true,
  })
  const session = createAgentSession('Package Agent Stop Smoke', channel.id, workspaceId, 'package-smoke', 'ai-sdk')
  const { runAgentHeadless, stopAgent } = await import('./agent-service')
  let completed = false
  let stoppedByUser = false
  const errors: string[] = []
  const running = runAgentHeadless({
    sessionId: session.id, userMessage: '保持响应，等待本地停止验收。', channelId: channel.id,
    workspaceId, modelId: 'package-smoke', agentRuntime: 'ai-sdk', permissionModeOverride: 'safe',
  }, {
    onError: error => { errors.push(error) },
    onComplete: (_messages, result) => { completed = true; stoppedByUser = result?.stoppedByUser ?? false },
    onTitleUpdated: () => {},
  })
  try {
    const runEndedBeforeRequest = running.then(() => {
      throw new Error(`Agent 在本地请求开始前结束：${errors.join('; ') || '无错误详情'}`)
    })
    await Promise.race([started, runEndedBeforeRequest, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('本地慢响应未收到请求')), 15_000))])
    const stop = stopAgent(session.id)
    await Promise.race([running, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Agent 停止后运行未结束')), 15_000))])
    assert(stop.requestAccepted, '目标 generation 未接受停止请求')
    assert.equal(stop.stopped, false, '同步接受停止不能宣称进程已终止')
    assert.equal(stop.processTermination, 'NOT_VERIFIED')
    assert(completed && stoppedByUser, `停止后流式运行未按用户停止结束：${errors.join('; ')}`)
    await waitFor(() => requestAborted, '本地 Provider 请求中止')
    return { requestAccepted: stop.requestAccepted, stoppedByUser, processTermination: stop.processTermination, providerRequestAborted: requestAborted }
  } finally {
    stopAgent(session.id)
    for (const response of responses) response.end()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

export async function runPackageProcessSmoke(root: string, workspace: { id: string; slug: string }): Promise<Record<string, unknown>> {
  mkdirSync(root, { recursive: true })
  // 与正常启动顺序一致：Agent 编排会读取项目数据库中的受控执行事实。
  await (await import('./project-sqlite-store')).initProjectDb()
  const terminal = await runTerminalSmoke(workspace.id)
  const mcp = await runMcpSmoke(root, workspace.slug)
  const agentStop = await runAgentStopSmoke(workspace.id)
  return { terminal, mcp, agentStop }
}
