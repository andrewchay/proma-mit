import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 优先选择仓库/系统 Node 头文件，最后使用与当前 Electron 精确匹配的 node-gyp 缓存。 */
export function resolveNapiHeaders(scriptsDirectory: string): string {
  const bundledHeaders = resolve(scriptsDirectory, '../../../node_modules/node-addon-api/external-napi')
  const nodeExecutable = Bun.which('node')
  const nodeHeaders = nodeExecutable ? resolve(dirname(nodeExecutable), '../include/node') : ''
  const electronPackage = resolve(scriptsDirectory, '../../../node_modules/electron/package.json')
  const electronVersion = existsSync(electronPackage)
    ? (JSON.parse(readFileSync(electronPackage, 'utf8')) as { version?: string }).version
    : undefined
  const electronHeaders = electronVersion
    ? join(homedir(), '.electron-gyp', electronVersion, 'include/node')
    : ''

  return [bundledHeaders, nodeHeaders, electronHeaders]
    .find((candidate) => candidate.length > 0 && existsSync(join(candidate, 'node_api.h')))
    ?? ''
}
