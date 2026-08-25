# Phase 2: 召回层升级 —— 借鉴 mycontext

## 目标
将当前简单的 LIKE 子串匹配升级为 mycontext 式的两档词元召回 + RRF 多路融合。

## 当前问题
- 使用 `LIKE '%term%'` 子串匹配，无法处理中文分词
- 无放宽机制：换词序就搜不到（"部署沙箱" vs "沙箱环境部署"）
- 无多路融合：只有一路文本召回
- tokens 返回的是空格分词，不是真正的检索词元

## 借鉴 mycontext 的设计

### 1. CJK Bigram 分词（`bigram.ts`）
- **单字 + 相邻二字**：「沙箱环境」→ `沙 沙箱 箱 环境 境`
- **ASCII 词原样保留**：`deploy` 不切 `dep epl plo`
- **单趟扫描**：token 顺序与原文一致（为将来 NEAR/phrase 查询留空间）

### 2. 两档词元召回（`recall.ts`）
- **严格档**：全部 token AND（含 CJK bigram）
- **放宽档**：去掉 CJK bigram，只留单字 + ASCII 词
- **策略**：严格档优先，只有 0 结果时才跑放宽档
- **原因**：换词序查询（"部署沙箱"）含跨词 bigram（`署沙`），原文不存在 → 0 命中

### 3. RRF 多路融合（`fuse.ts`）
- **RRF 公式**：`score = Σ 1/(k + rank_i)`，k=60
- **为什么不用加权分数**：FTS bm25 / 向量余弦 / 图谱置信度量纲不可比
- **偏好多路认可**：被多路命中的结果排名更高

### 4. FTS5 MATCH 安全构造（`match-expr.ts`）
- 逐 token 用 `"..."` 包裹，内部 `"` 双写
- 防止用户输入 `*` / `-` / `OR` 等 FTS 语法字符导致报错或被篡改语义

## 实施计划

### P2.1 Bigram 分词 + 两档召回
- [ ] 新建 `src/retrieval/tokenizer.ts`：CJK bigram + ASCII 词切分
- [ ] 改造 `SearchRepository.recall`：两档词元（严格 → 放宽）
- [ ] 更新 `RecallResult`：标记是否用了放宽档
- [ ] 测试：严格档命中、放宽档兜底、换词序召回

### P2.2 RRF 多路融合框架
- [ ] 新建 `src/retrieval/fuse.ts`：RRF 融合算法
- [ ] 改造 `recall` 接口：支持多路输入（FTS + 图谱 + 未来向量）
- [ ] 测试：多路命中排序、单路降级

### P2.3 召回结果渲染
- [ ] 新建 `src/retrieval/recall-render.ts`：把召回结果格式化为模型提示文本
- [ ] 带序号、时间、来源标注（模型能引用"根据 6月3日那条"）

## 关键约束
- 不引入向量检索（KNN）—— 需要 embedding 模型，超出当前范围
- 不引入 FTS5（sql.js 标准包不携带）—— 继续用 LIKE，但通过 bigram 提升效果
- 保持现有 API：`recall(handle, query, options)` 不变
