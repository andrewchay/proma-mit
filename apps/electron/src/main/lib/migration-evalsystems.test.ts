import { afterAll, beforeAll, describe, expect, test, mock } from 'bun:test'
import { buildElectronMock } from './testing/electron-mock'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs'

// ── mock electron + 子服务，避免真实 safeStorage / 网络 ──
mock.module('electron', () => buildElectronMock())

mock.module('./proxy-fetch', () => ({ getFetchFn: () => globalThis.fetch }))
mock.module('./proxy-settings-service', () => ({ getEffectiveProxyUrl: async () => undefined }))

const testDir = join(tmpdir(), `gravitas-migration-eval-${Date.now()}`)

beforeAll(() => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
})

describe('评测/Agent 定义迁移往返（evalsystems）', () => {
  test('import 能还原 benchmarks / default-agents / allowlist（含组件在 manifest）', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = (await import('./migration-service')) as any

    // 1) 构造一个含 evalsystems 的最小 zip（模拟团队/备份导出产物）
    const zipPath = join(testDir, 'share.gravi-team')
    const AdmZipBase = await import('adm-zip')
    const AdmZip = (AdmZipBase.default ?? AdmZipBase) as new () => {
      addFile(a: string, b: Buffer): void
      addLocalFile(a: string, b: string, c: string): void
      addLocalFile(a: string, b: string): void
      writeZip(a: string): void
      getEntries(): Array<{ entryName: string }>
    }
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ version: '1.0', components: ['evalsystems'], workspaceName: 'ws', workspaceSlug: 'ws1', mode: 'share' }), 'utf-8'))
    zip.addFile('evalsystems/benchmarks/b1/benchmark.json', Buffer.from(JSON.stringify({ id: 'b1', title: 'b' })))
    zip.addFile('evalsystems/benchmarks/b1/scoreboard.json', Buffer.from(JSON.stringify({ benchmarkId: 'b1', evaluations: [{ score: 91 }] })))
    zip.addFile('evalsystems/benchmarks/b1/cases/CASE-001/statement.md', Buffer.from('# 导入的 statement'))
    zip.addFile('evalsystems/benchmarks/b1/cases/CASE-001/rubric.json', Buffer.from(JSON.stringify({ version: 1, items: [{ name: 'p', points: 100 }] })))
    zip.addFile('evalsystems/agents/code-reviewer/system_config.json', Buffer.from(JSON.stringify({ id: 'code-reviewer', version: 3 })))
    zip.addFile('evalsystems/agents/code-reviewer/AGENTS.md', Buffer.from('导入的审查指令'))
    zip.addFile('evalsystems/allowlist.json', Buffer.from(JSON.stringify({ allowedTools: ['Edit'], allowedBashCommands: ['git'], trustedWebBridgeHosts: [] })))
    zip.writeZip(zipPath)

    // 2) parse：确认组件在 manifest、zip 内有 evalsystems 条目
    const preview = await m.parseImportFile(zipPath)
    expect((preview as { manifest: { components: string[] } }).manifest.components).toContain('evalsystems')
    const tempDir = (preview as { tempDir: string }).tempDir
    expect(existsSync(join(tempDir, 'evalsystems/benchmarks/b1/benchmark.json'))).toBe(true)

    // 3) 先造一个目标工作区（confirmImport 需要），再 confirmImport 还原
    const { createAgentWorkspace, listAgentWorkspaces } = await import('./agent-workspace-manager')
    createAgentWorkspace('ws1')
    const targetWs = listAgentWorkspaces()[0]

    const confirm = await m.confirmImport({
      tempDir,
      manifest: (preview as { manifest: unknown }).manifest,
      targetWorkspaceId: targetWs?.id,
      pathMappings: {},
      conflictResolution: 'overwrite',
    } as never)
    expect(confirm.success).toBe(true)

    // 4) 断言磁盘还原
    // benchmarks
    expect(existsSync(join(testDir, 'eval', 'benchmarks', 'b1', 'benchmark.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(testDir, 'eval', 'benchmarks', 'b1', 'scoreboard.json'), 'utf-8')).evaluations[0].score).toBe(91)
    expect(existsSync(join(testDir, 'eval', 'benchmarks', 'b1', 'cases', 'CASE-001', 'statement.md'))).toBe(true)
    // default-agents
    expect(JSON.parse(readFileSync(join(testDir, 'default-agents', 'code-reviewer', 'system_config.json'), 'utf-8')).version).toBe(3)
    expect(readFileSync(join(testDir, 'default-agents', 'code-reviewer', 'AGENTS.md'), 'utf-8')).toBe('导入的审查指令')
    // allowlist 合并进 settings
    const settings = JSON.parse(readFileSync(join(testDir, 'settings.json'), 'utf-8'))
    expect(settings.agentAllowlist.allowedTools).toContain('Edit')
    expect(settings.agentAllowlist.allowedBashCommands).toContain('git')
  }, 20000)
})
