import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPinnedBaselineVerifier, parseJUnitTotals, type PinnedVerifierConfig } from './pinned-baseline-verifier'

const root = mkdtempSync(join(tmpdir(), 'gravitas-pinned-verifier-'))
const bun = process.execPath
afterAll(() => rmSync(root, { recursive: true, force: true }))

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'f@x' } }).trim()
}
function makeRepo(name: string, tests: Record<string, string>): { repo: string; sha: string } {
  const repo = join(root, name)
  mkdirSync(repo)
  git(repo, ['init', '-q'])
  for (const [file, content] of Object.entries(tests)) writeFileSync(join(repo, file), content)
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'fixture'])
  return { repo, sha: git(repo, ['rev-parse', 'HEAD']) }
}
const passing = 'import { test, expect } from "bun:test"\ntest("ok", () => expect(1).toBe(1))\n'
const failing = 'import { test, expect } from "bun:test"\ntest("bad", () => expect(1).toBe(2))\n'
const bunArgv = [bun, 'test', '--reporter=junit', '--reporter-outfile={{JUNIT_REPORT}}']
function config(overrides: Partial<PinnedVerifierConfig> = {}): PinnedVerifierConfig {
  return { version: 1, verifierId: 'fixture-bun', argv: bunArgv, expectedExitCodes: [0], timeoutMs: 60_000, minimumTests: 1, ...overrides }
}

describe('固定基线验证：只使用已提交commit的干净副本', () => {
  test('工作树未提交的破坏不影响通过的已提交基线', async () => {
    const { repo, sha } = makeRepo('clean-pass', { 'a.test.ts': passing })
    writeFileSync(join(repo, 'a.test.ts'), failing)
    writeFileSync(join(repo, 'untracked.test.ts'), failing)
    const receipt = await runPinnedBaselineVerifier({ repoRoot: repo, commitSha: sha, config: config() })
    expect(receipt).toMatchObject({ verdict: 'passed', commitSha: sha, cleanCheckout: true, tests: 1, failures: 0 })
    expect(receipt.reasons).toEqual([])
  })
  test('已提交的失败测试判定为failed，并指出失败来源', async () => {
    const { repo, sha } = makeRepo('committed-fail', { 'a.test.ts': failing })
    const receipt = await runPinnedBaselineVerifier({ repoRoot: repo, commitSha: sha, config: config() })
    expect(receipt.verdict).toBe('failed')
    expect(receipt.reasons).toContain('exit_code_unexpected')
    expect(receipt.failures).toBeGreaterThan(0)
  })
  test('零测试或测试数量不足即使退出码为0也不通过', async () => {
    const { repo, sha } = makeRepo('zero-tests', { 'noop.ts': 'export const x = 1\n' })
    const receipt = await runPinnedBaselineVerifier({ repoRoot: repo, commitSha: sha, config: config({ argv: [bun, '-e', 'process.exit(0)'], minimumTests: 1 }) })
    expect(receipt.verdict).not.toBe('passed')
    expect(receipt.reasons.some((r) => r === 'collection_missing' || r === 'too_few_tests')).toBe(true)
  })
  test('超时被判定failed并回收子进程，不回退到工作树', async () => {
    const { repo, sha } = makeRepo('timeout', { 'a.test.ts': passing })
    const receipt = await runPinnedBaselineVerifier({ repoRoot: repo, commitSha: sha, config: config({ argv: ['/bin/sleep', '5'], timeoutMs: 200 }) })
    expect(receipt.verdict).toBe('failed')
    expect(receipt.reasons).toContain('timeout')
  })
  test('argv不经shell解释，元字符只是字面参数', async () => {
    const { repo, sha } = makeRepo('no-shell', { 'a.test.ts': passing })
    const marker = join(root, 'pwned-no-shell')
    await runPinnedBaselineVerifier({ repoRoot: repo, commitSha: sha, config: config({ argv: ['/usr/bin/true', `$(touch ${marker})`] }) })
    expect(existsSync(marker)).toBe(false)
  })
  test('非完整40位commit、非法配置与placeholder外的形式被拒绝', async () => {
    const { repo, sha } = makeRepo('invalid', { 'a.test.ts': passing })
    await expect(runPinnedBaselineVerifier({ repoRoot: repo, commitSha: 'HEAD', config: config() })).rejects.toThrow('commit')
    await expect(runPinnedBaselineVerifier({ repoRoot: repo, commitSha: sha.slice(0, 12), config: config() })).rejects.toThrow('commit')
    await expect(runPinnedBaselineVerifier({ repoRoot: repo, commitSha: sha, config: config({ argv: [] }) })).rejects.toThrow('argv')
    await expect(runPinnedBaselineVerifier({ repoRoot: repo, commitSha: sha, config: config({ minimumTests: 0 }) })).rejects.toThrow('minimumTests')
    await expect(runPinnedBaselineVerifier({ repoRoot: repo, commitSha: sha, config: config({ timeoutMs: 0 }) })).rejects.toThrow('timeoutMs')
  })
  test('临时checkout和报告目录在结束后清理', async () => {
    const { repo, sha } = makeRepo('cleanup', { 'a.test.ts': passing })
    const receipt = await runPinnedBaselineVerifier({ repoRoot: repo, commitSha: sha, config: config() })
    expect(receipt.cleanedUp).toBe(true)
  })
})

describe('seatbelt 沙箱：只允许写工作目录，拒绝配置目录', () => {
  const junit = '<testsuites tests="1" failures="0"></testsuites>'
  const sh = (script: string) => ['/bin/sh', '-c', script]
  test('报告路径（工作目录内）可写，测试通过', async () => {
    const { repo, sha } = makeRepo('sandbox-report', { 'a.test.ts': passing })
    const receipt = await runPinnedBaselineVerifier({ repoRoot: repo, commitSha: sha, config: config({ argv: sh(`printf '${junit}' > {{JUNIT_REPORT}}`) }) })
    expect(receipt).toMatchObject({ verdict: 'passed', isolation: 'seatbelt-macos' })
  })
  test('写入受保护配置目录被拒绝，且后续报告不会生成', async () => {
    const { repo, sha } = makeRepo('sandbox-protected', { 'a.test.ts': passing })
    const prot = join(root, 'protected-config')
    mkdirSync(prot)
    const leak = join(prot, 'leak.txt')
    const receipt = await runPinnedBaselineVerifier({
      repoRoot: repo, commitSha: sha, protectedDirs: [prot],
      config: config({ argv: sh(`echo x > '${leak}' && printf '${junit}' > {{JUNIT_REPORT}}`) }),
    })
    expect(existsSync(leak)).toBe(false)
    expect(receipt.verdict).not.toBe('passed')
    expect(receipt.reasons).toContain('collection_missing')
  })
  test('读取受保护目录被拒绝（签名密钥不可被测试代码读取）', async () => {
    const { repo, sha } = makeRepo('sandbox-read', { 'a.test.ts': passing })
    const prot = join(root, 'protected-read')
    mkdirSync(prot)
    writeFileSync(join(prot, 'secret'), 'k')
    const receipt = await runPinnedBaselineVerifier({
      repoRoot: repo, commitSha: sha, protectedDirs: [prot],
      config: config({ argv: sh(`cat '${join(prot, 'secret')}' >/dev/null && printf '${junit}' > {{JUNIT_REPORT}}`) }),
    })
    expect(receipt.verdict).not.toBe('passed')
  })
  test('非 darwin 平台无隔离：不执行命令，判 unknown', async () => {
    const { repo, sha } = makeRepo('sandbox-linux', { 'a.test.ts': passing })
    const marker = join(root, 'ran-on-linux')
    const receipt = await runPinnedBaselineVerifier({ repoRoot: repo, commitSha: sha, platform: 'linux', config: config({ argv: sh(`touch '${marker}'`) }) })
    expect(existsSync(marker)).toBe(false)
    expect(receipt).toMatchObject({ verdict: 'unknown', isolation: 'unavailable', reasons: ['sandbox_unavailable'] })
  })
})

describe('JUnit计数解析', () => {
  test('读取根节点计数，缺失errors视为0', () => {
    expect(parseJUnitTotals('<testsuites tests="3" failures="1" skipped="0"></testsuites>')).toEqual({ tests: 3, failures: 1, errors: 0, skipped: 0 })
  })
  test('无根节点或计数非法返回null', () => {
    expect(parseJUnitTotals('not xml')).toBeNull()
    expect(parseJUnitTotals('<testsuites tests="x" failures="0"></testsuites>')).toBeNull()
  })
})
