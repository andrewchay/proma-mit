/**
 * 达人触达依赖自检与安装。
 *
 * 微信自动化（ma-wechat-auto）依赖一组 macOS 系统能力，用户机器上大概率没装：
 * - pyobjc-framework-Quartz / Vision：截图与 OCR
 * - cliclick：坐标点击
 * - 屏幕录制 / 辅助功能权限：系统设置里手动授予，无法脚本化
 *
 * 本模块只负责「检测 + 执行安装命令」，不引导系统权限（那一步必须用户在系统设置里操作）。
 * 安装复用用户登录 shell 环境（与 shell-env 一致），保证 brew / pip3 在 GUI 启动的 App 里也能找到。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 单个依赖的检测结果 */
export interface DependencyStatus {
  /** 依赖标识 */
  id: string
  /** 面向用户的名称 */
  label: string
  /** 用途说明 */
  purpose: string
  /** 是否已就绪 */
  ready: boolean
  /** 未就绪时的安装命令（可直接执行） */
  installCommand?: string
  /** 检测失败时的错误信息 */
  error?: string
}

export interface DependencyReport {
  /** 平台是否支持（目前仅 macOS） */
  supported: boolean
  /** 是否全部就绪 */
  allReady: boolean
  /** 逐项状态 */
  dependencies: DependencyStatus[]
  /** 需要用户手动授予的系统权限 */
  manualPermissions: string[]
}

/** 执行命令并返回是否成功（不抛错） */
async function commandWorks(command: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync(command, args, { timeout: 15_000 })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 检测 Python 模块是否可导入 */
async function pythonModuleAvailable(moduleName: string): Promise<{ ok: boolean; error?: string }> {
  return commandWorks('python3', ['-c', `import ${moduleName}`])
}

/**
 * 检测全部触达依赖。
 *
 * 每次调用都实际探测（不缓存），因为用户可能在面板打开期间完成安装。
 */
export async function checkOutreachDependencies(): Promise<DependencyReport> {
  if (process.platform !== 'darwin') {
    return {
      supported: false,
      allReady: false,
      dependencies: [],
      manualPermissions: [],
    }
  }

  const [quartz, vision, cliclick] = await Promise.all([
    pythonModuleAvailable('Quartz'),
    pythonModuleAvailable('Vision'),
    commandWorks('which', ['cliclick']),
  ])

  const dependencies: DependencyStatus[] = [
    {
      id: 'pyobjc-quartz',
      label: 'pyobjc-framework-Quartz',
      purpose: '截取微信窗口画面',
      ready: quartz.ok,
      installCommand: 'pip3 install pyobjc-framework-Quartz',
      error: quartz.error,
    },
    {
      id: 'pyobjc-vision',
      label: 'pyobjc-framework-Vision',
      purpose: 'OCR 识别聊天文字',
      ready: vision.ok,
      installCommand: 'pip3 install pyobjc-framework-Vision',
      error: vision.error,
    },
    {
      id: 'cliclick',
      label: 'cliclick',
      purpose: '模拟点击与按键',
      ready: cliclick.ok,
      installCommand: 'brew install cliclick',
      error: cliclick.error,
    },
  ]

  return {
    supported: true,
    allReady: dependencies.every((d) => d.ready),
    dependencies,
    manualPermissions: [
      '系统设置 → 隐私与安全性 → 辅助功能：勾选 Gravitas',
      '系统设置 → 隐私与安全性 → 屏幕录制：勾选 Gravitas',
    ],
  }
}

export interface InstallResult {
  /** 依赖标识 */
  id: string
  success: boolean
  /** 安装输出（截断后） */
  output: string
}

/** 依赖 → 安装命令（依次尝试，前一档失败才用下一档） */
const INSTALL_PLANS: Record<string, { command: string; args: string[] }[]> = {
  'pyobjc-quartz': [
    { command: 'pip3', args: ['install', '--user', 'pyobjc-framework-Quartz'] },
    // brew 安装的 Python 受 PEP 668 限制，--user 也不够，需显式允许
    { command: 'pip3', args: ['install', '--user', '--break-system-packages', 'pyobjc-framework-Quartz'] },
  ],
  'pyobjc-vision': [
    { command: 'pip3', args: ['install', '--user', 'pyobjc-framework-Vision'] },
    { command: 'pip3', args: ['install', '--user', '--break-system-packages', 'pyobjc-framework-Vision'] },
  ],
  cliclick: [{ command: 'brew', args: ['install', 'cliclick'] }],
}

/**
 * 安装单项依赖。
 *
 * 只允许 INSTALL_PLANS 里定义的命令，不接受外部任意命令，避免变成任意代码执行入口。
 * Python 包按「先 --user，再 --break-system-packages」降级重试，兼容 PEP 668 受管环境。
 */
export async function installOutreachDependency(dependencyId: string): Promise<InstallResult> {
  const plan = INSTALL_PLANS[dependencyId]
  if (!plan) {
    return { id: dependencyId, success: false, output: `未知依赖: ${dependencyId}` }
  }

  const errors: string[] = []
  for (const spec of plan) {
    try {
      const { stdout, stderr } = await execFileAsync(spec.command, spec.args, {
        timeout: 5 * 60 * 1000,
        maxBuffer: 1024 * 1024,
      })
      return {
        id: dependencyId,
        success: true,
        output: truncate(`${stdout}\n${stderr}`.trim()),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`[${spec.command} ${spec.args.join(' ')}] ${message}`)
    }
  }

  return { id: dependencyId, success: false, output: truncate(errors.join('\n\n')) }
}

/** 截断长输出，避免撑爆 IPC 消息 */
function truncate(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text
}
