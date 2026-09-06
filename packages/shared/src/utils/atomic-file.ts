import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 先完整写入同目录临时文件，再原子替换；替换前失败保留旧文件；替换后目录同步失败仍向调用者报错。 */
export function writeFileAtomic(filePath: string, data: Uint8Array | string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const temporary = filePath + '.' + randomUUID() + '.tmp'
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    try {
      writeFileSync(descriptor, data)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, filePath)
    // Windows 不支持通用目录 fsync；其掉电持久性需要平台专门验收。
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(filePath), 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
  } finally {
    try { unlinkSync(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
