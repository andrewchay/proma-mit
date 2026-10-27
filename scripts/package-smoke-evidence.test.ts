import { afterAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { exportPackageSmokeEvidence } from './package-smoke-evidence'

const directory = mkdtempSync(join(tmpdir(), 'smoke-export-'))
afterAll(() => { rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  const profile = join(directory, randomUUID()), destination = join(directory, randomUUID())
  mkdirSync(profile)
  const put = (path: string, content: string) => {
    const file = join(profile, path)
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content)
  }
  return { profile, destination, put }
}

test('Given隔离profile含渠道及成果 When导出 Then只保留可核对证据且不复制配置或Git指针', () => {
  const f = fixture(), session = randomUUID(), prefix = `agent-workspaces/smoke/${session}`
  f.put('channels.json', '{"apiKey":"must-not-export"}')
  f.put('sdk-config/settings.json', 'private')
  f.put('agent-workspaces/smoke/mcp.json', 'private')
  f.put('projects/paa.db', 'database')
  f.put(`agent-sessions/${session}.jsonl`, 'receipt')
  f.put(`${prefix}/source/index.html`, '<main>2048</main>')
  f.put(`${prefix}/source/.git`, 'gitdir: removed-profile')
  f.put(`${prefix}/development-snapshot-run.json`, '{"hash":"snapshot"}')
  f.put(`${prefix}/development-snapshot-run.d/index.html`, '<main>2048</main>')
  f.put(`${prefix}/development-validation-run.json`, '{"status":"passed"}')
  f.put(`${prefix}/owner-development-validation-attempt-run.json`, '{"state":"completed"}')
  f.put('owner-real-chain-report.json', '{"reviewer":{"recorded":true}}')
  const files = exportPackageSmokeEvidence(f.profile, f.destination)
  expect(files).toHaveLength(8)
  expect(files.every(file => file.sha256.length === 64 && file.bytes > 0)).toBe(true)
  expect(existsSync(join(f.destination, 'channels.json'))).toBe(false)
  expect(existsSync(join(f.destination, prefix, 'source/.git'))).toBe(false)
  expect(readFileSync(join(f.destination, 'manifest.json'), 'utf8')).not.toContain('must-not-export')
  rmSync(f.profile, { recursive: true })
  expect(readFileSync(join(f.destination, prefix, 'source/index.html'), 'utf8')).toContain('2048')
})

test('Given导出路径重叠或已存在 When导出 Then拒绝覆盖证据', () => {
  const f = fixture()
  expect(() => exportPackageSmokeEvidence(f.profile, join(f.profile, 'export'))).toThrow('之外')
  expect(() => exportPackageSmokeEvidence(f.profile, directory)).toThrow('之外')
  expect(() => exportPackageSmokeEvidence(f.profile, 'relative')).toThrow('绝对路径')
})

test('Given目标父级链接指回profile When导出 Then拒绝并保留原profile', () => {
  const f = fixture(), alias = join(directory, `alias-${randomUUID()}`)
  symlinkSync(f.profile, alias)
  expect(() => exportPackageSmokeEvidence(f.profile, join(alias, 'nested', 'evidence'))).toThrow('之外')
  expect(existsSync(f.profile)).toBe(true)
})

test('Given成果引用外部符号链接 When导出 Then拒绝读取并保留源profile', () => {
  const f = fixture(), prefix = `agent-workspaces/smoke/${randomUUID()}/source`
  f.put('channels.json', 'credential')
  f.put(`${prefix}/index.html`, 'html')
  symlinkSync(join(f.profile, 'channels.json'), join(f.profile, prefix, 'leak.json'))
  expect(() => exportPackageSmokeEvidence(f.profile, f.destination)).toThrow('符号链接')
  expect(existsSync(f.profile)).toBe(true)
  expect(existsSync(join(f.destination, prefix, 'leak.json'))).toBe(false)
})

test('Given实际冒烟包装脚本 When子进程成功 Then证据先导出再清理临时profile', () => {
  const f = fixture(), executable = join(directory, `child-${randomUUID()}.sh`)
  writeFileSync(executable, '#!/bin/sh\nmkdir -p "$PROMA_TEST_CONFIG_DIR/projects"\nprintf database > "$PROMA_TEST_CONFIG_DIR/projects/paa.db"\nprintf \'{"status":"completed","reviewer":{"recorded":true,"verdict":"approved"},"profile":"%s"}\' "$PROMA_TEST_CONFIG_DIR" > "$PROMA_TEST_CONFIG_DIR/owner-real-chain-report.json"\n', { mode: 0o700 })
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, 'package-smoke.ts'), executable], {
    env: { ...process.env, GRAVITAS_OWNER_CHAIN_SMOKE_EXPORT_DIR: f.destination, GRAVITAS_OWNER_CHAIN_SMOKE_CHANNEL_ID: 'fake-smoke', GRAVITAS_OWNER_CHAIN_SMOKE_CHANNELS_PATH: '', GRAVITAS_OWNER_PARAM_PROBE_CHANNEL_ID: '', GRAVITAS_PACKAGE_SMOKE_KIMI_CHANNEL_ID: '' },
    stdout: 'pipe', stderr: 'pipe',
  })
  expect(child.exitCode).toBe(0)
  const profile = (JSON.parse(readFileSync(join(f.destination, 'owner-real-chain-report.json'), 'utf8')) as { profile: string }).profile
  expect(existsSync(profile)).toBe(false)
  expect(readFileSync(join(f.destination, 'projects/paa.db'), 'utf8')).toBe('database')
})

test('Given子进程启动成功但Owner无有效评审 When包装脚本判定 Then非零退出且失败证据仍导出', () => {
  const f = fixture(), executable = join(directory, `failed-child-${randomUUID()}.sh`)
  writeFileSync(executable, '#!/bin/sh\nprintf \'{"status":"completed","reviewer":{"recorded":false},"profile":"%s"}\' "$PROMA_TEST_CONFIG_DIR" > "$PROMA_TEST_CONFIG_DIR/owner-real-chain-report.json"\n', { mode: 0o700 })
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, 'package-smoke.ts'), executable], {
    env: { ...process.env, GRAVITAS_OWNER_CHAIN_SMOKE_EXPORT_DIR: f.destination, GRAVITAS_OWNER_CHAIN_SMOKE_CHANNEL_ID: 'fake-smoke', GRAVITAS_OWNER_CHAIN_SMOKE_CHANNELS_PATH: '', GRAVITAS_OWNER_PARAM_PROBE_CHANNEL_ID: '', GRAVITAS_PACKAGE_SMOKE_KIMI_CHANNEL_ID: '' },
    stdout: 'pipe', stderr: 'pipe',
  })
  expect(child.exitCode).not.toBe(0)
  expect(child.stderr.toString()).toContain('Owner 业务冒烟未通过')
  expect(existsSync(join(f.destination, 'manifest.json'))).toBe(true)
  const report = JSON.parse(readFileSync(join(f.destination, 'owner-real-chain-report.json'), 'utf8')) as { profile: string }
  expect(existsSync(report.profile)).toBe(false)
})

test('Given明确恢复同一冒烟profile When项目仍失败 Then导出证据并保留原profile和请求账本供恢复', () => {
  const f = fixture(), profile = mkdtempSync(join(tmpdir(), 'gravitas-package-smoke-'))
  const executable = join(directory, `resume-child-${randomUUID()}.sh`)
  mkdirSync(join(profile, 'projects'))
  writeFileSync(join(profile, '.package-smoke-empty'), '')
  writeFileSync(join(profile, 'projects/paa.db'), 'retained-request-ledger')
  writeFileSync(executable, '#!/bin/sh\nprintf \'{"status":"unknown","reviewer":{"recorded":false}}\' > "$PROMA_TEST_CONFIG_DIR/owner-real-chain-report.json"\n', { mode: 0o700 })
  try {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, 'package-smoke.ts'), executable], {
      env: { ...process.env, GRAVITAS_OWNER_CHAIN_SMOKE_MODE: 'project-2048', GRAVITAS_OWNER_CHAIN_SMOKE_RESUME_PROJECT_ID: 'synthetic-project',
        GRAVITAS_OWNER_CHAIN_SMOKE_RESUME_PROFILE: profile, GRAVITAS_OWNER_CHAIN_SMOKE_EXPORT_DIR: f.destination,
        GRAVITAS_OWNER_CHAIN_SMOKE_CHANNEL_ID: 'fake-smoke', GRAVITAS_OWNER_CHAIN_SMOKE_CHANNELS_PATH: '', GRAVITAS_OWNER_PARAM_PROBE_CHANNEL_ID: '', GRAVITAS_PACKAGE_SMOKE_KIMI_CHANNEL_ID: '' },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(child.exitCode).not.toBe(0)
    expect(existsSync(join(f.destination, 'manifest.json'))).toBe(true)
    expect(readFileSync(join(profile, 'projects/paa.db'), 'utf8')).toBe('retained-request-ledger')
  } finally { rmSync(profile, { recursive: true, force: true }) }
})
