import { resolve } from "node:path";
import { prepareMacNodePty } from "./node-pty-helper.cjs";

if (process.platform !== "darwin") {
  console.log("非 macOS 平台，跳过 node-pty helper 路径修补");
  process.exit(0);
}

const nodePtyRoot = resolve(import.meta.dir, "../../../node_modules/node-pty");
const result = prepareMacNodePty({
  nodePtyRoot,
  stagePath: resolve(import.meta.dir, "../.packaging/node-pty-spawn-helper"),
});

console.log(`node-pty macOS 打包 helper 已准备完成：${result.helper}`);
