/**
 * ScriptStudio - 脚本工坊（Chat Tool）
 *
 * 为达人内容创作生成详细的故事脚本、分镜脚本和视频拍摄指导。
 * 是 CreativePilot 的细化版，专注于脚本层面的深度创作。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@gravitas/core'
import type { ChatToolMeta } from '@gravitas/shared'
import { completePrompt, extractJSON } from './llm-service'

// =====================================================================
// 工具元数据
// =====================================================================

export const SCRIPT_STUDIO_TOOL_META: ChatToolMeta = {
  id: 'ma-script-studio',
  name: 'MA脚本工坊',
  description: '为达人内容创作生成详细的故事脚本、分镜脚本和视频拍摄指导，支持故事脚本/分镜脚本/拍摄指南三种模式',
  params: [
    { name: 'brand', type: 'string', description: '品牌名称', required: true },
    { name: 'product', type: 'string', description: '产品名称', required: true },
    { name: 'platform', type: 'string', description: '内容平台（小红书/抖音/B站/微博/快手/TikTok/Instagram/YouTube）', required: true },
    { name: 'script_type', type: 'string', description: '脚本类型（story/分镜/video_guide，默认story）', required: false },
    { name: 'duration', type: 'number', description: '视频时长（秒，默认60）', required: false },
    { name: 'style', type: 'string', description: '风格（真实体验/剧情/测评/教程，默认真实体验）', required: false },
    { name: 'key_messages', type: 'string', description: '必须传递的关键信息，逗号分隔', required: false },
    { name: 'target_audience', type: 'string', description: '目标受众', required: false },
    { name: 'hook_idea', type: 'string', description: '开头钩子创意（可选）', required: false },
  ],
  icon: 'Clapperboard',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<ma_script_studio_instructions>
你拥有 **MA脚本工坊** 能力（ScriptStudio）。

**ma_generate_script — 生成内容脚本：**
当用户需要为 KOL 创作生成详细脚本时调用：
- 生成故事脚本（story_arc、scene_breakdown、dialogue_script）
- 生成分镜脚本（storyboard、lighting_setup、prop_list）
- 生成拍摄指导（shooting_guide、editing_guide、platform_specific_tips）

支持 story / 分镜 / video_guide 三种脚本类型，根据用户需求自动选择或明确指定。
工具会返回详细的脚本内容、分镜描述、拍摄建议和平台-specific技巧。
</ma_script_studio_instructions>`,
}

export const SCRIPT_STUDIO_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'ma_generate_script',
    description: 'Generate detailed content scripts for KOL creation: story scripts with scene breakdowns, shot-by-shot storyboards, or video shooting guides. Supports story/storyboard/video_guide modes. Use when the user needs detailed scriptwriting, shot planning, or filming guidance for influencer content.',
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand name' },
        product: { type: 'string', description: 'Product name' },
        platform: { type: 'string', description: 'Content platform (xiaohongshu/douyin/bilibili/weibo/kuaishou/tiktok/instagram/youtube)' },
        script_type: { type: 'string', description: 'Script type: story / 分镜 / video_guide (default: story)' },
        duration: { type: 'number', description: 'Video duration in seconds (default: 60)' },
        style: { type: 'string', description: 'Style: 真实体验/剧情/测评/教程 (default: 真实体验)' },
        key_messages: { type: 'string', description: 'Key messages to convey, comma separated' },
        target_audience: { type: 'string', description: 'Target audience' },
        hook_idea: { type: 'string', description: 'Opening hook idea (optional)' },
      },
      required: ['brand', 'product', 'platform'],
    },
  },
]

// =====================================================================
// 可用性检查
// =====================================================================

export function isScriptStudioAvailable(): boolean {
  return true
}

// =====================================================================
// 工具执行
// =====================================================================

const TOOL_NAME = 'ma_generate_script'

export function isScriptStudioToolCall(toolName: string): boolean {
  return toolName === TOOL_NAME
}

export async function executeScriptStudioTool(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = toolCall.arguments as Record<string, unknown>
    const brand = String(args.brand ?? '')
    const product = String(args.product ?? '')
    const platform = String(args.platform ?? '')

    if (!brand || !product || !platform) {
      return { toolCallId: toolCall.id, content: '参数缺失: brand、product 和 platform 为必填项', isError: true }
    }

    const scriptType = String(args.script_type ?? 'story')
    const duration = Number(args.duration ?? 60)
    const style = String(args.style ?? '真实体验')
    const keyMessages = String(args.key_messages ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const targetAudience = String(args.target_audience ?? '')
    const hookIdea = String(args.hook_idea ?? '')

    const systemPrompt = buildSystemPromptByType(scriptType)

    const userPrompt = buildScriptPrompt({
      brand, product, platform, scriptType, duration, style,
      keyMessages, targetAudience, hookIdea,
    })

    const result = await completePrompt(userPrompt, systemPrompt, {
      jsonMode: true,
      temperature: 0.75,
      maxTokens: 8000,
    })

    if (!result.success) {
      return { toolCallId: toolCall.id, content: `脚本生成失败: ${result.error}`, isError: true }
    }

    let script: Record<string, unknown>
    try {
      script = extractJSON(result.text) as Record<string, unknown>
    } catch {
      return { toolCallId: toolCall.id, content: formatScriptText(result.text, brand, product, platform, scriptType) }
    }

    const formatted = formatScriptResult(script, brand, product, platform, scriptType, duration, style)
    return { toolCallId: toolCall.id, content: formatted }

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[ScriptStudio] 执行失败:', error)
    return { toolCallId: toolCall.id, content: `脚本生成错误: ${msg}`, isError: true }
  }
}

// =====================================================================
// 系统提示词（按类型）
// =====================================================================

function buildSystemPromptByType(scriptType: string): string {
  const base = `你是一位资深的内容脚本创作专家，曾在顶级 MCN 和影视制作公司担任创意总监，擅长为社交媒体平台创作病毒式传播内容。`

  if (scriptType === '分镜') {
    return `${base}

请生成详细的分镜脚本，包含每个镜头的角度、运镜、时长和画面描述。

**输出格式（严格 JSON）：**
{
  "storyboard": [
    {"shot": 1, "angle": "特写", "movement": "固定", "duration": "3s", "description": "画面描述", "dialogue": "台词"}
  ],
  "lighting_setup": "灯光建议",
  "prop_list": ["道具1"],
  "location_notes": "场地建议"
}`
  }

  if (scriptType === 'video_guide') {
    return `${base}

请生成详细的视频拍摄和后期制作指导方案。

**输出格式（严格 JSON）：**
{
  "shooting_guide": {
    "equipment": ["设备1"],
    "lighting": "灯光方案",
    "audio": "收音方案"
  },
  "editing_guide": {
    "pacing": "节奏建议",
    "transitions": ["转场建议1"],
    "bgm_suggestions": ["BGM风格建议"]
  },
  "platform_specific_tips": "平台-specific拍摄技巧"
}`
  }

  // 默认 story
  return `${base}

请生成详细的故事脚本，包含故事弧线、场景分解和完整对话。

**输出格式（严格 JSON）：**
{
  "story_arc": {
    "setup": "场景设定",
    "conflict": "冲突/问题",
    "resolution": "解决方案（产品出现）",
    "call_to_action": "行动号召"
  },
  "scene_breakdown": [
    {"scene": 1, "timestamp": "0-5s", "visual": "画面描述", "audio": "旁白/对话", "emotion": "情绪基调"}
  ],
  "dialogue_script": "完整对话文本",
  "visual_notes": ["视觉注意点1"],
  "audio_notes": ["音频注意点1"]
}`
}

// =====================================================================
// Prompt 构建
// =====================================================================

function buildScriptPrompt(params: {
  brand: string
  product: string
  platform: string
  scriptType: string
  duration: number
  style: string
  keyMessages: string[]
  targetAudience: string
  hookIdea: string
}): string {
  const typeLabel = params.scriptType === '分镜' ? '分镜脚本' : params.scriptType === 'video_guide' ? '拍摄指导' : '故事脚本'

  const parts: string[] = [
    `请为以下品牌生成 ${typeLabel}：`,
    ``,
    `品牌：${params.brand}`,
    `产品：${params.product}`,
    `平台：${params.platform}`,
    `脚本类型：${typeLabel}`,
    `视频时长：${params.duration} 秒`,
    `风格：${params.style}`,
  ]

  if (params.keyMessages.length > 0) parts.push(`关键信息：${params.keyMessages.join('、')}`)
  if (params.targetAudience) parts.push(`目标受众：${params.targetAudience}`)
  if (params.hookIdea) parts.push(`开头钩子创意：${params.hookIdea}`)

  parts.push(`\n请生成详细的${typeLabel}，确保内容适合 ${params.platform} 平台的用户习惯和算法偏好。`)
  parts.push(`视频时长严格控制在 ${params.duration} 秒内。`)

  return parts.join('\n')
}

// =====================================================================
// 结果格式化
// =====================================================================

function formatScriptResult(
  script: Record<string, unknown>,
  brand: string,
  product: string,
  platform: string,
  scriptType: string,
  duration: number,
  style: string,
): string {
  const typeLabel = scriptType === '分镜' ? '分镜脚本' : scriptType === 'video_guide' ? '拍摄指导' : '故事脚本'
  const parts: string[] = []
  parts.push(`# ${brand} · ${product} — ${platform} ${typeLabel}`)
  parts.push('')
  parts.push(`**时长**：${duration} 秒 | **风格**：${style}`)
  parts.push('')

  if (scriptType === '分镜') {
    return formatStoryboardResult(script, parts)
  }

  if (scriptType === 'video_guide') {
    return formatVideoGuideResult(script, parts)
  }

  return formatStoryResult(script, parts)
}

// --- story 类型格式化 ---

function formatStoryResult(script: Record<string, unknown>, parts: string[]): string {
  // 故事弧线
  const arc = script.story_arc as Record<string, unknown> | undefined
  if (arc) {
    parts.push(`## 🎭 故事弧线`)
    if (arc.setup) parts.push(`**场景设定**：${arc.setup}`)
    if (arc.conflict) parts.push(`**冲突/问题**：${arc.conflict}`)
    if (arc.resolution) parts.push(`**解决方案**：${arc.resolution}`)
    if (arc.call_to_action) parts.push(`**行动号召**：${arc.call_to_action}`)
    parts.push('')
  }

  // 场景分解
  const scenes = script.scene_breakdown as Array<Record<string, unknown>> | undefined
  if (scenes && scenes.length > 0) {
    parts.push(`## 🎬 场景分解`)
    for (const scene of scenes) {
      const num = scene.scene ?? '-'
      const ts = scene.timestamp ?? '-'
      parts.push(`### 场景 ${num}（${ts}）`)
      if (scene.visual) parts.push(`- **画面**：${scene.visual}`)
      if (scene.audio) parts.push(`- **音频**：${scene.audio}`)
      if (scene.emotion) parts.push(`- **情绪**：${scene.emotion}`)
      parts.push('')
    }
  }

  // 对话脚本
  if (script.dialogue_script) {
    parts.push(`## 📝 完整对话脚本`)
    parts.push('```')
    parts.push(String(script.dialogue_script))
    parts.push('```')
    parts.push('')
  }

  // 视觉注意点
  const visualNotes = script.visual_notes as string[] | undefined
  if (visualNotes && visualNotes.length > 0) {
    parts.push(`## 👁️ 视觉注意点`)
    for (const v of visualNotes) parts.push(`- ${v}`)
    parts.push('')
  }

  // 音频注意点
  const audioNotes = script.audio_notes as string[] | undefined
  if (audioNotes && audioNotes.length > 0) {
    parts.push(`## 🔊 音频注意点`)
    for (const a of audioNotes) parts.push(`- ${a}`)
    parts.push('')
  }

  return parts.join('\n')
}

// --- 分镜类型格式化 ---

function formatStoryboardResult(script: Record<string, unknown>, parts: string[]): string {
  // 分镜表
  const storyboard = script.storyboard as Array<Record<string, unknown>> | undefined
  if (storyboard && storyboard.length > 0) {
    parts.push(`## 🎬 分镜表`)
    parts.push('')
    parts.push(`| 镜号 | 景别 | 运镜 | 时长 | 画面描述 | 台词/旁白 |`)
    parts.push(`|------|------|------|------|----------|-----------|`)
    for (const shot of storyboard) {
      const num = shot.shot ?? '-'
      const angle = shot.angle ?? '-'
      const movement = shot.movement ?? '-'
      const dur = shot.duration ?? '-'
      const desc = shot.description ?? '-'
      const dialogue = shot.dialogue ?? '-'
      parts.push(`| ${num} | ${angle} | ${movement} | ${dur} | ${desc} | ${dialogue} |`)
    }
    parts.push('')
  }

  // 灯光
  if (script.lighting_setup) {
    parts.push(`## 💡 灯光方案`)
    parts.push(String(script.lighting_setup))
    parts.push('')
  }

  // 道具
  const props = script.prop_list as string[] | undefined
  if (props && props.length > 0) {
    parts.push(`## 🎁 道具清单`)
    for (const p of props) parts.push(`- ${p}`)
    parts.push('')
  }

  // 场地
  if (script.location_notes) {
    parts.push(`## 📍 场地建议`)
    parts.push(String(script.location_notes))
    parts.push('')
  }

  return parts.join('\n')
}

// --- video_guide 类型格式化 ---

function formatVideoGuideResult(script: Record<string, unknown>, parts: string[]): string {
  // 拍摄指导
  const shooting = script.shooting_guide as Record<string, unknown> | undefined
  if (shooting) {
    parts.push(`## 🎥 拍摄指导`)
    const equipment = shooting.equipment as string[] | undefined
    if (equipment && equipment.length > 0) {
      parts.push(`**推荐设备**：`)
      for (const e of equipment) parts.push(`- ${e}`)
    }
    if (shooting.lighting) parts.push(`**灯光方案**：${shooting.lighting}`)
    if (shooting.audio) parts.push(`**收音方案**：${shooting.audio}`)
    parts.push('')
  }

  // 后期指导
  const editing = script.editing_guide as Record<string, unknown> | undefined
  if (editing) {
    parts.push(`## ✂️ 后期制作指导`)
    if (editing.pacing) parts.push(`**节奏控制**：${editing.pacing}`)
    const transitions = editing.transitions as string[] | undefined
    if (transitions && transitions.length > 0) {
      parts.push(`**转场建议**：`)
      for (const t of transitions) parts.push(`- ${t}`)
    }
    const bgm = editing.bgm_suggestions as string[] | undefined
    if (bgm && bgm.length > 0) {
      parts.push(`**BGM 风格建议**：`)
      for (const b of bgm) parts.push(`- ${b}`)
    }
    parts.push('')
  }

  // 平台技巧
  if (script.platform_specific_tips) {
    parts.push(`## 📱 平台拍摄技巧`)
    parts.push(String(script.platform_specific_tips))
    parts.push('')
  }

  return parts.join('\n')
}

function formatScriptText(text: string, brand: string, product: string, platform: string, scriptType: string): string {
  const typeLabel = scriptType === '分镜' ? '分镜脚本' : scriptType === 'video_guide' ? '拍摄指导' : '故事脚本'
  return `# ${brand} · ${product} — ${platform} ${typeLabel}\n\n${text}`
}
