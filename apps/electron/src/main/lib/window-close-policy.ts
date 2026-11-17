/**
 * 主窗口关闭策略
 *
 * 决定「点击关闭按钮」时是隐藏到托盘还是真正退出。
 *
 * 为什么需要策略而不是内联判断：Owner 管理回路、autonomous scheduler、
 * 外部事件触发都跑在主进程里。窗口一关就退出，等于把这些后台能力一起停掉。
 * 但「退出应用」又必须能真正退出——否则用户无法结束进程。
 *
 * 判定依据是**是否正在退出**，而不是平台：
 * - 用户按 Cmd+Q / 菜单退出 / 系统关机 → `isQuitting=true` → 允许关闭
 * - 用户点击窗口关闭按钮 → `isQuitting=false` → 隐藏到托盘，主进程继续跑
 *
 * 这样所有平台行为一致，也避免「macOS 能常驻、Windows 一关就没」的分裂。
 */

export interface ClosePolicyInput {
  /** 是否正在退出应用（由 before-quit 置位） */
  isQuitting: boolean
}

export type CloseAction = 'allow-close' | 'hide-to-tray'

/**
 * 计算关闭窗口时应采取的动作。
 *
 * 纯函数，不读全局状态也不碰 Electron API——便于在 bun 测试环境下直接验证。
 */
export function resolveWindowCloseAction(input: ClosePolicyInput): CloseAction {
  return input.isQuitting ? 'allow-close' : 'hide-to-tray'
}
