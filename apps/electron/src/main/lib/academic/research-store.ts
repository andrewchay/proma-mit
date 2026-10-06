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

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
/** 读取事件的结果：除事件外附带恢复告警 */
export interface ReadEnvelopesResult {
  envelopes: ParsedEnvelope[]
  /** 恢复期产生的告警（如被丢弃的半写尾行） */
  warnings: string[]
}

/**
 * 解析事件文件。
 *
 * 恢复语义（方案 §10.2）：
 * - **末行无换行且解析失败** = 上次写入被中断（半写尾巴）：丢弃该行、
 *   保留原文件、给出告警，而不是让整个项目打不开。
 * - **中间行或已换行结尾的行损坏** = 真实损坏：整体拒绝并保留原文件，
 *   不静默跳过（否则会丢掉中间的历史事件）。
 */
function readEnvelopesWithWarnings(researchId: string): ReadEnvelopesResult {
  const path = eventsPath(researchId)
  if (!existsSync(path)) return { envelopes: [], warnings: [] }
  const raw = readFileSync(path, 'utf-8')
  if (!raw.trim()) return { envelopes: [], warnings: [] }

  const warnings: string[] = []
  const envelopes: ParsedEnvelope[] = []
  const lines = raw.split('\n')
  const fileEndsWithNewline = raw.endsWith('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    try {
      envelopes.push(JSON.parse(line) as ParsedEnvelope)
    } catch (err) {
      // 恢复的判定需要**两个信号同时成立**：
      //   1) 是最后一个非空行（中断总发生在末尾）
      //   2) 文件没有以换行结尾（半写行的特征）
      // 只有 (1) 会把「完整但损坏的尾行」误判为中断；只有 (2) 会把
      // 「中间行损坏且文件末尾恰好无换行」误判为中断。
      if (isLastNonEmptyLine(lines, i) && !fileEndsWithNewline) {
        warnings.push(
          `检测到未完成的写入（第 ${i + 1} 行）已忽略；原文件未修改：${path}`,
        )
        continue
      }
      throw new ResearchError(
        RESEARCH_ERROR_CODES.STORE_CORRUPTED,
        `研究事件文件损坏（第 ${i + 1} 行），已保留原文件：${path}`,
        { cause: err },
      )
    }
  }

  return { envelopes, warnings }
}

/**
 * 事件流索引缓存（M7 性能修复）。
 *
 * 旧实现每次追加都「读全文件 → 改 → 重写全文件」，5,000 条来源 +
 * 50,000 条证据时呈 O(n²)：实测 4,000 条追加需 20s，56,000 条无法完成
 * （见 scripts/academic-perf-smoke.ts）。
 *
 * 现在：文件大小与 mtime 未变时复用内存索引，追加走真正的 append。
 * 外部改动（其他进程/手工编辑）会让 stat 变化从而触发全量重建，
 * 因此不会读到过期的 revision 或漏掉 commandId。
 */
interface StreamIndex {
  sizeBytes: number
  mtimeMs: number
  revision: number
  count: number
  commandIds: Set<string>
}

const streamIndexCache = new Map<string, StreamIndex>()

function statOrNull(path: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(path)
    return { size: st.size, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

/**
 * 截掉文件末尾未完成的一行（无换行结尾的半写内容）。
 *
 * 只在追加路径调用：那里「无换行结尾」已由恢复语义确认为中断写入。
 */
function truncateIncompleteTail(path: string): void {
  const raw = readFileSync(path, 'utf-8')
  const lastNewline = raw.lastIndexOf('\n')
  const kept = lastNewline === -1 ? '' : raw.slice(0, lastNewline + 1)
  writeFileSync(path, kept, 'utf-8')
  // 文件内容变了：索引必须重建
  streamIndexCache.delete(pathKeyOf(path))
}

/** 从事件文件路径反推 researchId（缓存键一致性用） */
function pathKeyOf(path: string): string {
  for (const [id] of streamIndexCache) {
    if (eventsPath(id) === path) return id
  }
  return path
}

/** 该行之后是否还有非空行（即它是否为最后一个非空行） */
function isLastNonEmptyLine(lines: string[], index: number): boolean {
  for (let j = index + 1; j < lines.length; j++) {
    if (lines[j]!.trim()) return false
  }
  return true
}

/** 文件末尾是否为换行（空文件视为是）。读最后一个字节，开销可忽略。 */
function endsWithNewline(path: string): boolean {
  const stat = statOrNull(path)
  if (!stat || stat.size === 0) return true
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(1)
    readSync(fd, buf, 0, 1, stat.size - 1)
    return buf.toString('utf8') === '\n'
  } finally {
    closeSync(fd)
  }
}

/** 取索引：命中直接返回，未命中则全量解析并建索引 */
function getStreamIndex(researchId: string): StreamIndex {
  const path = eventsPath(researchId)
  const stat = statOrNull(path)
  const cached = streamIndexCache.get(researchId)

  if (cached && stat && cached.sizeBytes === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached
  }

  const { envelopes } = readEnvelopesWithWarnings(researchId)
  const index: StreamIndex = {
    sizeBytes: stat?.size ?? 0,
    mtimeMs: stat?.mtimeMs ?? 0,
    revision: envelopes.length > 0 ? envelopes[envelopes.length - 1]!.revision : 0,
    count: envelopes.length,
    commandIds: new Set(envelopes.map((e) => e.commandId)),
  }
  streamIndexCache.set(researchId, index)
  return index
}

/** 兼容旧调用：只取事件（告警通过 console 提示） */
function readEnvelopes(researchId: string): ParsedEnvelope[] {
  const { envelopes, warnings } = readEnvelopesWithWarnings(researchId)
  for (const w of warnings) console.warn(`[研究存储] ${w}`)
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
  const path = eventsPath(researchId)
  const index = getStreamIndex(researchId)

  if (index.commandIds.has(input.commandId)) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.DUPLICATE_COMMAND,
      `重复的 commandId: ${input.commandId}（外部回调应按 commandId 去重）`,
    )
  }

  if (input.expectedRevision !== undefined && input.expectedRevision !== index.revision) {
    throw new ResearchError(
      RESEARCH_ERROR_CODES.REVISION_CONFLICT,
      `revision 冲突：期望 ${input.expectedRevision}，当前 ${index.revision}`,
    )
  }

  const envelope: ResearchEventEnvelope = {
    revision: index.revision + 1,
    commandId: input.commandId,
    at: new Date().toISOString(),
    payload: input.payload,
  }

  // 真追加：单行写盘。
  // 若上次写入中断留下了无换行结尾的半写行，先**截掉**它再追加——
  // 补换行只会把半写行变成一条完整的坏行，反而更像真实损坏。
  if (!endsWithNewline(path)) {
    truncateIncompleteTail(path)
  }
  appendFileSync(path, JSON.stringify(envelope) + '\n', 'utf-8')

  // 更新索引（stat 变化后下次会重建，这里只是即时推进）
  const stat = statOrNull(path)
  streamIndexCache.set(researchId, {
    sizeBytes: stat?.size ?? index.sizeBytes,
    mtimeMs: stat?.mtimeMs ?? index.mtimeMs,
    revision: envelope.revision,
    count: index.count + 1,
    commandIds: new Set(index.commandIds).add(input.commandId),
  })

  // 定期落快照（快照失败不影响事件权威性）
  if ((index.count + 1) % SNAPSHOT_INTERVAL === 0) {
    try {
      const { envelopes } = readEnvelopesWithWarnings(researchId)
      writeFileSync(snapshotPath(researchId), JSON.stringify(replay(envelopes), null, 2), 'utf-8')
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

/** 读取项目的完整事件流（服务层用于按事件类型聚合视图数据） */
export async function readProjectEvents(researchId: string): Promise<ResearchEventEnvelope[]> {
  return readEnvelopes(researchId)
}

/**
 * 读取事件流并返回恢复告警（M7：供诊断界面/发布检查使用）。
 *
 * 调用方可据此提示「上次有未完成的写入已被忽略」，而不是默默修好。
 */
export async function readProjectEventsWithWarnings(
  researchId: string,
): Promise<ReadEnvelopesResult> {
  return readEnvelopesWithWarnings(researchId)
}
