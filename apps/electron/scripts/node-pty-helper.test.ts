import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PATCH_MARKER,
  patchNodePtyUnixTerminalSource,
  prepareMacNodePty,
  resolveSpawnHelper,
} from "./node-pty-helper.cjs";

const ORIGINAL_UNIX_TERMINAL = `const native = loadNative();
        var helperPath = native.dir + '/spawn-helper';
        helperPath = path.resolve(__dirname, helperPath);
        helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
`;

/** 构造一个最小的 node-pty 目录；只写入本测试关心的两个文件。 */
function fixtureRoot(options: { buildHelper?: boolean; prebuildHelper?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "gravitas-node-pty-"));
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib", "unixTerminal.js"), ORIGINAL_UNIX_TERMINAL);

  if (options.buildHelper) {
    mkdirSync(join(root, "build", "Release"), { recursive: true });
    writeFileSync(join(root, "build", "Release", "spawn-helper"), "build");
    chmodSync(join(root, "build", "Release", "spawn-helper"), 0o644);
  }
  if (options.prebuildHelper) {
    const prebuildDir = join(root, "prebuilds", `${process.platform}-${process.arch}`);
    mkdirSync(prebuildDir, { recursive: true });
    writeFileSync(join(prebuildDir, "spawn-helper"), "prebuilds");
    chmodSync(join(prebuildDir, "spawn-helper"), 0o644);
  }
  return root;
}

describe("node-pty macOS 打包修补", () => {
  test("生产包使用 Contents/MacOS 下的短 helper 路径", () => {
    const patched = patchNodePtyUnixTerminalSource(ORIGINAL_UNIX_TERMINAL);

    expect(patched).toContain(PATCH_MARKER);
    expect(patched).toContain("path.dirname(process.execPath), 'node-pty-spawn-helper'");
    expect(patched).toContain("path.resolve(__dirname, native.dir + '/spawn-helper')");
  });

  test("重复执行保持幂等", () => {
    const once = patchNodePtyUnixTerminalSource(ORIGINAL_UNIX_TERMINAL);
    expect(patchNodePtyUnixTerminalSource(once)).toBe(once);
  });

  test("上游结构变化时失败关闭", () => {
    expect(() => patchNodePtyUnixTerminalSource("unexpected source")).toThrow(
      "结构已变化",
    );
  });
});

describe("node-pty spawn-helper 定位与暂存", () => {
  test("优先使用 electron-rebuild 产物", () => {
    const root = fixtureRoot({ buildHelper: true, prebuildHelper: true });
    try {
      expect(resolveSpawnHelper(root)).toBe(join(root, "build", "Release", "spawn-helper"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("没有本地编译产物时回退到 npm prebuilds", () => {
    const root = fixtureRoot({ prebuildHelper: true });
    try {
      expect(resolveSpawnHelper(root)).toBe(
        join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("缺少 helper 时失败关闭，不产出缺 helper 的包", () => {
    const root = fixtureRoot({});
    try {
      expect(() =>
        prepareMacNodePty({ nodePtyRoot: root, stagePath: join(root, ".packaging", "spawn-helper") }),
      ).toThrow("找不到 node-pty spawn-helper");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("暂存 helper 并确保可执行", () => {
    const root = fixtureRoot({ prebuildHelper: true });
    const stagePath = join(root, ".packaging", "node-pty-spawn-helper");
    try {
      const result = prepareMacNodePty({ nodePtyRoot: root, stagePath });

      expect(result.stagePath).toBe(stagePath);
      expect(readFileSync(stagePath, "utf8")).toBe("prebuilds");
      expect(readFileSync(join(root, "lib", "unixTerminal.js"), "utf8")).toContain(PATCH_MARKER);
      expect(dirname(stagePath)).toBe(join(root, ".packaging"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
