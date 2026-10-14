import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkChannelConfigs, checkReleaseWorkflow } from './check-release-channel'

const root = join(import.meta.dir, '..')
const read = (name: string) => Bun.YAML.parse(readFileSync(join(root, name), 'utf8')) as Parameters<typeof checkChannelConfigs>[0]

test('实际 builder 配置满足双渠道契约', () => {
  expect(() => checkChannelConfigs(read('electron-builder.yml'), read('electron-builder.dev.yml'))).not.toThrow()
})
test('开发包误继承正式发布配置时阻断', () => {
  const dev = { ...read('electron-builder.dev.yml'), publish: { provider: 'github' } }
  expect(() => checkChannelConfigs(read('electron-builder.yml'), dev)).toThrow('不得继承')
})
test('开发包误用正式身份时阻断', () => {
  const dev = { ...read('electron-builder.dev.yml'), appId: 'com.gravitas.app' }
  expect(() => checkChannelConfigs(read('electron-builder.yml'), dev)).toThrow('appId')
})

test('正式发布工作流必须绑定 tag、渠道检查、构建和正式上传', () => {
  const workflow = readFileSync(join(root, '../../.github/workflows/release.yml'), 'utf8')
  expect(() => checkReleaseWorkflow(workflow)).not.toThrow()
  expect(() => checkReleaseWorkflow(workflow.replace("tags:\n      - 'v*'", "tags:\n      - 'dev-*'"))).toThrow('v* tag')
})
