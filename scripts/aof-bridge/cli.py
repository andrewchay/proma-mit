#!/usr/bin/env python3
"""AOF bridge CLI：Gravitas knowledge-aof-adapter 的固定传输入口。

协议：stdin/stdout JSON 帧（每行一个 JSON 对象）。请求：
  {"op": "health"}
  {"op": "build", "kb_id": "...", "docs": [{"relative_path","title","content","sha256"}]}
  {"op": "query", "query": "...", "limit": 5}
响应：{"ok": true, ...} 或 {"ok": false, "error": {"type","message"}}

边界：
- 只使用 AOF bridge 公开 API；不修改 AOF。
- 签名密钥从环境变量 AOF_BRIDGE_SECRET 读取，绝不回显。
- 构建角色标签是本地流程字段（editor/validator/reviewer/publisher），
  非认证身份；调用方 UI 必须如实展示。
- 所有状态写入调用方指定的 --state-dir，不触碰 AOF 仓库数据目录。

用法：
  <aof-venv-python> cli.py --aof-root <AOF路径> --state-dir <dir>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path


def slug(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def resolve_links(docs: list[dict]) -> tuple[list[dict], int]:
    """wikilink 唯一标题匹配连边；多义键断开。返回 (docs, dropped_ambiguous)。"""
    title_to_paths: dict[str, list[str]] = {}
    for d in docs:
        title_to_paths.setdefault(d["title"], []).append(d["relative_path"])
    dropped = 0
    for d in docs:
        resolved = []
        for link in d.get("links", []):
            candidates = title_to_paths.get(link.strip(), [])
            if len(candidates) == 1 and candidates[0] != d["relative_path"]:
                resolved.append(candidates[0])
            elif len(candidates) > 1:
                dropped += 1
        d["resolved_links"] = resolved
    return docs, dropped


def op_health(state_dir: Path) -> dict:
    try:
        from bridge.semantic_core import SemanticResource  # noqa: F401
        return {"ok": True, "aof": "importable"}
    except Exception as exc:
        return {"ok": False, "error": {"type": "AofUnavailable", "message": str(exc)[:300]}}


def op_build(state_dir: Path, kb_id: str, docs: list[dict]) -> dict:
    from bridge.decision_provenance import DecisionProvenanceStore
    from bridge.semantic_core import ResourceKind, SemanticResource
    from bridge.semantic_core.compilers import (
        CompilationRunRepository, CompilationRunService, CompilerPolicy,
        default_compiler_registry,
    )
    from bridge.semantic_core.continuous_ingest import (
        ContinuousIngestionService, KnowledgeSource, SourceConnector,
        SourceBatch, SourceConnectorRegistry, SqliteContinuousIngestionRepository,
    )
    from bridge.semantic_core.governance import SemanticGovernanceService
    from bridge.semantic_core.releases import KnowledgeRelease

    docs, dropped = resolve_links(docs)
    ledger: dict = {"kb_id": kb_id, "doc_count": len(docs), "ambiguous_links_dropped": dropped}

    # 1) 摄入（内存连接器 + SQLite 仓储，全部在 state_dir）
    class MemConnector(SourceConnector):
        def __init__(self, doc_list: list[dict]):
            self.docs = doc_list

        def fetch(self, source, cursor):
            records = tuple(
                {"id": f"doc-{slug(d['relative_path'])}", "path": d["relative_path"],
                 "content_sha256": d["sha256"], "title": d["title"], "links": d.get("resolved_links", [])}
                for d in self.docs
            )
            return SourceBatch.create(cursor_from=cursor, cursor_to=f"snapshot-{hashlib.sha256(json.dumps([d['sha256'] for d in self.docs]).encode()).hexdigest()[:16]}", records=records, source_snapshot={"doc_count": len(records)})

    repo = SqliteContinuousIngestionRepository(state_dir / "ingestion.sqlite3")
    decisions = DecisionProvenanceStore(state_dir / "decisions.jsonl")
    registry = SourceConnectorRegistry()
    registry.register("knowledge-snapshot", MemConnector(docs))
    svc = ContinuousIngestionService(repo, registry, decisions=decisions)
    ks = KnowledgeSource.create(source_id=f"kb-{slug(kb_id)}", tenant_id="gravitas",
                                source_type="knowledge-snapshot", owner="gravitas-adapter",
                                config={"kb_id": kb_id})
    repo.register_source(ks)
    run = svc.ingest_once(ks.source_id, tenant_id="gravitas", actor="gravitas-adapter")
    ledger["ingest"] = {"status": run.status, "run_digest": run.run_digest}
    if run.status != "succeeded":
        return {"ok": False, "error": {"type": "IngestFailed", "message": "ingestion did not succeed"}, "ledger": ledger}

    # 2) 语义资源
    resources = [
        SemanticResource.create(resource_id="aof://gravitas/knowledge/ontology/knowledge",
                                kind=ResourceKind.ONTOLOGY, name="knowledge", domain="knowledge",
                                owner="gravitas-adapter",
                                spec={"format": "turtle", "content": "@prefix ex: <https://example.test/> . ex:Doc a ex:Entity ."}),
        SemanticResource.create(resource_id="aof://gravitas/knowledge/retrieval-profile/default",
                                kind=ResourceKind.RETRIEVAL_PROFILE, name="default", domain="knowledge",
                                owner="gravitas-adapter", spec={"strategy": "keyword", "top_k": 10}),
        SemanticResource.create(resource_id="aof://gravitas/platform/policy/query-adapter",
                                kind=ResourceKind.POLICY, name="query-adapter", domain="platform",
                                owner="gravitas-adapter",
                                spec={"policy_type": "query", "role_capabilities": {"analyst": ["semantic_search"]}}),
        SemanticResource.create(resource_id="aof://gravitas/platform/policy/compiler-adapter",
                                kind=ResourceKind.POLICY, name="compiler-adapter", domain="platform",
                                owner="gravitas-adapter",
                                spec={"policy_type": "compiler",
                                      "allowed_compilers": {"owl": ["owl@1"], "rag": ["rag@1"], "semantic-json": ["semantic-json@1"]}}),
    ]
    path_to_id = {d["relative_path"]: f"aof://gravitas/knowledge/concept/doc-{slug(d['relative_path'])}" for d in docs}
    for d in docs:
        depends = [path_to_id[p] for p in d.get("resolved_links", []) if p in path_to_id and p != d["relative_path"]]
        resources.append(SemanticResource.create(
            resource_id=path_to_id[d["relative_path"]], kind=ResourceKind.CONCEPT,
            name=d["title"], domain="knowledge", owner="gravitas-adapter",
            depends_on=depends,
            spec={"source_path": d["relative_path"], "content_sha256": d["sha256"]}))
    ledger["resource_count"] = len(resources)

    # 3) 治理发布（本地角色标签，非认证身份）
    gov = SemanticGovernanceService(state_dir / "semantic-governance", decision_store=decisions,
                                    compiler_registry=default_compiler_registry())
    attempt = f"{time.strftime('%Y.%m.%d.%H%M%S')}-{time.time_ns()}"
    release_id = f"kb-{slug(kb_id)}@{attempt}"
    proposal = gov.create_proposal(proposal_id=f"prop-{slug(kb_id + release_id)}-{time.time_ns()}", release_id=release_id,
                                   resources=resources, actor="editor:gravitas-local", rationale="Gravitas knowledge graph build.")
    review = gov.validate(proposal["proposal_id"], actor="validator:gravitas-local")
    if not review["conforms"]:
        return {"ok": False, "error": {"type": "ValidationFailed", "message": json.dumps(review, ensure_ascii=False)[:500]}, "ledger": ledger}
    gov.approve(proposal["proposal_id"], actor="reviewer:gravitas-local", rationale="Local build.")
    compiled = gov.compile(proposal["proposal_id"], actor="compiler:gravitas-local", targets=["semantic-json"])
    published = gov.publish(proposal["proposal_id"], actor="publisher:gravitas-local")
    release_digest = published["release"]["release_digest"]
    release = KnowledgeRelease.from_dict(published["release"])
    ledger["publish"] = {"release_id": release_id, "release_digest": release_digest, "verify": release.verify()}

    # 4) 查询运行时：rag 编译 → replay → promote
    release2 = KnowledgeRelease.build(release_id=release_id, resources=resources, scope={"tenant_id": "gravitas"})
    compiler_repo = CompilationRunRepository(state_dir / "compiler" / "gravitas")
    policy_res = next(r for r in resources if r.spec.get("policy_type") == "compiler")
    comp_policy = CompilerPolicy.from_resource(policy_res)
    comp_svc = CompilationRunService(compiler_repo, registry=default_compiler_registry(), decision_store=decisions)
    plan = default_compiler_registry().plan(release2, resources=resources, targets=["rag"])
    compile_run_1 = f"compile-{slug(release_id)}-1"
    compile_run_2 = f"compile-{slug(release_id)}-2"
    comp_svc.execute(run_id=compile_run_1, plan=plan, policy=comp_policy,
                     release=release2, resources=resources, actor="compiler:gravitas-local", rationale="build")
    replay = comp_svc.replay(compile_run_1, run_id=compile_run_2,
                             policy=comp_policy, release=release2, resources=resources,
                             actor="compiler:gravitas-local", rationale="reproduce")
    comp_svc.promote(replay.run_id, channel="production", actor="publisher:gravitas-pub",
                     approved_by="reviewer:gravitas-review", rationale="promote")
    ledger["query_runtime"] = {"promoted_channel": "production", "run_id": replay.run_id}
    return {"ok": True, "release_id": release_id, "release_digest": release_digest, "ledger": ledger}


def op_query(state_dir: Path, query: str, limit: int, expected_release_digest: str | None) -> dict:
    from bridge.semantic_core import (
        QueryCapability, QueryExecutor, QueryRequest, TrustedSnapshotResolver,
    )
    from bridge.semantic_core.compilers import CompilationRunRepository as CRR
    repo = CRR(state_dir / "compiler" / "gravitas")
    resolver = TrustedSnapshotResolver(repo)
    executor = QueryExecutor(resolver)
    request = QueryRequest.create(channel="production", capability=QueryCapability.SEMANTIC_SEARCH,
                                  query=query, purpose="gravitas-knowledge",
                                  parameters=({"limit": limit, "expected_release_digest": expected_release_digest}
                                              if expected_release_digest else {"limit": limit}))
    plan = resolver.plan(request, tenant_id="gravitas")
    result = executor.execute(plan)
    hits = [{"resource_id": h.get("resource_id"), "name": h.get("name"), "kind": h.get("kind")}
            for h in result.data.get("hits", [])]
    return {"ok": True, "hits": hits, "count": len(hits),
            "release_digest": plan.parameters.get("expected_release_digest"),
            "evidence_count": len(result.evidence)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--aof-root", default="/Users/chaihao/LLM/AOF")
    args = parser.parse_args()

    sys.path.insert(0, args.aof_root)
    state_dir = Path(args.state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)

    secret = os.environ.get("AOF_BRIDGE_SECRET", "")
    if not secret:
        print(json.dumps({"ok": False, "error": {"type": "MissingSecret", "message": "AOF_BRIDGE_SECRET not set"}}))
        return

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            op = req.get("op")
            if op == "health":
                resp = op_health(state_dir)
            elif op == "build":
                resp = op_build(state_dir, str(req["kb_id"]), list(req["docs"]))
            elif op == "query":
                resp = op_query(state_dir, str(req["query"]), int(req.get("limit", 5)), req.get("expected_release_digest"))
            else:
                resp = {"ok": False, "error": {"type": "UnknownOp", "message": f"unknown op: {op}"}}
        except Exception as exc:
            import traceback
            traceback.print_exc(file=sys.stderr)
            resp = {"ok": False, "error": {"type": type(exc).__name__, "message": str(exc)[:500]}}
        print(json.dumps(resp, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
