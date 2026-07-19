/**
 * Pi SDK 是 ESM-only 包，主进程 bundle 当前输出为 CJS。
 *
 * 不能在 CJS bundle 中静态 import external Pi SDK，否则 esbuild 会生成 require()，
 * 打包后触发 ERR_PACKAGE_PATH_NOT_EXPORTED。这里用运行时 import() 保留 ESM 加载语义。
 */

export type PiCodingAgentModule = typeof import('@earendil-works/pi-coding-agent')

const importEsm = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>

export function loadPiCodingAgent(): Promise<PiCodingAgentModule> {
  return importEsm<PiCodingAgentModule>('@earendil-works/pi-coding-agent')
}
