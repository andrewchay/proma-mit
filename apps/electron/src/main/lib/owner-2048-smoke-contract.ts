/** 同一份需求进入真实 Owner 与最终冒烟检查，避免测试另加隐含标准。 */
export const OWNER_2048_SMOKE_CHECKS = [
  'html.loads', 'dom.board', 'dom.initial-tiles', 'behavior.merge',
  'storage.best-score', 'behavior.game-over', 'dom.restart',
] as const

export const OWNER_2048_SMOKE_COMMAND = `browser:${OWNER_2048_SMOKE_CHECKS.join('+')}`

export function owner2048SmokeGoal() {
  return {
    objective: '交付一个可在浏览器直接打开并游玩的 2048 网页，主入口为工作区 index.html；由 Owner 负责派工、检查、必要返工和最终交付。',
    acceptanceCriteria: [
      'index.html 可打开且无脚本错误',
      '棋盘恰好为 4×4 共16格',
      '新游戏初始至少两个数字块',
      '方向键按2048规则移动并合并相同数字，分数随合并增加且界面可见',
      '界面可见最高分，并以名称含 best 或 high 的数值 localStorage 键保存，刷新后仍保留',
      '棋盘填满且无可合并相邻数字时，界面明确显示游戏结束',
      '存在明确的重新开始按钮，点击后分数归零且恢复开局棋盘',
    ],
    constraints: [
      '只做一个实现步骤，由一名执行员工实现并由另一名员工独立评审；不要另设调研、测试脚本或总结步骤。',
      '成果只允许 index.html，可内联 CSS 和 JavaScript；不依赖网络或第三方资源，不安装依赖。',
      `在团队安排中选择 development，targetPaths 和 allowedPaths 均为 ["index.html"]；verificationCommands 必须为 ["${OWNER_2048_SMOKE_COMMAND}"]，与上述七项验收标准一一对应。`,
      '采用同步渲染的16格 CSS grid，每格显示当前数字；提供中文分数和最高分文字与重新开始按钮，便于用户操作和浏览器核验。',
      '检查失败时在当前成果上按具体缺陷返工并重新核验；不得改验收标准、跳过失败项或将检查失败解释为完成。',
    ],
  }
}
