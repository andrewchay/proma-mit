import { app, dialog, ipcMain, shell } from 'electron'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PerformanceSample, PerformanceSnapshotResult } from '../../types/performance-monitor'
import { getMainWindow } from '../main-window'
import { validateSamples } from './performance-monitor-validation'

interface MainSample { timestamp: number; delayMs: number; processes: { pid: number; type: string; cpu: number; memoryKB: number }[] }
const samples: MainSample[] = []

export function registerPerformanceMonitor(): void {
  let expected = performance.now() + 1000
  const timer = setInterval(() => {
    const now = performance.now()
    const delayMs = Math.max(0, Math.round(now - expected))
    try {
      samples.push({ timestamp: Date.now(), delayMs, processes: app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type, cpu: metric.cpu.percentCPUUsage, memoryKB: metric.memory.workingSetSize })) })
    } catch {
      // 诊断失败不能影响应用正常运行。
      samples.push({ timestamp: Date.now(), delayMs, processes: [] })
    }
    if (samples.length > 30) samples.shift()
    if (delayMs >= 200) getMainWindow()?.webContents.send('performance-monitor:main-stall')
    expected = now + 1000
  }, 1000)
  timer.unref()
  ipcMain.handle('performance-monitor:open-folder', async event => {
    const window = getMainWindow()
    if (!window || event.sender.id !== window.webContents.id) throw new Error('只有主窗口可以查看性能记录')
    const directory = join(app.getPath('userData'), 'performance-diagnostics')
    await mkdir(directory, { recursive: true })
    const error = await shell.openPath(directory)
    if (error) throw new Error(error)
  })
  let lastAutoSave = 0
  ipcMain.handle('performance-monitor:auto', async (event, input: unknown, reason: unknown): Promise<void> => {
    const window = getMainWindow()
    if (!window || event.sender.id !== window.webContents.id) throw new Error('只有主窗口可以保存性能记录')
    const renderer = validateSamples(input)
    const rendererStall = reason === 'renderer' && renderer.some(sample => sample.kind === 'long-task' && sample.durationMs >= 200)
    const mainStall = reason === 'main' && samples.some(sample => sample.delayMs >= 200 && sample.timestamp >= Date.now() - 15_000)
    if ((!rendererStall && !mainStall) || Date.now() - lastAutoSave < 60_000) return
    lastAutoSave = Date.now()
    const directory = join(app.getPath('userData'), 'performance-diagnostics')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `performance-${Date.now()}.json`), JSON.stringify({ version: 1, appVersion: app.getVersion(), capturedAt: Date.now(), reason, windowSeconds: 30, main: samples, renderer }), 'utf8')
    const files = (await readdir(directory)).filter(name => /^performance-\d+\.json$/.test(name)).sort().reverse()
    await Promise.all(files.slice(10).map(name => unlink(join(directory, name))))
  })
  ipcMain.handle('performance-monitor:save', async (event, input: unknown): Promise<PerformanceSnapshotResult> => {
    const window = getMainWindow()
    if (!window || event.sender.id !== window.webContents.id) throw new Error('只有主窗口可以保存性能记录')
    const renderer = validateSamples(input)
    const cutoff = Date.now() - 30_000
    const main = samples.filter(sample => sample.timestamp >= cutoff)
    const capturedAt = Date.now()
    const result = await dialog.showSaveDialog(window, { title: '保存性能记录', defaultPath: `gravitas-performance-${Date.now()}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (result.canceled || !result.filePath) return { saved: false }
    await writeFile(result.filePath, JSON.stringify({ version: 1, appVersion: app.getVersion(), capturedAt, windowSeconds: 30, main, renderer }, null, 2), 'utf8')
    return { saved: true, path: result.filePath }
  })
}
