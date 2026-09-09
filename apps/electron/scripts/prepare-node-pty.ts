import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { patchNodePtyUnixTerminalSource } from "./node-pty-packaging.ts";

if (process.platform !== "darwin") {
  console.log("非 macOS 平台，跳过 node-pty helper 路径修补");
  process.exit(0);
}

const nodePtyRoot = resolve(import.meta.dir, "../../../node_modules/node-pty");
const unixTerminalPath = resolve(nodePtyRoot, "lib/unixTerminal.js");
const spawnHelperPath = resolve(nodePtyRoot, "build/Release/spawn-helper");

await access(spawnHelperPath, constants.X_OK);

const source = await readFile(unixTerminalPath, "utf8");
const patched = patchNodePtyUnixTerminalSource(source);

if (patched !== source) {
  await writeFile(unixTerminalPath, patched, "utf8");
}

await chmod(spawnHelperPath, 0o755);
console.log("node-pty macOS 打包 helper 已准备完成");
