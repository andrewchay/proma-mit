import { describe, expect, test } from 'bun:test'
import { findGitCommandBoundaryViolation } from './git-command-boundary'

describe('Git 同命令执行边界', () => {
  test('Given git init 与其他 shell 步骤组合 When 预检 Then 执行前拒绝', () => {
    const cases = [
      'git init -q && git config core.fsmonitor "touch /tmp/pwn" && git status',
      'git init -q && echo evil > .git/hooks/pre-commit',
      'git status; git init -q',
      'git init -q | tee init.log',
    ]
    for (const command of cases) {
      expect(findGitCommandBoundaryViolation(command)).toContain('git init 必须单独执行')
    }
  })

  test('Given 独立 git init 或普通 Git 操作 When 预检 Then 保持兼容', () => {
    const cases = [
      'git init -q',
      'git init --template=/tmp/template',
      'git status --short',
      'git -c user.name=agent -c user.email=agent@example.invalid commit -qm init',
      'echo "core.fsmonitor 只是文档文本"',
    ]
    for (const command of cases) expect(findGitCommandBoundaryViolation(command)).toBeUndefined()
  })

  test('Given 命令行注入执行型 config When 预检 Then 不进入 Git', () => {
    const cases = [
      'git -c core.fsmonitor="touch /tmp/pwn" status',
      'git --config-env=core.hooksPath=EVIL_HOOKS status',
      'git -c filter.evil.clean="touch /tmp/pwn; cat" add a.txt',
      'git -c include.path=/tmp/evil status',
      'git -c alias.boom="!touch /tmp/pwn" boom',
    ]
    for (const command of cases) {
      expect(findGitCommandBoundaryViolation(command)).toContain('命令执行型 Git config')
    }
  })

  test('Given 命令内覆盖 Git 目录或 config 环境 When 预检 Then 失败关闭', () => {
    const cases = [
      'GIT_DIR=/tmp/other/.git git status',
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=/tmp/pwn git status',
      'GIT_CONFIG_PARAMETERS="core.pager=/tmp/pwn" git log',
    ]
    for (const command of cases) {
      expect(findGitCommandBoundaryViolation(command)).toContain('Git 环境覆盖')
    }
  })

  test('Given 命令行指定间接 Git 布局 When 预检 Then 拒绝绕过当前工作区', () => {
    const cases = [
      'git --git-dir=/tmp/other/.git status',
      'git --work-tree=/tmp/other status',
      'git init --separate-git-dir=/tmp/other/.git',
    ]
    for (const command of cases) {
      expect(findGitCommandBoundaryViolation(command)).toContain('间接 Git 布局')
    }
  })
})
