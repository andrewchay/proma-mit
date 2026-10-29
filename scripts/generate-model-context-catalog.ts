/** 从已锁定的 Pi SDK 提取纯窗口目录，避免 CJS 主进程静态加载 ESM runtime。 */
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const providers = ['anthropic', 'deepseek', 'google', 'kimi-coding', 'minimax', 'moonshotai', 'openai', 'qwen-token-plan', 'xai', 'xiaomi', 'zai'] as const
const windows: Record<string, Record<string, number>> = {}
for (const provider of providers) {
  windows[provider] = Object.fromEntries(getBuiltinModels(provider)
    .map((model) => [model.id, model.contextWindow])
    .sort(([left], [right]) => String(left).localeCompare(String(right))))
}
const destination = resolve(import.meta.dir, '../apps/electron/src/main/lib/model-context-catalog.generated.json')
writeFileSync(destination, JSON.stringify({ source: '@earendil-works/pi-ai/providers/all', windows }, null, 2) + '\n')
console.log(`[模型目录] 已更新 ${destination}`)
