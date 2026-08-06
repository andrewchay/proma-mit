/** Workflow 工作台状态。Definition 的草稿始终是画布与配置面板的单一数据源。 */

import { atom } from 'jotai'
import type { WorkflowDefinition, WorkflowPatchProposal, WorkflowRun, WorkflowRunEvent, WorkflowTemplate } from '@gravitas/shared'

export const workflowTemplatesAtom = atom<WorkflowTemplate[]>([])
export const workflowDefinitionsAtom = atom<WorkflowDefinition[]>([])
export const selectedWorkflowIdAtom = atom<string | null>(null)
export const workflowDraftAtom = atom<WorkflowDefinition | null>(null)
export const workflowLoadingAtom = atom(false)
export const workflowSavingAtom = atom(false)
export const workflowPatchProposalAtom = atom<WorkflowPatchProposal | null>(null)
export const workflowLatestRunAtom = atom<WorkflowRun | null>(null)
export const workflowRunsAtom = atom<WorkflowRun[]>([])
export const selectedWorkflowRunIdAtom = atom<string | null>(null)
export const workflowRunEventsAtom = atom<WorkflowRunEvent[]>([])
