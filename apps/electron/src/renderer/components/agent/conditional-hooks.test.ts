import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sourceFiles = [
  'AskUserBanner.tsx',
  'PermissionBanner.tsx',
  'McpOAuthBanner.tsx',
  'ExitPlanModeBanner.tsx',
]

test('常驻 Agent 横幅的 request 空值守卫位于全部 Hooks 之后', () => {
  for (const file of sourceFiles) {
    const source = readFileSync(join(import.meta.dir, file), 'utf8')
    const guardIndex = source.search(/if \(!(?:hasRequest|request)(?: \|\| !currentQuestion)?\) return null/)
    const hooks = [...source.matchAll(/(?:React\.)?use(?:Atom|State|Effect|Memo|Callback|Ref)\s*\(/g)]
    const lastHookIndex = Math.max(...hooks.map((match) => match.index ?? -1))

    expect(guardIndex, `${file} 应保留空 request 渲染守卫`).toBeGreaterThan(-1)
    expect(lastHookIndex, `${file} 应包含 React Hooks`).toBeGreaterThan(-1)
    expect(guardIndex, `${file} 的 request 守卫必须晚于全部 Hooks`).toBeGreaterThan(lastHookIndex)
  }
})

test('AskUserBanner 在空请求和空题目时仍在所有 Hooks 后返回', () => {
  const source = readFileSync(join(import.meta.dir, 'AskUserBanner.tsx'), 'utf8')
  const finalGuard = source.indexOf('if (!hasRequest || !currentQuestion) return null')
  const lastHook = Math.max(...[...source.matchAll(/(?:React\.)?use(?:Atom|State|Effect|Memo|Callback|Ref)\s*\(/g)].map((match) => match.index ?? -1))

  expect(finalGuard).toBeGreaterThan(lastHook)
})

test('交互横幅中的 Hooks 不依赖 request 是否存在', () => {
  for (const file of sourceFiles) {
    const source = readFileSync(join(import.meta.dir, file), 'utf8')
    const requestGuard = source.search(/if \(!(?:hasRequest|request)(?: \|\| !currentQuestion)?\) return null/)
    const beforeGuard = source.slice(0, requestGuard)

    expect(requestGuard).toBeGreaterThan(-1)
    expect(beforeGuard).not.toMatch(/if \([^\n]*request[^\n]*\)\s*\{[\s\S]{0,120}?\b(?:React\.)?use(?:Atom|State|Effect|Memo|Callback|Ref)\s*\(/)
  }
})
