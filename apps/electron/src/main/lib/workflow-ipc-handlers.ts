/** Workflow Mode 的最小 IPC 边界。 */

import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  WORKFLOW_IPC_CHANNELS,
  type WorkflowDefinition,
  type WorkflowPublishInput,
  type WorkflowRun,
  type WorkflowRunEvent,
  type WorkflowTriggerKind,
  type WorkflowIdentityDirectory,
  type WorkflowImportInput,
  type WorkflowTemplatePublishInput,
} from '@proma/shared'
import { executeWorkflowAgentNode } from './workflow-agent-executor'
import { executeWorkflowDeterministicNode } from './workflow-deterministic-executor'
import { executeWorkflowRun } from './workflow-run-executor'
import { proposeWorkflowPatches } from './workflow-designer-service'
import { getWorkflowIdentityDirectory, saveWorkflowIdentityDirectory } from './workflow-identity-service'
import { triggerWorkflowEvent } from './workflow-event-service'
import { deleteWorkflowTemplate, installWorkflowTemplate, installWorkflowTemplateBatch, listWorkflowTemplates, previewWorkflowTemplateUpgrade, publishWorkflowTemplate, rollbackWorkflowTemplate, upgradeWorkflowTemplate } from './workflow-template-service'
import {
  cancelWorkflowRun,
  createWorkflowRun,
  getWorkflowDefinition,
  getWorkflowRun,
  listWorkflowDefinitions,
  listWorkflowRuns,
  listWorkflowRunEvents,
  publishWorkflowDefinition,
  resolveWorkflowApproval,
  saveWorkflowDefinition,
  deleteWorkflowDefinition,
  exportWorkflowDefinition,
  importWorkflowDefinition,
  resolveWorkflowSideEffect,
} from './workflow-service'

export function registerWorkflowIpcHandlers(): void {
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.LIST_DEFINITIONS, (): WorkflowDefinition[] => listWorkflowDefinitions())
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.GET_DEFINITION, (_event, workflowId: string): WorkflowDefinition | null => getWorkflowDefinition(workflowId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.SAVE_DEFINITION, (_event, input: unknown): WorkflowDefinition => saveWorkflowDefinition(input))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.DELETE_DEFINITION, (_event, workflowId: string): { deleted: boolean; reason?: string } => deleteWorkflowDefinition(workflowId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.EXPORT_DEFINITION, (_event, workflowId: string) => exportWorkflowDefinition(workflowId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.IMPORT_DEFINITION, (_event, input: WorkflowImportInput): WorkflowDefinition => importWorkflowDefinition(input))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.EXPORT_DEFINITION_FILE, async (_event, workflowId: string): Promise<boolean> => {
    const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow()!, { title: '导出 Workflow', defaultPath: `${workflowId}.paa-workflow.json`, filters: [{ name: 'PAA Workflow', extensions: ['json'] }] })
    if (result.canceled || !result.filePath) return false
    writeFileSync(result.filePath, JSON.stringify(exportWorkflowDefinition(workflowId), null, 2), 'utf-8')
    return true
  })
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.IMPORT_DEFINITION_FILE, async (_event, workspaceId: string): Promise<WorkflowDefinition | null> => {
    const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow()!, { title: '导入 Workflow', properties: ['openFile'], filters: [{ name: 'PAA Workflow', extensions: ['json'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    return importWorkflowDefinition({ file: JSON.parse(readFileSync(result.filePaths[0], 'utf-8')) as unknown, workspaceId })
  })
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.LIST_TEMPLATES, () => listWorkflowTemplates())
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.PUBLISH_TEMPLATE, (_event, workflowId: string, input: WorkflowTemplatePublishInput) => publishWorkflowTemplate(workflowId, input))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.DELETE_TEMPLATE, (_event, templateId: string) => deleteWorkflowTemplate(templateId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.INSTALL_TEMPLATE, (_event, input: { templateId: string; workspaceId: string; workflowId?: string }) => installWorkflowTemplate(input.templateId, input.workspaceId, input.workflowId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.INSTALL_TEMPLATE_BATCH, (_event, input: { templateId: string; workspaceIds: string[] }) => installWorkflowTemplateBatch(input.templateId, input.workspaceIds))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.UPGRADE_TEMPLATE, (_event, workflowId: string) => upgradeWorkflowTemplate(workflowId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.PREVIEW_TEMPLATE_UPGRADE, (_event, workflowId: string) => previewWorkflowTemplateUpgrade(workflowId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.ROLLBACK_TEMPLATE, (_event, workflowId: string) => rollbackWorkflowTemplate(workflowId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.RESOLVE_SIDE_EFFECT, (_event, input: { workflowId: string; runId: string; nodeId: string; action: 'confirm' | 'retry' | 'abandon' }) => resolveWorkflowSideEffect(input.workflowId, input.runId, input.nodeId, input.action))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.PUBLISH_DEFINITION, (_event, workflowId: string, input: WorkflowPublishInput): WorkflowDefinition => {
    return publishWorkflowDefinition(workflowId, input)
  })
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.CREATE_RUN, (_event, workflowId: string, input: Record<string, unknown>, trigger?: WorkflowTriggerKind): WorkflowRun => {
    return createWorkflowRun(workflowId, input, trigger)
  })
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.GET_RUN, (_event, workflowId: string, runId: string): WorkflowRun | null => getWorkflowRun(workflowId, runId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.LIST_RUNS, (_event, workflowId: string): WorkflowRun[] => listWorkflowRuns(workflowId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.LIST_RUN_EVENTS, (_event, workflowId: string, runId: string): WorkflowRunEvent[] => listWorkflowRunEvents(workflowId, runId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.EXECUTE_AGENT_NODE, async (_event, input: {
    workflowId: string
    runId: string
    nodeId: string
    channelId: string
    modelId?: string
  }): Promise<WorkflowRun> => executeWorkflowAgentNode(input.workflowId, input.runId, input.nodeId, input.channelId, input.modelId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.EXECUTE_DETERMINISTIC_NODE, (_event, input: { workflowId: string; runId: string; nodeId: string }): WorkflowRun => executeWorkflowDeterministicNode(input.workflowId, input.runId, input.nodeId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.EXECUTE_RUN, async (_event, input: { workflowId: string; runId: string; channelId: string; modelId?: string }): Promise<WorkflowRun> => executeWorkflowRun(input.workflowId, input.runId, input.channelId, input.modelId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.RESOLVE_APPROVAL, (_event, input: {
    workflowId: string
    runId: string
    approvalId: string
    decision: { approved: boolean; resolvedBy?: string; comment?: string; editedOutput?: Record<string, unknown> }
  }): WorkflowRun => resolveWorkflowApproval(input.workflowId, input.runId, input.approvalId, input.decision))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.CANCEL_RUN, (_event, workflowId: string, runId: string): WorkflowRun => cancelWorkflowRun(workflowId, runId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.PROPOSE_PATCHES, async (_event, input: { definition: WorkflowDefinition; instruction: string; channelId: string; modelId?: string }) => proposeWorkflowPatches(input.definition, input.instruction, input.channelId, input.modelId))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.GET_IDENTITY_DIRECTORY, (): WorkflowIdentityDirectory => getWorkflowIdentityDirectory())
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.SAVE_IDENTITY_DIRECTORY, (_event, directory: WorkflowIdentityDirectory): WorkflowIdentityDirectory => saveWorkflowIdentityDirectory(directory))
  ipcMain.handle(WORKFLOW_IPC_CHANNELS.TRIGGER_EVENT, async (_event, input: { eventName: string; payload: Record<string, unknown> }): Promise<WorkflowRun[]> => triggerWorkflowEvent(input.eventName, input.payload))
}
