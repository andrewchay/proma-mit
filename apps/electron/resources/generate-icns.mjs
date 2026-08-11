import { readdir } from "node:fs/promises";

const [, , iconsetPath, outputPath] = process.argv;

if (!iconsetPath || !outputPath) {
  throw new Error("用法：bun generate-icns.mjs <iconset目录> <输出icns路径>");
}

const chunkTypes = {
  "icon_16x16.png": "icp4",
  "icon_16x16@2x.png": "icp5",
  "icon_32x32@2x.png": "icp6",
  "icon_128x128.png": "ic07",
  "icon_256x256.png": "ic08",
  "icon_512x512.png": "ic09",
  "icon_512x512@2x.png": "ic10",
};

const filenames = await readdir(iconsetPath);
const chunks = await Promise.all(
  Object.entries(chunkTypes)
    .filter(([filename]) => filenames.includes(filename))
    .map(async ([filename, type]) => {
      const png = await Bun.file(`${iconsetPath}/${filename}`).arrayBuffer();
      const chunk = new Uint8Array(8 + png.byteLength);
      chunk.set(new TextEncoder().encode(type), 0);
      new DataView(chunk.buffer).setUint32(4, chunk.byteLength, false);
      chunk.set(new Uint8Array(png), 8);
      return chunk;
    }),
);

if (chunks.length !== Object.keys(chunkTypes).length) {
  throw new Error("iconset 缺少必需的 PNG 尺寸");
}

const totalLength = 8 + chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
const icon = new Uint8Array(totalLength);
icon.set(new TextEncoder().encode("icns"), 0);
new DataView(icon.buffer).setUint32(4, totalLength, false);

let offset = 8;
for (const chunk of chunks) {
  icon.set(chunk, offset);
  offset += chunk.byteLength;
}

await Bun.write(outputPath, icon);
