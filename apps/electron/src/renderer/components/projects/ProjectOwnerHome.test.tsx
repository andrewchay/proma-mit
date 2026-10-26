import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { ProjectOwnerHome } from './ProjectOwnerHome'

function renderHome(): string {
  const store = createStore()
  return renderToStaticMarkup(createElement(Provider, { store }, createElement(ProjectOwnerHome, { projectId: 'project-1' })))
}

test('项目概览先显示项目目标、阶段和下一步，编辑器收在折叠区', () => {
  const html = renderHome()
  expect(html).toContain('先看目标，再决定下一步')
  expect(html).toContain('先明确希望项目达到什么结果')
  expect(html).toContain('01 · 项目目标')
  expect(html).toContain('02 · 规划提案')
  expect(html).toContain('03 · 实际执行')
  expect(html).toContain('先记录项目目标')
  expect(html).toContain('<details class="mt-5 border-t pt-4">')
  expect(html.indexOf('<details class="mt-5 border-t pt-4">')).toBeLessThan(html.indexOf('aria-label="项目目标草案"'))
})

test('规划解释说明岗位建议、可选岗位上限和未知费用语义', () => {
  const html = renderHome()
  expect(html).toContain('它是待审阅的工作方案，不是已经派出的团队')
  expect(html).toContain('共享总额是全局上限；可选岗位上限只会进一步收紧')
  expect(html).toContain('Reviewer 费用归入所评任务的岗位')
  expect(html).toContain('费用信息只显示可信回执；缺失时保持未知')
  expect(html).toContain('USD 微美元，不自动换汇')
  expect(html).toContain('未知费用继续占用预留额')
})

test('项目主页仍提供独立的Owner配置、调用记录、计划审阅和执行准备入口', () => {
  const html = renderHome()
  expect(html).toContain('Owner 规划配置')
  expect(html).toContain('最近一次规划')
  expect(html).toContain('计划提案')
  expect(html).toContain('审阅提案与准备执行授权')
  expect(html).toContain('不会自动授权或运行任务')
})
