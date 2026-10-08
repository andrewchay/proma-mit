import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { ownerGoalEditorsAtom } from '../../atoms/project-owner-goal-atoms'
import { ProjectOwnerGoalPanel } from './ProjectOwnerGoalPanel'

function render(state: Partial<ReturnType<typeof import('../../atoms/project-owner-goal-atoms').getOwnerGoalEditor>> = {}) {
  const store = createStore()
  store.set(ownerGoalEditorsAtom, new Map([['["a",null]', {
    snapshot: null, objective: '', constraintsText: '', criteriaText: '', dirty: false,
    loaded: false, loading: false, saving: false, conflict: false, requiresReview: false,
    editVersion: 0, error: '', ...state,
  }]]))
  return renderToStaticMarkup(createElement(Provider, { store }, createElement(ProjectOwnerGoalPanel, { projectId: 'a' })))
}

test('目标表单仅目标必填，缺配置可编辑但加载完成前禁止盲写', () => {
  const html = render()
  expect(html).toContain('保存目标草案')
  expect(html).toContain('required=""')
  expect(html).toContain('disabled=""')
  expect(html).toContain('必要约束与完成标准（可选）')
  expect(html).toContain('不会调用模型')
  expect(html).not.toContain('placeholder="文件路径')
})
test('冲突与加载失败提示保留输入，不展示模型已运行或启动授权', () => {
  const html = render({ objective: '保留我的输入', dirty: true, loaded: true, conflict: true, error: '已更新' })
  expect(html).toContain('保留我的输入')
  expect(html).toContain('加载最新版本')
  expect(html).toContain('role="alert"')
  expect(html).not.toContain('开始执行')
})
test('比较最新版本时展示服务器事实，不把本地文本当已保存', () => {
  const html = render({ loaded: true, dirty: true, requiresReview: true, objective: '我的修改',
    snapshot: { schemaVersion: 1, revision: 2, state: 'draft', actor: 'local-user', savedAt: 1,
      goal: { projectId: 'a', goalVersion: 2, objective: '服务器版本', constraints: ['原约束'], acceptanceCriteria: ['原标准'] } } })
  expect(html).toContain('服务器版本'); expect(html).toContain('我的修改')
  expect(html).toContain('原约束'); expect(html).toContain('已比较最新版本')
  expect(html).toContain('保存前请先比较')
})
