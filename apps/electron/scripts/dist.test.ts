import { describe, expect, test } from 'bun:test'
import { buildMainBuildArgs } from './dist'

/**
 * 打包脚本参数组装的回归测试。
 *
 * 覆盖的是「--dev-unlock → esbuild 放开标记 define」这一条链路。它是调试包能生效的
 * 唯一环节：一旦静默断掉，产物仍然能正常打包启动，只是付费能力依旧锁着，
 * 从外部表现看很像「放开功能没写对」，实际是打包参数丢了。
 */
describe('打包脚本 · 调试放开参数', () => {
  test('未开启时不注入任何 define，正式构建行为不变', () => {
    expect(buildMainBuildArgs(false)).toEqual(['run', 'build:main'])
  })

  test('开启时恰好注入放开标记 define', () => {
    expect(buildMainBuildArgs(true)).toEqual([
      'run',
      'build:main',
      '--',
      '--define:__GRAVITAS_DEV_UNLOCK__=true',
    ])
  })

  test('define 名称必须与 dev-unlock.ts 声明的构建期常量一致', () => {
    const define = buildMainBuildArgs(true).join(' ')
    expect(define).toContain('__GRAVITAS_DEV_UNLOCK__')
    // define 值必须是合法 JSON 字面量，否则 esbuild 会直接报错
    expect(define).toContain('=true')
  })
})
