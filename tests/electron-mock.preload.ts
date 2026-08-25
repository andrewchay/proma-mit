/**
 * 全局测试 preload：为所有单测进程注入一份完整、统一的 Electron Mock。
 *
 * 背景：项目在纯 Bun/单测进程（无真实 Electron runtime）下跑测试，而 `node_modules/electron`
 * 是二进制启动器，非 Electron 进程下不提供真实命名导出，`import { WebContentsView } from 'electron'`
 * 会抛 `Export named ... not found`。
 *
 * 又因 Bun 的 `mock.module` 是「进程级全局 + 最后一次注册覆盖先前」，多个测试文件各自 mock
 * electron 时，内容残缺的一份会顶掉其它文件所需的完整导出，造成全量并发/串行测试互相踩崩。
 *
 * 解法：进程启动时最先注入一份覆盖被测所用全部 electron 导出与子 API 的完整 mock；
 * 各测试文件不要再使用残缺自建 mock，统一引用 `buildElectronMock`（内容一致，覆盖之后
 * 也仍是完整版），从而消除互踩。
 */

import { mock } from 'bun:test'
// 注意：preload 里直接 import 共享 mock，保证先于被测模块完成 electron 隔离
import { buildElectronMock } from '../apps/electron/src/main/lib/testing/electron-mock'

mock.module('electron', () => buildElectronMock())
