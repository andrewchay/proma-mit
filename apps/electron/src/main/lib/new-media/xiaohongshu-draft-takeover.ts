import type { ToolContext } from '../agent-runtime/types'
import {
  COMPUTER_USE_REQUEST_TAKEOVER_TOOL_NAME,
  executeComputerUseRequestTakeoverTool,
} from '../agent-runtime/tool-impls/computer-use-tools'
import { assertOwnerToolGate } from '../agent-runtime/tool-impls/tool-utils'
import { getSettings } from '../settings-service'
import { assertDirectorToolActive } from './director-tool-gate'
import { revealXiaohongshuDraftBrowser, operateXiaohongshuDraftBrowser } from './xiaohongshu-draft-browser'
import { getPreparedXiaohongshuHandoff, getXiaohongshuBrowserDraft } from './xiaohongshu-handoff'

const pendingHandoffs = new Set<string>()
const takeoverInstruction = '请切到小红书创作窗口，核对封面与文案，点击「暂存离开」，然后从草稿箱重新打开同一篇草稿。回到本对话，选择「我已完成，可继续」。'

function assertTakeoverAllowed(ctx: ToolContext): void {
  assertDirectorToolActive(ctx)
  assertOwnerToolGate(ctx, COMPUTER_USE_REQUEST_TAKEOVER_TOOL_NAME, {}, { recordKnowledgeRead: false })
  const settings = getSettings().computerUse
  if (settings?.enabled === false || settings?.readOnlyOnly) {
    throw new Error('Computer Use 当前未开放接管。你仍可在新媒体工作台手动交接和核对草稿。')
  }
}

export async function executeXiaohongshuDraftTakeover(input: unknown, ctx: ToolContext) {
  const draftId = (input as { draft_id?: unknown } | undefined)?.draft_id
  try {
    assertTakeoverAllowed(ctx)
    if (typeof draftId !== 'string' || !draftId.trim() || draftId.length > 100) throw new Error('请指定需要暂存的小红书草稿。')
    if (!ctx.onAskUser || !ctx.abortSignal) throw new Error('当前会话无法请求 Computer Use 接管。')
    const handoff = await getPreparedXiaohongshuHandoff(draftId)
    await getXiaohongshuBrowserDraft(handoff.id)
    if (pendingHandoffs.has(handoff.id)) throw new Error('这篇小红书草稿已有接管请求。')
    pendingHandoffs.add(handoff.id)
    try {
      const assertAllowed = () => assertTakeoverAllowed(ctx)
      assertAllowed()
      revealXiaohongshuDraftBrowser(handoff.id)
      const response = await executeComputerUseRequestTakeoverTool({ reason: '小红书草稿暂存', instruction: takeoverInstruction }, ctx)
      if (response.isError) return response
      assertAllowed()
      await operateXiaohongshuDraftBrowser(handoff.id, 'verify', assertAllowed)
      assertAllowed()
      return { toolCallId: '', content: '已核对小红书草稿页的标题和正文，与交接内容一致。发布由用户在小红书操作。' }
    } finally {
      pendingHandoffs.delete(handoff.id)
    }
  } catch (error) {
    return { toolCallId: '', content: error instanceof Error ? error.message : '小红书草稿接管失败，请在创作窗口核对。', isError: true }
  }
}
