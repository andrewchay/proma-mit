# G2 工程门禁证据

> 2026-10-11 12:50 GMT+8。固定 HEAD `36f6ac05`（G1 通过同批）。

## PR 门禁（固定 commit）

- 全仓测试 3931 pass / 0 fail / 30 skip；九包 typecheck、lint、docs:generate+check、git diff --check 全绿；真实 workspace 目录 36→36 且名称集合一致。
- 真实运行类测试按默认跳过（不把 skip 记通过）。

## 完整构建

- `bun run dist:fast`（含主进程/preload/渲染进程构建、原生 helper rebuild、electron-builder）：1m28s 成功。
- 产物：`Gravitas-0.12.155-arm64.dmg`。

## 隔离包启动（package-smoke）

对真实安装包执行 `bun scripts/package-smoke.ts` 通过：

```json
{"packageSmoke":"passed","newMedia":{"schemaVersion":3,"migrations":3,"skills":6,"audits":3},"version":"0.12.155","tools":26,"defaultSkills":3,"skillSetToggle":2,"kimiCompaction":false,"sqlite":"node:sqlite"}
```

- 隔离临时配置启动、SQLite 迁移链重开（schemaVersion 3 / migrations 3）、默认 Skills 注入与分组停用均验证。
- `kimiCompaction: false`：受控变量未设置，**不记为通过项**（既有约定）。

## 数据兼容与回滚

- 数据兼容：smoke 覆盖全新临时配置的迁移链；**真实用户配置目录（既有 ~/.gravitas 数据）由打包版直接打开未做自动化直测**（烟测隔离是既定设计），此项为已声明边界，建议发布前由用户在开发并存包上手动验收一次。
- 回滚：机制级回滚演练由 R04 承担（调度禁用/策略删除/旧数据可读/预算闸不降低）；制品级回滚路径 = 旧版 DMG 保留 + git revert 重建。

## 结论

G2 = **通过（本机 arm64 固定构建工程验收）**。G3（真实 Provider 完整验收）/G4（默认推广授权）未执行；GA（ACP 宿主）阻塞。
