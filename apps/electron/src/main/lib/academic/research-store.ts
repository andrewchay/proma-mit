/**
 * 研究项目事件存储（M1，方案 v1 §10）
 *
 * 设计约束（对应 docs/storage-contract.md 的本地优先原则）：
 *
 * 1. events.jsonl 是权威记录：已提交的事件只追加、不修改；
 *    snapshot.json 只是加速读取的派生物，可随时从事件重建。
 * 2. commandId 幂等：同一 commandId 的重复投递被拒绝，外部回调
 *    重试不会产生双份状态变更。
 * 3. revision 单调递增；追加时可带 expectedRevision 做乐观并发检查。
 * 4. 文件损坏时保留原件并拒绝读写——绝不把用户研究当空库覆盖。
 * 5. MVP 仅允许一个权威写进程（Electron 主进程）；不做跨进程锁，
 *    多实例并发写不在本层承诺范围内。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  RESEARCH_ERROR_CODES,
  ResearchError,
  type ResearchEventEnvelope,
  type ResearchEventPayload,
  type ResearchProject,
} from '@gravitas/shared'
import { getAcademicDir } from '../config-paths'

/** 快照间隔：每 N 个事件落一次快照，减少重放开销 */
const SNAPSHOT_INTERVAL = 50

export interface ResearchProjectState {
  project: ResearchProject | null
  /** 已应用的最高事件 revision；无事件为 0 */
  revision: number
}

interface AppendInput {
  commandId: string
  /** 乐观并发检查：调用方读到的 revision；缺省跳过检查 */
  expectedRevision?: number
  payload: ResearchEventPayload
}

/** 研究项目数据目录：<configDir>/academic/research/<researchId>/ */
export function getResearchDir(researchId: string): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(researchId)) {
    throw new ResearchError(RESEARCH_ERROR_CODES.INVALID_INPUT, `非法研究项目 ID: ${researchId}`)
  }
  const dir = join(getAcademicDir(), 'research', researchId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function eventsPath(researchId: string): string {
  return join(getResearchDir(researchId), 'events.jsonl')
}

function snapshotPath(researchId: string): string {
  return join(getResearchDir(researchId), 'snapshot.json')
}

interface ParsedEnvelope extends ResearchEventEnvelope {
  /** 解析失败标记：保留行内容，由调用方决定报错 */
  malformed?: false
}

/** 解析事件文件；任何一行损坏都整体拒绝（不静默跳过中间损坏） */
function readEnvelopes(researchId: string): ParsedEnvelope[] {
  const path = eventsPath(researchId)
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf-8')
  if (!raw.trim()) return []

  const envelopes: ParsedEnvelope[] = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    try {
      envelopes.push(JSON.parse(line) as ParsedEnvelope)
    } catch (err) {
      throw new ResearchError(
        RESEARCH_ERROR_CODES.STORE_CORRUPTED,
        `研究事件文件损坏（第 ${i + 1} 行），已保留原文件：${path}`,
        { cause: err },
      )
    }
  }
  return envelopes
}

/** 从事件序列重放项目状态 */
function replay(envelopes: ParsedEnvelope[]): ResearchProjectState {
  let project: ResearchProject | null = null
  let revision = 0

  for (const envelope of envelopes) {
    revision = envelope.revision
    const payload = envelope.payload
    if (payload.type === 'project_created') {
      project = payload.project
    } else if (payload.type === 'brief_updated' && project) {
      project.brief = payload.brief
      project.updatedAt = envelope.at
    } else if (payload.type === 'status_changed' && project) {
      project.status = payload.to
      project.updatedAt = envelope.at
    } else if (payload.type === 'project_archived' && project) {
      project.status = 'archived'
      project.updatedAt = envelope.at
    }
    if (project) project.revision = revision
  }

  return { project, revision }
}

/** 读取项目当前状态：优先快照，回放增量事件 */
export async function loadProjectState(researchId: string): Promise<ResearchProjectState> {
  const snapPath = snapshotPath(researchId)
  if (!existsSync(eventsPath(researchId))) {
    return { project: null, revision: 0 }
  }

  const envelopes = readEnvelopes(researchId)
  if (envelopes.length === 0) return { project: null, revision: 0 }

  // 快照有效性：revision 不超过事件流，且快照文件未损坏
  let base = { project: null as ResearchProject | null, revision: 0 }
  if (existsSync(snapPath)) {
    try {
      const snap = JSON.parse(readFileSync(snapPath, 'utf-8')) as ResearchProjectState
      if (snap.revision <= envelopes[envelopes.length - 1]!.revision) {
        base = { project: snap.project, revision: snap.revision }
      }
    } catch {
      // 快照损坏不算数据损坏：丢弃快照，从事件全量重建
      console.warn(`[研究存储] 快照损坏，从事件重建: ${researchId}`)
    }
  }

  const applicable = envelopes.filter((e) => e.revision > base.revision)
  const state = replay(applicable)
  const project = base.project
    ? replayOnProject(base.project, applicable, base.revision)
    : state.project

  return { project, revision: envelopes[envelopes.length - 1]!.revision }
}

/** 在已有快照项目上继续重放 */
function replayOnProject(
  project: ResearchProject,
  envelopes: ParsedEnvelope[],
  fromRevision: number,
): ResearchProject {
  const { project: rebuilt } = replay(envelopes.filter((e) => e.revision > fromRevision))
  // 快照 base 必须是同一项目；若事件流开头不是 created（不可能，但防御），以重放为准
  return rebuilt ?? project
}

/**
 * 追加一条事件（同一业务事务一个信封）。
 *
 * 幂等：commandId 已存在时抛 DUPLICATE_COMMAND。
 * 并发：expectedRevision 不匹配当前 revision 时抛 REVISION_CONFLICT。
 */
export async function appendEvent(researchId: string, input: AppendInput): Promise<ResearchEventEnvelope> {
  const envelopes = readEnvelopes(researchId)

  if (envelopes.some((e) => e.commandId === input.commandId)) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.DUPLICATE_COMMAND,
      `重复的 commandId: ${input.commandId}（外部回调应按 commandId 去重）`,
    )
  }

  const currentRevision = envelopes.length > 0 ? envelopes[envelopes.length - 1]!.revision : 0
  if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.REVISION_CONFLICT,
      `revision 冲突：期望 ${input.expectedRevision}，当前 ${currentRevision}`,
    )
  }

  const envelope: ResearchEventEnvelope = {
    revision: currentRevision + 1,
    commandId: input.commandId,
    at: new Date().toISOString(),
    payload: input.payload,
  }

  // 追加到内存后原子写盘：写临时文件再 rename，避免半截事件
  const allEnvelopes = [...envelopes, envelope]
  const tmpPath = `${eventsPath(researchId)}.${randomUUID().slice(0, 8)}.tmp`
  const serialized = allEnvelopes.map((e) => JSON.stringify(e)).join('\n') + '\n'
  writeFileSync(tmpPath, serialized, 'utf-8')
  renameSync(tmpPath, eventsPath(researchId))

  // 定期落快照（快照失败不影响事件权威性）
  if (allEnvelopes.length % SNAPSHOT_INTERVAL === 0) {
    try {
      const state = replay(allEnvelopes)
      writeFileSync(snapshotPath(researchId), JSON.stringify(state, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[研究存储] 快照写入失败（事件已安全落盘）:', err)
    }
  }

  return envelope
}

/** 列出本机所有研究项目 ID（扫描 research/ 目录下有 events.jsonl 的目录） */
export async function listResearchProjectIds(): Promise<string[]> {
  const root = join(getAcademicDir(), 'research')
  if (!existsSync(root)) return []

  const { readdirSync, statSync } = await import('node:fs')
  return readdirSync(root)
    .filter((name) => {
      const dir = join(root, name)
      return statSync(dir).isDirectory() && existsSync(join(dir, 'events.jsonl'))
    })
    .sort()
}
