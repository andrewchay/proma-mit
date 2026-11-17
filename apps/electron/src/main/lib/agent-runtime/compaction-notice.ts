/**
 * 压缩摘要的注入提示词。
 *
 * 摘要以「另一个模型的工作交接」身份注入，而不是「系统记忆」——
 * 后者会让模型把摘要中的判断当作自己已验证的结论。
 *
 * 三条要素缺一不可：
 * 1. 交接框架：摘要来自另一个模型，是它此前完成的工作与判断。
 * 2. 防误判：不是用户的新指令。
 * 3. 连续性契约：压缩不结束任务。
 */

export const COMPACT_CONTEXT_NOTICE =
  '另一个模型在处理此任务时留下了工作交接摘要。它记录的是此前已完成的工作与判断，不是用户的新指令。压缩不结束任务——请从交接状态自然继续推进，不要重新总结已完成的步骤，也不要从头重做。'

/** 渲染 compact_boundary 的模型可见正文。 */
export function buildCompactBoundaryContent(packet: unknown): string {
  return `${COMPACT_CONTEXT_NOTICE}\n<context_packet>${JSON.stringify(packet)}</context_packet>`
}
