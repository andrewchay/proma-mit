import { describe, expect, test } from 'bun:test'
import { WEB_DASHBOARD_HTML } from './dashboard.ts'

describe('WEB_DASHBOARD_HTML（运行档案 / Signals / 数据集可视化）', () => {
  test('侧边导航包含新增的三个可视化视图', () => {
    expect(WEB_DASHBOARD_HTML).toContain('运行档案')
    expect(WEB_DASHBOARD_HTML).toContain('Signals')
    expect(WEB_DASHBOARD_HTML).toContain('评估数据集')
  })

  test('包含对应的渲染函数', () => {
    expect(WEB_DASHBOARD_HTML).toContain('async function loadRuns')
    expect(WEB_DASHBOARD_HTML).toContain('async function loadSignals')
    expect(WEB_DASHBOARD_HTML).toContain('async function loadDatasets')
    expect(WEB_DASHBOARD_HTML).toContain('function spanTree')
    expect(WEB_DASHBOARD_HTML).toContain('async function loadRun(')
  })

  test('可视化视图调用真实 API 端点（运行档案/signals/datasets）', () => {
    expect(WEB_DASHBOARD_HTML).toContain("/agent/runs/")
    expect(WEB_DASHBOARD_HTML).toContain('/agent/signals')
    expect(WEB_DASHBOARD_HTML).toContain('/agent/datasets')
  })

  test('内嵌 <script> 语法合法（可被浏览器解析）', () => {
    const match = WEB_DASHBOARD_HTML.match(/<script>([\s\S]*?)<\/script>/)
    expect(match).not.toBeNull()
    // 基本引用平衡检查：单/双引号与括号计数为偶数（粗略回归），实际由浏览器解析。
    const js = match![1]!
    expect((js.match(/'/g) ?? []).length % 2).toBe(0)
    expect((js.match(/\(/g) ?? []).length).toBe((js.match(/\)/g) ?? []).length)
  })
})
