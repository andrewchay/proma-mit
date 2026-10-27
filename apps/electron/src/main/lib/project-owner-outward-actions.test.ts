import { expect, test } from 'bun:test'
import { detectOwnerOutwardActions, OWNER_OUTWARD_TOOL_NAMES } from './project-owner-outward-actions'

const toolUse = (name: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input: {} }] } }) as never

test('Given 会话记录含对外工具调用 When 识别 Then 返回去重后的工具名', () => {
  expect(detectOwnerOutwardActions([toolUse('SendExternalMessage'), toolUse('Write'), toolUse('SendExternalMessage')])).toEqual(['SendExternalMessage'])
})

test('Given 只有工作区内工具 When 识别 Then 不声称存在对外动作', () => {
  expect(detectOwnerOutwardActions([toolUse('Write'), toolUse('Edit'), toolUse('ReadKnowledgeSource')])).toEqual([])
})

test('Given 非工具消息或缺失内容 When 识别 Then 安全跳过不抛错', () => {
  expect(detectOwnerOutwardActions([{ type: 'user', message: { content: '文本' } } as never, { type: 'result' } as never, null as never])).toEqual([])
})

test('Given 对外工具集合 When 检查 Then 只包含明确的跨边界工具', () => {
  expect([...OWNER_OUTWARD_TOOL_NAMES].sort()).toEqual(['ComputerUseRequestTakeover', 'SendExternalMessage', 'WebBridgeDownload', 'WebBridgeUpload'])
})
