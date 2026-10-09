import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBashSandboxPolicy, resolveGitLayout, scratchDirFor } from './bash-sandbox'
import { buildSeatbeltProfile } from '../../pinned-verifier-sandbox'
import { executeBashTool, executeBashToolOnPlatform } from './bash-tool'

const root = mkdtempSync(join(tmpdir(), 'gravitas-bash-sandbox-'))
const configDir = join(root, 'config')
const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
const sessionId = `bash-sandbox-${process.pid}`
const identity = ['-c', 'user.name=agent', '-c', 'user.email=agent@example.invalid']

beforeAll(() => {
  mkdirSync(configDir)
  process.env.PROMA_TEST_CONFIG_DIR = configDir
})
afterAll(() => {
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(root, { recursive: true, force: true })
})

const run = (cwd: string, command: string) => executeBashTool({ command }, { cwd, sessionId })
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...identity, ...args], { encoding: 'utf8' }).trim()
}
/** 主仓库 + 两个链接 worktree（feature、other）。 */
function layout(name: string) {
  const main = join(root, `repo-${name}`)
  mkdirSync(main)
  execFileSync('git', ['init', '-q', '-b', 'main', main])
  writeFileSync(join(main, 'README.md'), 'base\n')
  git(main, ['add', '.'])
  git(main, ['commit', '-q', '-m', 'base'])
  const feature = join(root, `repo-${name}-feature`)
  const other = join(root, `repo-${name}-other`)
  git(main, ['worktree', 'add', '-q', '-b', 'feature', feature])
  git(main, ['worktree', 'add', '-q', '-b', 'other', other])
  return { main, feature, other }
}

describe('Bash 沙箱（macOS seatbelt）', () => {
  test('基础命令在工作目录中运行并返回输出', async () => {
    const dir = join(root, 'plain')
    mkdirSync(dir)
    const result = await run(dir, 'echo hello')
    expect(result.isError).toBeFalsy()
    expect(result.content.trim()).toBe('hello')
  })
  test('scratch（TMPDIR）可写；工作区之外的临时目录不可写', async () => {
    const dir = join(root, 'scratch-check')
    mkdirSync(dir)
    const inside = await run(dir, 'echo ok > "$TMPDIR/a.txt" && cat "$TMPDIR/a.txt"')
    expect(inside.content.trim()).toBe('ok')
    const outside = join(root, 'outside.txt')
    const denied = await run(dir, `echo x > '${outside}'`)
    expect(denied.isError).toBe(true)
    expect(existsSync(outside)).toBe(false)
  })
  test('包管理器缓存指向会话 scratch，而不是共享缓存目录', async () => {
    const dir = join(root, 'cache-env')
    mkdirSync(dir)
    const result = await run(dir, 'echo "$BUN_INSTALL_CACHE_DIR|$npm_config_cache"')
    const [bun, npm] = result.content.trim().split('|')
    expect(bun?.startsWith(scratchDirFor(sessionId))).toBe(true)
    expect(npm?.startsWith(scratchDirFor(sessionId))).toBe(true)
  })
  test('配置目录禁止写入；签名目录（verifiers）读写均被拒绝', async () => {
    const dir = join(root, 'config-check')
    mkdirSync(dir)
    mkdirSync(join(configDir, 'verifiers'), { recursive: true })
    writeFileSync(join(configDir, 'verifiers', 'signing-key.enc'), 'k')
    const read = await run(dir, `cat '${join(configDir, 'verifiers', 'signing-key.enc')}'`)
    expect(read.isError).toBe(true)
    const write = await run(dir, `echo x > '${join(configDir, 'leak.txt')}'`)
    expect(write.isError).toBe(true)
    expect(existsSync(join(configDir, 'leak.txt'))).toBe(false)
    const writeVerifier = await run(dir, `echo x > '${join(configDir, 'verifiers', 'leak.json')}'`)
    expect(writeVerifier.isError).toBe(true)
  })
  test('链接 worktree 中 add/commit/log/branch 正常工作（兼容性）', async () => {
    const { feature } = layout('compat')
    const result = await run(feature, [
      'echo change > f.txt', 'git add f.txt', 'git -c user.name=agent -c user.email=agent@example.invalid commit -qm "feature change"',
      'git log --oneline -1', 'git branch --show-current',
    ].join(' && '))
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('feature change')
    expect(result.content).toContain('feature')
  })
  test('写入 git hooks 被拒绝（hooks 会在之后的正常 git 操作中执行）', async () => {
    const { feature } = layout('hooks')
    const hookPath = join(feature, '..', 'hooks-main', 'hooks-probe')
    const common = (await resolveGitLayout(feature))!.commonDir
    const result = await run(feature, `echo '#!/bin/sh' > '${join(common, 'hooks', 'pre-commit')}'`)
    expect(result.isError).toBe(true)
    expect(existsSync(join(common, 'hooks', 'pre-commit'))).toBe(false)
    expect(existsSync(hookPath)).toBe(false)
  })
  test('修改主仓库 config 被拒绝；git config 写入同样失败（已知取舍）', async () => {
    const { feature } = layout('config')
    const common = (await resolveGitLayout(feature))!.commonDir
    const before = readFileSync(join(common, 'config'), 'utf8')
    const direct = await run(feature, `echo '[x]' >> '${join(common, 'config')}'`)
    expect(direct.isError).toBe(true)
    const viaGit = await run(feature, 'git config --local user.leak yes')
    expect(viaGit.isError).toBe(true)
    expect(readFileSync(join(common, 'config'), 'utf8')).toBe(before)
  })
  test('改写 .git 指针文件被拒绝（防止指向其他 gitdir）', async () => {
    const { feature, other } = layout('pointer')
    const gitdirOfOther = (await resolveGitLayout(other))!.ownDir
    const result = await run(feature, `echo 'gitdir: ${gitdirOfOther}' > .git`)
    expect(result.isError).toBe(true)
    expect(readFileSync(join(feature, '.git'), 'utf8')).toContain('feature')
  })
  test('其他 worktree 的 gitdir 不可写', async () => {
    const { feature, other } = layout('cross')
    const otherHead = join((await resolveGitLayout(other))!.ownDir, 'HEAD')
    const result = await run(feature, `echo 'ref: refs/heads/evil' > '${otherHead}'`)
    expect(result.isError).toBe(true)
    expect(readFileSync(otherHead, 'utf8')).toContain('other')
  })
  test('会话目录位于配置目录下：agent-workspaces 可读写（含 git），其余配置目录仍被拒', async () => {
    const sessionDir = join(configDir, 'agent-workspaces', 'ws-fixture', 'session-1')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(configDir, 'channels.json'), '{}')
    mkdirSync(join(configDir, 'verifiers'), { recursive: true })
    writeFileSync(join(configDir, 'verifiers', 'signing-key.enc'), 'k')
    const write = await run(sessionDir, 'echo data > note.txt')
    expect(write.isError).toBeFalsy()
    expect(readFileSync(join(sessionDir, 'note.txt'), 'utf8').trim()).toBe('data')
    const commit = await run(sessionDir, [
      'git init -q', 'echo x > f.txt', 'git add f.txt',
      'git -c user.name=agent -c user.email=agent@example.invalid commit -qm init', 'git log --oneline',
    ].join(' && '))
    expect(commit.isError).toBeFalsy()
    expect(commit.content).toContain('init')
    // 签名目录不可读写；配置目录其余文件（密文）可读但不可写。
    const readKey = await run(sessionDir, `cat '${join(configDir, 'verifiers', 'signing-key.enc')}'`)
    expect(readKey.isError).toBe(true)
    const readChannels = await run(sessionDir, `cat '${join(configDir, 'channels.json')}'`)
    expect(readChannels.isError).toBeFalsy()
    const writeKey = await run(sessionDir, `echo x > '${join(configDir, 'verifiers', 'x.json')}'`)
    expect(writeKey.isError).toBe(true)
    const writeChannels = await run(sessionDir, `echo x > '${join(configDir, 'channels.json')}'`)
    expect(writeChannels.isError).toBe(true)
  })
  test('非 darwin 平台默认拒绝执行，不运行命令', async () => {
    const dir = join(root, 'linux-check')
    mkdirSync(dir)
    const marker = join(dir, 'ran')
    const result = await executeBashToolOnPlatform({ command: `touch '${marker}'` }, { cwd: dir, sessionId }, 'linux')
    expect(result.isError).toBe(true)
    expect(result.content).toContain('默认拒绝')
    expect(existsSync(marker)).toBe(false)
  })
})

describe('沙箱策略内容', () => {
  test('链接 worktree：允许对象库与自身 gitdir，禁止 hooks、config 与 .git 指针', () => {
    const profile = buildSeatbeltProfile(buildBashSandboxPolicy({
      cwd: '/work/wt', scratchDir: '/tmp/s', configDirs: ['/cfg'],
      git: { commonDir: '/repo/.git', ownDir: '/repo/.git/worktrees/wt' },
    }))
    expect(profile).toContain('(subpath "/repo/.git/objects")')
    expect(profile).toContain('(subpath "/repo/.git/worktrees/wt")')
    // 同一规则可包含多个过滤器（SBPL 允许），按路径片段断言。
    expect(profile).toContain('(subpath "/repo/.git/hooks")')
    expect(profile).toContain('(literal "/repo/.git/config")')
    expect(profile).toContain('(literal "/work/wt/.git")')
    expect(profile).toContain('(subpath "/cfg/verifiers")')
    expect(profile).toContain('(subpath "/cfg")')
    expect(profile).toContain('(subpath "/cfg/agent-workspaces")')
    expect(profile).not.toContain('"/repo/.git/worktrees"')
  })
  test('主工作区：禁止其他 worktree 目录与 hooks，允许其余 .git 内容', () => {
    const profile = buildSeatbeltProfile(buildBashSandboxPolicy({
      cwd: '/repo', scratchDir: '/tmp/s', configDirs: ['/cfg'],
      git: { commonDir: '/repo/.git', ownDir: '/repo/.git' },
    }))
    expect(profile).toContain('(subpath "/repo/.git/worktrees")')
    expect(profile).toContain('(subpath "/repo/.git/hooks")')
    expect(profile).toContain('(literal "/repo/.git/config")')
  })
  test('非 git 目录：只开放工作目录与 scratch', () => {
    const profile = buildSeatbeltProfile(buildBashSandboxPolicy({ cwd: '/plain', scratchDir: '/tmp/s', configDirs: [] }))
    expect(profile).toContain('(subpath "/plain")')
    expect(profile).not.toContain('objects')
    expect(profile).not.toContain('hooks')
  })
})
