/** 用临时配置启动实际安装包；不连接 Provider，不替换用户应用。 */
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
  const timer = setTimeout(() => child.kill(), 60_000)
  try { process.exitCode = await child.exited } finally { clearTimeout(timer) }
} finally { rmSync(directory, { recursive: true, force: true }) }
