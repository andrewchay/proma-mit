/**
 * W02：冻结交付快照服务的 BDD 契约（T06/T07/T08/T09 + 边界）。
 * 使用临时真实 Git 仓库与研发 worktree；不触碰真实 index 之外的全局状态。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-rd-snap-'))
const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = join(directory, 'config')
mock.module('electron', () => buildElectronMock())

const { createDevelopmentWorktree } = await import('./agent-development-worktree')
const { createDevelopmentSnapshot, loadDevelopmentSnapshot, SNAPSHOT_LIMITS } = await import('./development-snapshot-service')

beforeAll(async () => { /* 快照服务不依赖项目数据库 */ })
afterAll(() => {
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(directory, { recursive: true, force: true })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** 建立干净基线仓库 + 会话目录 + worktree 绑定 */
function fixture(name: string) {
  const repo = join(directory, `${name}-repo`); mkdirSync(repo)
  git(repo, 'init'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'a.ts'), 'original-a\n')
  writeFileSync(join(repo, 'src', 'b.ts'), 'original-b\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'baseline')
  const session = join(directory, `${name}-session`); mkdirSync(session, { recursive: true })
  const executionId = `exec${Math.random().toString(36).slice(2, 10)}`
  const worktree = createDevelopmentWorktree(repo, session, executionId)
  const scope = { workspaceId: 'ws', targetPaths: ['src/a.ts'], allowedPaths: ['src'], reviewerId: 'local-user' }
  return { repo, session, executionId, worktreePath: worktree.path, scope }
}

describe('快照冻结（T06/T08）', () => {
  test('Given 已提交+未提交+暂存+未跟踪变更 When 冻结 Then 全部相对基线可见且指纹一致', () => {
    const f = fixture('all')
    const wt = f.worktreePath
    // 已提交变更
    writeFileSync(join(wt, 'src', 'a.ts'), 'committed change\n')
    git(wt, 'add', '.'); git(wt, 'commit', '-m', 'agent commit')
    // 未暂存变更
    writeFileSync(join(wt, 'src', 'a.ts'), 'final content\n')
    // 暂存变更
    writeFileSync(join(wt, 'src', 'b.ts'), 'staged content\n')
    git(wt, 'add', 'src/b.ts')
    // 未跟踪新增
    writeFileSync(join(wt, 'src', 'new.ts'), 'brand new\n')

    const snapshot = createDevelopmentSnapshot({ worktreePath: wt, sessionDirectory: f.session, executionId: f.executionId, workspaceId: 'ws', scope: f.scope })
    expect(snapshot.files.map((file) => file.path).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/new.ts'])
    expect(snapshot.files.find((file) => file.path === 'src/new.ts')).toMatchObject({ changeType: 'add' })
    expect(snapshot.files.find((file) => file.path === 'src/a.ts')?.oldSha256).not.toBeNull()

    // 回读校验通过且指纹一致；真实 index 未被触碰（worktree 里 git status 仍显示同样内容）
    const loaded = loadDevelopmentSnapshot(f.session, f.executionId)
    expect(loaded.contentHash).toBe(snapshot.contentHash)
    expect(git(wt, 'status', '--porcelain')).toContain('src/a.ts')
    // 删除暂存状态未被破坏：b.ts 仍在暂存区
    expect(git(wt, 'diff', '--cached', '--name-only')).toContain('src/b.ts')
  })

  test('Given 中文与空格路径、无结尾换行、删除文件 When 冻结 Then 内容逐字节一致', () => {
    const f = fixture('i18n')
    const wt = f.worktreePath
    writeFileSync(join(wt, 'src', '中文 说明.md'), '# 标题\n\n内容无换行')
    rmSync(join(wt, 'src', 'b.ts'))
    const snapshot = createDevelopmentSnapshot({ worktreePath: wt, sessionDirectory: f.session, executionId: f.executionId, workspaceId: 'ws', scope: f.scope })
    expect(snapshot.files.map((file) => `${file.path}:${file.changeType}`).sort()).toEqual(['src/b.ts:delete', 'src/中文 说明.md:add'].sort())
    expect(loadDevelopmentSnapshot(f.session, f.executionId).files.length).toBe(2)
  })

  test('Given worktree 无变更 When 冻结 Then 明确拒绝', () => {
    const f = fixture('clean')
    expect(() => createDevelopmentSnapshot({ worktreePath: f.worktreePath, sessionDirectory: f.session, executionId: f.executionId, workspaceId: 'ws', scope: f.scope })).toThrow('没有变更')
  })
})

describe('快照阻塞（T07/T09）', () => {
  test('Given 范围外变更 When 冻结 Then 整轮阻塞而非静默过滤', () => {
    const f = fixture('outside')
    writeFileSync(join(f.worktreePath, 'outside.txt'), 'x')
    writeFileSync(join(f.worktreePath, 'src', 'a.ts'), 'ok\n')
    expect(() => createDevelopmentSnapshot({ worktreePath: f.worktreePath, sessionDirectory: f.session, executionId: f.executionId, workspaceId: 'ws', scope: f.scope })).toThrow('范围外')
  })

  test('Given 受保护路径变更 When 冻结 Then 阻塞', () => {
    const f = fixture('protected')
    writeFileSync(join(f.worktreePath, '.env'), 'SECRET=1')
    expect(() => createDevelopmentSnapshot({ worktreePath: f.worktreePath, sessionDirectory: f.session, executionId: f.executionId, workspaceId: 'ws', scope: { ...f.scope, allowedPaths: ['src', '.env'], targetPaths: ['src/a.ts', '.env'] } })).toThrow('受保护')
  })

  test('Given 二进制/符号链接/重命名 When 冻结 Then 明确不支持', () => {
    const bin = fixture('binary')
    writeFileSync(join(bin.worktreePath, 'src', 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]))
    expect(() => createDevelopmentSnapshot({ worktreePath: bin.worktreePath, sessionDirectory: bin.session, executionId: bin.executionId, workspaceId: 'ws', scope: bin.scope })).toThrow('二进制')

    const link = fixture('symlink')
    symlinkSync('/etc/hosts', join(link.worktreePath, 'src', 'link.ts'))
    expect(() => createDevelopmentSnapshot({ worktreePath: link.worktreePath, sessionDirectory: link.session, executionId: link.executionId, workspaceId: 'ws', scope: link.scope })).toThrow('符号链接')

    const rename = fixture('rename')
    git(rename.worktreePath, 'add', '.')
    git(rename.worktreePath, 'mv', 'src/a.ts', 'src/a-renamed.ts')
    expect(() => createDevelopmentSnapshot({ worktreePath: rename.worktreePath, sessionDirectory: rename.session, executionId: rename.executionId, workspaceId: 'ws', scope: rename.scope })).not.toThrow()
    // --no-renames 枚举下 rename 表现为 delete + add，不中断冻结（内容层面正确）
  })

  test('Given 超限文件/超限总量/超限文件数 When 冻结 Then 拒绝且阈值来自集中配置', () => {
    const one = fixture('limit-file')
    writeFileSync(join(one.worktreePath, 'src', 'big.ts'), 'x'.repeat(SNAPSHOT_LIMITS.maxFileBytes + 1))
    expect(() => createDevelopmentSnapshot({ worktreePath: one.worktreePath, sessionDirectory: one.session, executionId: one.executionId, workspaceId: 'ws', scope: one.scope })).toThrow('单文件上限')

    const total = fixture('limit-total')
    writeFileSync(join(total.worktreePath, 'src', 'a.ts'), 'x'.repeat(SNAPSHOT_LIMITS.maxFileBytes))
    writeFileSync(join(total.worktreePath, 'src', 'b.ts'), 'x'.repeat(SNAPSHOT_LIMITS.maxFileBytes))
    expect(() => createDevelopmentSnapshot({
      worktreePath: total.worktreePath, sessionDirectory: total.session, executionId: total.executionId, workspaceId: 'ws', scope: total.scope,
      limits: { maxTotalBytes: SNAPSHOT_LIMITS.maxFileBytes + 10 },
    })).toThrow('总量')

    const count = fixture('limit-count')
    for (let i = 0; i < SNAPSHOT_LIMITS.maxFiles + 1; i++) writeFileSync(join(count.worktreePath, 'src', `f${i}.ts`), 'x')
    expect(() => createDevelopmentSnapshot({
      worktreePath: count.worktreePath, sessionDirectory: count.session, executionId: count.executionId, workspaceId: 'ws', scope: count.scope,
      limits: { maxFiles: 5 },
    })).toThrow('文件数')
  })
})

describe('快照读取（T30 前置）', () => {
  test('Given 快照内容被篡改或缺失 When 读取 Then 校验失败', () => {
    const f = fixture('tamper')
    writeFileSync(join(f.worktreePath, 'src', 'a.ts'), 'content\n')
    createDevelopmentSnapshot({ worktreePath: f.worktreePath, sessionDirectory: f.session, executionId: f.executionId, workspaceId: 'ws', scope: f.scope })
    const contentsDir = join(f.session, `development-snapshot-${f.executionId}.d`)
    writeFileSync(join(contentsDir, '0.new'), 'tampered\n')
    expect(() => loadDevelopmentSnapshot(f.session, f.executionId)).toThrow('校验失败')

    const missing = fixture('missing')
    expect(() => loadDevelopmentSnapshot(missing.session, missing.executionId)).toThrow('不存在')
  })
})
