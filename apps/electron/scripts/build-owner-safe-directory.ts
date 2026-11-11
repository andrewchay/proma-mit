/** 构建用于Owner工作树目录创建的稳定 N-API 模块。 */
import { existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveNapiHeaders } from './resolve-napi-headers'

const output = resolve(import.meta.dir, '../resources/owner-safe-directory/owner_safe_directory.node')
if (process.platform !== 'darwin' && process.platform !== 'linux') {
  rmSync(output, { force: true })
  console.log('[Owner] 此平台暂不支持安全创建缺失目录')
  process.exit(0)
}
const headers = resolveNapiHeaders(import.meta.dir)
if (!headers || !existsSync(resolve(headers, 'node_api.h'))) throw new Error('未找到 N-API 头文件，无法构建 Owner 安全目录模块')
const source = resolve(import.meta.dir, '../resources/owner-safe-directory/owner_safe_directory.c')
const args = process.platform === 'darwin'
  ? ['/usr/bin/xcrun', '--sdk', 'macosx', 'clang', '-O2', '-dynamiclib', '-undefined', 'dynamic_lookup', '-I', headers, source, '-o', output]
  : ['cc', '-O2', '-shared', '-fPIC', '-I', headers, source, '-o', output]
const proc = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit' })
if (await proc.exited !== 0) throw new Error('Owner 安全目录模块构建失败')
console.log('[Owner] 安全目录模块构建完成')
