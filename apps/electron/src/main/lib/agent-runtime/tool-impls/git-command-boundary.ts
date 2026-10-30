/**
 * Bash 中高风险 Git 结构的保守词法门禁。
 *
 * 不把它当作通用 shell 解析器：目标是在进入 seatbelt 前明确拒绝已知的同命令执行通道，
 * 而不是分析或放行任意 shell。其他 Runtime 与不经 Bash 工具的入口不在本模块范围内。
 */

const GIT_INIT = /\bgit\s+(?:(?:-C|-c|--git-dir|--work-tree|--exec-path|--namespace|--config-env)\s+\S+\s+|--\S+\s+|-\S+\s+)*init\b/i
const SHELL_COMPOSITION = /[&;|\r\n]/
const GIT_COMMAND = /\bgit\b/i
const INDIRECT_GIT_OPTION = /\bgit\b[\s\S]*?--(?:git-dir|work-tree|separate-git-dir)(?:\s|=)/i
const GIT_ENV_OVERRIDE = /\bGIT_(?:DIR|COMMON_DIR|WORK_TREE|TEMPLATE_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|INDEX_FILE|SHALLOW_FILE|EXEC_PATH|CONFIG(?:_[A-Z0-9]+)?)\s*=/i
const COMMAND_CONFIG_KEY = /(?:core\.(?:fsmonitor|pager|editor|sshcommand|askpass|hookspath)|credential\.helper|diff\.external|gpg\.program|filter\.[a-z0-9_.-]+\.(?:clean|smudge|process)|include(?:if\.[a-z0-9_.-]+)?\.path)/i
const COMMAND_CONFIG_VALUE = /(?:alias\.[a-z0-9_.-]+|submodule\.[a-z0-9_.-]+\.update)\s*=\s*["']?!/i

/** 返回拒绝原因；未命中受限制结构时返回 undefined。 */
export function findGitCommandBoundaryViolation(command: string): string | undefined {
  if (INDIRECT_GIT_OPTION.test(command)) {
    return 'Bash Git 门禁：不允许通过命令行指定间接 Git 布局，请在当前工作区内操作'
  }
  if (GIT_INIT.test(command) && SHELL_COMPOSITION.test(command)) {
    return 'Bash Git 门禁：git init 必须单独执行，完成 hooks/config 收口后再运行后续命令'
  }
  if (GIT_ENV_OVERRIDE.test(command)) {
    return 'Bash Git 门禁：不允许命令内的 Git 环境覆盖（目录或 config）'
  }
  if (GIT_COMMAND.test(command) && (COMMAND_CONFIG_KEY.test(command) || COMMAND_CONFIG_VALUE.test(command))) {
    return 'Bash Git 门禁：不允许通过 -c/--config-env 注入命令执行型 Git config'
  }
  return undefined
}
