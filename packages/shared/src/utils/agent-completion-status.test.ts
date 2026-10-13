import { describe, expect, it } from 'bun:test'
import { parseAgentCompletionStatus } from './agent-completion-status'

describe('parseAgentCompletionStatus', () => {
  it('解析标准绿灯状态行', () => {
    const text = '已完成前两步。\n\n🟢 还差：C｜搁置：X'
    expect(parseAgentCompletionStatus(text)).toEqual({
      status: 'green',
      detail: '还差：C｜搁置：X',
    })
  })

  it('解析黄灯状态行', () => {
    const text = '任务完成。计划已写入 .context/plan/next.md\n🟡 计划：.context/plan/next.md，等你决定是否启动'
    expect(parseAgentCompletionStatus(text)).toEqual({
      status: 'yellow',
      detail: '计划：.context/plan/next.md，等你决定是否启动',
    })
  })

  it('解析红灯状态行（无详情）', () => {
    const text = '全部达成，无超出项\n🔴'
    expect(parseAgentCompletionStatus(text)).toEqual({ status: 'red', detail: '' })
  })

  it('容忍行首 Markdown 装饰与行尾加粗', () => {
    const text = 'done\n> **🟢 还差：B**'
    expect(parseAgentCompletionStatus(text)).toEqual({
      status: 'green',
      detail: '还差：B',
    })
  })

  it('红绿灯 emoji 出现在中间行时不识别', () => {
    const text = '🔴 必须修复：空指针\n🟢 值得肯定：命名清晰\n总结如上。'
    expect(parseAgentCompletionStatus(text)).toBeNull()
  })

  it('code-reviewer 风格的分级意见列表不误判（最后一行非状态行）', () => {
    const text = '审查结果：\n🔴 必须修复\n🟡 建议改进\n审查通过，无需修改'
    expect(parseAgentCompletionStatus(text)).toBeNull()
  })

  it('普通问答无状态行返回 null', () => {
    expect(parseAgentCompletionStatus('你好，我是 Gravitas Agent。')).toBeNull()
    expect(parseAgentCompletionStatus('')).toBeNull()
    expect(parseAgentCompletionStatus('   \n  ')).toBeNull()
  })

  it('容忍末尾空行', () => {
    const text = '完成\n🟡 后续计划见 plan/next.md\n\n\n'
    expect(parseAgentCompletionStatus(text)?.status).toBe('yellow')
  })
})
