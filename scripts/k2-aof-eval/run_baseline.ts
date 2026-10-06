/**
 * K2-01 对照基线：用 Gravitas packages/core 的显式 wikilink 图与
 * suggestLinks 相似度候选，对同一份样本计算与 AOF 路线的重合度。
 *
 * 只读样本快照；输出 baseline-metrics.json 到评测目录。
 *
 * 用法：bun scripts/k2-aof-eval/run_baseline.ts --manifest <path> --sample-dir <dir> --aof-metrics <metrics.json> --out <dir>
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { calculateSimilarity, suggestLinks } from '@gravitas/core/services/knowledge'

function main(): void {
  const args = process.argv.slice(2)
  const argOf = (f: string): string | undefined => {
    const i = args.indexOf(f)
    return i >= 0 ? args[i + 1] : undefined
  }
  const manifest = JSON.parse(readFileSync(argOf('--manifest')!, 'utf8'))
  const sampleDir = argOf('--sample-dir')!
  const aofMetrics = JSON.parse(readFileSync(argOf('--aof-metrics')!, 'utf8'))
  const out = argOf('--out')!

  const docs = manifest.files.map((f: { relativePath: string }) => {
    const content = readFileSync(join(sampleDir, f.relativePath), 'utf8')
    const links = [...content.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1]!.trim())
    const tags = [...content.matchAll(/(^|\s)#([\w\u4e00-\u9fff-]+)/g)].map((m) => m[2]!)
    return { id: f.relativePath, title: f.relativePath.replace(/\.md$/, ''), content, tags, links }
  })
  const byTitle = new Map(docs.map((d) => [d.title, d.id]))

  const suggestions = suggestLinks(
    docs.map((d) => ({ id: d.id, title: d.title, content: d.content, tags: d.tags, links: d.links })),
    50,
    5,
  )
  const sugTop = new Map<string, string[]>()
  for (const s of suggestions) {
    const list = sugTop.get(s.sourceId) ?? []
    if (list.length < 5) list.push(s.targetId)
    sugTop.set(s.sourceId, list)
  }

  const linkTop = new Map<string, string[]>()
  for (const d of docs) {
    const targets = d.links.map((l) => byTitle.get(l)).filter((x): x is string => Boolean(x) && x !== d.id)
    linkTop.set(d.id, [...new Set(targets)].slice(0, 5))
  }

  const jaccard = (a: string[], b: string[]): number => {
    const A = new Set(a), B = new Set(b)
    if (A.size === 0 && B.size === 0) return 1
    const inter = [...A].filter((x) => B.has(x)).length
    const union = new Set([...a, ...b]).size
    return union === 0 ? 0 : inter / union
  }

  const perDoc = docs.map((d) => {
    const aofRelated = (aofMetrics.queries as Array<{ doc: string; hits: number }>)
      .filter((q) => q.doc === d.id).length > 0 ? ['query-served'] : []
    return {
      doc: d.id,
      explicitLinks: (linkTop.get(d.id) ?? []).length,
      suggestLinks: (sugTop.get(d.id) ?? []).length,
      aofServed: aofRelated.length > 0,
    }
  })

  // 路线重合度：对每篇文档，显式链接 vs suggestLinks 的 Jaccard
  const overlaps = docs.map((d) => jaccard(linkTop.get(d.id) ?? [], sugTop.get(d.id) ?? []))
  const result = {
    docs: docs.length,
    explicitLinkTotal: [...linkTop.values()].reduce((s, x) => s + x.length, 0),
    suggestLinkTotal: [...sugTop.values()].reduce((s, x) => s + x.length, 0),
    meanJaccardExplicitVsSuggest: Number((overlaps.reduce((s, x) => s + x, 0) / overlaps.length).toFixed(3)),
    perDoc,
  }
  writeFileSync(join(out, 'baseline-metrics.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({
    docs: result.docs,
    explicitLinkTotal: result.explicitLinkTotal,
    suggestLinkTotal: result.suggestLinkTotal,
    meanJaccard: result.meanJaccardExplicitVsSuggest,
  }))
}

main()
