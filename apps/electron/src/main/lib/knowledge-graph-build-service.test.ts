import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  computeSnapshotDigest,
  KnowledgeGraphBuildService,
  type GraphBuildRecord,
  type KnowledgeDocSnapshot,
} from './knowledge-graph-build-service'
import type { AofDoc, KnowledgeAofAdapter } from './knowledge-aof-adapter'

/** 行为可控的假 adapter：不 spawn Python。 */
class FakeAdapter {
  calls: Array<{ kbId: string; docs: AofDoc[] }> = []
  queries: Array<{ query: string; opts: { limit?: number; expectedReleaseDigest?: string } }> = []
  failBuild = false
  releasedigest = 'sha256:fake-digest'

  async buildAndPublish(kbId: string, docs: AofDoc[]): Promise<{ ok: true; release_id: string; release_digest: string; ledger: Record<string, unknown> }> {
    this.calls.push({ kbId, docs })
    if (this.failBuild) throw new Error('AOF 构建失败: IngestFailed 模拟')
    return { ok: true, release_id: `kb-test@1`, release_digest: this.releasedigest, ledger: {} }
  }

  async semanticQuery(query: string, opts: { limit?: number; expectedReleaseDigest?: string } = {}): Promise<Array<{ resource_id: string; name: string; kind: string }>> {
    this.queries.push({ query, opts })
    if (opts.expectedReleaseDigest !== this.releasedigest) throw new Error('AOF 查询失败: digest 不匹配')
    return [{ resource_id: 'aof://gravitas/knowledge/concept/doc-1', name: '甲', kind: 'Concept' }]
  }
}

function makeService(docs: KnowledgeDocSnapshot[], scopeRev: number, adapter: FakeAdapter): {
  service: KnowledgeGraphBuildService
  file: string
  setDocs: (d: KnowledgeDocSnapshot[]) => void
  setScopeRev: (n: number) => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'kgb-test-'))
  const file = join(dir, 'graph-builds.json')
  let currentDocs = docs
  let currentRev = scopeRev
  const service = new KnowledgeGraphBuildService(
    file,
    adapter as unknown as KnowledgeAofAdapter,
    () => currentDocs,
    () => currentRev,
  )
  return {
    service,
    file,
    setDocs: (d) => { currentDocs = d },
    setScopeRev: (n) => { currentRev = n },
  }
}

const DOCS: KnowledgeDocSnapshot[] = [
  { relativePath: 'a.md', sha256: 'h1', title: '甲', links: ['乙'] },
  { relativePath: 'b.md', sha256: 'h2', title: '乙', links: [] },
]

describe('快照哈希', () => {
  test('顺序无关、内容敏感', () => {
    const a = computeSnapshotDigest(DOCS)
    const b = computeSnapshotDigest([...DOCS].reverse())
    const c = computeSnapshotDigest([DOCS[0]!, { ...DOCS[1]!, sha256: 'changed' }])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('GraphBuild 状态机', () => {
  test('构建成功 → published → 可查询', async () => {
    const adapter = new FakeAdapter()
    const { service } = makeService(DOCS, 1, adapter)
    const record = await service.build('kb1')
    expect(record.state).toBe('published')
    expect(service.isQueryable('kb1')).toBe(true)
    const hits = await service.query('kb1', '甲')
    expect(hits).toHaveLength(1)
    // release-pinning：查询携带构建时的 digest
    expect(adapter.queries[0]!.opts.expectedReleaseDigest).toBe('sha256:fake-digest')
  })

  test('同快照重复构建幂等跳过', async () => {
    const adapter = new FakeAdapter()
    const { service } = makeService(DOCS, 1, adapter)
    await service.build('kb1')
    await service.build('kb1')
    expect(adapter.calls).toHaveLength(1)
  })

  test('文档变化 → stale，旧图不可查询，重建后恢复', async () => {
    const adapter = new FakeAdapter()
    const { service, setDocs } = makeService(DOCS, 1, adapter)
    await service.build('kb1')
    setDocs([{ ...DOCS[0]!, sha256: 'h1-new' }, DOCS[1]!])
    expect(service.isQueryable('kb1')).toBe(false)
    await service.build('kb1')
    expect(service.isQueryable('kb1')).toBe(true)
    expect(adapter.calls).toHaveLength(2)
  })

  test('scope 修订变化 → 不可查询', async () => {
    const adapter = new FakeAdapter()
    const { service, setScopeRev } = makeService(DOCS, 1, adapter)
    await service.build('kb1')
    setScopeRev(2)
    expect(service.isQueryable('kb1')).toBe(false)
  })

  test('构建失败：无旧发布 → failed；有旧发布 → stale 且旧记录保留', async () => {
    const adapter = new FakeAdapter()
    const { service, setDocs } = makeService(DOCS, 1, adapter)
    await service.build('kb1')
    adapter.failBuild = true
    setDocs([{ ...DOCS[0]!, sha256: 'h1-new' }, DOCS[1]!])
    await expect(service.build('kb1')).rejects.toThrow('AOF 构建失败')
    const record = service.getBuild('kb1') as GraphBuildRecord
    expect(record.state).toBe('stale') // 保留旧发布但标记过期
    expect(record.releaseDigest).toBe('sha256:fake-digest')
    expect(service.isQueryable('kb1')).toBe(false)
  })

  test('空知识库拒绝构建', async () => {
    const adapter = new FakeAdapter()
    const { service } = makeService([], 1, adapter)
    await expect(service.build('kb-empty')).rejects.toThrow('没有可构建的文档')
  })
})

describe('损坏文件失败关闭', () => {
  test('graph-builds.json 损坏时不静默重建', () => {
    const adapter = new FakeAdapter()
    const dir = mkdtempSync(join(tmpdir(), 'kgb-test-'))
    try {
      const file = join(dir, 'graph-builds.json')
      require('node:fs').writeFileSync(file, '{broken json')
      expect(() => new KnowledgeGraphBuildService(file, adapter as unknown as KnowledgeAofAdapter, () => [], () => 1)).toThrow('损坏')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
