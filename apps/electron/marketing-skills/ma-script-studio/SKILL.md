---
name: ma-script-studio
description: 脚本工坊专家。为达人内容创作生成详细的故事脚本、分镜脚本和视频拍摄指导。是 ma-creative-pilot 的细化版，专注于脚本执行层。当用户提到"脚本"、"分镜"、"storyboard"、"视频指导"、"拍摄脚本"、"脚本创作"时触发。
version: "1.0.0"
---

# 脚本工坊

## 这个 Skill 做什么

为达人内容创作提供专业的脚本执行方案，覆盖三种核心脚本类型：
- **故事脚本（story）**：完整的故事弧线、场景分解、对话设计和视听注意点
- **分镜脚本（storyboard）**：逐镜头的分镜表、灯光/道具/场地建议
- **视频拍摄指导（video_guide）**：拍摄设备/灯光/收音方案、后期节奏/转场/BGM建议

同时提供平台适配和品牌植入检查，确保脚本可落地执行。

## 何时使用

**合适的场景：**
- 达人内容创作的脚本撰写阶段
- 品牌合作内容的拍摄前准备
- 需要分镜表指导拍摄执行
- 视频拍摄团队需要设备/灯光/收音方案
- 多平台内容需要调整脚本格式和时长

**不合适的场景：**
- 创意概念和 Big Idea 发想阶段（用 ma-creative-concept）
- 纯平面图文内容创作
- 没有品牌/产品/平台信息时

## 工作流

### Step 1 · 输入确认

确认以下信息是否充足：
| 信息项 | 说明 |
|--------|------|
| 品牌 | 品牌名称和核心信息 |
| 产品 | 产品卖点和关键信息 |
| 平台 | 目标发布平台（小红书/抖音/B站等） |
| 脚本类型 | story / storyboard / video_guide |
| 时长 | 目标视频时长 |
| 风格 | 内容风格调性 |

### Step 2 · 脚本生成

根据脚本类型生成对应内容：

- **story 类型**：构建故事弧线（设定-冲突-解决-CTA），逐场景分解，撰写完整对话，标注视听注意点
- **storyboard 类型**：逐镜头设计分镜表（镜头/角度/运动/时长/画面/台词），提供灯光/道具/场地建议
- **video_guide 类型**：制定拍摄设备/灯光/收音方案，规划后期节奏/转场/BGM，提供平台-specific 技巧

### Step 3 · 平台适配与品牌植入检查

根据平台规范调整脚本格式和时长，检查品牌信息是否自然融入，不生硬。

## 输出格式

必须以 JSON 格式返回，根据 `script_type` 不同，结构如下：

**story 类型：**
```json
{
  "script_type": "story",
  "story_arc": {
    "setup": "",
    "conflict": "",
    "resolution": "",
    "call_to_action": ""
  },
  "scene_breakdown": [
    {
      "scene": 1,
      "timestamp": "0-5s",
      "visual": "",
      "audio": "",
      "emotion": ""
    }
  ],
  "dialogue_script": "完整对话文本",
  "visual_notes": [],
  "audio_notes": [],
  "brand_integration_points": ["植入点1"]
}
```

**storyboard 类型：**
```json
{
  "script_type": "storyboard",
  "storyboard": [
    {
      "shot": 1,
      "angle": "",
      "movement": "",
      "duration": "",
      "description": "",
      "dialogue": ""
    }
  ],
  "lighting_setup": "",
  "prop_list": [],
  "location_notes": "",
  "brand_integration_points": []
}
```

**video_guide 类型：**
```json
{
  "script_type": "video_guide",
  "shooting_guide": {
    "equipment": [],
    "lighting": "",
    "audio": ""
  },
  "editing_guide": {
    "pacing": "",
    "transitions": [],
    "bgm_suggestions": []
  },
  "platform_specific_tips": "",
  "brand_integration_points": []
}
```

## 规则

1. **脚本时长必须严格匹配平台规范**：小红书 60s 内 / 抖音 15-60s / B站可长，超出时长必须标注并给出压缩建议
2. **品牌植入要自然**，每 15-20s 至少有一个品牌露出点，避免生硬口播和突兀的产品展示
3. **开头 3 秒必须有钩子（hook）**，否则完播率会低，hook 可以是悬念/冲突/反常识/利益承诺
4. **对话要口语化**，避免书面语和广告腔，使用目标受众的真实语言习惯
5. **分镜要标注镜头运动方式**：固定 / 推 / 拉 / 摇 / 跟，每个镜头运动要有明确的叙事目的
6. **BGM 建议要匹配情绪曲线**，不是简单推荐热门歌曲，而是按场景标注情绪需求和节奏要求
7. **如果品牌信息不足**，标注需要补充的信息项，不虚构品牌卖点
