/**
 * 调试用「全能力放开」开关（Development Unlock）
 *
 * 用途：本地调试时一次性打开全部受订阅控制的能力与被开发阶段门禁隐藏的模块，
 * 不需要服务端签发权益快照，也不需要逐个去改 settings.json。
 *
 * 两条生效路径（任一命中即放开，均需显式打开，默认关闭）：
 *   1. 运行时：环境变量 GRAVITAS_UNLOCK_ALL_CAPABILITIES === '1'，且非打包环境
 *   2. 构建期：调试专用打包脚本注入 __GRAVITAS_DEV_UNLOCK__，打包产物也生效
 *      （见 scripts/dist.ts 的 --dev-unlock；macOS 的 .app 不继承终端环境变量，
 *       所以打包产物只能走这条路）
 *
 * 为什么运行时路径必须限定非打包环境：这是全仓唯一会同时绕过权益验签与开发阶段
 * 门禁的代码路径。如果正式打包产物也认这个环境变量，用户设一个变量就能解锁全部
 * 付费能力，商业化模型等于不存在。
 *
 * 构建期路径为什么安全：正式打包脚本不注入该定义，esbuild 未定义时会把整个判断
 * 保留为运行时 `typeof` 检查，结果为 false；注入 true 时则被折叠为常量。
 * 也就是说正式产物里不是「恰好没开」，而是这条分支恒为 false。
 *
 * 与 entitlement-gate / feature-gate 的职责边界：本模块只回答「调试放开是否生效」，
 * 不承担任何业务判定。各门禁自己决定放开时返回什么（授予哪些能力、哪些模块可见），
 * 避免门禁语义被这里悄悄吞掉。
 */

import type { EntitlementSnapshot } from '@gravitas/shared'
import { ALL_SUBSCRIPTION_CAPABILITIES } from '@gravitas/shared'

/** 打开全部付费能力与未发布模块的环境变量名 */
export const DEV_UNLOCK_ENV = 'GRAVITAS_UNLOCK_ALL_CAPABILITIES'

/**
 * 构建期注入的放开标记（仅调试专用打包脚本定义）。
 *
 * 为什么需要它：macOS 上双击启动的 .app 由 launchd 拉起，根本不会继承你在终端
 * 设的环境变量，所以打包产物无法靠 GRAVITAS_UNLOCK_ALL_CAPABILITIES 放开。
 * 靠运行时环境变量的路径对打包产物天然无效，只能把标记在构建时就烧进产物。
 *
 * esbuild --define（见 scripts/dist.ts 的 --dev-unlock）会把整个表达式折叠成常量：
 * - 未注入时：`typeof` 检查保留，运行时遇到未声明的标识符会得到 'undefined'，
 *   返回 false。`&&` 右侧因此不会执行，不会抛 ReferenceError。
 * - 注入 true 时：表达式被折叠为 `true`，打包环境也放开。
 *
 * 安全边界：正式打包脚本（dist:mac / dist:fast 等）不注入这个定义，
 * 所以正式产物里这条分支恒为 false，而不是「靠配置恰好没开」。
 */
declare const __GRAVITAS_DEV_UNLOCK__: boolean | undefined

/** 仅测试使用：模拟构建期注入，避免为验一个分支真的去跑一次打包。 */
let buildInjectedUnlockForTest: boolean | undefined

export function __setBuildInjectedUnlockForTest(value: boolean | undefined): void {
  buildInjectedUnlockForTest = value
}

/** 构建期注入的释放标记是否生效。正式产物恒为 false。 */
function isBuildInjectedUnlock(): boolean {
  if (buildInjectedUnlockForTest !== undefined) return buildInjectedUnlockForTest
  return typeof __GRAVITAS_DEV_UNLOCK__ !== 'undefined' && __GRAVITAS_DEV_UNLOCK__ === true
}

/** 读取 Electron 的打包状态。非 Electron 环境（bun test / 脚本）按开发环境处理。 */
function readIsPackaged(): boolean {
  try {
    // 延迟 require：本模块会被多个门禁在模块初始化期引用，
    // 顶层 import electron 容易形成初始化顺序问题。
    const { app } = require('electron') as { app?: { isPackaged?: boolean } }
    return app?.isPackaged === true
  } catch {
    return false
  }
}

/**
 * 调试放开是否生效。
 *
 * 未显式设置环境变量且未注入构建期标记时一律返回 false —— 默认行为必须与放开前
 * 完全一致，否则「只有显式打开才放开」就只是口头约定。
 *
 * @param options.isPackaged 调用方已知的打包状态。feature-gate 等已经把
 *   isPackaged 作为参数传入，应由调用方透传，避免同一进程里存在两份「是否打包」
 *   的判断源。不传时自行读取 Electron 的 app.isPackaged。
 */
export function isDevUnlockEnabled(options: { isPackaged?: boolean } = {}): boolean {
  // 构建期注入（调试专用打包脚本）：打包环境也放开。这一条必须排在 isPackaged
  // 检查之前，否则打包产物永远被拦，构建期标记就失去意义。
  if (isBuildInjectedUnlock()) return true

  // 以下是运行时路径：必须显式设置变量，且仅非打包环境有效。
  if (process.env[DEV_UNLOCK_ENV] !== '1') return false

  const isPackaged = options.isPackaged ?? readIsPackaged()
  // 真机打包产物一定带 app.isPackaged === true，据此拒绝放开。
  return isPackaged !== true
}

/**
 * 供日志与自检使用的放开状态描述。
 *
 * 调试时能一眼看出「放开到底有没有生效」，比事后猜为什么门禁没开要省时间。
 */
export function describeDevUnlock(): string {
  if (isBuildInjectedUnlock()) return '已生效（构建期注入）'
  const configured = process.env[DEV_UNLOCK_ENV] === '1'
  if (!configured) return '未配置'
  return isDevUnlockEnabled() ? '已生效' : '已配置但在打包环境被忽略'
}

/**
 * 构造调试放开的权益快照（仅内存，绝不落盘）。
 *
 * status 用 active、capabilities 填满，让所有基于快照的判定（渲染层
 * selectCanUseCapability、主进程 canUseCapability）自然放行。
 *
 * signature / keyId 用显式标记值而不是伪造服务端签名：真实验签路径不会读到它
 * （调用方在验签之前就已提前返回），万一哪天有人把它接到验签链路上，也会因为
 * 签名不匹配而 fail-closed，不会静默变成一张通行证。
 */
export function buildDevUnlockedSnapshot(now: Date = new Date()): EntitlementSnapshot {
  return {
    accountId: 'dev-unlock',
    planId: 'pro',
    capabilities: [...ALL_SUBSCRIPTION_CAPABILITIES],
    status: 'active',
    lastVerifiedAt: now.toISOString(),
    signature: 'dev-unlock-not-verifiable',
    keyId: 'dev-unlock',
  }
}
