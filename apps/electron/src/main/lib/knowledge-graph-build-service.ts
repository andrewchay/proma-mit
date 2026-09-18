/**
 * K2-02：知识图谱构建服务（GraphBuild 状态机 + 持久化）。
 *
 * 职责：
 * - 以知识库当前索引文档为输入快照，调用 AOF adapter 构建+发布。
 * - GraphBuild 状态：building → published / failed；失败保留旧发布标 stale。
 * - 查询前校验：文档哈希或 scope 修订变化 → stale，旧图不得用于当前回答。
 * - 持久化：知识目录 graph-builds.json，版本化 + 修订号乐观并发。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KnowledgeAofAdapter, type AofDoc, type AofQueryHit } from './knowledge-aof-adapter'
import { writeJsonFileAtomic } from './safe-file'

export type GraphBuildState = 'idle' | 'building' | 'published' | 'stale' | 'failed' | 'recovery_required'

export interface GraphBuildRecord {
  knowledgeBaseId: string
  state: GraphBuildState
  releaseId?: string
  releaseDigest?: string
  /** 构建输入快照哈希（文档路径+sha256 列表） */
  inputSnapshotDigest?: string
  /** 构建时的 scope revision，用于撤权失效 */
  scopeRevisionAtBuild?: number
  builtAt?: number
  failedAt?: number
  error?: string
  /** AOF 本地角色标签为名义分离，非认证身份——UI 必须展示 */
  governanceNotice: 'local-role-labels'
}

export interface GraphBuildsFile {
  schemaVersion: 1
  revision: number
  builds: GraphBuildRecord[]
}

export interface KnowledgeDocSnapshot {
  relativePath: string
  sha256: string
  title: string
  links: string[]
}

/** 计算输入快照哈希：文档集合 (path, sha256) 的确定性摘要。 */
export function computeSnapshotDigest(docs: KnowledgeDocSnapshot[]): string {
  const canonical = docs
    .map((d) => `${d.relativePath}:${d.sha256}`)
    .sort()
    .join('\n')
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export class KnowledgeGraphBuildService {
  private readonly file: GraphBuildsFile
  private readonly inFlightBuilds = new Map<string, Promise<GraphBuildRecord>>()

  constructor(
    private readonly filePath: string,
    private readonly adapter: KnowledgeAofAdapter,
    /** 获取知识库当前文档快照（来自索引服务） */
    private readonly loadDocs: (knowledgeBaseId: string) => KnowledgeDocSnapshot[],
    /** 获取知识库当前 scope revision */
    private readonly loadScopeRevision: (knowledgeBaseId: string) => number,
  ) {
    this.file = this.load()
    this.closeInterruptedBuilds()
  }

  private load(): GraphBuildsFile {
    if (!existsSync(this.filePath)) {
      return { schemaVersion: 1, revision: 1, builds: [] }
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as GraphBuildsFile
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.builds)) {
        throw new Error(`未知 schemaVersion: ${String((parsed as { schemaVersion?: number }).schemaVersion)}`)
      }
      return parsed
    } catch (err) {
      // 失败关闭：损坏文件不静默重建
      throw new Error(`graph-builds.json 损坏， refusing to auto-rebuild: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private save(): void {
    const previousRevision = this.file.revision
    this.file.revision = previousRevision + 1
    try {
      writeJsonFileAtomic(this.filePath, this.file)
    } catch (err) {
      this.file.revision = previousRevision
      throw err
    }
  }

  /**
   * building 只代表上一个进程持有的本地 operation。进程重启后 owner 已丢失，
   * 因此必须失败关闭并等待用户显式重建，绝不能根据持久化状态盲目重放 AOF。
   */
  private closeInterruptedBuilds(): void {
    const interrupted = this.file.builds.filter((record) => record.state === 'building')
    if (interrupted.length === 0) return

    const failedAt = Date.now()
    for (const record of interrupted) {
      record.state = 'recovery_required'
      record.failedAt = failedAt
      record.error = '检测到应用重启前未完成的构建；已失败关闭，请显式重新构建'
    }
    this.save()
  }

  getBuild(knowledgeBaseId: string): GraphBuildRecord | undefined {
    return this.file.builds.find((b) => b.knowledgeBaseId === knowledgeBaseId)
  }

  /** 是否可查询：published 且输入快照与 scope revision 均未变化。 */
  isQueryable(knowledgeBaseId: string): boolean {
    const record = this.getBuild(knowledgeBaseId)
    if (!record || record.state !== 'published') return false
    const docs = this.loadDocs(knowledgeBaseId)
    if (record.inputSnapshotDigest !== computeSnapshotDigest(docs)) return false
    if (record.scopeRevisionAtBuild !== this.loadScopeRevision(knowledgeBaseId)) return false
    return true
  }

  /**
   * 触发构建。同一知识库同一时刻只有一个本地 owner；并发调用复用该 operation，
   * 不会重复调用 adapter。不同知识库仍可并行构建。
   */
  build(knowledgeBaseId: string): Promise<GraphBuildRecord> {
    const existingOperation = this.inFlightBuilds.get(knowledgeBaseId)
    if (existingOperation) return existingOperation

    const operation = this.performBuild(knowledgeBaseId).finally(() => {
      if (this.inFlightBuilds.get(knowledgeBaseId) === operation) {
        this.inFlightBuilds.delete(knowledgeBaseId)
      }
    })
    this.inFlightBuilds.set(knowledgeBaseId, operation)
    return operation
  }

  /** 幂等：同快照 + 已发布 + scope 未变 → 跳过。 */
  private async performBuild(knowledgeBaseId: string): Promise<GraphBuildRecord> {
    const docs = this.loadDocs(knowledgeBaseId)
    if (docs.length === 0) throw new Error('知识库没有可构建的文档（请先建立索引）')
    const snapshotDigest = computeSnapshotDigest(docs)
    const scopeRev = this.loadScopeRevision(knowledgeBaseId)
    const existing = this.getBuild(knowledgeBaseId)
    if (existing?.state === 'published' && existing.inputSnapshotDigest === snapshotDigest && existing.scopeRevisionAtBuild === scopeRev) {
      return existing
    }

    const record: GraphBuildRecord = existing ?? {
      knowledgeBaseId,
      state: 'idle',
      governanceNotice: 'local-role-labels',
    }
    record.state = 'building'
    delete record.error
    if (!this.file.builds.includes(record)) this.file.builds.push(record)
    this.save()

    const aofDocs: AofDoc[] = docs.map((d) => ({
      relative_path: d.relativePath,
      title: d.title,
      content: '', // 构建只需要路径/标题/哈希/链接，不传输笔记正文
      sha256: d.sha256,
      links: d.links,
    }))
    try {
      const result = await this.adapter.buildAndPublish(knowledgeBaseId, aofDocs)
      record.state = 'published'
      record.releaseId = result.release_id
      record.releaseDigest = result.release_digest
      record.inputSnapshotDigest = snapshotDigest
      record.scopeRevisionAtBuild = scopeRev
      record.builtAt = Date.now()
      this.save()
      return record
    } catch (err) {
      // 失败保留旧发布：state 标 stale（有旧 digest）或 failed（无）
      if (record.releaseDigest && record.inputSnapshotDigest) {
        record.state = 'stale'
      } else {
        record.state = 'failed'
      }
      record.failedAt = Date.now()
      record.error = err instanceof Error ? err.message : String(err)
      this.save()
      throw err
    }
  }

  /** release-pinned 语义查询；不可查询时拒绝（不回退旧图）。 */
  async query(knowledgeBaseId: string, query: string, limit = 5): Promise<AofQueryHit[]> {
    if (!this.isQueryable(knowledgeBaseId)) {
      throw new Error('图谱不可查询：未发布、已过期或范围已变化，请先重新构建')
    }
    const record = this.getBuild(knowledgeBaseId)!
    return this.adapter.semanticQuery(query, { limit, expectedReleaseDigest: record.releaseDigest })
  }
}

export type { AofQueryHit } from './knowledge-aof-adapter'
// ---------------------------------------------------------------------------
// 主进程组装工厂：从索引服务/目录服务/adapter 组装可用实例。
// AOF 环境缺失时返回 null（失败关闭语义路径，基础检索不受影响）。
// ---------------------------------------------------------------------------

import { openKnowledgeIndexStore } from './knowledge-index-service'
import { getKnowledgeDir } from './config-paths'
import { readCatalog } from './knowledge-catalog-service'
import { listKnowledgeNotes } from './knowledge-service'

/** 异步组装：先打开索引库，再用同步快照读取器构造服务。 */
export async function createKnowledgeGraphBuildService(): Promise<KnowledgeGraphBuildService | null> {
  const aofRoot = join(process.env.HOME ?? '', 'LLM', 'AOF')
  const adapter = new KnowledgeAofAdapter({ aofRoot, stateDir: join(getKnowledgeDir(), 'aof-state') })
  if (adapter.disabled) return null

  await openKnowledgeIndexStore()
  const { getStoreHandle } = await import('./knowledge-index-service')
  const store = getStoreHandle()
  if (!store) return null

  const catalogCache = { revision: 0, at: 0 }
  const scopeRevision = (): number => {
    // 目录修订读取有 1s 缓存；精确性由 build/query 前的 stale 校验兜底
    if (Date.now() - catalogCache.at > 1_000) {
      try {
        catalogCache.revision = readCatalog().revision.revision
        catalogCache.at = Date.now()
      } catch { catalogCache.revision = catalogCache.revision || 0 }
    }
    return catalogCache.revision
  }

  return new KnowledgeGraphBuildService(
    join(getKnowledgeDir(), 'graph-builds.json'),
    adapter,
    (kbId) => {
      const docs = store.knowledge.listDocuments([kbId])
      // wikilinks 从知识服务笔记中按相对路径 best-effort 匹配
      let notesByPath: Map<string, string[]> | null = null
      try {
        notesByPath = new Map(listKnowledgeNotes().map((n) => [n.filePath.split('/').pop() ?? '', n.links]))
      } catch { notesByPath = null }
      return docs.map((d) => ({
        relativePath: d.relativePath,
        sha256: d.contentHash,
        title: d.title,
        links: notesByPath?.get(d.relativePath.split('/').pop() ?? '') ?? [],
      }))
    },
    scopeRevision,
  )
}
