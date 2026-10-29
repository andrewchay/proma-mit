import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCommandCarryingConfigKey, quarantineNewGitArtifacts, sanitizeGitConfigText, sanitizeNewGitConfig } from './bash-sandbox'

const git = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=agent@example.invalid', ...args], { cwd, encoding: 'utf8' })

/** 造一个"git init 已完成"的最小仓库目录，avoid 依赖真实 git 生成。 */
const makeRepo = (name: string, config: string) => {
  const root = join(mkdtempSync(join(tmpdir(), `cfg-${name}-`)), 'ws')
  mkdirSync(join(root, '.git', 'objects'), { recursive: true })
  mkdirSync(join(root, '.git', 'refs'), { recursive: true })
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(root, '.git', 'config'), config)
  return { root, configPath: join(root, '.git', 'config') }
}

describe('sanitizeGitConfigText（纯文本）', () => {
  test('Given 各载体键 When 清洗 Then 全部移除且保留无关配置', () => {
    const input = [
      '[core]',
      '\trepositoryformatversion = 0',
      '\tfilemode = true',
      '\tfsmonitor = touch /tmp/pwn',
      '\tpager = less',
      '\thooksPath = .evil-hooks',
      '[credential]',
      '\thelper = !sh -c "exfil"',
      '[diff]',
      '\texternal = /tmp/pwn.sh',
      '[filter "evil"]',
      '\tclean = touch /tmp/pwn; cat',
      '\tsmudge = cat',
      '[include]',
      '\tpath = /tmp/outside.gitconfig',
      '[alias]',
      '\tst = status -sb',
      '\tboom = !touch /tmp/pwn',
      '[user]',
      '\temail = dev@example.invalid',
      '',
    ].join('\n')
    const { text, removed } = sanitizeGitConfigText(input)
    expect(removed).toEqual([
      'core.fsmonitor',
      'core.pager',
      'core.hookspath',
      'credential.helper',
      'diff.external',
      'filter.evil.clean',
      'filter.evil.smudge',
      'include.path',
      'alias.boom',
    ])
    expect(text).toContain('repositoryformatversion = 0')
    expect(text).toContain('filemode = true')
    expect(text).toContain('st = status -sb')
    expect(text).toContain('email = dev@example.invalid')
    expect(text).not.toContain('fsmonitor')
    expect(text).not.toContain('/tmp/pwn')
  })

  test('Given 点分小节与大小写混写 When 清洗 Then 同样命中', () => {
    const { removed } = sanitizeGitConfigText('[CORE]\n\tFSMonitor = /tmp/pwn\n[filter.lfs]\n\tprocess = /tmp/pwn\n')
    expect(removed).toEqual(['core.fsmonitor', 'filter.lfs.process'])
  })

  test('Given 续行值 When 清洗 Then 整条移除不留半截', () => {
    const { text, removed } = sanitizeGitConfigText('[filter "x"]\n\tclean = touch /tmp/a; \\\n\t\ttouch /tmp/b\n[core]\n\tbare = false\n')
    expect(removed).toEqual(['filter.x.clean'])
    expect(text).not.toContain('/tmp/b')
    expect(text).toContain('bare = false')
  })

  test('Given 多值同名键 When 清洗 Then 全部移除', () => {
    const { removed } = sanitizeGitConfigText('[credential]\n\thelper = a\n\thelper = b\n')
    expect(removed).toEqual(['credential.helper'])
  })

  test('Given 无载体 When 清洗 Then 原样返回', () => {
    const input = '[core]\n\trepositoryformatversion = 0\n[user]\n\tname = dev\n'
    expect(sanitizeGitConfigText(input).text).toBe(input)
    expect(sanitizeGitConfigText(input).removed).toEqual([])
  })

  test('Given 键判定 When 值与键组合不同 Then 只认危险组合', () => {
    expect(isCommandCarryingConfigKey('alias.st', 'status -sb')).toBe(false)
    expect(isCommandCarryingConfigKey('alias.st', '!git status')).toBe(true)
    expect(isCommandCarryingConfigKey('submodule.x.update', '!sh -c evil')).toBe(true)
    expect(isCommandCarryingConfigKey('submodule.x.update', 'rebase')).toBe(false)
    expect(isCommandCarryingConfigKey('includeif.gitdir:/x/.path', '/tmp/cfg')).toBe(true)
    expect(isCommandCarryingConfigKey('core.filemode', 'true')).toBe(false)
  })
})

describe('sanitizeNewGitConfig（文件系统）', () => {
  test('Given 新建仓库 config 含载体 When 清洗 Then 改写并保留原文件副本', async () => {
    const config = '[core]\n\trepositoryformatversion = 0\n\tfsmonitor = /tmp/pwn\n\tfilemode = true\n'
    const { root, configPath } = makeRepo('new', config)
    const removed = await sanitizeNewGitConfig(root, false)
    expect(removed).toEqual(['core.fsmonitor'])
    const cleaned = readFileSync(configPath, 'utf8')
    expect(cleaned).toContain('filemode = true')
    expect(cleaned).not.toContain('fsmonitor')
    expect(readFileSync(`${configPath}.gravitas-quarantine`, 'utf8')).toBe(config)
  })

  test('Given 仓库在命令前已存在 When 清洗 Then 完全不改动', async () => {
    const config = '[core]\n\tfsmonitor = /tmp/pwn\n'
    const { root, configPath } = makeRepo('preexisting', config)
    expect(await sanitizeNewGitConfig(root, true)).toBeUndefined()
    expect(readFileSync(configPath, 'utf8')).toBe(config)
    expect(existsSync(`${configPath}.gravitas-quarantine`)).toBe(false)
  })

  test('Given 无载体 When 清洗 Then 不产生副本文件', async () => {
    const { root, configPath } = makeRepo('clean', '[core]\n\trepositoryformatversion = 0\n')
    expect(await sanitizeNewGitConfig(root, false)).toBeUndefined()
    expect(existsSync(`${configPath}.gravitas-quarantine`)).toBe(false)
  })

  test('Given config 为符号链接 When 清洗 Then 不跟随写入', async () => {
    const { root, configPath } = makeRepo('symlink', '[core]\n')
    const outside = join(mkdtempSync(join(tmpdir(), 'cfg-target-')), 'cfg')
    writeFileSync(outside, '[core]\n\tfsmonitor = /tmp/pwn\n')
    const { unlinkSync, symlinkSync } = await import('node:fs')
    unlinkSync(configPath)
    symlinkSync(outside, configPath)
    expect(await sanitizeNewGitConfig(root, false)).toBeUndefined()
    expect(readFileSync(outside, 'utf8')).toContain('fsmonitor')
  })

  test('Given hooks 与 config 同时被注入 When 统一收口 Then 两者都处理', async () => {
    const { root, configPath } = makeRepo('both', '[core]\n\tfsmonitor = /tmp/pwn\n')
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'evil')
    const notice = await quarantineNewGitArtifacts(root, false)
    expect(notice).toContain('pre-commit')
    expect(notice).toContain('core.fsmonitor')
    expect(existsSync(join(root, '.git', 'hooks', 'pre-commit'))).toBe(false)
    expect(readFileSync(configPath, 'utf8')).not.toContain('fsmonitor')
  })
})

describe('config 载体的真实 git 行为', () => {
  test('Given filter.clean 指向外部命令 When git add Then 清洗后不再执行', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'cfg-real-')), 'ws')
    mkdirSync(root, { recursive: true })
    git(root, ['init', '-q', '.'])
    const marker = join(root, 'marker')
    writeFileSync(join(root, '.gitattributes'), '*.txt filter=evil\n')
    writeFileSync(join(root, 'a.txt'), 'x\n')
    git(root, ['config', 'filter.evil.clean', `touch ${marker}; cat`])
    git(root, ['add', 'a.txt'])
    // 先确认载体在真实 git 下确实会执行，否则后面的"未执行"没有证明力。
    expect(existsSync(marker)).toBe(true)

    const removed = await sanitizeNewGitConfig(root, false)
    expect(removed).toEqual(['filter.evil.clean'])
    execFileSync('rm', ['-f', marker])
    execFileSync('rm', ['-f', join(root, '.git', 'index')])
    git(root, ['add', 'a.txt'])
    expect(existsSync(marker)).toBe(false)
  })

  test('Given core.fsmonitor 指向外部命令 When git status Then 清洗后不再执行', async () => {
    const root = join(mkdtempSync(join(tmpdir(), 'cfg-fsmon-')), 'ws')
    mkdirSync(root, { recursive: true })
    git(root, ['init', '-q', '.'])
    const marker = join(root, 'fs-marker')
    const script = join(root, 'fs.sh')
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nexit 0\n`)
    execFileSync('chmod', ['+x', script])
    writeFileSync(join(root, 'a.txt'), 'x\n')
    git(root, ['config', 'core.fsmonitor', script])
    git(root, ['-c', 'core.fsmonitorHookVersion=2', 'status', '--porcelain'])
    const executedBefore = existsSync(marker)

    const removed = await sanitizeNewGitConfig(root, false)
    expect(removed).toEqual(['core.fsmonitor'])
    if (executedBefore) execFileSync('rm', ['-f', marker])
    git(root, ['status', '--porcelain'])
    // 无论 git 版本是否在本次调用中执行 fsmonitor，清洗后 config 中都不再存在该键。
    expect(existsSync(marker)).toBe(false)
    expect(() => git(root, ['config', '--get', 'core.fsmonitor'])).toThrow()
  })
})
