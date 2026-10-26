/**
 * 安装包冒烟：受管浏览器运行验证执行器。
 *
 * 目的：在打包后的真实 Electron 里验证断言执行器，而不是用注入的假实现替代。
 * 覆盖：
 * 1. 隐藏窗口能加载工作区内 HTML 并执行内置断言；
 * 2. 非 file 请求被 partition 拦截，本地探针服务收不到任何请求；
 * 3. 越界路径在进入浏览器前被拒绝（fail-closed）。
 * 边界：只使用临时目录里的夹具文件，不访问外网、不写工作区。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { executeBrowserVerificationCommand } from './owner-runtime-verification-command'
import { runOwnerRuntimeBrowserAssertions } from './owner-runtime-browser-verifier'

/** 可运行的 2048 最小夹具：16 格棋盘、两块初始数字、左移合并、重开与最高分。 */
const GAME_FIXTURE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>冒烟棋盘</title>
<style>#board{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}.cell{min-height:32px;background:#eee}</style>
</head><body>
<h1>冒烟棋盘</h1>
<div id="board"></div>
<button id="restart" type="button">重新开始</button>
<script>
  const cells = []
  const board = document.getElementById('board')
  for (let index = 0; index < 16; index += 1) {
    const cell = document.createElement('div')
    cell.className = 'cell'
    board.appendChild(cell)
    cells.push(cell)
  }
  // 竖排两块：按左键只是并到同一列不会合并，按上键才合并。
  // 用来验证"随机开局左键不保证发生合并"时断言仍能通过。
  const state = new Array(16).fill(0)
  state[0] = 2
  state[4] = 2
  const render = () => cells.forEach((cell, index) => { cell.textContent = state[index] ? String(state[index]) : '' })
  const linesFor = (direction) => {
    const groups = []
    for (let line = 0; line < 4; line += 1) {
      const indices = []
      for (let step = 0; step < 4; step += 1) {
        if (direction === 'left') indices.push(line * 4 + step)
        else if (direction === 'right') indices.push(line * 4 + (3 - step))
        else if (direction === 'up') indices.push(step * 4 + line)
        else indices.push((3 - step) * 4 + line)
      }
      groups.push(indices)
    }
    return groups
  }
  const move = (direction) => {
    for (const indices of linesFor(direction)) {
      const values = indices.map(index => state[index]).filter(value => value > 0)
      const merged = []
      for (let index = 0; index < values.length; index += 1) {
        if (values[index] === values[index + 1]) { merged.push(values[index] * 2); index += 1 }
        else merged.push(values[index])
      }
      while (merged.length < 4) merged.push(0)
      indices.forEach((index, position) => { state[index] = merged[position] })
    }
    render()
  }
  const keys = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
  document.addEventListener('keydown', event => { const direction = keys[event.key]; if (direction) move(direction) })
  document.getElementById('restart').addEventListener('click', () => {
    state.fill(0); state[0] = 2; state[4] = 2; render(); localStorage.setItem('best', '4')
  })
  localStorage.setItem('best', '2')
  render()
</script>
</body></html>`

/** 反例夹具：数字会变但没有真正合并、只有无关存储键、没有重开入口。 */
const DECEPTIVE_FIXTURE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>假通过页面</title>
<style>#board{display:grid;grid-template-columns:repeat(4,1fr)}.cell{min-height:24px;background:#eee}</style>
</head><body>
<div id="board"></div>
<p>分数 <span id="score">0</span></p>
<script>
  let scoreShown = 0
  const cells = []
  const board = document.getElementById('board')
  for (let index = 0; index < 16; index += 1) {
    const cell = document.createElement('div')
    cell.className = 'cell'
    board.appendChild(cell)
    cells.push(cell)
  }
  const state = new Array(16).fill(0)
  state[0] = 2
  state[1] = 4
  const render = () => cells.forEach((cell, index) => { cell.textContent = state[index] ? String(state[index]) : '' })
  // 只改数字，不做任何合并、不加分。
  document.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft') return
    state[2] = state[2] === 8 ? 16 : 8
    // 伪造计分：按键就把"分数"文本加一，但从未发生合并。
    scoreShown += 1
    document.getElementById('score').textContent = String(scoreShown)
    render()
  })
  localStorage.setItem('theme', 'dark')
  render()
</script>
</body></html>`

/**
 * 真实形态夹具：合并后立刻生成新块，因此按键前后块数不变。
 * 用于证明合并判定不依赖"块数减少"。
 */
const SPAWN_FIXTURE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>生成新块的棋盘</title>
<style>#board{display:grid;grid-template-columns:repeat(4,1fr)}.cell{min-height:24px;background:#eee}</style>
</head><body>
<div id="board"></div><p>分数 <span id="score">0</span></p><button id="restart" type="button">重新开始</button>
<script>
  const cells = []
  const board = document.getElementById('board')
  for (let index = 0; index < 16; index += 1) {
    const cell = document.createElement('div')
    cell.className = 'cell'
    board.appendChild(cell)
    cells.push(cell)
  }
  const state = new Array(16).fill(0)
  state[0] = 2
  state[1] = 2
  let score = 0, spawned = false
  const render = () => {
    cells.forEach((cell, index) => { cell.textContent = state[index] ? String(state[index]) : '' })
    document.getElementById('score').textContent = String(score)
  }
  const moveLeft = () => {
    for (let row = 0; row < 4; row += 1) {
      const values = [0, 1, 2, 3].map(column => state[row * 4 + column]).filter(value => value > 0)
      const merged = []
      for (let index = 0; index < values.length; index += 1) {
        if (values[index] === values[index + 1]) { merged.push(values[index] * 2); score += values[index] * 2; index += 1 }
        else merged.push(values[index])
      }
      while (merged.length < 4) merged.push(0)
      for (let column = 0; column < 4; column += 1) state[row * 4 + column] = merged[column]
    }
    // 关键：合并后立刻生成新块，按键前后块数保持不变。
    if (!spawned) { state[15] = 2; spawned = true }
    render()
  }
  document.addEventListener('keydown', event => { if (event.key === 'ArrowLeft') moveLeft() })
  document.getElementById('restart').addEventListener('click', () => { state.fill(0); state[0] = 2; state[1] = 2; score = 0; spawned = false; render(); localStorage.setItem('best', '4') })
  localStorage.setItem('best', '2')
  render()
</script>
</body></html>`

/** 联网探针夹具：请求被拦截后本地服务不应收到任何命中。 */
const PROBE_FIXTURE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>联网探针</title></head>
<body><p>probe</p>
<script>
  fetch('http://127.0.0.1:__PROBE_PORT__/probe').catch(() => {})
</script></body></html>`

export interface OwnerRuntimeVerificationSmokeResult {
  checks: number
  passed: number
  networkBlocked: boolean
  traversalRejected: boolean
  htmlLoads: boolean
  mergeChanged: boolean
  deceptiveRejected: boolean
  navigationRejected: boolean
  spawnMergePassed: boolean
  loadTimeoutMs: number
}

export async function runOwnerRuntimeVerificationSmoke(configRoot: string): Promise<OwnerRuntimeVerificationSmokeResult> {
  const workspaceRoot = join(configRoot, 'owner-runtime-smoke-workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  writeFileSync(join(workspaceRoot, 'game.html'), GAME_FIXTURE)
  writeFileSync(join(workspaceRoot, '..', 'owner-runtime-smoke-escape.html'), '<html></html>')

  // 1) 真实受管浏览器执行内置断言
  const run = await runOwnerRuntimeBrowserAssertions({
    workspaceRoot,
    relativePath: 'game.html',
    intents: ['页面可加载', '棋盘', '开局数字块', '合并计分', '最高分持久化', '重开入口'],
    timeoutMs: 45_000,
  })
  const byId = new Map(run.checks.map(check => [check.id, check]))
  const expectPassed = (id: string) => {
    const check = byId.get(id)
    assert(check, `缺少断言 ${id}`)
    assert.equal(check.status, 'passed', `断言 ${id} 未通过：${check.detail}`)
  }
  for (const id of ['html.loads', 'dom.board', 'dom.initial-tiles', 'behavior.merge', 'storage.best-score', 'dom.restart']) expectPassed(id)
  assert.equal(run.timedOut, false, '断言执行超时')
  assert(run.durationMs >= 0, '断言耗时异常')

  // 2) 命令层聚合：同一套证据格式与门禁字段
  const commandRun = await executeBrowserVerificationCommand({
    workspaceRoot,
    targetPaths: ['game.html'],
    command: 'browser:html.loads+dom.board+behavior.merge',
    timeoutMs: 45_000,
  })
  assert.equal(commandRun.exitCode, 0, `命令聚合失败：${JSON.stringify(commandRun.checks)}`)
  assert.match(commandRun.rawOutputSha256, /^[a-f0-9]{64}$/, '输出摘要格式无效')
  assert(commandRun.rawOutputByteLength > 0, '输出字节数为 0')

  // 3) 网络拦截：本地探针服务不得收到任何请求
  let probeHits = 0
  const probe = createServer((_request, response) => { probeHits += 1; response.end('hit') })
  await new Promise<void>(resolve => { probe.listen(0, '127.0.0.1', resolve) })
  const port = (probe.address() as { port: number }).port
  try {
    writeFileSync(join(workspaceRoot, 'probe.html'), PROBE_FIXTURE.replace('__PROBE_PORT__', String(port)))
    await runOwnerRuntimeBrowserAssertions({ workspaceRoot, relativePath: 'probe.html', intents: ['页面可加载'], timeoutMs: 20_000 })
    // 给被拦截或被放行的请求留出落地时间，避免"还没来得及请求"造成假通过。
    await new Promise(resolve => setTimeout(resolve, 600))
    assert.equal(probeHits, 0, '受管浏览器未拦截外部请求')
  } finally {
    await new Promise<void>(resolve => probe.close(() => resolve()))
  }

  // 3.5) 反例：假页面不得被判定为通过（数字变化 ≠ 合并；任意存储键 ≠ 最高分；无重开 ≠ 有重开）
  writeFileSync(join(workspaceRoot, 'deceptive.html'), DECEPTIVE_FIXTURE)
  const deceptive = await executeBrowserVerificationCommand({
    workspaceRoot,
    targetPaths: ['deceptive.html'],
    command: 'browser:behavior.merge+storage.best-score+dom.restart',
    timeoutMs: 30_000,
  })
  assert.equal(deceptive.exitCode, 1, `假页面竟通过验证：${JSON.stringify(deceptive.checks)}`)
  const deceptiveStatus = new Map(deceptive.checks.map(check => [check.id, check.status]))
  assert.equal(deceptiveStatus.get('behavior.merge'), 'failed', '只改数字被判为合并成功')
  assert.equal(deceptiveStatus.get('storage.best-score'), 'failed', '无关存储键被判为最高分已持久化')
  assert.equal(deceptiveStatus.get('dom.restart'), 'failed', '缺少重开入口却判为通过')

  // 3.8) 整体超时：页面脚本阻塞加载时，验证必须在预算内返回并标记超时（不能无限等待）
  writeFileSync(join(workspaceRoot, 'hang.html'), '<!doctype html><html><body><script>for(;;){}</script></body></html>')
  const hangStartedAt = Date.now()
  const hang = await runOwnerRuntimeBrowserAssertions({ workspaceRoot, relativePath: 'hang.html', intents: ['页面可加载'], timeoutMs: 8_000 })
  const hangElapsed = Date.now() - hangStartedAt
  assert.equal(hang.timedOut, true, '加载被阻塞时未标记超时')
  // 超时也必须有逐项失败记录：既不能空证据蒙混，也不能产出通过项。
  assert(hang.checks.length > 0 && hang.checks.every(check => check.status === 'failed'), `加载阻塞未留下逐项失败记录：${JSON.stringify(hang.checks)}`)
  assert(hangElapsed < 25_000, `加载超时未在预算内返回：${hangElapsed}ms`)

  // 3.7) 真实形态：合并后生成新块（块数不变）也必须识别为合并
  writeFileSync(join(workspaceRoot, 'spawn.html'), SPAWN_FIXTURE)
  const spawnRun = await runOwnerRuntimeBrowserAssertions({ workspaceRoot, relativePath: 'spawn.html', intents: ['合并计分'], timeoutMs: 20_000 })
  const spawnMerge = spawnRun.checks.find(check => check.id === 'behavior.merge')
  assert.equal(spawnMerge?.status, 'passed', `合并后生成新块的棋盘被误判：${spawnMerge?.detail}`)

  // 3.9) 导航越权：成果尝试跳到本机其他文件时必须被拦住（页面仍是本次成果）
  writeFileSync(join(workspaceRoot, 'nav-escape.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>导航越权</title>
<style>#board{display:grid;grid-template-columns:repeat(4,1fr)}.cell{min-height:20px;background:#eee}</style></head>
<body><div id="board"></div><script>
  const board = document.getElementById('board')
  for (let index = 0; index < 16; index += 1) board.appendChild(document.createElement('div'))
  location.href = 'file:///etc/hosts'
</script></body></html>`)
  const navEscape = await runOwnerRuntimeBrowserAssertions({
    workspaceRoot, relativePath: 'nav-escape.html', intents: ['页面可加载', '棋盘'], timeoutMs: 20_000,
  })
  // 被劫持的页面不得产出任何通过项：证据不能来自另一份文档。
  assert.equal(navEscape.checks.some(check => check.status === 'passed'), false, `导航越权后仍产出了通过证据：${JSON.stringify(navEscape.checks)}`)
  assert(navEscape.checks.length > 0 && navEscape.checks.every(check => check.status === 'failed'), `导航越权后未留下逐项失败记录：${JSON.stringify(navEscape.checks)}`)

  // 4) 越界路径在进入浏览器前被拒绝
  let traversalRejected = false
  try {
    await runOwnerRuntimeBrowserAssertions({ workspaceRoot, relativePath: '../owner-runtime-smoke-escape.html', intents: ['页面可加载'] })
  } catch (error) {
    traversalRejected = String((error as Error).message).includes('不在工作区内')
  }
  assert(traversalRejected, '越界路径未被拒绝')

  assert(readFileSync(join(workspaceRoot, 'game.html'), 'utf8').includes('冒烟棋盘'), '夹具被意外修改')

  return {
    checks: run.checks.length,
    passed: run.checks.filter(check => check.status === 'passed').length,
    networkBlocked: probeHits === 0,
    traversalRejected,
    htmlLoads: byId.get('html.loads')?.status === 'passed',
    mergeChanged: byId.get('behavior.merge')?.status === 'passed',
    deceptiveRejected: deceptive.exitCode === 1,
    navigationRejected: navEscape.checks.length > 0 && navEscape.checks.every(check => check.status === 'failed'),
    spawnMergePassed: spawnMerge?.status === 'passed',
    loadTimeoutMs: hangElapsed,
  }
}
