/**
 * electron-builder `beforePack` 钩子：macOS 打包前确认 node-pty spawn-helper 存在，
 * 修补 unixTerminal.js 的 helper 解析路径，并把它暂存到 `.packaging/` 供 mac.extraFiles 使用。
 *
 * 之所以放在打包钩子里而不是只依赖 rebuild:natives：CI 与发布流水线直接调用
 * electron-builder，没有经过 rebuild:natives，过去会静默产出缺少 helper 的安装包。
 */
const path = require('node:path')
const { prepareMacNodePty } = require('./node-pty-helper.cjs')

module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const projectDir = context.packager.projectDir
  const result = prepareMacNodePty({
    nodePtyRoot: path.resolve(projectDir, '../../node_modules/node-pty'),
    stagePath: path.resolve(projectDir, '.packaging/node-pty-spawn-helper'),
  })
  console.log(`[node-pty] spawn-helper 已暂存：${result.helper} -> ${result.stagePath}`)
}
