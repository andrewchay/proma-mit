---
name: ma-image-audit
description: 达人稿件图片审核。用 Kimi 视觉模型逐图审核场景/构图/品牌露出/合规等维度，输出逐图问题（含 severity 严重度标记）与内部评分。供 ma-draft-review 审核稿件图片时调用（据 has_critical 判红卡）；当需要审核图片、判断画面质量与品牌露出时使用。
version: "1.0.1"
---

# 达人稿件图片审核

用视觉模型审核达人稿件中的图片，输出结构化评分与逐图修改建议。

## 何时使用

**合适的场景：**
- 达人稿件/内容中的图片审核（ma-draft-review 调用）
- 图文、封面、产品图的质量与品牌露出检查

**不合适的场景：**
- 纯文字审核 → 用 `ma-content-audit`
- 视频画面审核（当前不覆盖）

## 调用协议

**输入**（由调用方提供）：
- 图片列表（按顺序编号，如 图1、图2…）
- 品牌与产品信息（用于判断品牌露出与契合度）
- brief 中与画面相关的视觉要求（可选）

**输出**：JSON，供调用方组装为最终回复：

```json
{
  "image_score": 50,
  "images": [
    {
      "index": 1,
      "issues": [
        { "issue": "三张图重复同质化", "suggestion": "换不同场景/角度", "severity": "critical" },
        { "issue": "无品牌露出", "suggestion": "补一张带品牌盒的图", "severity": "critical" }
      ]
    }
  ],
  "overall_issues": [
    { "location": "图片1/图片2", "issue": "问题描述", "suggestion": "修改建议", "severity": "critical | warning" }
  ],
  "has_critical": false
}
```

- `image_score` 取各图最低分或整体观感分（0-100，**内部参考**，不用于调用方红黄判定）
- `severity`：**critical = 硬伤**（品牌露出缺失 / 构图大面积同质化 / 画面不可用 / 违禁画面）；**warning = 建议**（轻微瑕疵、可优化点），缺省 warning
- `has_critical`：任一 overall_issues 为 critical 时为 true；调用方（ma-draft-review）据此判红卡
- `overall_issues` 合并逐图问题，`location` 用 `图片N` 锚点，与 ma-draft-review 修改意见的 `[图片N]` 对应

## 工作流

### Step 1 · 配置检查
用 `KIMI_API_KEY` + OpenAI 兼容协议调 `moonshot-v1-8k-vision-preview`（`KIMI_BASE_URL` 默认 `https://api.moonshot.cn/v1`，`KIMI_MODEL` 可覆盖）。未配置或调用失败 → 返回 `{ "image_score": null, "has_critical": false, "error": "Kimi 未配置" }`，由调用方降级为纯文字审核。可用 MAPro 渠道多模态模型替代。

### Step 2 · 逐图审核

每张图按以下维度检查：

| 维度 | 检查要点 |
|------|---------|
| 场景氛围 | 场景是否贴合品牌调性（如居家/外出/办公） |
| 产品特写 | 产品是否清晰、突出卖点 |
| 构图重复 | 多图间是否同质化（角度/场景/内容重复） |
| 摆拍痕迹 | 是否过度摆拍、不自然 |
| 品牌露出 | 品牌/产品名是否露出（logo、包装、标签） |
| 画面质量 | 清晰度、光线、构图美观 |
| 合规 | 违禁内容、虚假宣传、敏感画面 |

### Step 3 · 输出
每张图列出问题与建议并标注 `severity`，合并为 `overall_issues`，给出 `image_score`（内部参考）与 `has_critical`。

## 规则

1. **品牌露出是核心**：关键场景必须有品牌/产品露出，缺失标 critical
2. **构图重复**：多图大面积同质化标 critical，必须明确指出"第几张与第几张重复"；轻微重复标 warning
3. **画面不可用即 critical**：模糊、过暗、构图失衡到无法使用的图片，标 critical 并给出重拍方向
4. **合规一票否决**：违禁画面、虚假宣传画面标 critical，`has_critical` = true
5. **建议可操作**：每条问题附具体改法（"换不同场景/角度""补一张带品牌盒的图"）
6. **图片顺序稳定**：`图片N` 的编号与调用方传入顺序一致，不得重排
