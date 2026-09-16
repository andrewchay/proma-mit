/**
 * 外部工具注册表与探测（M6）
 *
 * 关键约束（方案 §7）：
 * - **不内置上游源码或二进制**：这里只有描述符与探测逻辑
 * - 探测用受限 CLI 调用（无 shell、短超时、只读 `--version`）
 * - 配置落盘不含任何凭据；启用需用户确认许可 + 填写实际版本
 * - descriptor-only 工具只登记能力，不提供执行路径
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RESEARCH_ERROR_CODES, ResearchError } from '@gravitas/shared'
import type {
  ExternalToolConfig,
  ExternalToolDescriptor,
  ExternalToolStatusView,
} from '@gravitas/shared'
import { parseVersion, resolveToolStatus, validateToolDescriptor } from '@gravitas/core/services/academic'
import { getAcademicDir } from '../config-paths'

const execFileAsync = promisify(execFile)

/** 探测超时（毫秒）：只读版本号，不应长跑 */
const PROBE_TIMEOUT_MS = 5000

/**
 * 内置注册表（描述符）。
 *
 * 所有工具都需要用户自行安装；这里不下载、不捆绑任何上游产物。
 */
export const EXTERNAL_TOOL_REGISTRY: ExternalToolDescriptor[] = [
  {
    id: 'openresearch',
    name: 'OpenResearch (orx)',
    role: 'cli-adapter',
    binary: 'orx',
    versionArgs: ['--version'],
    licenseNote: '上游为 alphaXiv/OpenResearch 自有许可（见仓库 LICENSE），需自行确认条款',
    homepage: 'https://github.com/alphaXiv/OpenResearch',
    capabilities: ['实验树与分支管理', '运行提交与日志回收', '内容寻址源码快照'],
    prerequisites: ['自行安装 orx CLI', '如需算力后端需另行配置凭据'],
  },
  {
    id: 'dvc',
    name: 'DVC',
    role: 'cli-adapter',
    binary: 'dvc',
    versionArgs: ['--version'],
    licenseNote: 'Apache-2.0',
    homepage: 'https://github.com/iterative/dvc',
    capabilities: ['数据与模型内容寻址版本化', '外部数据引用'],
    prerequisites: ['自行安装 dvc', '目标目录需已 git init 或 dvc init'],
  },
  {
    id: 'rd-agent',
    name: 'RD-Agent',
    role: 'descriptor-only',
    licenseNote: 'MIT',
    homepage: 'https://github.com/microsoft/RD-Agent',
    capabilities: ['' + '研发自动化（提想法 / 实现循环）', '量化因子与模型协同优化'],
    prerequisites: ['需要 Python 环境', '需自行安装并配置模型凭据', '本插件不内置其运行栈'],
  },
  {
    id: 'biomni',
    name: 'Biomni',
    role: 'descriptor-only',
    licenseNote: 'Apache-2.0',
    homepage: 'https://github.com/snap-stanford/Biomni',
    capabilities: ['生物医学任务规划与代码执行', '领域数据库检索'],
    prerequisites: ['需要 conda 环境与大量领域依赖', '仅限生医计算任务', '本插件不内置其运行栈'],
  },
]

export function listToolDescriptors(): ExternalToolDescriptor[] {
  return EXTERNAL_TOOL_REGISTRY
}

export function getToolDescriptor(toolId: string): ExternalToolDescriptor {
  const descriptor = EXTERNAL_TOOL_REGISTRY.find((t) => t.id === toolId)
  if (!descriptor) {
    throw new ResearchError(RESEARCH_ERROR_CODES.NOT_FOUND, `未知外部工具: ${toolId}`)
  }
  return descriptor
}

// ===== 配置落盘（不含凭据） =====

interface ToolsFile {
  tools: ExternalToolConfig[]
}

function configPath(): string {
  const dir = getAcademicDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'external-tools.json')
}

function readToolsFile(): ToolsFile {
  const path = configPath()
  if (!existsSync(path)) return { tools: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ToolsFile
    return Array.isArray(parsed.tools) ? parsed : { tools: [] }
  } catch (err) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.STORE_CORRUPTED,
      `外部工具配置损坏，已保留原文件：${path}`,
      { cause: err },
    )
  }
}

function writeToolsFile(data: ToolsFile): void {
  writeFileSync(configPath(), JSON.stringify(data, null, 2), 'utf-8')
}

export function listToolConfigs(): ExternalToolConfig[] {
  return readToolsFile().tools
}

export function getToolConfig(toolId: string): ExternalToolConfig {
  return (
    readToolsFile().tools.find((t) => t.toolId === toolId) ?? { toolId, enabled: false }
  )
}

/** 更新工具配置（启用校验由调用方经规则层完成） */
export function saveToolConfig(config: ExternalToolConfig): ExternalToolConfig {
  const data = readToolsFile()
  const idx = data.tools.findIndex((t) => t.toolId === config.toolId)
  if (idx >= 0) data.tools[idx] = config
  else data.tools.push(config)
  writeToolsFile(data)
  return config
}

// ===== 探测 =====

export interface ProbeResult {
  installed: boolean
  version?: string
  error?: string
}

/** 探测函数类型（测试注入） */
export type ToolProbe = (descriptor: ExternalToolDescriptor) => Promise<ProbeResult>

/**
 * 默认探测实现：受限 execFile（无 shell）+ 短超时。
 *
 * 只运行描述符声明的 `versionArgs`，不接受调用方传入的命令。
 */
export const defaultToolProbe: ToolProbe = async (descriptor) => {
  if (!descriptor.binary) return { installed: false, version: undefined }

  try {
    const { stdout } = await execFileAsync(descriptor.binary, descriptor.versionArgs ?? ['--version'], {
      timeout: PROBE_TIMEOUT_MS,
      // 不用 shell：避免把 PATH 查找变成命令拼接
      shell: false,
      windowsHide: true,
    })
    return { installed: true, version: parseVersion(stdout) }
  } catch (err) {
    const code = (err as { code?: string | number }).code
    if (code === 'ENOENT') return { installed: false }
    return {
      installed: false,
      error: `探测失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** 探测单个工具并给出状态视图 */
export async function probeTool(
  toolId: string,
  probe: ToolProbe = defaultToolProbe,
): Promise<ExternalToolStatusView> {
  const descriptor = getToolDescriptor(toolId)
  validateToolDescriptor(descriptor)
  const config = getToolConfig(toolId)

  const result =
    descriptor.role === 'cli-adapter' ? await probe(descriptor) : { installed: false }

  const { status, detail } = resolveToolStatus({ descriptor, config, probe: result })
  return { descriptor, config, status, detectedVersion: result.version, detail }
}

/** 探测全部登记工具 */
export async function probeAllTools(probe: ToolProbe = defaultToolProbe): Promise<ExternalToolStatusView[]> {
  const views: ExternalToolStatusView[] = []
  for (const descriptor of EXTERNAL_TOOL_REGISTRY) {
    views.push(await probeTool(descriptor.id, probe))
  }
  return views
}
