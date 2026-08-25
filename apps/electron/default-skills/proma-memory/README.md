# Proma Memory Plugin

> 版本: 0.1.0  
> 作者: Gravitas Team  
> 描述: 长期记忆和主动反思 routines

## 包含 Routines

- `memory-daily` — 每日记忆整理
- `memory-init` — 记忆初始化
- `weekly-review` — 周回顾

## 数据目录

```
~/.gravitas/plugins/proma-memory/
  data/
    profile.md          # 用户档案
    corrections/        # 纠正记录
    sop-candidates/     # SOP 候选
    memory-log/         # 记忆日志
    diary/              # 工作日记
```

## 使用方式

1. 在 Proactive Center 的 Memory Tab 中启用
2. 创建 `memory-daily` schedule（默认每天 23:30）
3. 运行结果会生成记忆候选，需要审批后写入

## 记忆摄取契约

Agent 输出必须包含 `proma-memory-items` fenced JSON block：

```json
[
  {
    "title": "偏好标题",
    "content": "具体内容",
    "kind": "preference|correction|sop|diary|fact",
    "tags": ["tag1", "tag2"],
    "confidence": 0.9
  }
]
```
