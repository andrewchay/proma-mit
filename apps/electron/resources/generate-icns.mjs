import { readdir } from "node:fs/promises";

const [, , iconsetPath, outputPath] = process.argv;
const chunkTypes = {
  "icon_16x16.png": "icp4", "icon_16x16@2x.png": "icp5", "icon_32x32@2x.png": "icp6",
  "icon_128x128.png": "ic07", "icon_256x256.png": "ic08", "icon_512x512.png": "ic09", "icon_512x512@2x.png": "ic10",
};

if (!iconsetPath || !outputPath) throw new Error("用法：bun generate-icns.mjs <iconset目录> <输出icns路径>");
const filenames = await readdir(iconsetPath);
const chunks = await Promise.all(Object.entries(chunkTypes).filter(([name]) => filenames.includes(name)).map(async ([name, type]) => {
  const png = await Bun.file(`${iconsetPath}/${name}`).arrayBuffer();
  const chunk = new Uint8Array(8 + png.byteLength);
  chunk.set(new TextEncoder().encode(type));
  new DataView(chunk.buffer).setUint32(4, chunk.byteLength, false);
  chunk.set(new Uint8Array(png), 8);
  return chunk;
}));
if (chunks.length !== Object.keys(chunkTypes).length) throw new Error("iconset 缺少必需的 PNG 尺寸");
const size = 8 + chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
const icon = new Uint8Array(size);
icon.set(new TextEncoder().encode("icns"));
new DataView(icon.buffer).setUint32(4, size, false);
let offset = 8;
for (const chunk of chunks) { icon.set(chunk, offset); offset += chunk.byteLength; }
await Bun.write(outputPath, icon);
