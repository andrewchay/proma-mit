import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertNoWritableHardlinks, buildBashSandboxPolicy, quarantineNewGitHooks, quarantineWritableHardlinks, resolveGitLayout, sanitizeBashGitEnvironment, scratchDirFor } from './bash-sandbox'
import { buildSeatbeltProfile } from '../../pinned-verifier-sandbox'
import { executeBashTool, executeBashToolOnPlatform } from './bash-tool'

const root = mkdtempSync(join(tmpdir(), 'gravitas-bash-sandbox-'))
const configDir = join(root, 'config')
const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
const sessionId = `bash-sandbox-${process.pid}`
const identity = ['-c', 'user.name=agent', '-c', 'user.email=agent@example.invalid']

beforeAll(async () => {
  mkdirSync(configDir)
  process.env.PROMA_TEST_CONFIG_DIR = configDir
  const { initProjectDb } = await import('../../project-sqlite-store')
  await initProjectDb()
})
afterAll(async () => {
  const { closeProjectDb } = await import('../../project-sqlite-store')
  closeProjectDb()
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
    expect((await run(sessionDir, 'git init -q')).isError).toBeFalsy()
    const commit = await run(sessionDir, [
      'echo x > f.txt', 'git add f.txt',
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
  test('Given 配置目录内会话 When 修改其他会话或工作区配置 Then 拒绝写入且本会话仍可工作', async () => {
    const workspace = join(configDir, 'agent-workspaces', 'isolation')
    const session = join(workspace, 'current')
    const other = join(workspace, 'other')
    mkdirSync(session, { recursive: true })
    mkdirSync(other, { recursive: true })
    const mcp = join(workspace, 'mcp.json')
    const otherFile = join(other, 'state.json')
    writeFileSync(mcp, 'original')
    writeFileSync(otherFile, 'original')
    expect((await run(session, `echo x > '${mcp}'`)).isError).toBe(true)
    expect((await run(session, `python3 -c "open('${otherFile}', 'w').write('changed')"`)).isError).toBe(true)
    expect(readFileSync(mcp, 'utf8')).toBe('original')
    expect(readFileSync(otherFile, 'utf8')).toBe('original')
    expect((await run(session, 'echo current > allowed.txt')).isError).toBeFalsy()
  })
  test('Given 工作目录中的链接指向其他会话 When 通过链接写入 Then 不修改其他会话', async () => {
    const workspace = join(configDir, 'agent-workspaces', 'link-isolation')
    const session = join(workspace, 'current')
    const other = join(workspace, 'other')
    mkdirSync(session, { recursive: true }); mkdirSync(other, { recursive: true })
    const target = join(other, 'state.json')
    writeFileSync(target, 'original')
    symlinkSync(target, join(session, 'symlink'))
    await run(session, 'echo changed > symlink')
    expect(readFileSync(target, 'utf8')).toBe('original')
    await run(session, `ln '${target}' hardlink && echo changed > hardlink`)
    expect(readFileSync(target, 'utf8')).toBe('original')
  })
  // 预存硬链接由 prepareBashSandbox 的隔离步骤溶解为私有副本；seatbelt 只按路径授权，
  // 无法直接表达 inode 约束。本用例需要在支持嵌套 seatbelt 的宿主环境运行。
  test('Given 预先存在的硬链接指向其他会话 When 写入 Then 不修改其他会话', async () => {
    const workspace = join(configDir, 'agent-workspaces', 'preexisting-hardlink')
    const session = join(workspace, 'current')
    const other = join(workspace, 'other')
    mkdirSync(session, { recursive: true }); mkdirSync(other, { recursive: true })
    const target = join(other, 'state.json')
    writeFileSync(target, 'original')
    linkSync(target, join(session, 'hardlink'))
    await run(session, 'echo changed > hardlink')
    expect(readFileSync(target, 'utf8')).toBe('original')
    // 会话内路径写入成功（落在溶解后的私有副本上），且副本 inode 已与目标分离。
    expect(readFileSync(join(session, 'hardlink'), 'utf8').trim()).toBe('changed')
    expect(statSync(join(session, 'hardlink')).nlink).toBe(1)
    expect(statSync(target).nlink).toBe(1)
  })
  test('Given .git/config 的预存硬链接位于工作目录 When 写入副本 Then config 不变', async () => {
    const session = join(configDir, 'agent-workspaces', 'hardlink-config', 'current')
    mkdirSync(session, { recursive: true })
    git(session, ['init', '-q'])
    const common = (await resolveGitLayout(session))!.commonDir
    linkSync(join(common, 'config'), join(session, 'config-copy'))
    await run(session, `echo '[evil]' > config-copy`)
    expect(readFileSync(join(common, 'config'), 'utf8')).not.toContain('[evil]')
  })
  test('Given 非 git 目录 When 同命令 init 并注入 config Then 执行前拒绝且不创建仓库', async () => {
    const session = join(configDir, 'agent-workspaces', 'init-config-attack', 'current')
    mkdirSync(session, { recursive: true })
    const marker = join(session, 'fsmonitor-ran')
    const result = await run(session, `git init -q && git config core.fsmonitor 'touch ${marker}' && git status --porcelain`)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('git init 必须单独执行')
    expect(existsSync(join(session, '.git'))).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })
  test('Given 已有仓库 When 通过 -c 注入 fsmonitor Then 执行前拒绝且不触发命令', async () => {
    const session = join(configDir, 'agent-workspaces', 'inline-config-attack', 'current')
    mkdirSync(session, { recursive: true })
    git(session, ['init', '-q'])
    const marker = join(session, 'inline-fsmonitor-ran')
    const result = await run(session, `git -c core.fsmonitor='touch ${marker}' status --porcelain`)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('命令执行型 Git config')
    expect(existsSync(marker)).toBe(false)
  })
  test('Given 独立 init 使用含 hook 的模板 When 命令结束 Then hook 被收口且后续提交可用', async () => {
    const session = join(configDir, 'agent-workspaces', 'init-hook-template', 'current')
    const template = join(configDir, 'agent-workspaces', 'init-hook-template', 'template')
    mkdirSync(session, { recursive: true })
    mkdirSync(join(template, 'hooks'), { recursive: true })
    writeFileSync(join(template, 'hooks', 'pre-commit'), 'evil\n')
    const result = await run(session, `git init -q --template='${template}'`)
    expect(result.isError).toBeFalsy()
    expect(readFileSync(join(session, '.git', 'hooks', 'pre-commit.gravitas-quarantine'), 'utf8')).toBe('evil\n')
    expect(existsSync(join(session, '.git', 'hooks', 'pre-commit'))).toBe(false)
    const commit = await run(session, 'echo ok > a.txt && git add a.txt && git -c user.name=agent -c user.email=agent@example.invalid commit -qm init && git log --oneline')
    expect(commit.isError).toBeFalsy()
    expect(commit.content).toContain('init')
  })
  test('Given 配置目录内 git 工作区 When 修改 hooks 或 config Then 拒绝且正常提交仍可用', async () => {
    const session = join(configDir, 'agent-workspaces', 'git-isolation', 'current')
    mkdirSync(session, { recursive: true })
    git(session, ['init', '-q'])
    const common = (await resolveGitLayout(session))!.commonDir
    const before = readFileSync(join(common, 'config'), 'utf8')
    expect((await run(session, `echo x >> '${join(common, 'config')}'`)).isError).toBe(true)
    expect((await run(session, `echo x > '${join(common, 'hooks', 'pre-commit')}'`)).isError).toBe(true)
    expect(readFileSync(join(common, 'config'), 'utf8')).toBe(before)
    const commit = await run(session, 'echo ok > a.txt && git add a.txt && git -c user.name=agent -c user.email=agent@example.invalid commit -qm init')
    expect(commit.isError).toBeFalsy()
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
    expect(profile).not.toContain('(subpath "/cfg/agent-workspaces")')
    expect(profile).not.toContain('"/repo/.git/worktrees"')
  })
  test('配置目录下的工作区根不能作为整个 workspace 的写入例外', () => {
    const profile = buildSeatbeltProfile(buildBashSandboxPolicy({
      cwd: '/cfg/agent-workspaces/ws', scratchDir: '/tmp/s', configDirs: ['/cfg'],
    }))
    expect(profile).not.toContain('(allow file-write* (subpath \"/cfg/agent-workspaces/ws\"))')
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

describe('quarantineWritableHardlinks（纯文件系统）', () => {
  const makeRoot = (name: string) => {
    const root = join(mkdtempSync(join(tmpdir(), `quarantine-${name}-`)), 'ws')
    mkdirSync(root, { recursive: true })
    return root
  }
  const policyFor = (roots: string[], literals: string[] = []) => ({
    writableRoots: roots,
    writableLiterals: literals,
    denyRoots: [],
  })

  test('Given 预存硬链接指向范围外文件 When 隔离后写入 Then 范围外文件不受影响', async () => {
    const outside = makeRoot('outside')
    const inside = makeRoot('inside')
    const target = join(outside, 'secret.txt')
    writeFileSync(target, 'original')
    const link = join(inside, 'hardlink.txt')
    linkSync(target, link)
    await quarantineWritableHardlinks(policyFor([inside]))
    writeFileSync(link, 'changed')
    expect(readFileSync(target, 'utf8')).toBe('original')
    // 双方各自成为独立 inode。
    expect(statSync(link).nlink).toBe(1)
    expect(statSync(target).nlink).toBe(1)
  })

  test('Given 权限位不同的硬链接文件 When 隔离 Then 副本保留权限位', async () => {
    const root = makeRoot('mode')
    const script = join(root, 'run.sh')
    writeFileSync(script, '#!/bin/sh\necho ok\n')
    chmodSync(script, 0o755)
    const link = join(root, 'run-link.sh')
    linkSync(script, link)
    await quarantineWritableHardlinks(policyFor([root]))
    expect(statSync(link).mode & 0o777).toBe(0o755)
    expect(statSync(script).mode & 0o777).toBe(0o755)
  })

  test('Given nlink=1 的普通文件 When 隔离 Then inode 不变', async () => {
    const root = makeRoot('single')
    const file = join(root, 'plain.txt')
    writeFileSync(file, 'data')
    const before = statSync(file).ino
    await quarantineWritableHardlinks(policyFor([root]))
    expect(statSync(file).ino).toBe(before)
    expect(readFileSync(file, 'utf8')).toBe('data')
  })

  test('Given 符号链接 When 隔离 Then 跳过且不跟随', async () => {
    const outside = makeRoot('sym-outside')
    const root = makeRoot('sym-inside')
    const target = join(outside, 't.txt')
    writeFileSync(target, 'original')
    const link = join(root, 'link')
    symlinkSync(target, link)
    await quarantineWritableHardlinks(policyFor([root]))
    // 符号链接本体保持为链接；未发生副本替换。
    expect(readFileSync(link, 'utf8')).toBe('original')
  })

  test('Given 范围内两个互为硬链接的文件 When 隔离 Then 双方独立副本化', async () => {
    const root = makeRoot('pair')
    const a = join(root, 'a.txt')
    const b = join(root, 'b.txt')
    writeFileSync(a, 'shared')
    linkSync(a, b)
    await quarantineWritableHardlinks(policyFor([root]))
    writeFileSync(a, 'from-a')
    expect(readFileSync(b, 'utf8')).toBe('shared')
  })

  test('Given 可写字面路径（writableLiterals）When 文件带预存硬链接 Then 同样溶解', async () => {
    const outside = makeRoot('lit-outside')
    const root = makeRoot('lit-inside')
    const target = join(outside, 't.txt')
    writeFileSync(target, 'original')
    const literal = join(root, 'packed-refs')
    linkSync(target, literal)
    await quarantineWritableHardlinks(policyFor([], [literal]))
    writeFileSync(literal, 'changed')
    expect(readFileSync(target, 'utf8')).toBe('original')
  })

  test('Given 递归子目录中的预存硬链接 When 隔离 Then 深层文件同样处理', async () => {
    const outside = makeRoot('deep-outside')
    const root = makeRoot('deep-inside')
    const nested = join(root, 'a', 'b')
    mkdirSync(nested, { recursive: true })
    const target = join(outside, 't.txt')
    writeFileSync(target, 'original')
    linkSync(target, join(nested, 'deep.txt'))
    await quarantineWritableHardlinks(policyFor([root]))
    writeFileSync(join(nested, 'deep.txt'), 'changed')
    expect(readFileSync(target, 'utf8')).toBe('original')
  })

  test('Given 扫描根不存在 When 隔离 Then 静默跳过不报错', async () => {
    await quarantineWritableHardlinks(policyFor([join(tmpdir(), 'quarantine-missing-root-xyz')]))
  })

  test('Given 隔离后目录无残留临时文件 When 列目录 Then 无 .gravitas-quarantine 残留', async () => {
    const outside = makeRoot('clean-outside')
    const root = makeRoot('clean-inside')
    const target = join(outside, 't.txt')
    writeFileSync(target, 'original')
    linkSync(target, join(root, 'f.txt'))
    await quarantineWritableHardlinks(policyFor([root]))
    const names = [...readdirSync(root)]
    expect(names.some((n) => n.includes('gravitas-quarantine'))).toBe(false)
    expect(names).toContain('f.txt')
    expect(readFileSync(target, 'utf8')).toBe('original')
  })
})

describe('quarantineNewGitHooks（纯文件系统）', () => {
  const makeRepo = (name: string, options: { config?: string } = {}) => {
    const root = join(mkdtempSync(join(tmpdir(), `hooks-${name}-`)), 'ws')
    const hooks = join(root, '.git', 'hooks')
    mkdirSync(hooks, { recursive: true })
    // rev-parse 校验仓库需要 objects 与 refs 目录存在。
    mkdirSync(join(root, '.git', 'objects'), { recursive: true })
    mkdirSync(join(root, '.git', 'refs'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(root, '.git', 'config'), options.config ?? '[core]\n\trepositoryformatversion = 0\n')
    return { root, hooks }
  }

  test('Given 新建仓库含恶意 hook When 收口 Then hook 停用而 sample 保留', async () => {
    const { root, hooks } = makeRepo('evil')
    writeFileSync(join(hooks, 'pre-commit'), 'evil')
    writeFileSync(join(hooks, 'pre-commit.sample'), 'sample')
    const notice = await quarantineNewGitHooks(root, false)
    expect(notice).toContain('pre-commit')
    expect(existsSync(join(hooks, 'pre-commit'))).toBe(false)
    expect(readFileSync(join(hooks, 'pre-commit.gravitas-quarantine'), 'utf8')).toBe('evil')
    expect(readFileSync(join(hooks, 'pre-commit.sample'), 'utf8')).toBe('sample')
  })

  test('Given 仓库在命令前已存在 When 收口 Then 不改动任何文件', async () => {
    const { root, hooks } = makeRepo('preexisting')
    writeFileSync(join(hooks, 'pre-commit'), 'user-hook')
    const notice = await quarantineNewGitHooks(root, true)
    expect(notice).toBeUndefined()
    expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).toBe('user-hook')
  })

  test('Given 无仓库 When 收口 Then 静默无操作', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'hooks-empty-')), 'ws')
    mkdirSync(root, { recursive: true })
    expect(await quarantineNewGitHooks(root, false)).toBeUndefined()
  })

  test('Given core.hooksPath 指向工作目录内目录 When 收口 Then 该目录 hook 同样停用', async () => {
    const { root } = makeRepo('hookspath', { config: '[core]\n\trepositoryformatversion = 0\n\thooksPath = custom-hooks\n' })
    mkdirSync(join(root, 'custom-hooks'), { recursive: true })
    writeFileSync(join(root, 'custom-hooks', 'pre-commit'), 'evil')
    const notice = await quarantineNewGitHooks(root, false)
    expect(notice).toContain('custom-hooks')
    expect(existsSync(join(root, 'custom-hooks', 'pre-commit'))).toBe(false)
    expect(readFileSync(join(root, 'custom-hooks', 'pre-commit.gravitas-quarantine'), 'utf8')).toBe('evil')
  })

  test('Given core.hooksPath 指向工作目录之外 When 收口 Then 不触碰范围外目录', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'hooks-outside-'))
    const { root } = makeRepo('outside', { config: `[core]\n\thooksPath = ${outside}\n` })
    writeFileSync(join(outside, 'pre-commit'), 'outside-hook')
    await quarantineNewGitHooks(root, false)
    // 范围外的目录不是本会话创建，保持原样。
    expect(readFileSync(join(outside, 'pre-commit'), 'utf8')).toBe('outside-hook')
  })

  test('Given 符号链接形式的 hook When 收口 Then 同样停用', async () => {
    const { root, hooks } = makeRepo('symlink')
    const target = join(mkdtempSync(join(tmpdir(), 'hooks-target-')), 'evil.sh')
    writeFileSync(target, 'evil')
    symlinkSync(target, join(hooks, 'pre-commit'))
    const notice = await quarantineNewGitHooks(root, false)
    expect(notice).toContain('pre-commit')
    expect(existsSync(join(hooks, 'pre-commit'))).toBe(false)
    expect(existsSync(join(hooks, 'pre-commit.gravitas-quarantine'))).toBe(true)
  })

  test('Given 命令前不存在仓库且目录中没有 hooks When 收口 Then 正常完成', async () => {
    const { root } = makeRepo('nohooksdir')
    rmSync(join(root, '.git', 'hooks'), { recursive: true })
    expect(await quarantineNewGitHooks(root, false)).toBeUndefined()
  })
})

describe('Git 间接环境隔离', () => {
  test('Given 继承环境含目录、config 与执行变量 When 构建沙箱环境 Then 清除并重定向到空配置', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      GIT_DIR: '/outside/.git',
      GIT_WORK_TREE: '/outside',
      GIT_COMMON_DIR: '/outside/.git',
      GIT_TEMPLATE_DIR: '/outside/templates',
      GIT_OBJECT_DIRECTORY: '/outside/objects',
      GIT_INDEX_FILE: '/outside/index',
      GIT_EXEC_PATH: '/outside/libexec',
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor=/outside/pwn'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: '/outside/pwn',
      GIT_CONFIG_GLOBAL: '/outside/config',
      GIT_SSH_COMMAND: '/outside/ssh',
      GIT_ASKPASS: '/outside/askpass',
      GIT_EDITOR: '/outside/editor',
      PAGER: '/outside/pager',
    }
    const env = sanitizeBashGitEnvironment(source)
    expect(env.PATH).toBe(source.PATH)
    for (const key of [
      'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_TEMPLATE_DIR', 'GIT_OBJECT_DIRECTORY',
      'GIT_INDEX_FILE', 'GIT_EXEC_PATH', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_EDITOR', 'PAGER',
    ]) expect(env[key]).toBeUndefined()
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null')
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(source.GIT_DIR).toBe('/outside/.git')
  })

  test('Given 进程 GIT_DIR 指向其他仓库 When 解析当前目录布局 Then 忽略继承覆盖', async () => {
    const actual = join(root, 'layout-actual')
    const other = join(root, 'layout-other')
    mkdirSync(actual)
    mkdirSync(other)
    git(actual, ['init', '-q'])
    git(other, ['init', '-q'])
    const previous = process.env.GIT_DIR
    process.env.GIT_DIR = join(other, '.git')
    try {
      const resolved = await resolveGitLayout(actual)
      expect(resolved?.ownDir).toBe(resolved?.commonDir)
      expect(resolved?.ownDir.endsWith(join('layout-actual', '.git'))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previous
    }
  })
})

describe('硬链接启动前复核', () => {
  test('Given 初次隔离后新增跨边界硬链接 When 启动前复核 Then 失败关闭且不修改目标', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hardlink-launch-race-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const target = join(root, 'outside.txt')
    writeFileSync(target, 'original')
    const policy = { writableRoots: [workspace], denyRoots: [] }
    await quarantineWritableHardlinks(policy)
    linkSync(target, join(workspace, 'raced.txt'))

    await expect(assertNoWritableHardlinks(policy)).rejects.toThrow('可写范围出现硬链接')
    expect(readFileSync(target, 'utf8')).toBe('original')
    expect(statSync(target).nlink).toBe(2)
  })
})

describe('Bash 会话中止（端到端）', () => {
  test('Given 命令运行中会话被中止 When 停止 Then 命令与后代被终止且不再产生副作用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abort-'))
    const marker = join(dir, 'survived')
    const controller = new AbortController()
    const pending = executeBashTool(
      { command: `sleep 3; touch '${marker}'` },
      { cwd: dir, sessionId, abortSignal: controller.signal },
    )
    setTimeout(() => controller.abort(), 200)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toContain('中止')
    // 给被中止命令足够时间"如果还活着"就会写下 marker。
    await new Promise((resolve) => setTimeout(resolve, 3500))
    expect(existsSync(marker)).toBe(false)
  }, 15_000)
})
