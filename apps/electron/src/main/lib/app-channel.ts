/** 发布渠道的纯函数规则：打包渠道由 package.json 固定，环境变量不能改写。 */
export type AppChannel = 'dev' | 'stable'

export function resolveAppChannel(isPackaged: boolean, packagedChannel?: unknown): AppChannel {
  if (!isPackaged) return 'dev'
  if (packagedChannel === undefined || packagedChannel === 'stable') return 'stable'
  if (packagedChannel === 'dev') return 'dev'
  throw new Error(`未知应用渠道: ${String(packagedChannel)}`)
}

export function getAppIdentity(channel: AppChannel) {
  const dev = channel === 'dev'
  return {
    channel,
    displayName: dev ? 'Gravitas Dev' : 'Gravitas',
    processName: dev ? 'Gravitas Dev' : 'Gravitas',
    appId: dev ? 'com.gravitas.app.dev' : 'com.gravitas.app',
    configDirName: dev ? '.gravitas-dev' : '.gravitas',
    userDataDirName: dev ? 'Gravitas Dev' : 'Gravitas',
    deepLinkProtocol: dev ? 'gravitas-dev' : 'gravitas',
  }
}

/** Dev 不恢复后台自动动作；用户手动操作仍走现有权限审批。 */
export function allowsAutomaticSideEffects(channel: AppChannel): boolean {
  return channel === 'stable'
}

export function allowsAppUpdates(channel: AppChannel, isPackaged: boolean): boolean {
  return channel === 'stable' && isPackaged
}

/** Dev 使用独立监听端口，避免与 Stable 的默认服务端口冲突。 */
export function getAppServicePorts(channel: AppChannel, stablePorts: { brief: number; companion: number }) {
  return channel === 'dev'
    ? { brief: 0, companion: 0 }
    : stablePorts
}
