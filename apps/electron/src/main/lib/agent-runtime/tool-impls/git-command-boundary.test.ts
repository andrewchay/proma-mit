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

  test('Given 受限制结构出现在引号、heredoc、注释或参数文本里 When 预检 Then 不误拒', () => {
    const cases = [
      'grep -rn "git init 必须单独执行" apps/electron/src/main',
      'rg -n "GIT_DIR=|--git-dir|--config-env" apps/electron/src/main',
      'git commit -qm "docs: 说明 git init 必须单独执行; 不要再组合命令"',
      'git commit -qm "fix: 提交信息里可以出现 --git-dir 字样"',
      'git log --grep="core.fsmonitor" --oneline',
      'git log --grep="GIT_DIR" --all',
      'echo \'bash -c "git init && touch /tmp/pwn" 只是文档字符串\'',
      'git status --short # 注释里写 git init 也不该被拦',
      'git init -q 2>&1',
      'git -c user.name=agent commit -qm "git init 相关说明"',
    ]
    for (const command of cases) expect(findGitCommandBoundaryViolation(command)).toBeUndefined()
  })

  test('Given heredoc 正文含受限制结构 When 预检 Then 只按命令分析', () => {
    const command = ['git commit -F - <<\'EOF\'', '说明：git init 必须单独执行', 'GIT_DIR=/tmp/x git status', 'EOF', 'git status'].join('\n')
    expect(findGitCommandBoundaryViolation(command)).toBeUndefined()
  })

  test('Given 嵌套的 sh -c 脚本体 When 预检 Then 仍按命令分析', () => {
    expect(findGitCommandBoundaryViolation('bash -c "git init -q && git config core.fsmonitor x"'))
      .toContain('git init 必须单独执行')
    expect(findGitCommandBoundaryViolation('sh -c "git --git-dir=/tmp/other status"'))
      .toContain('间接 Git 布局')
  })

  test('Given 换行或前缀命令包裹 When 预检 Then 组合与覆盖仍被拒绝', () => {
    expect(findGitCommandBoundaryViolation('git init -q\ngit status')).toContain('git init 必须单独执行')
    expect(findGitCommandBoundaryViolation('env GIT_DIR=/tmp/other git status')).toContain('Git 环境覆盖')
    expect(findGitCommandBoundaryViolation('sudo GIT_DIR=/tmp/other git status')).toContain('Git 环境覆盖')
    expect(findGitCommandBoundaryViolation('git status && git -c core.fsmonitor=/tmp/pwn status')).toContain('命令执行型 Git config')
  })

  test('Given eval 或 find -exec 间接执行 When 预检 Then 仍按命令分析', () => {
    expect(findGitCommandBoundaryViolation('eval "git init -q && git config core.fsmonitor x"')).toContain('git init 必须单独执行')
    expect(findGitCommandBoundaryViolation('eval git --git-dir=/tmp/other status')).toContain('间接 Git 布局')
    expect(findGitCommandBoundaryViolation('find . -maxdepth 1 -exec git init \\;')).toContain('git init 必须单独执行')
    expect(findGitCommandBoundaryViolation('find . -execdir git -c core.fsmonitor=x status +')).toContain('命令执行型 Git config')
    // eval 内只有一条命令时等价于直接执行，不按组合处理。
    expect(findGitCommandBoundaryViolation('eval "git init -q"')).toBeUndefined()
  })

  test('Given eval 只做无害展开或 find 不派生子命令 When 预检 Then 不误拒', () => {
    const cases = [
      'eval "$(direnv hook zsh)"',
      'eval echo hello',
      'find . -name "*.ts" -maxdepth 2',
      'find . -name "git init 说明.txt"',
      'find . -exec grep -l pattern {} \\;',
    ]
    for (const command of cases) expect(findGitCommandBoundaryViolation(command)).toBeUndefined()
  })
})
