#!/usr/bin/env python3
"""K2-02 T1：fastembed 稠密检索对照评测（本地 ONNX，无云端调用）。

对同一份 30 篇样本，比较三条检索路线的 Recall@5：
  A. 稠密向量（fastembed bge-small-zh-v1.5，本地）
  B. 稀疏 TF 余弦（模拟 AOF _semantic_search retrieval_mode=vector 的算法）
  C. Gravitas 关键词整串 includes（knowledge-service 现行为）

查询集：
  Q1 标题查询（自检索，可比基线）
  Q2 内容片段查询（取正文第 2~3 段前 160 字，稠密优势场景）

输出 dense-metrics.json：各路线 Recall@5、MRR、平均延迟。

用法：
  /Users/chaihao/LLM/AOF/.venv/bin/python run_dense_eval.py \
      --sample-dir <dir> --manifest <json> --out <dir>
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
from collections import Counter
from pathlib import Path

WIKILINK = re.compile(r"\[\[([^\]|#]+)")


def load_docs(sample_dir: Path, manifest_path: Path) -> list[dict]:
    manifest = json.loads(manifest_path.read_text())
    docs = []
    for entry in manifest["files"]:
        content = (sample_dir / entry["relativePath"]).read_text(encoding="utf-8", errors="replace")
        # 去掉 wikilink 语法再切正文段落，避免链接文本泄漏答案
        plain = re.sub(r"\[\[([^\]|#]+)(\|[^\]]*)?\]\]", r"\1", content)
        paragraphs = [p.strip() for p in plain.split("\n\n") if len(p.strip()) >= 40]
        snippet = paragraphs[1][:160] if len(paragraphs) > 1 else (paragraphs[0][:160] if paragraphs else plain[:160])
        docs.append({
            "relativePath": entry["relativePath"],
            "title": Path(entry["relativePath"]).stem,
            "text": plain,
            "snippet": snippet,
        })
    return docs


def tokenize(text: str) -> list[str]:
    return re.findall(r"[a-zA-Z0-9]+|[\u4e00-\u9fff]", text.lower())


def sparse_cosine_rank(query: str, docs: list[dict], top_k: int = 5) -> list[int]:
    q = Counter(tokenize(query))
    qn = math.sqrt(sum(v * v for v in q.values())) or 1.0
    scores = []
    for i, d in enumerate(docs):
        t = Counter(tokenize(d["text"]))
        dot = sum(v * t.get(k, 0) for k, v in q.items())
        dn = math.sqrt(sum(v * v for v in t.values())) or 1.0
        scores.append(dot / (qn * dn))
    ranked = sorted(range(len(docs)), key=lambda i: (-scores[i], i))
    return ranked[:top_k]


def keyword_rank(query: str, docs: list[dict], top_k: int = 5) -> list[int]:
    """模拟 Gravitas knowledge-service 的整串 includes 加权。"""
    scores = []
    for i, d in enumerate(docs):
        s = 0
        if query in d["text"]:
            s += 3
        if query in d["title"]:
            s += 5
        scores.append(s)
    ranked = [i for i in sorted(range(len(docs)), key=lambda i: (-scores[i], i)) if scores[i] > 0]
    return ranked[:top_k]


def eval_route(rank_fn, queries: list[tuple[str, int]], top_k: int = 5) -> dict:
    recall_hits, rr, latencies = 0, 0.0, []
    for query, gold in queries:
        t0 = time.time()
        ranked = rank_fn(query, top_k)
        latencies.append((time.time() - t0) * 1000)
        if gold in ranked:
            recall_hits += 1
            rr += 1.0 / (ranked.index(gold) + 1)
    n = len(queries)
    return {"recall@5": round(recall_hits / n, 3), "mrr": round(rr / n, 3),
            "avg_latency_ms": round(sum(latencies) / n, 2)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sample-dir", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="BAAI/bge-small-zh-v1.5")
    args = parser.parse_args()

    docs = load_docs(Path(args.sample_dir), Path(args.manifest))

    from fastembed import TextEmbedding  # 本地 ONNX

    t0 = time.time()
    model = TextEmbedding(model_name=args.model)
    load_s = round(time.time() - t0, 1)

    def dense_rank_fn_factory(corpus: list[str]):
        embs = list(model.embed(corpus))

        def rank(query: str, top_k: int = 5) -> list[int]:
            import numpy as np
            q = np.array(list(model.embed([query]))[0])
            scores = embs @ q / (np.linalg.norm(embs, axis=1) * np.linalg.norm(q) + 1e-9)
            return list(np.argsort(-scores)[:top_k])
        return rank

    queries_title = [(d["title"], i) for i, d in enumerate(docs)]
    queries_snippet = [(d["snippet"], i) for i, d in enumerate(docs)]

    results: dict = {"model": args.model, "model_load_seconds": load_s, "docs": len(docs), "routes": {}}

    for qname, queries in (("title", queries_title), ("snippet", queries_snippet)):
        dense = dense_rank_fn_factory([d["text"] for d in docs])
        results["routes"][f"dense/{qname}"] = eval_route(lambda q, k, f=dense: f(q, k), queries)
        results["routes"][f"sparse-tf-cosine/{qname}"] = eval_route(lambda q, k: sparse_cosine_rank(q, docs, k), queries)
        results["routes"][f"keyword-includes/{qname}"] = eval_route(lambda q, k: keyword_rank(q, docs, k), queries)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "dense-metrics.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    for k, v in results["routes"].items():
        print(f"{k}: recall@5={v['recall@5']} mrr={v['mrr']} latency={v['avg_latency_ms']}ms")
    print(f"model_load: {load_s}s ({args.model})")


if __name__ == "__main__":
    main()
