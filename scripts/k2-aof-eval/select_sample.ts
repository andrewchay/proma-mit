/**
 * K2-01 AOF 对照小样验证——样本选择脚本（只读 Vault，输出临时快照）。
 *
 * 用法：
 *   bun scripts/k2-aof-eval/select_sample.ts [--vault <path>] [--count 30] [--out <dir>]
 *
 * 规则：
 * - 只读取与复制（快照），绝不写入/移动/重命名 Vault 内任何文件。
 * - 排除清单：Archive、Apple Notes 同步、附件、.obsidian、AOF-review，
 *   以及文件名含敏感关键词（密码/secret/key/账单/token/credential）的文件。
 * - 采样确定性：按 (目录分层 + sha256) 排序取前 N 篇，可复现。
 * - 输出 sample-manifest.json：相对路径、size、mtime、sha256。
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const DEFAULT_VAULT = '/Users/chaihao/Library/Mobile Documents/iCloud~md~obsidian/Documents/andrewchay'

const EXCLUDED_DIRS = new Set([
  '99 - Archive',
  'Apple Notes',
  'Attachments',
  '.obsidian',
  'AOF-review',
  '.trash',
  '.git',
])

const SENSITIVE_NAME_PATTERNS = [/密码/i, /secret/i, /api[_-]?key/i, /token/i, /credential/i, /账单/, /\.env/i]

function walkMdFiles(root: string, dir: string = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      out.push(...walkMdFiles(root, join(dir, entry.name)))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      if (SENSITIVE_NAME_PATTERNS.some((p) => p.test(entry.name))) continue
      out.push(join(dir, entry.name))
    }
  }
  return out
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function main(): void {
  const args = process.argv.slice(2)
  const argOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const vault = argOf('--vault') ?? DEFAULT_VAULT
  const count = Number(argOf('--count') ?? 30)
  const outDir = argOf('--out') ?? join(process.env.TMPDIR ?? '/tmp', 'k2-aof-eval', 'sample')

  if (!existsSync(vault)) throw new Error(`Vault 不存在: ${vault}`)

  const files = walkMdFiles(vault)
  // 确定性排序：目录深度 → 路径 sha256，均匀覆盖各目录且可复现
  const ranked = files
    .map((p) => ({
      path: p,
      depth: relative(vault, p).split(sep).length,
      hash: sha256(Buffer.from(relative(vault, p))),
    }))
    .sort((a, b) => a.depth - b.depth || (a.hash < b.hash ? -1 : 1))
    .slice(0, count)

  mkdirSync(outDir, { recursive: true })
  const manifest = ranked.map(({ path }) => {
    const buf = readFileSync(path)
    const rel = relative(vault, path)
    cpSync(path, join(outDir, rel), { recursive: true })
    const st = statSync(path)
    return {
      relativePath: rel,
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      sha256: sha256(buf),
    }
  })

  writeFileSync(
    join(outDir, '..', 'sample-manifest.json'),
    JSON.stringify({ vault, count: manifest.length, generatedAt: new Date().toISOString(), files: manifest }, null, 2),
  )
  console.log(`采样 ${manifest.length} 篇 → ${outDir}`)
  console.log(`manifest → ${join(outDir, '..', 'sample-manifest.json')}`)
}

main()
