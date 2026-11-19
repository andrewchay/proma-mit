import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

test('给定 CommonJS 主进程包，读取已加密的渠道凭据时使用 Electron safeStorage 解密', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gravitas-channel-bundle-'))
  try {
    const electron = join(root, 'node_modules', 'electron')
    mkdirSync(electron, { recursive: true })
    writeFileSync(join(electron, 'index.js'), `
      exports.app = { isPackaged: false, getPath: () => __dirname };
      exports.safeStorage = {
        isEncryptionAvailable: () => true,
        decryptString: (value) => 'decrypted:' + value.toString('utf8'),
      };
    `)
    writeFileSync(join(root, 'channels.json'), JSON.stringify({
      version: 1,
      channels: [{ id: 'fixture', provider: 'zhipu', apiKey: Buffer.from('fixture-ciphertext').toString('base64') }],
    }))

    const outfile = join(root, 'channel.cjs')
    await build({
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      external: ['electron', 'original-fs'],
      logLevel: 'silent',
      stdin: {
        resolveDir: import.meta.dir,
        contents: `
          import { decryptApiKey } from './channel-manager';
          console.log(decryptApiKey('fixture'));
        `,
      },
    })
    const result = execFileSync('node', [outfile], {
      encoding: 'utf8',
      env: { ...process.env, PROMA_TEST_CONFIG_DIR: root },
      timeout: 10_000,
    })
    expect(result.trim()).toBe('decrypted:fixture-ciphertext')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
