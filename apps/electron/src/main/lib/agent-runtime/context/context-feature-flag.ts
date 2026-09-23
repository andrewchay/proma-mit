export interface TypedContextCompilerFlagInput {
  workspaceEnabled?: boolean
  sessionEnabled?: boolean
}

/**
 * 会话开关优先于工作区默认值；两者缺失时 fail-closed。
 */
export function isTypedContextCompilerEnabled(input: TypedContextCompilerFlagInput): boolean {
  return input.sessionEnabled ?? input.workspaceEnabled ?? false
}
