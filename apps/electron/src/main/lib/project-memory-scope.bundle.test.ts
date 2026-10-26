import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

test('Given 单文件打包且没有源码相对模块 When 解析项目绑定 Then 实际加载权威服务并实时拒绝解绑及跨项目', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owner-binding-bundle-'))
  const outfile = join(root, 'binding.cjs')
  try {
    await build({ bundle: true, platform: 'node', format: 'cjs', outfile,
      stdin: { resolveDir: import.meta.dir, contents: `
        import { resolveWorkspaceProjectBinding } from './project-memory-scope';
        import { unbind } from './project-workspace-bindings';
        const results = [resolveWorkspaceProjectBinding('project', 'workspace'), resolveWorkspaceProjectBinding('other', 'workspace')];
        unbind(); results.push(resolveWorkspaceProjectBinding('project', 'workspace'));
        console.log(JSON.stringify(results));
      ` },
      plugins: [{ name: 'isolated-authoritative-binding', setup(builder) {
        builder.onResolve({ filter: /project-workspace-bindings$/ }, () => ({ path: 'binding', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
          let active = true;
          export function hasProjectWorkspaceBinding(projectId, workspaceId) { return active && projectId === 'project' && workspaceId === 'workspace'; }
          export function unbind() { active = false; }
        `, loader: 'js' }))
      } }],
    })
    expect(JSON.parse(execFileSync('node', [outfile], { encoding: 'utf8', timeout: 10_000 }))).toEqual([true, false, false])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
