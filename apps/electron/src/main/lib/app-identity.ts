/** 运行时身份：Stable 保留原路径；Dev 使用独立配置和协议。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as electron from 'electron'
// Bun 直接导入 electron 时导出的是可执行路径；不能使用静态命名导入。
const app = (electron as unknown as { app?: import('electron').App }).app
import { getPackagedTestProfileName } from './test-build-identity'
import { allowsAppUpdates, allowsAutomaticSideEffects, getAppIdentity, getAppServicePorts, resolveAppChannel } from './app-channel'

function readPackagedMetadata(): { gravitasChannel?: unknown; gravitasTestBuild?: unknown; gravitasTestProfileName?: unknown } | undefined {
  if (!app?.isPackaged) return undefined
  // 读取安装包自己的元数据，不信任 cwd 或终端环境变量。
  const metadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))
  return metadata
}

const metadata = readPackagedMetadata()
const isOwnerTestBuild = metadata?.gravitasTestBuild === true
export const APP_CHANNEL = resolveAppChannel(app?.isPackaged === true, metadata?.gravitasChannel)
const identity = getAppIdentity(APP_CHANNEL)
export const APP_DISPLAY_NAME = isOwnerTestBuild ? getPackagedTestProfileName(metadata) : identity.displayName
export const APP_PROCESS_NAME = isOwnerTestBuild ? getPackagedTestProfileName(metadata) : identity.processName
export const APP_CONFIG_DIR_NAME = identity.configDirName
export const APP_DEEP_LINK_PROTOCOL = isOwnerTestBuild ? 'gravitas-owner-test' : identity.deepLinkProtocol
export const APP_IS_DEV = APP_CHANNEL === 'dev'
export const APP_AUTOMATIC_SIDE_EFFECTS = allowsAutomaticSideEffects(APP_CHANNEL)
export const APP_UPDATES_ENABLED = allowsAppUpdates(APP_CHANNEL, app?.isPackaged === true)
export const APP_SERVICE_PORTS = getAppServicePorts(APP_CHANNEL, { brief: 8765, companion: 8790 })

export const APP_DEV_CONFIG_DIR_NAME = '.gravitas-dev'
export const APP_DEV_USER_DATA_DIR_NAME = 'Gravitas Dev'
