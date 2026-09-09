import { describe, expect, test } from "bun:test";
import { patchNodePtyUnixTerminalSource } from "./node-pty-packaging.ts";

describe("node-pty macOS 打包修补", () => {
  const original = `const native = loadNative();
        var helperPath = native.dir + '/spawn-helper';
        helperPath = path.resolve(__dirname, helperPath);\n        helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');`;

  test("生产包使用 Contents/MacOS 下的短 helper 路径", () => {
    const patched = patchNodePtyUnixTerminalSource(original);

    expect(patched).toContain("GRAVITAS_MACOS_PACKAGED_HELPER");
    expect(patched).toContain("path.dirname(process.execPath), 'node-pty-spawn-helper'");
    expect(patched).toContain("path.resolve(__dirname, native.dir + '/spawn-helper')");
  });

  test("重复执行保持幂等", () => {
    const once = patchNodePtyUnixTerminalSource(original);
    expect(patchNodePtyUnixTerminalSource(once)).toBe(once);
  });

  test("上游结构变化时失败关闭", () => {
    expect(() => patchNodePtyUnixTerminalSource("unexpected source")).toThrow(
      "结构已变化",
    );
  });
});
