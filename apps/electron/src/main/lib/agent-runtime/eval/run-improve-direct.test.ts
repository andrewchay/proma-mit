/**
 * Improve 闭环测试 - 测试自演化流程
 *
 * 运行: cd apps/electron && bun test src/main/lib/agent-runtime/eval/run-improve-direct.test.ts
 *
 * 此测试直接调用 commands.ts 的 runImprove，绕过 eval-service.ts 的依赖链。
 * 使用 mock delegate 和自定义 propose 来验证自演化流程。
 */

import { test, expect } from 'bun:test'
import { runImprove, requireBenchmark } from './commands'
import { buildToolsetStateGuard } from './toolset-state'
import type { SubAgentDelegate } from './evaluator'
import type { ProposeChange } from './self-evolver'

// 模拟一个会逐步改进的 delegate
// 第一轮返回低分，第二轮返回高分（模拟改进效果）
let callCount = 0

function createImprovingDelegate(): SubAgentDelegate {
  return async (input) => {
    callCount++
    const task = input.task.toLowerCase()
    const systemPrompt = input.systemPrompt

    // 如果有 systemPrompt 覆盖（即候选被应用），返回更好的结果
    const isImproved = !!systemPrompt && systemPrompt.includes('IMPROVED')

    if (task.includes('marketing') || task.includes('策略')) {
      if (isImproved) {
        return {
          text: `改进后的营销策略：\n\n正确识别场景并选择工具：\n- 识别策略场景\n- 调用 ma_generate_strategy\n- 无多余调用\n\n参数填充完整准确：\n- brand=茶里茶气\n- product=健康低糖奶茶\n- platform=xiaohongshu,douyin\n- budget=100万\n\n无多余或错误调用：\n- 仅调用所需工具\n\n{"score": 95, "findings": ["正确识别场景并选择工具", "参数填充完整准确", "无多余或错误调用"], "verdict": "pass"}`,
        }
      }
      // 初始版本：分数较低
      return {
        text: `营销策略：\n\n正确识别场景并选择工具：\n- 识别场景\n\n参数填充完整准确：\n- 部分参数\n\n{"score": 60, "findings": ["正确识别场景并选择工具"], "verdict": "partial"}`,
      }
    }

    if (task.includes('computer') || task.includes('权限')) {
      if (isImproved) {
        return {
          text: `改进后的权限处理：\n\n先检查权限：\n- 调用 computer_use_status\n\n请求权限：\n- 调用 computer_use_request_permissions\n\n再执行操作：\n- 获得权限后执行 click\n\n{"score": 95, "findings": ["先检查权限", "请求权限", "再执行操作"], "verdict": "pass"}`,
        }
      }
      return {
        text: `权限处理：\n\n先检查权限：\n- 检查状态\n\n{"score": 40, "findings": ["先检查权限"], "verdict": "partial"}`,
      }
    }

    return { text: `{"score": 50, "findings": [], "verdict": "partial"}` }
  }
}

// 创建一个会产生改进候选的 propose
function createImprovingPropose(): ProposeChange {
  return async ({ round }) => {
    // 第一轮产生改进候选
    if (round === 1) {
      return {
        description: '改进版 TOOLS.md：增加更详细的工具选择引导',
        target: 'marketing',
        afterState: {
          prompt: 'IMPROVED: 你是营销助手。遇到策略制定场景时，必须调用 ma_generate_strategy 工具，并确保 brand、product、platform、budget 参数完整填充。不要调用无关工具。',
        },
      }
    }
    // 后续轮次不再产生候选
    return null
  }
}

test('marketing-toolset improve 闭环', async () => {
  console.log('\n🔄 运行 marketing-toolset improve...')
  callCount = 0

  const benchmark = requireBenchmark('marketing-toolset')
  const delegate = createImprovingDelegate()
  const state = buildToolsetStateGuard('marketing')

  const result = await runImprove({
    benchmark,
    delegate,
    state,
    maxRounds: 2,
    propose: createImprovingPropose(),
  })

  console.log('✅ marketing-toolset improve 完成:')
  console.log(`   Baseline: ${result.baselineScore}`)
  console.log(`   Final: ${result.finalScore}`)
  console.log(`   Accepted Rounds: ${result.acceptedRounds}/${result.totalRounds}`)
  console.log(`   Final Version: ${result.finalVersion}`)
  if (result.bestAcceptedPrompt) {
    console.log(`   Best Prompt: ${result.bestAcceptedPrompt.slice(0, 80)}...`)
  }

  expect(result).toBeDefined()
  expect(result.totalRounds).toBeGreaterThan(0)
  // 由于 mock 设计，改进后的分数应该更高
  expect(result.finalScore).toBeGreaterThanOrEqual(result.baselineScore)

  console.log(`   总调用次数: ${callCount}`)
}, 60000)

test('computer-use improve 闭环（保守模式）', async () => {
  console.log('\n🔄 运行 computer-use improve（保守模式）...')
  callCount = 0

  const benchmark = requireBenchmark('computer-use')
  const delegate = createImprovingDelegate()
  const state = buildToolsetStateGuard('computer-use')

  // 使用保守 propose（不产生候选）
  const result = await runImprove({
    benchmark,
    delegate,
    state,
    maxRounds: 2,
    // 不传入 propose，使用默认的 conservativePropose（返回 null）
  })

  console.log('✅ computer-use improve 完成:')
  console.log(`   Baseline: ${result.baselineScore}`)
  console.log(`   Final: ${result.finalScore}`)
  console.log(`   Accepted Rounds: ${result.acceptedRounds}/${result.totalRounds}`)

  expect(result).toBeDefined()
  // 保守模式下没有候选，应该 0 轮接受
  expect(result.acceptedRounds).toBe(0)
  expect(result.finalScore).toBe(result.baselineScore)

  console.log(`   总调用次数: ${callCount}`)
}, 60000)
