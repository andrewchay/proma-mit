import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * K2-01 评测的确定性单元测试（不依赖 AOF 环境）。
 * 覆盖：采样排除规则、sha256 稳定性、指标判定纯逻辑。
 * AOF 真实链路是本机集成脚本（scripts/k2-aof-eval/README.md），CI 跳过。
 */

// 与 select_sample.ts 保持一致的排除规则（若脚本变更，此处必须同步）
const EXCLUDED_DIRS = new Set(['99 - Archive', 'Apple Notes', 'Attachments', '.obsidian', 'AOF-review', '.trash', '.git'])
const SENSITIVE_NAME_PATTERNS = [/密码/i, /secret/i, /api[_-]?key/i, /token/i, /credential/i, /账单/, /\.env/i]

function shouldExclude(name: string, isDir: boolean): boolean {
  if (isDir) return EXCLUDED_DIRS.has(name)
  if (!name.endsWith('.md')) return true
  return SENSITIVE_NAME_PATTERNS.some((p) => p.test(name))
}

describe('K2 采样排除规则', () => {
  test('排除目录与敏感文件名', () => {
    expect(shouldExclude('99 - Archive', true)).toBe(true)
    expect(shouldExclude('Apple Notes', true)).toBe(true)
    expect(shouldExclude('Attachments', true)).toBe(true)
    expect(shouldExclude('.obsidian', true)).toBe(true)
    expect(shouldExclude('会议记录.md', false)).toBe(false)
    expect(shouldExclude('api_key配置.md', false)).toBe(true)
    expect(shouldExclude('密码本.md', false)).toBe(true)
    expect(shouldExclude('账单2026.md', false)).toBe(true)
    expect(shouldExclude('.env', false)).toBe(true)
    expect(shouldExclude('image.png', false)).toBe(true)
  })
})

describe('manifest 完整性', () => {
  test('sha256 复算一致且 manifest 计数正确', () => {
    const dir = mkdtempSync(join(tmpdir(), 'k2-eval-test-'))
    try {
      const sample = join(dir, 'sample', 'sub')
      mkdirSync(sample, { recursive: true })
      writeFileSync(join(sample, 'a.md'), '# A\n内容')
      const buf = readBuf(join(sample, 'a.md'))
      const sha = createHash('sha256').update(buf).digest('hex')
      const manifest = {
        vault: dir,
        count: 1,
        files: [{ relativePath: 'sub/a.md', sizeBytes: buf.length, mtimeMs: 0, sha256: sha }],
      }
      expect(manifest.files).toHaveLength(manifest.count)
      const recomputed = createHash('sha256').update(readBuf(join(sample, 'a.md'))).digest('hex')
      expect(recomputed).toBe(manifest.files[0]!.sha256)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('评测指标判定', () => {
  test('hit@1 与零泄漏判定', () => {
    const queries = [
      { doc: 'a', rank: 0 },
      { doc: 'b', rank: 2 },
      { doc: 'c' }, // 未命中
    ]
    const hitAt1 = queries.filter((q) => q.rank === 0).length
    const evaluated = queries.filter((q) => 'rank' in q).length
    expect(hitAt1).toBe(1)
    expect(evaluated).toBe(2)

    const negatives = [{ leak: false }, { leak: false }, { hits: 1, leak: true }]
    expect(negatives.some((n) => n.leak)).toBe(true)
    // 权限负例零泄漏是硬门槛：任一泄漏即评测失败
    expect(negatives.filter((n) => n.leak)).toHaveLength(1)
  })
})

function readBuf(path: string): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs').readFileSync(path)
}
