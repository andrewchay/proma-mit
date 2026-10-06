import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import * as React from 'react'
import {
  AnalysisSectionBody,
  BarChart,
  DonutChart,
  StackedBarChart,
  StatsTable,
  TrendChart,
} from './AnalysisCharts'

/**
 * 图表渲染的健壮性测试。
 *
 * 报告的 section.data 是 unknown（来自磁盘上的 JSON），因此渲染层必须
 * 对形态不符的数据降级展示而不是抛错 —— 一份损坏的报告不应让整个分析
 * 页面白屏。这里用 renderToStaticMarkup 验证真实渲染路径。
 */

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node)
}

/** 时间分析的真实 section.data 形态 */
const categoriesData = {
  categories: [
    { name: '工作', minutes: 300, percentage: 62.5, color: '#8b5cf6' },
    { name: '学习', minutes: 180, percentage: 37.5 },
  ],
}

/** 生产力分析的真实 section.data 形态 */
const statusData = {
  statusDistribution: [
    { name: 'done', value: 8 },
    { name: 'in-progress', value: 3 },
  ],
}

const dailyRatesData = {
  dailyRates: [
    { date: '2026-09-01', completed: 2, total: 3, rate: 0.67 },
    { date: '2026-09-02', completed: 5, total: 5, rate: 1 },
  ],
}

const dailyBreakdownData: {
  dailyBreakdown: Array<{
    date: string
    totalMinutes: number
    categories: Record<string, number>
  }>
} = {
  dailyBreakdown: [
    { date: '2026-09-01', totalMinutes: 480, categories: { 工作: 300, 学习: 180 } },
    { date: '2026-09-02', totalMinutes: 240, categories: { 工作: 240 } },
  ],
}

describe('图表组件空数据降级', () => {
  test('DonutChart 总值为 0 时展示无数据而非崩溃', () => {
    const html = render(React.createElement(DonutChart, { items: [{ name: 'a', value: 0 }] }))
    expect(html).toContain('无数据')
  })

  test('BarChart 全为 0 时展示无数据', () => {
    const html = render(React.createElement(BarChart, { items: [{ name: 'a', value: 0 }] }))
    expect(html).toContain('无数据')
  })

  test('TrendChart 空数组时展示无数据', () => {
    const html = render(React.createElement(TrendChart, { points: [] }))
    expect(html).toContain('无数据')
  })

  test('StackedBarChart 空数组时展示无数据', () => {
    const html = render(React.createElement(StackedBarChart, { daily: [] }))
    expect(html).toContain('无数据')
  })

  test('StatsTable 非对象数据时展示格式提示', () => {
    const html = render(React.createElement(StatsTable, { data: 'not-an-object' }))
    expect(html).toContain('无法识别')
  })

  test('StatsTable 空对象时展示无统计', () => {
    const html = render(React.createElement(StatsTable, { data: {} }))
    expect(html).toContain('无统计数据')
  })
})

describe('图表组件正常渲染', () => {
  test('DonutChart 渲染分类名称与百分比', () => {
    // DonutChart 接收已归一化的 items（由 extractNamedValues 产出），
    // 这里直接构造该形态：时间分析的 minutes 已映射到 value，
    // 并保留 percentage 供展示。
    const items = [
      { name: '工作', value: 300, minutes: 300, percentage: 62.5, color: '#8b5cf6' },
      { name: '学习', value: 180, minutes: 180, percentage: 37.5 },
    ]
    const html = render(React.createElement(DonutChart, { items }))
    expect(html).toContain('工作')
    expect(html).toContain('学习')
    // 300 分钟应格式化为小时
    expect(html).toContain('5.0 小时')
    // 占比由 value 实时计算，不受 percentage 字段影响
    expect(html).toContain('62.5%')
    expect(html).toContain('37.5%')
    // conic-gradient 是环形图的实现方式
    expect(html).toContain('conic-gradient')
    // 不允许出现 NaN（minutes 与 value 混淆时的典型症状）
    expect(html).not.toContain('NaN')
  })

  test('TrendChart 渲染日期轴并优先使用 completed', () => {
    const points = dailyRatesData.dailyRates.map((d) => ({ date: d.date, value: d.completed }))
    const html = render(React.createElement(TrendChart, { points }))
    expect(html).toContain('2026-09-01')
    expect(html).toContain('2026-09-02')
  })

  test('StackedBarChart 渲染分类图例', () => {
    const html = render(
      React.createElement(StackedBarChart, { daily: dailyBreakdownData.dailyBreakdown }),
    )
    expect(html).toContain('工作')
    expect(html).toContain('学习')
  })
})

describe('AnalysisSectionBody 按形态分发', () => {
  test('pie + categories 走环形图（时间分析的 minutes 形态）', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, {
        type: 'chart',
        chartType: 'pie',
        data: categoriesData,
      }),
    )
    expect(html).toContain('conic-gradient')
    // minutes 必须被当作绝对量参与占比，不能出现 NaN%
    expect(html).not.toContain('NaN')
    expect(html).toContain('62.5%')
  })

  test('pie + statusDistribution 走环形图（生产力状态分布）', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, {
        type: 'chart',
        chartType: 'pie',
        data: statusData,
      }),
    )
    expect(html).toContain('conic-gradient')
    expect(html).toContain('done')
  })

  test('line + dailyRates 走趋势图', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, {
        type: 'chart',
        chartType: 'line',
        data: dailyRatesData,
      }),
    )
    expect(html).toContain('2026-09-01')
  })

  test('stacked-bar + dailyBreakdown 走堆叠柱', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, {
        type: 'chart',
        chartType: 'stacked-bar',
        data: dailyBreakdownData,
      }),
    )
    expect(html).toContain('工作')
  })

  test('table + categories 走分类详情表', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, {
        type: 'table',
        data: categoriesData,
      }),
    )
    expect(html).toContain('工作')
    expect(html).toContain('62.5%')
  })

  test('table + 键值统计走 StatsTable', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, {
        type: 'table',
        data: { total: 12, completed: 8, completionRate: 67, overdue: 2 },
      }),
    )
    expect(html).toContain('任务总数')
    expect(html).toContain('完成率')
    // rate 结尾的字段自动加百分号
    expect(html).toContain('67%')
  })

  test('text 类型直接展示文本', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, { type: 'text', data: '这是一段说明' }),
    )
    expect(html).toContain('这是一段说明')
  })

  test('未知 chartType 与无法识别的数据降级为提示而非抛错', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, {
        type: 'chart',
        chartType: 'radar',
        data: { weird: 'shape' },
      }),
    )
    expect(html).toContain('暂不支持渲染')
  })

  test('data 为 null 时不抛错', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, { type: 'chart', chartType: 'pie', data: null }),
    )
    expect(html).toContain('暂不支持渲染')
  })

  test('data 为数组（非对象）时不抛错', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, { type: 'chart', chartType: 'bar', data: [1, 2, 3] }),
    )
    expect(html).toContain('暂不支持渲染')
  })

  test('未指定 chartType 时按数据形态自动选择堆叠柱', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, { type: 'chart', data: dailyBreakdownData }),
    )
    expect(html).toContain('工作')
  })

  test('未指定 chartType 时按数据形态自动选择趋势图', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, { type: 'chart', data: dailyRatesData }),
    )
    expect(html).toContain('2026-09-01')
  })
})

describe('损坏数据不导致崩溃', () => {
  test('categories 数组内元素缺 name 时被跳过', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, {
        type: 'chart',
        chartType: 'pie',
        data: { categories: [{ value: 10 }, { name: '有效', value: 5 }] },
      }),
    )
    expect(html).toContain('有效')
  })

  test('categories 全部元素非法时降级为提示', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, {
        type: 'chart',
        chartType: 'pie',
        data: { categories: [{ value: 10 }, null, 'string'] },
      }),
    )
    expect(html).toContain('暂不支持渲染')
  })

  test('dailyRates 缺 date 时被跳过', () => {
    const html = render(
      React.createElement(AnalysisSectionBody, {
        type: 'chart',
        chartType: 'line',
        data: { dailyRates: [{ completed: 3 }, { date: '2026-09-05', completed: 2 }] },
      }),
    )
    expect(html).toContain('2026-09-05')
  })
})
