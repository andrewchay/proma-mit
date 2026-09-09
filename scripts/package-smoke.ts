/** 用临时配置启动实际安装包；仅在显式 Kimi 渠道变量存在时连接 Provider，不替换用户应用。 */
import { copyFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const executable = process.argv[2]
if (!executable) throw new Error('用法: bun scripts/package-smoke.ts <安装包可执行文件>')
const directory = mkdtempSync(join(tmpdir(), 'gravitas-package-smoke-'))
try {
  writeFileSync(join(directory, '.package-smoke-empty'), '')
  if (process.env.GRAVITAS_PACKAGE_SMOKE_KIMI_CHANNEL_ID) {
    const channelsPath = process.env.GRAVITAS_PACKAGE_SMOKE_CHANNELS_PATH
    if (!channelsPath) throw new Error('真实 Kimi 烟测必须指定 GRAVITAS_PACKAGE_SMOKE_CHANNELS_PATH')
    copyFileSync(channelsPath, join(directory, 'channels.json'))
  }
  const child = Bun.spawn([executable], {
    env: { ...process.env, GRAVITAS_PACKAGE_SMOKE: '1', PROMA_TEST_CONFIG_DIR: directory, PROMA_ALLOW_MULTI_INSTANCE: '1' },
    stdout: 'inherit', stderr: 'inherit',
  })
  const timeoutMs = process.env.GRAVITAS_PACKAGE_SMOKE_KIMI_CHANNEL_ID ? 180_000 : 60_000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  try {
    const exitCode = await child.exited
    if (timedOut) throw new Error(`实际安装包烟测超时（${timeoutMs}ms）`)
    if (exitCode !== 0) throw new Error(`实际安装包烟测失败，exitCode=${exitCode}`)
    console.log(`[Package Smoke] 子进程正常结束: exitCode=${exitCode}`)
  } finally { clearTimeout(timer) }
} finally { rmSync(directory, { recursive: true, force: true }) }
