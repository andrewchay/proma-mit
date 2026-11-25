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

test('Computer Use 接管不会预选已完成', () => {
  expect(createInitialAskUserAnswer('computer_use_takeover', {
    question: '完成敏感操作后继续吗？',
    options: [{ label: '我已完成，可继续' }, { label: '取消' }],
  }).selected).toEqual([])
})
