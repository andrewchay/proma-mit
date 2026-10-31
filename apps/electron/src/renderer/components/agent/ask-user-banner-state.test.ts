import { expect, test } from 'bun:test'
import type { AskUserQuestion } from '@gravitas/shared'
import { createInitialAskUserAnswer } from './ask-user-banner-state'

const question: AskUserQuestion = {
  question: '请核对动作是否已生效',
  options: [{ label: '未生效，允许重试' }, { label: '已生效，继续拦截' }],
}

test('Given 未知动作核对 When 初始化答案 Then 不预选可能解除重试拦截的选项', () => {
  expect(createInitialAskUserAnswer('unknown_action_resolution', question)).toEqual({
    selected: [],
    customText: '',
    showCustom: false,
  })
})

test('Given 普通问答 When 初始化答案 Then 保留默认首项体验', () => {
  expect(createInitialAskUserAnswer('question', question).selected).toEqual(['未生效，允许重试'])
})
