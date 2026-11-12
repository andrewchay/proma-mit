import { expect, test } from 'bun:test'
import { buildCommandCoversTargets, isBuildVerificationCommand, resolveOwnerRuntimeBuildCommand } from './owner-runtime-build-command'

test('Given build 前缀命令 When 判断来源 Then 只有该前缀算构建验证', () => {
  expect(isBuildVerificationCommand('build:swift')).toBe(true)
  expect(isBuildVerificationCommand('browser:html.loads')).toBe(false)
  expect(isBuildVerificationCommand('swift build')).toBe(false)
})

test('Given 注册表内标识 When 解析 Then 返回固定 argv', () => {
  expect(resolveOwnerRuntimeBuildCommand('build:swift').argv).toEqual(['swift', 'build'])
  expect(resolveOwnerRuntimeBuildCommand('build:swift-test').argv).toEqual(['swift', 'test'])
})

test('Given 未知/空/带参数的命令 When 解析 Then 一律报错而不是猜测', () => {
  expect(() => resolveOwnerRuntimeBuildCommand('build:unknown')).toThrow('未知的构建验证命令标识')
  expect(() => resolveOwnerRuntimeBuildCommand('build:')).toThrow('缺少标识')
  expect(() => resolveOwnerRuntimeBuildCommand('browser:html.loads')).toThrow('不是构建验证命令')
  // 标识必须整段精确匹配，不能把多余参数当合法后缀吞掉。
  expect(() => resolveOwnerRuntimeBuildCommand('build:swift build --verbose')).toThrow()
})

test('Given 目标扩展名 When 判断覆盖 Then 只认注册表声明的扩展名', () => {
  const swift = resolveOwnerRuntimeBuildCommand('build:swift')
  expect(buildCommandCoversTargets(swift, ['Sources/App.swift'])).toBe(true)
  expect(buildCommandCoversTargets(swift, ['index.html'])).toBe(false)
  expect(buildCommandCoversTargets(swift, [])).toBe(false)
})
