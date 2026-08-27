# Thinking Patterns — 部署指南 (DEPLOY.md)

> 说明如何把本 skill 移植到 Proma 之外的 agent 环境。
> 读本文件前先了解 skill 的三层结构（SKILL.md 顶部有简介）。

---

## 一、三层可移植性速查

| 层 | 文件 | 可移植性 | 备注 |
|---|---|:---:|---|
| 指令层 | `SKILL.md` | ✅ 完全通用 | 任何能设 system prompt 的 agent 可直接用 |
| 工作流层 | `discovery-workflow.js` | ⚠️ Proma 专用 | 依赖 Proma Workflow runtime；其他环境需按逻辑自行实现 |
| 知识库层 | `finder-traces.yaml` + KB YAML | ✅ 可内联 | 直接贴进 prompt 或让 agent 读文件 |

**核心判断**：诊断模式 + 伴随模式 = 纯 LLM 推理，**任何环境开箱即用**。发现模式的 generate→select 循环需要根据目标环境的 multi-agent 能力重新实现。

---

## 二、场景A：Claude API / Anthropic SDK

### 诊断模式 + 伴随模式（直接可用）

把 `SKILL.md` 全文作为 **system prompt**。用户输入命题，模型按 SKILL.md 的 Diagnostic Workflow 跑即可。

```python
import anthropic

with open("SKILL.md") as f:
    system = f.read()

client = anthropic.Anthropic()
response = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=4096,
    system=system,
    messages=[{"role": "user", "content": "用思维范式诊断：<你的命题>"}]
)
```

推荐开启 **prompt caching**（SKILL.md 约 21KB，命中缓存可省 ~90% token 费用）：

```python
response = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=4096,
    system=[{
        "type": "text",
        "text": system,
        "cache_control": {"type": "ephemeral"}  # 缓存 system prompt
    }],
    messages=[{"role": "user", "content": "用思维范式诊断：<你的命题>"}]
)
```

### 发现模式（需自行实现 generate→select 循环）

`discovery-workflow.js` 用的是 Proma 的 `agent()/parallel()` runtime，Claude API 没有。需按以下逻辑自行实现：

```
1. Generate 阶段：
   - 8个 finder × 6个生成性范式 = 48 组合（wide）或选6组（narrow）
   - 每组独立调一次 API，prompt = SKILL.md + finder轨迹(finder-traces.yaml) + 领域/已知/好奇
   - 并发调用（asyncio/ThreadPoolExecutor）提速
   - 收集所有候选，每个附 falsifiable_hypothesis

2. Select 阶段（Stage 1，逐候选）：
   - 每个候选单独调一次 API
   - prompt 强调"默认 kill，写最致命反驳，举证才留"
   - 程序化过滤：重要性<4 / hypothesis_is_specific=false / objection_is_fatal=true 直接丢

3. Select 阶段（Stage 2，横向收敛）：
   - 把所有 Stage1 survivor 一次性丢给一次 API 调用
   - 做去重合并（同一要害的候选并成一簇）+ 强制淘汰
   - 返回最终 N 个簇（N = max(5, ceil(survivors/3))）
```

`finder-traces.yaml` 的内容可直接读取后内联进 Generate 阶段的 prompt（每个 finder 的 `trace` 字段）。

**参考实现片段**（Python，asyncio）：

```python
import asyncio, yaml

with open("finder-traces.yaml") as f:
    traces = {t["finder"].split(" ")[0]: t for t in yaml.safe_load(f)["traces"]}

async def generate_one(p_name, p_move, f_name, f_core, f_trace, domain, known, curiosity):
    trace_section = f"\n【{f_name}的实操轨迹】：\n{f_trace}\n" if f_trace else ""
    prompt = f"""领域：{domain}
已知：{known}
好奇方向：{curiosity}

用【{p_name}】范式 × 【{f_name}】母结构生成候选问题。
范式动作：{p_move}
母结构：{f_core}{trace_section}
每个候选必须附 falsifiable_hypothesis（可证伪具体预测）。宁缺毋滥。"""
    # 调用 claude API ...
    pass

# 并发跑 generate 阶段
combos = [(p, f) for p in GEN_PATTERNS for f in FINDERS]  # wide
tasks = [generate_one(*c, domain, known, curiosity) for c in combos]
results = await asyncio.gather(*tasks)
```

---

## 三、场景B：另一个 Proma 工作区

最简单。直接把 skill 目录复制过去：

```bash
cp -r ~/.proma/agent-workspaces/personal/skills/thinking-patterns \
       ~/.proma/agent-workspaces/<目标工作区>/skills/
```

**知识库（KB）的问题**：`SKILL.md` 的 `knowledge-base` 字段指向 `workspace-files/.context/thinking-patterns-kb/`，这是 personal 工作区的路径。如果目标工作区没有这个 KB，**诊断/伴随模式仍然完全可用**（它们不依赖 KB 文件，只用 SKILL.md 内的 21 范式和 diagnostic_questions）；发现模式的 finder 轨迹已内联进 `discovery-workflow.js`，也不依赖文件读取。

只有当你需要"查阅某位大师的具体著作" 时才需要 KB，可选择性复制：

```bash
cp -r ~/.proma/agent-workspaces/personal/workspace-files/.context/thinking-patterns-kb \
       ~/.proma/agent-workspaces/<目标工作区>/workspace-files/.context/
```

---

## 四、场景C：LangChain / OpenAI 等框架

### 诊断 + 伴随模式（直接可用）

同场景A，把 `SKILL.md` 作为 system prompt：

```python
# LangChain
from langchain_openai import ChatOpenAI
from langchain.schema import SystemMessage, HumanMessage

with open("SKILL.md") as f:
    system = f.read()

llm = ChatOpenAI(model="gpt-4o")
response = llm.invoke([
    SystemMessage(content=system),
    HumanMessage(content="用思维范式诊断：<你的命题>")
])
```

### 发现模式（需要框架的 multi-agent 能力）

参考场景A的逻辑，用框架自带的 multi-agent 工具实现：

- **LangChain**：`RunnableParallel` 做 generate 并发，链式接 Stage1→Stage2
- **OpenAI Assistants**：每个 generate agent 是一个线程，select 是一个汇总线程
- **CrewAI**：每个 finder×范式 组合是一个 Agent，Crew 并发运行后汇总

generate 和 select 的 prompt 逻辑直接从 `discovery-workflow.js` 里的字符串模板翻译即可，框架无关。

---

## 五、注意事项

1. **finder-traces.yaml 要一并带走**：它存了 8 个 finder 的厚轨迹（被否决分支），是发现模式能产出领域特异候选的关键。在非 Proma 环境里，把它的内容内联进 generate prompt（读 YAML → 找对应 finder 的 `trace` 字段 → 插进 prompt）。

2. **test-logs.md 不要移植**：它是含具体业务数据的测试记录，工具运行不需要它。

3. **select 的"默认 kill"是关键**：如果你自行实现 select，prompt 里必须明确"默认裁决是 killed，只有举证说明最强反驳不致命时才 survives"。不加这条，select 会退化成为每个候选辩护（见 `discovery-mode.md` 七节的方法论教训）。

4. **发现模式的 wide 扇出开销不低**：wide = 48 个并发 generate agent + N 个 select agent，成本和延迟都高。建议先用 narrow（6 组合内联）验证领域是否合适，再决定要不要上 wide。
