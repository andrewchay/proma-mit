/**
 * node-pty 在 macOS 上依赖 spawn-helper。
 *
 * 打包应用路径较深时 posix_spawnp 无法启动 asar 解包目录里的 helper，因此生产包统一
 * 指向 Contents/MacOS 下的短路径。helper 可能来自 electron-rebuild 产物（build/Release），
 * 也可能来自 node-pty npm 包自带的 prebuilds；两者都必须能被找到，找不到时让打包失败，
 * 而不是产出一个终端无法启动的安装包。
 */
const { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const PATCH_MARKER = 'GRAVITAS_MACOS_PACKAGED_HELPER'

const ORIGINAL_HELPER_RESOLUTION =
  /^(\s*)var helperPath = native\.dir \+ '\/spawn-helper';\r?\n\1helperPath = path\.resolve\(__dirname, helperPath\);$/m

function patchNodePtyUnixTerminalSource(source) {
  if (source.includes(PATCH_MARKER)) {
    return source
  }

  if (!ORIGINAL_HELPER_RESOLUTION.test(source)) {
    throw new Error('node-pty unixTerminal.js 结构已变化，无法安全修补 spawn-helper 路径')
  }

  return source.replace(ORIGINAL_HELPER_RESOLUTION, (_match, indentation) => {
    return `${indentation}// ${PATCH_MARKER}
${indentation}var helperPath = process.versions.electron && !process.defaultApp
${indentation}    ? path.resolve(path.dirname(process.execPath), 'node-pty-spawn-helper')
${indentation}    : path.resolve(__dirname, native.dir + '/spawn-helper');`
  })
}

/** 按 node-pty 运行时顺序（build/Release → build/Debug → prebuilds）查找 helper。 */
function resolveSpawnHelper(nodePtyRoot, platform = process.platform, arch = process.arch) {
  const candidates = [
    path.join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
    path.join(nodePtyRoot, 'build', 'Debug', 'spawn-helper'),
    path.join(nodePtyRoot, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

/**
 * 修补 node_modules 中的 unixTerminal.js，并把 helper 暂存到打包可引用的稳定路径。
 * 任一步失败都抛出错误，让 electron-builder 与 rebuild:natives 直接失败。
 */
function prepareMacNodePty({ nodePtyRoot, stagePath }) {
  const helper = resolveSpawnHelper(nodePtyRoot)
  if (!helper) {
    throw new Error(
      `找不到 node-pty spawn-helper，打包中止。已检查：${nodePtyRoot}/build/{Release,Debug}、` +
        `prebuilds/${process.platform}-${process.arch}。请在 macOS 构建机执行 bun run rebuild:natives，` +
        '或确认 bun install 拉取到了 node-pty prebuilds。',
    )
  }

  const unixTerminalPath = path.join(nodePtyRoot, 'lib', 'unixTerminal.js')
  const source = readFileSync(unixTerminalPath, 'utf8')
  const patched = patchNodePtyUnixTerminalSource(source)
  if (patched !== source) {
    writeFileSync(unixTerminalPath, patched, 'utf8')
  }
  if (!readFileSync(unixTerminalPath, 'utf8').includes(PATCH_MARKER)) {
    throw new Error('node-pty unixTerminal.js 修补未生效，打包中止')
  }

  chmodSync(helper, 0o755)
  mkdirSync(path.dirname(stagePath), { recursive: true })
  copyFileSync(helper, stagePath)
  chmodSync(stagePath, 0o755)

  return { helper, stagePath }
}

module.exports = {
  PATCH_MARKER,
  patchNodePtyUnixTerminalSource,
  resolveSpawnHelper,
  prepareMacNodePty,
}
