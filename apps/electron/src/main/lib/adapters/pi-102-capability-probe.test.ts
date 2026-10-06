import { describe, expect, test } from 'bun:test'
import { normalizeContext } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

// Pi 1.0.2 试用分支（feat/pi-runtime-1.0.2-trial）能力探针。
// 只做离线目录/方法面断言，不触发真实 Provider 调用；
// 真实 ChatGPT 登录、图片生成、分类器调用留给应用内真机验收。
describe('Pi 1.0.2 能力面（相对 0.87.1）', () => {
  test('Gravitas 依赖的 SDK 出口保持不变', async () => {
    const pi = await import('@earendil-works/pi-coding-agent')
    expect(typeof pi.createAgentSession).toBe('function')
    expect(typeof pi.SessionManager.inMemory).toBe('function')
    expect(typeof pi.SettingsManager.inMemory).toBe('function')
    expect(typeof pi.DefaultResourceLoader).toBe('function')
    expect(typeof normalizeContext).toBe('function')
    expect(typeof streamSimple).toBe('function')
  })

  test('Codex 遗留路线目录完整（openai-codex / openai-codex-responses）', async () => {
    const rt = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
    const codex = [...rt.getModels('openai-codex')]
    expect(codex.length).toBeGreaterThan(0)
    // 遗留 provider 未被移除，传输仍是 Codex Responses 专用 API。
    for (const model of codex) expect(model.api).toBe('openai-codex-responses')
  })

  test('图片生成与分类器能力面（0.99+ 新增，目录离线可读）', async () => {
    const rt = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false })
    expect(typeof rt.generateImages).toBe('function')
    expect(typeof rt.classify).toBe('function')
    const images = [...rt.getModelsOfType('image')]
    expect(images.length).toBeGreaterThan(0)
    const classifiers = [...rt.getModelsOfType('classifier')]
    expect(classifiers.length).toBeGreaterThan(0)
    // Jev 分类器（TypeSafe）是内置分类模型族的代表。
    expect(classifiers.some((m) => m.id.includes('jev'))).toBe(true)
  })
  // 注意：虚拟模型（pi.registerVirtualModel）是 extension host API，
  // 不在裸 SDK 模块导出中；Gravitas 以 noExtensions: true 运行，
  // 若未来采用需走 SDK inline extension（builtin: true）路径，另行评估。
})
