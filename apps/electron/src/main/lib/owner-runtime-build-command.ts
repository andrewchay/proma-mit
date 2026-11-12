/**
 * 原生构建验证命令的解析。
 *
 * 目的：绿地原生/命令行项目（Swift、CLI 等）没有网页可断言，若只允许 browser 断言，
 * 模型只能要么编造断言、要么放弃验证。这里提供一组**固定 argv** 的构建命令，
 * 让这类项目也能产出真实进程证据，而不是退回「模型自称通过」。
 * 边界：
 * - 命令只能来自内置注册表，模型不能自带参数、shell 语法、环境变量或管道；
 * - 执行侧不做 shell 展开，工作目录固定为受管 worktree；
 * - 退出码即结论，超时不算通过（沿用既有验证门禁）。
 */

export const BUILD_VERIFICATION_PREFIX = 'build:'

export interface OwnerRuntimeBuildCommandTemplate {
  /** 稳定标识，进入证据的 command 字段（形如 build:swift） */
  id: string
  title: string
  /** 固定 argv，首项是可执行文件 */
  argv: readonly string[]
  /** 目标文件至少要有一个匹配的扩展名，避免把原生构建塞给纯网页交付 */
  requiresExtensions: readonly string[]
}

/**
 * 注册表随版本发布，模型只能引用不能新增。
 * 新增条目时同步更新 project-owner-execution-assignment-protocol 的提示文本。
 */
const OWNER_RUNTIME_BUILD_COMMANDS: readonly OwnerRuntimeBuildCommandTemplate[] = [
  { id: 'swift', title: 'Swift Package 构建', argv: ['swift', 'build'], requiresExtensions: ['.swift'] },
  { id: 'swift-test', title: 'Swift Package 测试', argv: ['swift', 'test'], requiresExtensions: ['.swift'] },
]

export function listOwnerRuntimeBuildCommands(): readonly OwnerRuntimeBuildCommandTemplate[] {
  return OWNER_RUNTIME_BUILD_COMMANDS
}

export function isBuildVerificationCommand(command: string): boolean {
  return command.trim().startsWith(BUILD_VERIFICATION_PREFIX)
}

/** 解析 `build:<标识>`；未知标识直接报错，不静默跳过。 */
export function resolveOwnerRuntimeBuildCommand(command: string): OwnerRuntimeBuildCommandTemplate {
  const trimmed = command.trim()
  if (!isBuildVerificationCommand(trimmed)) throw new Error(`不是构建验证命令：${command}`)
  const id = trimmed.slice(BUILD_VERIFICATION_PREFIX.length)
  if (!id) throw new Error('构建验证命令缺少标识')
  const template = OWNER_RUNTIME_BUILD_COMMANDS.find(item => item.id === id)
  if (!template) throw new Error(`未知的构建验证命令标识：${id}`)
  return template
}

/** 目标路径里是否至少有一个文件能被该命令覆盖（按扩展名判断）。 */
export function buildCommandCoversTargets(
  template: OwnerRuntimeBuildCommandTemplate,
  targetPaths: readonly string[],
): boolean {
  return targetPaths.some(path => template.requiresExtensions.some(extension => path.toLowerCase().endsWith(extension)))
}
