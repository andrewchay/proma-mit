import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { cpus, freemem, totalmem } from 'node:os'

export { totalmem as readOwnerHostTotalMemory }

export function readOwnerHostCpu() {
  let idle = 0
  let total = 0
  for (const { times } of cpus()) {
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

export function readOwnerHostAvailableMemory(): Promise<number | undefined> {
  if (process.platform === 'darwin') {
    // Darwin 的 freemem 只含完全空闲页，常在无压力时也很低；用系统压力工具的可用比例。
    return new Promise(resolve => {
      execFile('/usr/bin/memory_pressure', ['-Q'], { timeout: 1000, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => {
        const percent = error ? undefined : /System-wide memory free percentage:\s*(\d+)%/.exec(stdout)?.[1]
        resolve(percent === undefined ? undefined : totalmem() * Number(percent) / 100)
      })
    })
  }
  if (process.platform === 'linux') {
    return readFile('/proc/meminfo', 'utf8').then(content => {
      const available = /^MemAvailable:\s+(\d+)\s+kB/m.exec(content)?.[1]
      return available === undefined ? undefined : Number(available) * 1024
    }, () => undefined)
  }
  return Promise.resolve(freemem())
}
