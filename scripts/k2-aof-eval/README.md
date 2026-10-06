# K2-01 AOF 对照小样评测（离线、可复现）

本目录是 Gravitas K2-01 的 AOF 对照评测工具。**只读**消费 Obsidian 样本快照，在隔离临时目录运行本地 AOF（reference-local profile），不修改 AOF 源码、不产生云端模型调用、不写入 Vault。

## 前置

- 本机已存在 `/Users/chaihao/LLM/AOF`，且 `.venv/bin/python` 可用（Python 3.13，依赖按 `requirements/locks/reference-local.lock` 安装）。
- Gravitas 仓库依赖已安装（`bun install`）。

## 复现步骤

```bash
# 1. 采样（只读 Vault，输出到临时目录快照）
bun scripts/k2-aof-eval/select_sample.ts --count 30

# 2. AOF 链路：摄入 → 语义资源 → governance 发布 → release-pinned 查询
/Users/chaihao/LLM/AOF/.venv/bin/python scripts/k2-aof-eval/run_pipeline.py \
  --sample-dir "$TMPDIR/k2-aof-eval/sample" \
  --manifest "$TMPDIR/k2-aof-eval/sample-manifest.json" \
  --out "$TMPDIR/k2-aof-eval/eval"

# 3. Gravitas 对照基线（显式 wikilink 图 + suggestLinks）
bun scripts/k2-aof-eval/run_baseline.ts \
  --manifest "$TMPDIR/k2-aof-eval/sample-manifest.json" \
  --sample-dir "$TMPDIR/k2-aof-eval/sample" \
  --aof-metrics "$TMPDIR/k2-aof-eval/eval/metrics.json" \
  --out "$TMPDIR/k2-aof-eval/eval"

# 4. 确定性单元测试（不依赖 AOF 环境）
bun run test knowledge-aof-eval
```

## 边界与诚实声明

- **采样排除**：`99 - Archive`、`Apple Notes`、`Attachments`、`.obsidian`、`AOF-review`、`.trash`、`.git`，以及文件名含敏感关键词（密码/secret/api_key/token/credential/账单/.env）的文件。
- **角色标签非认证身份**：AOF reference-local 的 governance 流程使用 editor/validator/reviewer/publisher 角色标签；promotion 强制 approver 与 publisher 分离，但本地两个标签由同一操作者持有。**名义分离 ≠ 企业级治理**，个人模式治理差距如实记录在评测报告中。
- **资源派生是确定性的**：Concept 资源来自文档标题、wikilink（唯一标题匹配才连边，多义键断开），不含 LLM 抽取；因此本评测验证的是 AOF 的治理/版本/证据/隔离链路，**不声称语义抽取增益**。
- **台账**：`ledger.jsonl`（摄入/校验/编译/发布/查询）、`metrics.json`（AOF 查询指标）、`baseline-metrics.json`（对照基线）。台账不含笔记原文，只有路径、sha256 与指标。

## 2026-09-15 实测结果（andrewchay Vault，30 篇）

- 发布链路全通：ingest succeeded → validate conforms → publish verify=true。
- 查询 hit@1：30/30（标题查询命中自身文档）。
- 越权负例：5/5 未入库文档标题查询 0 命中，零泄漏。
- 延迟：平均 0.9ms，最大 1.4ms（本地 SQLite/RDF，无模型调用）。
- 对照基线：样本显式 wikilink 仅 11 条，suggestLinks（阈值 50）0 条；AOF 路线的增量主要在治理、版本化证据与 release-pinned 隔离，而非召回数量。
