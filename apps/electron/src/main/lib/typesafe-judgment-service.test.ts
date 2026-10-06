import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildElectronMock } from './testing/electron-mock'

const testRoot = join(tmpdir(), `gravitas-typesafe-${process.pid}-${Date.now()}`)
const originalConfigDir = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = testRoot

let encryptionAvailable = false
const electronMock = buildElectronMock()
electronMock.safeStorage = {
  isEncryptionAvailable: () => encryptionAvailable,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, ''),
}
mock.module('electron', () => electronMock)

let transport: (input: string, init?: RequestInit) => Promise<Response> = async () => {
  throw new Error('测试未配置 transport')
}
mock.module('./proxy-fetch', () => ({
  getFetchFn: () => (input: string, init?: RequestInit) => transport(input, init),
}))
mock.module('./proxy-settings-service', () => ({
  getEffectiveProxyUrl: async () => 'http://proxy.test:8080',
}))

const config = await import('./typesafe-judgment-config')
const service = await import('./typesafe-judgment-service')
const audit = await import('./typesafe-judgment-audit')
const validation = await import('./typesafe-judgment-validation')
const { getEnabledTools } = await import('./chat-tool-registry')

function successResponse(answerName: string, choice: string, probabilities: Record<string, number>, confidence = 0.8): Response {
  return new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers: {
      [answerName]: { type: 'choice', choice, confidence, probabilities },
    },
    usage: { input_tokens: 42, output_tokens: 0 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  process.env.PROMA_TEST_CONFIG_DIR = testRoot
  encryptionAvailable = false
  rmSync(testRoot, { recursive: true, force: true })
  mkdirSync(testRoot, { recursive: true })
  config.resetTypeSafeMemoryCredentialForTest()
  service.resetTypeSafeCircuitForTest()
  transport = async () => { throw new Error('测试未配置 transport') }
})

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true })
  if (originalConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfigDir
})

describe('TypeSafe 判断服务配置', () => {
  test('Given safeStorage 可用，When 保存 API Key，Then 密文落盘且 renderer 状态不包含明文', () => {
    encryptionAvailable = true
    const settings = config.updateTypeSafeJudgmentSettings({ apiKey: 'ts_encrypted_secret' })
    const secretPath = join(testRoot, 'typesafe', 'api-key.bin')

    expect(settings.hasApiKey).toBe(true)
    expect(settings.credentialStorage).toBe('encrypted')
    expect(readFileSync(secretPath, 'utf8')).not.toBe('ts_encrypted_secret')
    expect(config.getTypeSafeApiKey()).toBe('ts_encrypted_secret')
    expect(JSON.stringify(settings)).not.toContain('ts_encrypted_secret')
  })

  test('Given safeStorage 不可用，When 保存 API Key，Then 仅保存在内存且不明文落盘', () => {
    const settings = config.updateTypeSafeJudgmentSettings({
      apiKey: 'ts_secret_value',
      enabled: true,
      skillShadowEnabled: true,
    })

    expect(settings.hasApiKey).toBe(true)
    expect(settings.credentialStorage).toBe('memory')
    expect(config.getTypeSafeApiKey()).toBe('ts_secret_value')
    expect(existsSync(join(testRoot, 'typesafe', 'api-key.bin'))).toBe(false)
    expect(readFileSync(join(testRoot, 'typesafe', 'config.json'), 'utf8')).not.toContain('ts_secret_value')
  })

  test('Given 已保存内存密钥，When 清除，Then 主进程不再能读取密钥', () => {
    config.updateTypeSafeJudgmentSettings({ apiKey: 'ts_secret_value' })
    const settings = config.clearTypeSafeApiKey()
    expect(settings.hasApiKey).toBe(false)
    expect(settings.credentialStorage).toBe('none')
    expect(config.getTypeSafeApiKey()).toBeNull()
  })
})

describe('TypeSafe Chat → Agent 判断', () => {
  test('Given 高概率 Agent 路由，When 判断成功，Then 返回本地模板推荐且请求固定模型并最小化附件信息', async () => {
    config.updateTypeSafeJudgmentSettings({
      apiKey: 'ts_secret_value',
      enabled: true,
      chatAgentRecommendEnabled: true,
    })
    let requestBody = ''
    transport = async (_input, init) => {
      requestBody = String(init?.body ?? '')
      return successResponse('route', 'agent_file_or_code', {
        chat: 0.03,
        agent_file_or_code: 0.88,
        agent_multi_step_tools: 0.05,
        agent_research_or_browser: 0.04,
      }, 0.82)
    }

    const result = await service.judgeChatAgentRoute({
      conversationId: 'conversation-private-id',
      message: '请修改这个项目里的 TypeScript 文件',
      attachments: [{
        id: 'attachment-1',
        filename: 'private-name.ts',
        localPath: '/private/project/private-name.ts',
        mediaType: 'text/typescript',
        size: 12,
      }],
    })

    expect(result.status).toBe('success')
    expect(result.recommendation?.route).toBe('agent_file_or_code')
    expect(result.recommendation?.reason).toContain('文件或代码操作')
    expect(requestBody).toContain('jev-1.13.0')
    expect(requestBody).toContain('attachment_kinds')
    expect(requestBody).not.toContain('private-name.ts')
    expect(requestBody).not.toContain('/private/project')
  })

  test('Given 低概率或低置信度结果，When 判断成功，Then 不展示推荐且不调用 legacy 二次判断', async () => {
    config.updateTypeSafeJudgmentSettings({
      apiKey: 'ts_secret_value',
      enabled: true,
      chatAgentRecommendEnabled: true,
    })
    transport = async () => successResponse('route', 'agent_multi_step_tools', {
      chat: 0.24,
      agent_file_or_code: 0.05,
      agent_multi_step_tools: 0.69,
      agent_research_or_browser: 0.02,
    }, 0.3)

    const result = await service.judgeChatAgentRoute({
      conversationId: 'conversation-1',
      message: '帮我看看这个问题',
    })

    expect(result.status).toBe('success')
    expect(result.route).toBe('agent_multi_step_tools')
    expect(result.recommendation).toBeUndefined()
  })

  test('Given 用户取消请求，When 连续取消三次，Then 不计为服务故障或开启熔断', async () => {
    config.updateTypeSafeJudgmentSettings({
      apiKey: 'ts_secret_value',
      enabled: true,
      chatAgentRecommendEnabled: true,
    })

    for (let index = 0; index < 3; index += 1) {
      const controller = new AbortController()
      controller.abort()
      const result = await service.judgeChatAgentRoute({
        conversationId: `conversation-${index}`,
        message: '请修改代码',
        signal: controller.signal,
      })
      expect(result.reasonCode).toBe('aborted')
    }

    expect(service.isTypeSafeChatRecommendationAvailable()).toBe(true)
  })

  test('Given TypeSafe 返回 529，When 有界重试仍失败，Then 返回 unavailable 供 Chat 回退 legacy 工具', async () => {
    config.updateTypeSafeJudgmentSettings({
      apiKey: 'ts_secret_value',
      enabled: true,
      chatAgentRecommendEnabled: true,
    })
    let attempts = 0
    transport = async () => {
      attempts += 1
      return new Response(JSON.stringify({ error: 'overloaded' }), {
        status: 529,
        headers: { 'content-type': 'application/json' },
      })
    }

    const result = await service.judgeChatAgentRoute({
      conversationId: 'conversation-1',
      message: '请修改代码',
    })

    expect(result.status).toBe('unavailable')
    expect(result.reasonCode).toBe('http_529')
    expect(attempts).toBe(2)
  })
})

describe('TypeSafe Skill shadow 与隐私审计', () => {
  test('Given 多个候选 Skill，When shadow 判断，Then 只返回预测并且审计不保存用户正文', async () => {
    config.updateTypeSafeJudgmentSettings({
      apiKey: 'ts_secret_value',
      enabled: true,
      skillShadowEnabled: true,
    })
    transport = async () => successResponse('skill_route', 'xlsx', {
      no_skill: 0.02,
      xlsx: 0.9,
      docx: 0.05,
      pdf: 0.03,
    }, 0.91)

    const privateMessage = '请整理秘密季度数据到表格'
    const result = await service.judgeSkillRoute({
      message: privateMessage,
      contextId: 'session-private-id',
      candidates: [
        { slug: 'xlsx', name: 'Spreadsheet', description: '处理表格' },
        { slug: 'docx', name: 'Word', description: '处理文档' },
        { slug: 'pdf', name: 'PDF', description: '处理 PDF' },
      ],
    })

    expect(result.status).toBe('success')
    expect(result.selected).toBe('xlsx')
    expect(Object.keys(result.probabilities ?? {})).toHaveLength(3)
    const audit = readFileSync(join(testRoot, 'typesafe', 'decisions.jsonl'), 'utf8')
    expect(audit).not.toContain(privateMessage)
    expect(audit).not.toContain('session-private-id')
    expect(audit).toContain('skill_shadow')
  })
})

describe('TypeSafe 审计与 IPC 输入边界', () => {
  test('Given 审计目录不可写，When 记录判断，Then 不向业务层抛错', () => {
    const invalidConfigRoot = join(testRoot, 'config-is-a-file')
    writeFileSync(invalidConfigRoot, 'not-a-directory')
    process.env.PROMA_TEST_CONFIG_DIR = invalidConfigRoot
    expect(() => audit.recordTypeSafeDecision({
      kind: 'chat_agent_route',
      status: 'success',
      model: 'jev-1.13.0',
      latencyMs: 10,
    })).not.toThrow()
    process.env.PROMA_TEST_CONFIG_DIR = testRoot
  })

  test('Given renderer 传入非法设置或反馈，When 校验 IPC 输入，Then 拒绝超长密钥和伪造动作', () => {
    expect(() => validation.validateTypeSafeSettingsInput({ enabled: 'yes' })).toThrow()
    expect(() => validation.validateTypeSafeSettingsInput({ apiKey: 'x'.repeat(513) })).toThrow()
    expect(() => validation.validateTypeSafeFeedback({ decisionId: 'not-a-uuid', action: 'accepted' })).toThrow()
    expect(() => validation.validateTypeSafeFeedback({
      decisionId: '5f0a3b8c-fd34-4c4c-9dc6-cc33db52f433',
      action: 'forged',
    })).toThrow()
  })
})

describe('Chat 工具回退契约', () => {
  test('Given TypeSafe 已成功接管本回合，When 排除 agent-mode-recommend，Then legacy 定义和提示都不注入', () => {
    const normal = getEnabledTools(['agent-mode-recommend'])
    expect(normal.tools?.some((tool) => tool.name === 'suggest_agent_mode')).toBe(true)
    expect(normal.systemPromptAppend).toContain('<agent_mode_recommendation>')

    const replaced = getEnabledTools(['agent-mode-recommend'], new Set(['agent-mode-recommend']))
    expect(replaced.tools).toBeUndefined()
    expect(replaced.systemPromptAppend).toBeUndefined()
  })
})
