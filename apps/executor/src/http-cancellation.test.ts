import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('Given HTTP 长任务 When 客户端断开 Then 后代进程不能继续写入', async () => {
  const root = mkdtempSync(join(tmpdir(), 'executor-http-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  const child = Bun.spawn([process.execPath, 'src/index.ts'], {
    env: { ...process.env, PROMA_EXECUTOR_TOKEN: 'synthetic', PROMA_EXECUTOR_PORT: String(port),
      PROMA_EXECUTOR_WORKSPACE_ROOT: root, PROMA_EXECUTOR_ALLOWED_COMMANDS: 'bun' },
    stdout: 'ignore', stderr: 'pipe',
  })
  const endpoint = 'http://127.0.0.1:' + port
  try {
    let ready = false
    for (let i = 0; i < 50; i++) {
      try { ready = (await fetch(endpoint + '/healthz')).ok } catch {}
      if (ready) break
      await Bun.sleep(40)
    }
    expect(ready).toBe(true)
    const controller = new AbortController()
    const code = 'await Bun.write("started","ok");Bun.spawn(["bun","-e",\'setTimeout(()=>Bun.write("escaped","bad"),800)\']);setInterval(()=>{},1000)'
    const pending = fetch(endpoint + '/execute', { method: 'POST',
      headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'http-cancel', workspaceDir: workspace, command: 'bun', args: ['-e', code], timeoutMs: 5000, maxOutputBytes: 1024 }),
      signal: controller.signal,
    }).catch(error => error as Error)
    for (let i = 0; i < 50 && !existsSync(join(workspace, 'started')); i++) await Bun.sleep(20)
    expect(existsSync(join(workspace, 'started'))).toBe(true)
    controller.abort()
    await pending
    await Bun.sleep(1000)
    expect(existsSync(join(workspace, 'escaped'))).toBe(false)
  } finally {
    child.kill()
    await child.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 10000)
