import { describe, expect, test } from 'bun:test'

/**
 * 运行规则测试（M4）：
 * - 解释器白名单、脚本路径安全（绝对路径/穿越/盘符/前导 -）
 * - 预算边界、状态机终态
 * - 非计算运行不得夹带脚本（防绕过）
 */

const {
  ALLOWED_INTERPRETERS,
  DEFAULT_BUDGET,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  ResearchError,
  assertInterpreterAllowed,
  assertRunTransition,
  assertSafeArgs,
  assertSafeScriptPath,
  digestInputManifest,
  isTerminalRunStatus,
  validateBudget,
  validateRunRequest,
} = await import('@gravitas/core/services/academic')

describe('解释器白名单', () => {
  test('允许清单内的解释器通过', () => {
    for (const i of ALLOWED_INTERPRETERS) {
      expect(() => assertInterpreterAllowed(i)).not.toThrow()
    }
  })

  test('bash/sh/curl 等被拒绝', () => {
    for (const bad of ['bash', 'sh', 'curl', 'python3 -c']) {
      expect(() => assertInterpreterAllowed(bad)).toThrow(ResearchError)
    }
  })
})

describe('脚本路径安全', () => {
  test('正常相对路径通过', () => {
    expect(() => assertSafeScriptPath('analysis/run_sim.py')).not.toThrow()
  })

  test('绝对路径/穿越/盘符/前导 - 全部拒绝', () => {
    expect(() => assertSafeScriptPath('/etc/passwd')).toThrow('绝对路径')
    expect(() => assertSafeScriptPath('../../etc/passwd')).toThrow('上级目录')
    expect(() => assertSafeScriptPath('C:\\Windows\\system32\\x.py')).toThrow('绝对路径')
    expect(() => assertSafeScriptPath('-c')).toThrow('不得以 - 开头')
    expect(() => assertSafeScriptPath('  ')).toThrow('不能为空')
  })

  test('参数不允许控制字符', () => {
    expect(() => assertSafeArgs(['--seed', '42'])).not.toThrow()
    expect(() => assertSafeArgs(['a\u0000b'])).toThrow('控制字符')
    expect(() => assertSafeArgs(['x'.repeat(5000)])).toThrow('过长')
  })
})

describe('预算边界', () => {
  test('缺省时用默认预算', () => {
    expect(validateBudget(undefined)).toEqual(DEFAULT_BUDGET)
  })

  test('非正数或超上限拒绝', () => {
    expect(() => validateBudget({ timeoutMs: 0 })).toThrow('正数')
    expect(() => validateBudget({ timeoutMs: MAX_TIMEOUT_MS + 1 })).toThrow('不得超过')
    expect(() => validateBudget({ maxOutputBytes: 0 })).toThrow('正数字节')
    expect(() => validateBudget({ maxOutputBytes: MAX_OUTPUT_BYTES + 1 })).toThrow('不得超过')
  })
})

describe('运行请求校验', () => {
  test('compute 必须有解释器与安全脚本路径', () => {
    expect(() =>
      validateRunRequest({ kind: 'compute', title: 'T', input: {} }),
    ).toThrow('必须声明解释器')

    expect(() =>
      validateRunRequest({
        kind: 'compute', title: 'T',
        input: { interpreter: 'python3', scriptPath: '../evil.py' },
      }),
    ).toThrow('上级目录')

    const ok = validateRunRequest({
      kind: 'compute', title: 'T',
      input: { interpreter: 'python3', scriptPath: 'sim.py', args: ['--n', '100'] },
    })
    expect(ok.input.interpreter).toBe('python3')
    expect(ok.budget.timeoutMs).toBe(DEFAULT_BUDGET.timeoutMs)
  })

  test('非计算运行不得夹带解释器或脚本（防绕过）', () => {
    expect(() =>
      validateRunRequest({
        kind: 'manual-observation', title: '访谈记录',
        input: { interpreter: 'python3', scriptPath: 'x.py' },
      }),
    ).toThrow('不允许声明解释器/脚本')

    expect(() =>
      validateRunRequest({ kind: 'manual-observation', title: '访谈记录', input: {} }),
    ).not.toThrow()
  })

  test('标题与类型校验', () => {
    expect(() =>
      validateRunRequest({ kind: 'compute', title: ' ', input: { interpreter: 'node', scriptPath: 'a.js' } }),
    ).toThrow('标题')
    expect(() =>
      validateRunRequest({ kind: 'magic' as never, title: 'T', input: {} }),
    ).toThrow('未知运行类型')
  })
})

describe('状态机与摘要', () => {
  test('终态不可迁移', () => {
    expect(isTerminalRunStatus('completed')).toBe(true)
    expect(isTerminalRunStatus('running')).toBe(false)
    expect(() => assertRunTransition('completed', 'running')).toThrow('非法运行状态迁移')
    expect(() => assertRunTransition('queued', 'running')).not.toThrow()
    expect(() => assertRunTransition('running', 'timed-out')).not.toThrow()
  })

  test('输入清单摘要稳定且随内容变化', () => {
    const a = digestInputManifest({ interpreter: 'python3', scriptPath: 'a.py', args: ['1'] })
    const b = digestInputManifest({ interpreter: 'python3', scriptPath: 'a.py', args: ['1'] })
    const c = digestInputManifest({ interpreter: 'python3', scriptPath: 'a.py', args: ['2'] })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
