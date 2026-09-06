/** 将 Electron 运行时资源复制到构建产物；避免依赖平台 shell 的 cp 命令。 */

import { cp } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = resolve(import.meta.dir, '../resources')
const destination = resolve(import.meta.dir, '../dist/resources')

await cp(source, destination, { recursive: true, force: true })
console.log('[构建资源] 已复制 resources/ 到 dist/resources/')
