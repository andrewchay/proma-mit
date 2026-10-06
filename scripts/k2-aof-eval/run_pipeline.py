#!/usr/bin/env python3
"""K2-01 AOF 对照小样验证 pipeline。

只读消费评测样本（临时目录快照，来自 select_sample.ts），
在隔离临时状态目录中走 AOF reference-local 本地链路：

  摄入(ContinuousIngestionService) → 语义资源(由 wikilink 确定性派生)
  → governance proposal → validate → approve → compile → publish
  → release-pinned semantic_search 查询 → 证据与指标台账

边界声明：
- 不修改 AOF 源码；只按其公开的 bridge API 组装本地流程。
- 角色标签(editor/validator/reviewer/publisher)是 AOF reference-local
  设计的本地流程字段，不是认证身份；报告中必须注明。
- 无 LLM 调用：embedding 不走 fastembed（避免首次下载模型），检索对照
  由 release 编译产物 + 关键词/词面匹配完成；如需真实 embedding 另行批准。
- 不输出笔记原文，台账只含路径、sha256、chunk 序号与指标。

用法：
  /Users/chaihao/LLM/AOF/.venv/bin/python run_pipeline.py \
      --sample-dir <select_sample 输出目录> \
      --manifest <sample-manifest.json> \
      --out <eval 输出目录>
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

AOF_ROOT = Path("/Users/chaihao/LLM/AOF")
sys.path.insert(0, str(AOF_ROOT))

from bridge.decision_provenance import DecisionProvenanceStore  # noqa: E402
from bridge.semantic_core import ResourceKind, SemanticResource  # noqa: E402
from bridge.semantic_core.compilers import (  # noqa: E402
    CompilationRunRepository,
    CompilationRunService,
    CompilerPolicy,
    default_compiler_registry,
)
from bridge.semantic_core.continuous_ingest import (  # noqa: E402
    ContinuousIngestionService,
    KnowledgeSource,
    SourceConnector,
    SourceBatch,
    SourceConnectorRegistry,
    SqliteContinuousIngestionRepository,
)
from bridge.semantic_core.governance import SemanticGovernanceService  # noqa: E402
from bridge.semantic_core.identity import SignedPrincipalVerifier  # noqa: E402
from bridge.semantic_core.query_execution import (  # noqa: E402
    QueryCapability,
    QueryExecutor,
    QueryRequest,
)
from bridge.semantic_core.releases import KnowledgeRelease  # noqa: E402

WIKILINK = re.compile(r"\[\[([^\]|#]+)")


def slug(text: str) -> str:
    import hashlib
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def load_docs(sample_dir: Path, manifest_path: Path) -> list[dict]:
    manifest = json.loads(manifest_path.read_text())
    docs = []
    for entry in manifest["files"]:
        path = sample_dir / entry["relativePath"]
        content = path.read_text(encoding="utf-8", errors="replace")
        title = path.stem
        links = [m.strip() for m in WIKILINK.findall(content)]
        docs.append({
            "relativePath": entry["relativePath"],
            "sha256": entry["sha256"],
            "sizeBytes": entry["sizeBytes"],
            "title": title,
            "links": links,
        })
    return docs


class MarkdownSnapshotConnector(SourceConnector):
    """最小 Markdown 目录连接器：一次 fetch 全量返回（样本仅 30 篇）。"""

    def __init__(self, docs: list[dict]) -> None:
        self.docs = docs

    def fetch(self, source, cursor):  # noqa: ANN001
        records = tuple(
            {
                "id": f"doc-{slug(d['relativePath'])}",
                "path": d["relativePath"],
                "content_sha256": d["sha256"],
                "size_bytes": d["sizeBytes"],
                "title": d["title"],
                "links": d["links"],
            }
            for d in self.docs
        )
        return SourceBatch.create(
            cursor_from=cursor,
            cursor_to="full-snapshot-1",
            records=records,
            source_snapshot={"doc_count": len(records)},
        )


def build_resources(docs: list[dict]):
    path_to_id = {d["relativePath"]: f"aof://k2/knowledge/concept/doc-{slug(d['relativePath'])}" for d in docs}
    title_to_paths: dict[str, list[str]] = {}
    for d in docs:
        title_to_paths.setdefault(d["title"], []).append(d["relativePath"])

    resources: list[SemanticResource] = [
        SemanticResource.create(
            resource_id="aof://k2/knowledge/ontology/knowledge",
            kind=ResourceKind.ONTOLOGY,
            name="knowledge",
            domain="knowledge",
            owner="k2-eval",
            spec={"format": "turtle", "content": "@prefix ex: <https://example.test/> . ex:Doc a ex:Entity ."},
        ),
        SemanticResource.create(
            resource_id="aof://k2/knowledge/retrieval-profile/default",
            kind=ResourceKind.RETRIEVAL_PROFILE,
            name="default",
            domain="knowledge",
            owner="k2-eval",
            spec={"strategy": "keyword", "top_k": 5},
        ),
        SemanticResource.create(
            resource_id="aof://k2/platform/policy/query-eval",
            kind=ResourceKind.POLICY,
            name="query-eval",
            domain="platform",
            owner="k2-eval",
            spec={"policy_type": "query", "role_capabilities": {"analyst": ["semantic_search", "semantic_sql", "graph"]}},
        ),
        SemanticResource.create(
            resource_id="aof://k2/platform/policy/compiler-eval",
            kind=ResourceKind.POLICY,
            name="compiler-eval",
            domain="platform",
            owner="k2-eval",
            spec={
                "policy_type": "compiler",
                "allowed_compilers": {
                    "owl": ["owl@1"], "datalog": ["datalog@1"], "rag": ["rag@1"],
                    "mcp": ["mcp@1"], "semantic-json": ["semantic-json@1"],
                },
            },
        ),
    ]
    link_count = 0
    ambiguous = 0
    for d in docs:
        rid = path_to_id[d["relativePath"]]
        depends = []
        for link in d["links"]:
            # 唯一标题匹配才连边；多义键宁可断开（与 Gravitas K1-06 同规则）
            candidates = title_to_paths.get(link.strip(), [])
            if len(candidates) == 1 and candidates[0] != d["relativePath"]:
                depends.append(path_to_id[candidates[0]])
                link_count += 1
            elif len(candidates) > 1:
                ambiguous += 1
        resources.append(SemanticResource.create(
            resource_id=rid,
            kind=ResourceKind.CONCEPT,
            name=d["title"],
            domain="knowledge",
            owner="k2-eval",
            depends_on=depends,
            spec={"source_path": d["relativePath"], "content_sha256": d["sha256"]},
        ))
    return resources, link_count, ambiguous


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-dir", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    sample_dir, out_dir = Path(args.sample_dir), Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    ledger = out_dir / "ledger.jsonl"

    def log(event: dict) -> None:
        event["ts"] = time.time()
        with ledger.open("a") as f:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")

    docs = load_docs(sample_dir, Path(args.manifest))
    log({"event": "sample_loaded", "count": len(docs)})

    # 1) 摄入
    state = out_dir / "aof-state"
    repo = SqliteContinuousIngestionRepository(state / "ingestion.sqlite3")
    decisions = DecisionProvenanceStore(state / "decisions.jsonl")
    registry = SourceConnectorRegistry()
    registry.register("markdown-snapshot", MarkdownSnapshotConnector(docs))
    service = ContinuousIngestionService(repo, registry, decisions=decisions)
    ks = KnowledgeSource.create(
        source_id="k2-sample", tenant_id="k2", source_type="markdown-snapshot",
        owner="k2-eval", config={"root": str(sample_dir)},
    )
    repo.register_source(ks)
    run = service.ingest_once("k2-sample", tenant_id="k2", actor="k2-eval")
    log({"event": "ingest", "status": run.status, "run_digest": run.run_digest,
         "record_count": getattr(run, "record_count", None)})
    if run.status != "succeeded":
        print("INGEST FAILED", file=sys.stderr)
        sys.exit(2)

    # 2) 语义资源
    resources, link_count, ambiguous = build_resources(docs)
    log({"event": "resources", "count": len(resources), "explicit_links": link_count, "ambiguous_dropped": ambiguous})

    # 3) 治理发布（本地角色标签，非认证身份——报告注明）
    gov = SemanticGovernanceService(
        state / "semantic-governance", decision_store=decisions,
        compiler_registry=default_compiler_registry(),
    )
    proposal = gov.create_proposal(
        proposal_id="k2-release-001", release_id="k2-knowledge@0.1.0",
        resources=resources, actor="editor:k2-eval", rationale="K2 sample release.",
    )
    review = gov.validate(proposal["proposal_id"], actor="validator:k2-eval")
    log({"event": "validate", "conforms": review["conforms"]})
    if not review["conforms"]:
        print(json.dumps(review, ensure_ascii=False)[:2000], file=sys.stderr)
        sys.exit(3)
    gov.approve(proposal["proposal_id"], actor="reviewer:k2-eval", rationale="K2 eval.")
    compiled = gov.compile(proposal["proposal_id"], actor="compiler:k2-eval", targets=["semantic-json"])
    log({"event": "compile", "state": compiled["state"]})
    published = gov.publish(proposal["proposal_id"], actor="publisher:k2-eval")
    release_digest = published["release"]["release_digest"]
    release = KnowledgeRelease.from_dict(published["release"])
    log({"event": "publish", "release_digest": release_digest, "verify": release.verify()})

    # 4) 查询运行时：编译 rag 产物 → replay 复现 → promote 到 production 通道
    release2 = KnowledgeRelease.build(
        release_id="k2-knowledge@0.1.0", resources=resources, scope={"tenant_id": "k2"},
    )
    compiler_repo = CompilationRunRepository(state / "compiler" / "k2")
    compiler_policy = CompilerPolicy.from_resource(next(r for r in resources if r.spec.get("policy_type") == "compiler"))
    comp_service = CompilationRunService(compiler_repo, registry=default_compiler_registry(), decision_store=decisions)
    compile_plan = default_compiler_registry().plan(release2, resources=resources, targets=["rag"])
    comp_service.execute(run_id="k2-compile-001", plan=compile_plan, policy=compiler_policy,
                         release=release2, resources=resources, actor="compiler:k2-eval", rationale="K2 eval.")
    replay = comp_service.replay("k2-compile-001", run_id="k2-compile-002", policy=compiler_policy,
                                 release=release2, resources=resources, actor="compiler:k2-eval", rationale="Reproduce.")
    comp_service.promote(replay.run_id, channel="production", actor="publisher:k2-eval-pub",
                         approved_by="reviewer:k2-eval-review", rationale="Promote K2 query runtime.")

    from bridge.semantic_core import QueryExecutor, QueryRequest, QueryCapability, TrustedSnapshotResolver, TrustedQueryError, SignedPrincipalVerifier  # type: ignore
    resolver = TrustedSnapshotResolver(compiler_repo)
    executor = QueryExecutor(resolver)
    verifier = SignedPrincipalVerifier(key_id="k2-eval-key", secret=b"k2-eval-local-secret")

    # 查询集：每篇文档标题作为查询（应命中自身）+ 从 Vault 全量标题取 5 个未入库文档作负例
    import os
    vault_root = json.loads(Path(args.manifest).read_text())["vault"]
    sample_titles = {d["title"] for d in docs}
    all_titles: list[str] = []
    for root_dir, dir_names, file_names in os.walk(vault_root):
        dir_names[:] = [x for x in dir_names if x not in {"99 - Archive", "Apple Notes", "Attachments", ".obsidian", "AOF-review", ".trash", ".git"}]
        for fn in file_names:
            if fn.endswith(".md") and fn[:-3] not in sample_titles:
                all_titles.append(fn[:-3])
    negative = sorted(set(all_titles))[:5]

    metrics = {"queries": [], "positives": [], "negatives": []}
    headers = verifier.sign_headers(subject="k2-analyst", tenant_id="k2", roles=["analyst"])
    for d in docs:
        request = QueryRequest.create(
            channel="production", capability=QueryCapability.SEMANTIC_SEARCH,
            query=d["title"], purpose="k2-eval", parameters={"limit": 5},
        )
        t0 = time.time()
        try:
            plan = resolver.plan(request, tenant_id="k2")
            result = executor.execute(plan)
            hits = result.data.get("hits", [])
            rank = next((i for i, h in enumerate(hits) if h.get("resource_id", "").endswith(f"doc-{slug(d['relativePath'])}")), None)
            metrics["queries"].append({"query": d["title"], "doc": d["relativePath"], "rank": rank, "hits": len(hits), "latency_ms": round((time.time() - t0) * 1000, 1), "evidence": len(result.evidence)})
            if rank is not None:
                metrics["positives"].append(d["relativePath"])
        except TrustedQueryError as exc:
            metrics["queries"].append({"query": d["title"], "error": str(exc)[:200]})
    for q in negative:
        request = QueryRequest.create(channel="production", capability=QueryCapability.SEMANTIC_SEARCH, query=q, purpose="k2-eval", parameters={"limit": 5})
        try:
            plan = resolver.plan(request, tenant_id="k2")
            result = executor.execute(plan)
            hits = result.data.get("hits", [])
            metrics["negatives"].append({"query": q, "hits": len(hits), "leak": bool(hits)})
        except TrustedQueryError as exc:
            metrics["negatives"].append({"query": q, "error": str(exc)[:200]})

    (out_dir / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2))
    hit_at_1 = sum(1 for q in metrics["queries"] if q.get("rank") == 0)
    evaluated = sum(1 for q in metrics["queries"] if "rank" in q)
    print(json.dumps({
        "sample": len(docs), "publish": release.verify(),
        "hit_at_1": f"{hit_at_1}/{evaluated}",
        "negative_leaks": sum(1 for n in metrics["negatives"] if n.get("leak")),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
