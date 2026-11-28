/**
 * 微信只读服务：列出会话、读取对话。
 *
 * 设计边界（重要）：
 * - **只读**。本模块不提供任何发送能力，脚本层也只有 sessions-json / read-json 两个入口。
 * - 坐标点击 + OCR 的失败模式是「静默点错位置」，发错人不可撤回；
 *   因此自动发送被有意排除在面板能力之外，只保留「读取 + 生成草稿 + 复制」。
 * - 依赖本机环境（微信运行、屏幕录制权限、窗口 ≥ 700x500），失败时返回可读原因。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 微信脚本目录（开发态在源码里，打包后在 resources 下） */
function resolveWechatScriptsDir(): string {
  // 开发态：__dirname 指向 dist，脚本在源码 marketing-skills 下
  const devPath = join(__dirname, '../../marketing-skills/ma-wechat-auto/scripts')
  if (existsSync(devPath)) return devPath

  const { app } = require('electron') as { app?: { isPackaged?: boolean } }
  if (app?.isPackaged) {
    return join(process.resourcesPath, 'marketing-skills/ma-wechat-auto/scripts')
  }
  return devPath
}

/** 会话列表项 */
export interface WechatSession {
  name: string
  preview: string
  y: number
}

/** 一条消息 */
export interface WechatMessage {
  dir: 'in' | 'out'
  text: string
  y: number
}

export interface WechatReadResult {
  success: boolean
  /** 错误信息（success=false 时） */
  error?: string
  /** 失败类型，供 UI 决定展示方式 */
  errorKind?: 'not-running' | 'window-too-small' | 'permission' | 'unknown'
  sessions?: WechatSession[]
  messages?: WechatMessage[]
}

/** 把脚本的 stderr 归类成可读的失败原因 */
function classifyError(stderr: string): WechatReadResult['errorKind'] {
  if (stderr.includes('窗口当前为') || stderr.includes('小于最小要求')) return 'window-too-small'
  if (stderr.includes('未找到微信主窗口')) return 'not-running'
  if (stderr.includes('CGWindowListCreateImage') || stderr.includes('None')) return 'permission'
  return 'unknown'
}

/** 执行只读脚本命令，返回解析后的 JSON（失败时返回错误） */
async function runReadonlyScript<T>(args: string[]): Promise<{ ok: true; data: T } | { ok: false; error: string; errorKind: WechatReadResult['errorKind'] }> {
  if (process.platform !== 'darwin') {
    return { ok: false, error: '微信自动化仅支持 macOS', errorKind: 'unknown' }
  }

  const scriptsDir = resolveWechatScriptsDir()
  const scriptPath = join(scriptsDir, 'wx.py')
  if (!existsSync(scriptPath)) {
    return { ok: false, error: `未找到微信脚本: ${scriptPath}`, errorKind: 'unknown' }
  }

  try {
    const { stdout } = await execFileAsync('python3', [scriptPath, ...args], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      cwd: scriptsDir,
    })
    return { ok: true, data: JSON.parse(stdout) as T }
  } catch (err) {
    // execFile 失败时 stderr 在 err.stderr 上
    const e = err as { stderr?: string; message?: string }
    const stderr = e.stderr ?? e.message ?? String(err)
    return {
      ok: false,
      error: stderr.trim() || '微信读取失败',
      errorKind: classifyError(stderr),
    }
  }
}

/**
 * 列出微信会话（只读，不点击、不打开）。
 *
 * 每次调用都会截图 + OCR，约 2-4 秒。调用方应做防抖。
 */
export async function listWechatSessions(): Promise<WechatReadResult> {
  const result = await runReadonlyScript<WechatSession[]>(['sessions-json'])
  if (!result.ok) {
    return { success: false, error: result.error, errorKind: result.errorKind }
  }
  return { success: true, sessions: result.data ?? [] }
}

/**
 * 读取某个联系人的最近消息（只读）。
 *
 * 注意：内部会点击会话行打开对话，但不会输入文字、不会发送。
 */
export async function readWechatMessages(contact: string, limit = 12): Promise<WechatReadResult> {
  const result = await runReadonlyScript<{ contact: string; messages: WechatMessage[] }>([
    'read-json',
    contact,
    String(limit),
  ])
  if (!result.ok) {
    return { success: false, error: result.error, errorKind: result.errorKind }
  }
  return { success: true, messages: result.data?.messages ?? [] }
}
