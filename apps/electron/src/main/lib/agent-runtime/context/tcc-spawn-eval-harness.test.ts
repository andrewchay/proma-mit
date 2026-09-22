import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toTccExperimentFixture } from './tcc-spawn-eval-harness'

const fixturePath = new URL('./fixtures/m3-spawn-representative.json', import.meta.url).pathname
const raw = JSON.parse(await Bun.file(fixturePath).text()) as unknown

describe('TCC spawn evaluation harness', () => {
  test('maps the representative spawn fixture onto the M3 experiment fixture', () => {
    const fixture = toTccExperimentFixture(raw)
    expect(fixture.cases).toHaveLength(10)
    expect(fixture.cases[0]!.requiredItemIds).toHaveLength(2)
    expect(fixture.cases[0]!.items).toHaveLength(23)
  })

  test('refuses a plan whose authorization is smaller than the matrix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tcc-eval-'))
    try {
      const { runTccSpawnEvaluation } = await import('./tcc-spawn-eval-harness')
      await expect(runTccSpawnEvaluation({
        fixturePath,
        scoreboardPath: join(dir, 'scoreboard.json'),
        isolationDir: join(dir, 'iso'),
        authorizedCalls: 10,
        runsPerCase: 3,
        provider: 'zhipu',
        modelId: 'glm-5.3-flash',
        implementationVersion: 'tcc-spawn-m3-v2',
      }, { channelId: 'c1', provider: 'zhipu', apiKey: 'k', baseUrl: 'https://example.invalid', modelId: 'glm-5.3-flash' }, { workspaceDir: join(dir, 'iso') }))
        .rejects.toThrow('fewer than the planned matrix')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses to start when the fixture cannot satisfy the preflight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tcc-eval-'))
    try {
      const brokenPath = join(dir, 'broken.json')
      const broken = structuredClone(raw) as { cases: Array<{ forbiddenItemIds: string[] }> }
      // 把必需项也标为禁止，制造“投影必然泄漏”的矛盾样本
      broken.cases[0]!.forbiddenItemIds = ['case-001-required-1']
      writeFileSync(brokenPath, JSON.stringify(broken))
      const { runTccSpawnEvaluation } = await import('./tcc-spawn-eval-harness')
      await expect(runTccSpawnEvaluation({
        fixturePath: brokenPath,
        scoreboardPath: join(dir, 'scoreboard.json'),
        isolationDir: join(dir, 'iso'),
        authorizedCalls: 90,
        runsPerCase: 3,
        provider: 'zhipu',
        modelId: 'glm-5.3-flash',
        implementationVersion: 'tcc-spawn-m3-v2',
      }, { channelId: 'c1', provider: 'zhipu', apiKey: 'k', baseUrl: 'https://example.invalid', modelId: 'glm-5.3-flash' }, { workspaceDir: join(dir, 'iso') }))
        .rejects.toThrow('preflight failed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
