/** 预览和下载缓存必须跟随渠道；生产沿用原目录，避免破坏现有引用。 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as electron from 'electron'
import { APP_IS_DEV } from './app-identity'
import { getConfigDir } from './config-paths'

export function getPreviewTempDir(): string {
  return APP_IS_DEV || (process.env.GRAVITAS_PACKAGE_SMOKE === '1' && process.env.PROMA_TEST_CONFIG_DIR)
    ? join(getConfigDir(), 'cache', 'preview')
    : join(tmpdir(), 'proma-preview')
}

export function getInstallerTempDir(): string {
  return APP_IS_DEV || (process.env.GRAVITAS_PACKAGE_SMOKE === '1' && process.env.PROMA_TEST_CONFIG_DIR)
    ? join(getConfigDir(), 'cache', 'installers')
    : join(electron.app.getPath('temp'), 'proma-installers')
}
