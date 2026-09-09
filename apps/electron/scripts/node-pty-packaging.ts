const PATCH_MARKER = "GRAVITAS_MACOS_PACKAGED_HELPER";

const ORIGINAL_HELPER_RESOLUTION =
  /^(\s*)var helperPath = native\.dir \+ '\/spawn-helper';\r?\n\1helperPath = path\.resolve\(__dirname, helperPath\);$/m;

/**
 * macOS 打包应用路径较深时，posix_spawnp 无法启动 asar 解包目录中的 helper。
 * 将生产包指向 Contents/MacOS 下的短路径，同时保留开发态原有行为。
 */
export function patchNodePtyUnixTerminalSource(source: string): string {
  if (source.includes(PATCH_MARKER)) {
    return source;
  }

  if (!ORIGINAL_HELPER_RESOLUTION.test(source)) {
    throw new Error("node-pty unixTerminal.js 结构已变化，无法安全修补 spawn-helper 路径");
  }

  return source.replace(ORIGINAL_HELPER_RESOLUTION, (_match, indentation: string) => {
    return `${indentation}// ${PATCH_MARKER}
${indentation}var helperPath = process.versions.electron && !process.defaultApp
${indentation}    ? path.resolve(path.dirname(process.execPath), 'node-pty-spawn-helper')
${indentation}    : path.resolve(__dirname, native.dir + '/spawn-helper');`;
  });
}
