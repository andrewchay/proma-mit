import type { OwnerExecutionCommandView } from '@gravitas/shared'

/** 选出应当展示终端证据的命令：所有已终结（非 queued/running）且带证据的命令。 */
export function selectEvidenceCommands(commands: readonly OwnerExecutionCommandView[]): OwnerExecutionCommandView[] {
  return commands
    .filter(command => command.terminalEvidence && command.executionStatus !== 'queued' && command.executionStatus !== 'running')
    .sort((left, right) => right.updatedAt - left.updatedAt)
}
