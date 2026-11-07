/**
 * 项目外网扫描的 Agent-Reach 采集层。
 *
 * 职责：spawn 本机 `agent-reach` CLI，把一行 JSON envelope 翻译成统一的
 * WatchSourceItem / 错误明细。不在这里实现任何渠道逻辑；渠道、动作与
 * 错误码语义全部来自上游 CLI，契约见
 * docs/plans/2026-11-06-web-watch-agent-reach/design.md。
 *
 * 失败纪律（与 seedDefaultSkills 的「单源失败不掀翻整轮」一致）：
 * 单个源失败只记一条错误，绝不抛出。
 */

import { spawn } from 'node:child_process'
import {
  AGENT_REACH_WATCH_TEMPLATES,
  type AgentReachWatchTemplate,
  type WebWatchSource,
  type WebWatchSourceError,
} from '@gravitas/shared'
import type { WebSearchResultItem } from './agent-runtime/tool-impls/web-search-tool'

// ===== 类型 =====

/** 监控源的元素类型：通用网页搜索结果 + 采集来源标注（旧记录无 origin 视为 websearch）。 */
export interface WatchSourceItem extends WebSearchResultItem {
  origin?: { type: 'websearch' } | { type: 'agent-reach'; channel: string; action: string; backend?: string }
}

export type AgentReachWatchSource = WebWatchSource
export type AgentReachSourceError = WebWatchSourceError

export interface AgentReachCollectResult {
  items: WatchSourceItem[]
  errors: AgentReachSourceError[]
}

interface AgentReachEnvelopeItem {
  title?: string
  url?: string
  author?: string
  published_at?: string
  text?: string
}

interface AgentReachEnvelope {
  ok?: boolean
  channel?: string
  action?: string
  backend?: string
  items?: AgentReachEnvelopeItem[]
  error?: { code?: string; message?: string; hint?: string }
}

// ===== 渠道模板（一期白名单，免登录渠道；与渲染进程共用 @gravitas/shared 的同一份） =====

export type AgentReachSourceTemplate = AgentReachWatchTemplate

export const AGENT_REACH_TEMPLATES: readonly AgentReachSourceTemplate[] = AGENT_REACH_WATCH_TEMPLATES

/** 校验一条监控源是否符合白名单模板；合法返回 null，否则返回错误文案。 */
export function validateAgentReachSource(input: Pick<AgentReachWatchSource, 'channel' | 'action' | 'params'>): string | null {
  const template = AGENT_REACH_TEMPLATES.find((candidate) => candidate.channel === input.channel && candidate.action === input.action)
  if (!template) return `不支持的渠道动作：${input.channel}/${input.action}`
  const allowed = new Set([...template.requiredParams, ...template.optionalParams])
  for (const name of Object.keys(input.params)) {
    if (!allowed.has(name)) return `参数 ${name} 不属于 ${input.channel}/${input.action}`
  }
  for (const name of template.requiredParams) {
    const value = input.params[name]
    if (typeof value !== 'string' || !value.trim()) return `缺少必需参数：${name}`
  }
  for (const name of Object.keys(input.params)) {
    const value = input.params[name]
    if (typeof value === 'string') {
      if (value.length > 200) return `参数 ${name} 过长（最多 200 字符）`
    } else if (typeof value === 'number') {
      if (!Number.isInteger(value) || value < 1 || value > 50) return `参数 ${name} 必须是 1-50 的整数`
    }
  }
  return null
}

// ===== CLI 探测 =====

interface CliProbeState {
  binary: string | null
  probedAt: number
}

let cliProbe: CliProbeState | undefined

/** 探测间隔：失败或成功后 5 分钟内不重复探测。 */
const PROBE_CACHE_MS = 5 * 60 * 1000

/**
 * 解析 agent-reach 可执行文件。运行时初始化（shell-env.ts）已把用户
 * shell 的 PATH 合并进 process.env，uv tool install 的产物（~/.local/bin）
 * 可被覆盖；再查常见回退目录作为兜底。全部目录都查不到时返回 null
 * （采集层据此记 NEED_SETUP），不依赖 spawn 的 ENOENT 推断。
 */
export function resolveAgentReachBinary(now = Date.now()): string | null {
  if (cliProbe && now - cliProbe.probedAt < PROBE_CACHE_MS) return cliProbe.binary
  const { existsSync } = require('node:fs') as typeof import('node:fs')
  const { delimiter, join } = require('node:path') as typeof import('node:path')
  const home = process.env.HOME ?? ''
  const dirs = [
    `${home}/.local/bin`,
    `${home}/.cargo/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
  ]
  const binary = dirs.map((dir) => join(dir, 'agent-reach')).find((candidate) => existsSync(candidate)) ?? null
  cliProbe = { binary, probedAt: now }
  return binary
}

/** 仅测试用：重置探测缓存。 */
export function resetAgentReachProbe(): void {
  cliProbe = undefined
}

/** 仅测试用：直接写入探测结果（绕过文件系统查找）。 */
export function setAgentReachProbe(binary: string | null): void {
  cliProbe = { binary, probedAt: Date.now() }
}

// ===== 采集执行 =====

/** 单源默认超时；CLI 内部自带排队与节奏控制，外层超时只兜底。 */
export const AGENT_REACH_SOURCE_TIMEOUT_MS = 45_000

interface SpawnRunner {
  (argv: string[], timeoutMs: number): Promise<{ stdout: string; timedOut: boolean }>
}

let spawnRunner: SpawnRunner = defaultSpawnRunner

/** 仅测试用：替换 spawn 执行器（契约测试注入 mock envelope）。 */
export function setAgentReachSpawnRunner(runner: SpawnRunner | null): void {
  spawnRunner = runner ?? defaultSpawnRunner
}

function defaultSpawnRunner(argv: string[], timeoutMs: number): Promise<{ stdout: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const [command, ...args] = argv
    if (!command) {
      resolve({ stdout, timedOut: false })
      return
    }
    // 显式标注 ChildProcess：stdio 元组重载在某些 TS 版本下推断会塌成 never。
    const child: import('node:child_process').ChildProcess = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ stdout, timedOut: true })
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, timedOut: false })
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, timedOut: false })
    })
  })
}

/** 把模板 + 参数拼成 CLI 参数（不含程序名；必需参数按序位置传入，可选参数 --name 传入）。 */
export function buildAgentReachArgv(template: AgentReachSourceTemplate, params: Record<string, string | number>): string[] {
  const argv: string[] = [template.channel, template.action]
  for (const name of template.requiredParams) {
    const value = params[name]
    argv.push(String(value ?? ''))
  }
  for (const name of template.optionalParams) {
    const value = params[name]
    if (value !== undefined && value !== null && value !== '') argv.push(`--${name}`, String(value))
  }
  return argv
}

/** 解析一行 envelope JSON；结构非法视为 UPSTREAM_BROKEN，不带原文。 */
export function parseAgentReachEnvelope(raw: string): { envelope: AgentReachEnvelope } | { error: string } {
  const line = raw.split('\n').find((candidate) => candidate.trim())
  if (!line) return { error: 'CLI 无输出' }
  try {
    const parsed = JSON.parse(line) as AgentReachEnvelope
    if (typeof parsed !== 'object' || parsed === null) return { error: 'CLI 输出不是 JSON 对象' }
    return { envelope: parsed }
  } catch {
    return { error: 'CLI 输出不是合法 JSON' }
  }
}

/** 单条 envelope item → WatchSourceItem；缺 url 的条目丢弃（与去重逻辑一致）。 */
export function mapEnvelopeItem(item: AgentReachEnvelopeItem, origin: WatchSourceItem['origin']): WatchSourceItem | null {
  if (typeof item.url !== 'string' || !item.url) return null
  const text = typeof item.text === 'string' ? item.text : ''
  const publishedAt = typeof item.published_at === 'string' && Number.isNaN(Date.parse(item.published_at))
    ? undefined
    : item.published_at
  return {
    title: typeof item.title === 'string' && item.title ? item.title : item.url,
    url: item.url,
    snippet: text.slice(0, 500),
    ...(publishedAt ? { publishedAt } : {}),
    origin,
  }
}

/**
 * 采集一批监控源。单源失败只记错误，不抛出；CLI 未安装时全部源记
 * NEED_SETUP 并返回空 items（topics 搜索由调用方照常执行）。
 */
export async function collectAgentReachSources(
  sources: AgentReachWatchSource[],
  options: { timeoutPerSourceMs?: number } = {},
): Promise<AgentReachCollectResult> {
  const enabled = sources.filter((source) => source.enabled)
  const result: AgentReachCollectResult = { items: [], errors: [] }
  if (enabled.length === 0) return result

  const binary = resolveAgentReachBinary()
  if (!binary) {
    for (const source of enabled) {
      result.errors.push({ sourceId: source.id, channel: source.channel, code: 'NEED_SETUP', message: '未找到 agent-reach CLI，请先安装' })
    }
    return result
  }

  const timeoutMs = options.timeoutPerSourceMs ?? AGENT_REACH_SOURCE_TIMEOUT_MS
  for (const source of enabled) {
    const template = AGENT_REACH_TEMPLATES.find((candidate) => candidate.channel === source.channel && candidate.action === source.action)
    if (!template) {
      result.errors.push({ sourceId: source.id, channel: source.channel, code: 'BAD_INPUT', message: `不支持的渠道动作：${source.channel}/${source.action}` })
      continue
    }
    try {
      const argv = [binary, ...buildAgentReachArgv(template, source.params)]
      const { stdout, timedOut } = await spawnRunner(argv, timeoutMs)
      if (timedOut) {
        result.errors.push({ sourceId: source.id, channel: source.channel, code: 'TIMEOUT', message: `采集超时（${Math.round(timeoutMs / 1000)}s）` })
        continue
      }
      const parsed = parseAgentReachEnvelope(stdout)
      if ('error' in parsed) {
        result.errors.push({ sourceId: source.id, channel: source.channel, code: 'UPSTREAM_BROKEN', message: parsed.error })
        continue
      }
      const envelope = parsed.envelope
      const origin: WatchSourceItem['origin'] = { type: 'agent-reach', channel: source.channel, action: source.action, ...(envelope.backend ? { backend: envelope.backend } : {}) }
      if (envelope.ok) {
        for (const item of envelope.items ?? []) {
          const mapped = mapEnvelopeItem(item, origin)
          if (mapped) result.items.push(mapped)
        }
        continue
      }
      const code = typeof envelope.error?.code === 'string' && envelope.error.code ? envelope.error.code : 'UPSTREAM_BROKEN'
      const hint = typeof envelope.error?.hint === 'string' && envelope.error.hint ? `（${envelope.error.hint}）` : ''
      const message = typeof envelope.error?.message === 'string' ? envelope.error.message : '未知错误'
      result.errors.push({ sourceId: source.id, channel: source.channel, code, message: message + hint })
    } catch (error) {
      result.errors.push({ sourceId: source.id, channel: source.channel, code: 'UPSTREAM_BROKEN', message: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}
