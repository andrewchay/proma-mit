/**
 * 把 index.html 里的本地图片内联为 base64，产出可直接分发的单文件版本。
 * 用法：node build-standalone.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
let html = readFileSync(resolve(dir, 'index.html'), 'utf8');

const replaced = [];
html = html.replace(/src="(assets\/[^"]+)"/g, (_, rel) => {
  const buf = readFileSync(resolve(dir, rel));
  replaced.push(`${rel} (${(buf.length / 1024).toFixed(0)} KB)`);
  return `src="data:image/jpeg;base64,${buf.toString('base64')}"`;
});

const out = resolve(dir, 'index-standalone.html');
writeFileSync(out, html);
console.log('内联图片:', replaced.join('、'));
console.log('输出:', out, `${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
