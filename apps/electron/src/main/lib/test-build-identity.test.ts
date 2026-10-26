import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { getPackagedTestConfigDir, getPackagedTestProfileName } from './test-build-identity.ts'

test('Given带测试标记的已打包应用 When解析配置目录 Then返回独立应用数据路径', () => {
  expect(getPackagedTestConfigDir(true, { gravitasTestBuild: true, version: '0.13.249' }, '/Users/test/Library/Application Support'))
    .toBe('/Users/test/Library/Application Support/Gravitas Owner Test 0.13.249/owner-config')
  expect(getPackagedTestConfigDir(true, { gravitasTestBuild: true, gravitasTestProfileName: 'Gravitas Owner E2E', version: '0.13.249' }, '/Users/test/Library/Application Support'))
    .toBe('/Users/test/Library/Application Support/Gravitas Owner E2E 0.13.249/owner-config')
  expect(getPackagedTestConfigDir(true, { gravitasTestBuild: true }, '/Users/test/Library/Application Support', '/tmp/owner-e2e/config', true))
    .toBe('/tmp/owner-e2e/config')
  expect(getPackagedTestConfigDir(true, { gravitasTestBuild: true, version: '0.13.249' }, '/Users/test/Library/Application Support', '/tmp/owner-e2e/config', false))
    .toBe('/Users/test/Library/Application Support/Gravitas Owner Test 0.13.249/owner-config')
  expect(getPackagedTestConfigDir(true, { gravitasTestBuild: true, version: '0.13.249' }, '/Users/test/Library/Application Support', 'relative/config', true))
    .toBe('/Users/test/Library/Application Support/Gravitas Owner Test 0.13.249/owner-config')
  expect(getPackagedTestProfileName({ gravitasTestProfileName: '../unsafe' })).toBe('Gravitas Owner Test')
})

test('Given正式包或开发运行 When解析配置目录 Then不启用测试目录', () => {
  expect(getPackagedTestConfigDir(true, {}, '/tmp')).toBeUndefined()
  expect(getPackagedTestConfigDir(false, { gravitasTestBuild: true }, '/tmp')).toBeUndefined()
  expect(getPackagedTestConfigDir(true, { gravitasTestBuild: 'true' }, '/tmp')).toBeUndefined()
})
test('Given 集成包配置 When 检查Dev与OwnerTest Then 应用身份、输出目录及更新通道分离', () => {
  const root = join(import.meta.dir, '../../..')
  interface BuilderConfig {
    appId: string
    extends: string
    directories: { output: string }
    extraMetadata: { gravitasChannel?: string; gravitasTestBuild?: boolean }
    publish: unknown
  }
  const read = (name: string) => parse(readFileSync(join(root, name), 'utf8')) as BuilderConfig
  const dev = read('electron-builder.dev.yml')
  const owner = read('electron-builder.owner-test.yml')
  expect(dev.appId).toBe('com.gravitas.app.dev')
  expect(dev.extraMetadata.gravitasChannel).toBe('dev')
  expect(dev.directories.output).toBe('out-dev')
  expect(owner.appId).toBe('com.gravitas.owner-test.a02')
  expect(owner.extends).toBe('electron-builder.yml')
  expect(owner.directories.output).toBe('out-owner-test')
  expect(owner.extraMetadata).toEqual({ gravitasChannel: 'dev', gravitasTestBuild: true })
  expect(owner.publish).toBeNull()
  const e2e = read('electron-builder.owner-e2e.yml')
  expect(e2e.extends).toBe('electron-builder.owner-test.yml')
})
