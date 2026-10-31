import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindTestToolContext } from '../../testing/bound-tool-context'
import { executeAskUserQuestionTool } from './ask-user-tool'

const directory = mkdtempSync(join(tmpdir(), 'ask-user-gate-')), previous = process.env.PROMA_TEST_CONFIG_DIR
const store = await import('../../project-sqlite-store')
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = directory; await store.initProjectDb() })
afterAll(() => { store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })

test('Given 等待回答时账本失效 When 用户回答返回 Then 不向运行中的 Agent 返回答案', async () => {
  let finish!: (value: { behavior: 'allow'; answers: Record<string, string> }) => void
  const pending = executeAskUserQuestionTool({ questions: [{ question: '问题' }] }, bindTestToolContext({
    cwd: directory, sessionId: 'ordinary', onAskUser: () => new Promise(resolve => { finish = resolve }),
  }))
  store.closeProjectDb()
  finish({ behavior: 'allow', answers: { '问题': '私有答案' } })
  const result = await pending
  expect(result.isError).toBe(true)
  expect(result.content).not.toContain('私有答案')
})
