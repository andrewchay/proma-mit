import { describe, expect, test } from 'bun:test'
import { normalizeAgentRuntimeError } from './agent-runtime-error'

describe('normalizeAgentRuntimeError', () => {
  test('given Google model 404 then returns invalid_model with actionable details', () => {
    const error = normalizeAgentRuntimeError({
      runtime: 'ai-sdk',
      provider: 'google',
      model: 'gemini-2.5-flash',
      error: {
        statusCode: 404,
        message: 'This model models/gemini-2.5-flash is no longer available to new users.',
      },
    })

    expect(error.code).toBe('invalid_model')
    expect(error.title).toBe('Google 模型不可用')
    expect(error.canRetry).toBe(false)
    expect(error.details).toContain('provider: google')
  })

  test('given Google OAuth-style 401 then returns invalid_api_key', () => {
    const error = normalizeAgentRuntimeError({
      runtime: 'pi',
      provider: 'google',
      model: 'gemini-3.5-flash',
      error: new Error('401 Request had invalid authentication credentials. Expected OAuth 2 access token.'),
    })

    expect(error.code).toBe('invalid_api_key')
    expect(error.actions.map((action) => action.action)).toContain('open_channel_settings')
  })

  test('given Qwen max_tokens range error then returns invalid_request', () => {
    const error = normalizeAgentRuntimeError({
      runtime: 'pi',
      provider: 'qwen',
      model: 'qwen-turbo',
      error: '<400> InternalError.Algo.InvalidParameter: Range of max_tokens should be [1, 16384]',
    })

    expect(error.code).toBe('invalid_request')
    expect(error.title).toBe('Qwen 参数超出限制')
  })

  test('given transient network error then returns retryable network_error', () => {
    const error = normalizeAgentRuntimeError({
      runtime: 'ai-sdk',
      provider: 'deepseek',
      model: 'deepseek-chat',
      error: new Error('fetch failed: socket hang up'),
    })

    expect(error.code).toBe('network_error')
    expect(error.canRetry).toBe(true)
    expect(error.retryDelayMs).toBeGreaterThan(0)
  })
})
