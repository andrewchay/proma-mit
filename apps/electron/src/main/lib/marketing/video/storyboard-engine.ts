/**
 * 分镜脚本生成引擎
 * 基于文本输入自动生成广告视频分镜脚本
 */

// ============================================================
// 类型定义
// ============================================================

export interface StoryboardShot {
  /** 镜号 */
  shotId: string;
  /** 时间范围 */
  timeRange: string;
  /** 时长（秒） */
  duration: number;
  /** 场景名称 */
  scene: string;
  /** 画面描述 */
  visualDescription: string;
  /** 镜头运动 */
  camera: string;
  /** 旁白 */
  narration: string;
  /** 字幕 */
  subtitle: string;
  /** 首帧图提示词（用于图生视频） */
  firstFramePrompt: string;
  /** 视频生成提示词 */
  videoPrompt: string;
  /** 生成方式 */
  generationMethod: "text_to_video" | "image_to_video";
  /** 转场到下一镜 */
  transitionToNext: "cut" | "fade" | "slide" | "zoom";
}

export interface Storyboard {
  /** 分镜列表 */
  shots: StoryboardShot[];
  /** 总时长 */
  totalDuration: number;
  /** 分镜数 */
  totalShots: number;
  /** 推荐引擎 */
  recommendedEngine: "seedance" | "minimax-h3";
  /** 创意方向 */
  creativeDirection: string;
}

export interface VideoInput {
  /** 产品/服务名称 */
  product: string;
  /** 品类 */
  category: string;
  /** 核心卖点 */
  sellingPoints: string[];
  /** 目标人群 */
  targetAudience: string;
  /** 投放平台 */
  platform: "xiaohongshu" | "douyin" | "bilibili" | "weibo";
  /** 目标时长 */
  duration: number;
  /** 风格偏好（可选） */
  style?: string;
  /** 原始输入文本 */
  textInput: string;
}

export interface PlatformConfig {
  /** 宽高比 */
  aspectRatio: "9:16" | "16:9" | "1:1" | "3:4";
  /** 分辨率 */
  resolution: string;
  /** 最大时长 */
  maxDuration: number;
  /** 推荐时长 */
  recommendedDuration: number;
  /** 风格特点 */
  styleCharacteristics: string[];
}

// ============================================================
// 平台配置
// ============================================================

const PLATFORM_CONFIGS: Record<string, PlatformConfig> = {
  xiaohongshu: {
    aspectRatio: "3:4",
    resolution: "1080x1440",
    maxDuration: 60,
    recommendedDuration: 15,
    styleCharacteristics: ["真实感", "生活化", "种草感", "软植入"],
  },
  douyin: {
    aspectRatio: "9:16",
    resolution: "1080x1920",
    maxDuration: 60,
    recommendedDuration: 15,
    styleCharacteristics: ["快节奏", "强Hook", "音乐驱动", "视觉冲击"],
  },
  bilibili: {
    aspectRatio: "16:9",
    resolution: "1920x1080",
    maxDuration: 120,
    recommendedDuration: 30,
    styleCharacteristics: ["内容深度", "知识性", "二次元友好", "弹幕文化"],
  },
  weibo: {
    aspectRatio: "1:1",
    resolution: "1080x1080",
    maxDuration: 30,
    recommendedDuration: 15,
    styleCharacteristics: ["话题性", "明星感", "精致", "社交传播"],
  },
};

// ============================================================
// 分镜模板库
// ============================================================

interface ShotTemplate {
  /** 场景类型 */
  sceneType: "hook" | "problem" | "solution" | "proof" | "cta";
  /** 时长（秒） */
  duration: number;
  /** 画面模板 */
  visualTemplate: string;
  /** 旁白模板 */
  narrationTemplate: string;
  /** 字幕模板 */
  subtitleTemplate: string;
  /** 首帧提示词模板 */
  firstFrameTemplate: string;
  /** 视频提示词模板 */
  videoPromptTemplate: string;
}

/** 15秒短视频模板（3镜） */
const TEMPLATE_15S: ShotTemplate[] = [
  {
    sceneType: "hook",
    duration: 5,
    visualTemplate: "特写：{target_audience}的面部/使用场景，自然光",
    narrationTemplate: "{hook_statement}",
    subtitleTemplate: "{hook_text}",
    firstFrameTemplate: "A close-up of {target_audience}, natural lighting, realistic photography, warm tone",
    videoPromptTemplate: "Subtle camera movement, {target_audience} showing emotion, natural reaction",
  },
  {
    sceneType: "solution",
    duration: 5,
    visualTemplate: "产品展示：{product}特写，质感光线",
    narrationTemplate: "{product}，{selling_point_1}",
    subtitleTemplate: "{product} | {selling_point_1}",
    firstFrameTemplate: "Product photography of {product}, elegant lighting, clean background, commercial style, 8k detail",
    videoPromptTemplate: "Product showcase, gentle rotation, light reflection on surface, premium feel",
  },
  {
    sceneType: "cta",
    duration: 5,
    visualTemplate: "使用效果：前后对比或满意表情",
    narrationTemplate: "{cta_statement}",
    subtitleTemplate: "{cta_text}",
    firstFrameTemplate: "Before and after comparison, glowing skin, satisfied smile, bright lighting",
    videoPromptTemplate: "Split screen transition, showing transformation, happy expression",
  },
];

/** 30秒短视频模板（5镜） */
const TEMPLATE_30S: ShotTemplate[] = [
  {
    sceneType: "hook",
    duration: 5,
    visualTemplate: "痛点场景：{target_audience}遇到{problem}",
    narrationTemplate: "是不是也这样？{problem}",
    subtitleTemplate: "{problem}，怎么办？",
    firstFrameTemplate: "A frustrated {target_audience} looking at mirror, dim lighting, relatable scene",
    videoPromptTemplate: "Expressing concern, touching face, natural movement",
  },
  {
    sceneType: "problem",
    duration: 5,
    visualTemplate: "问题放大：{problem}细节展示",
    narrationTemplate: "{problem_detail}",
    subtitleTemplate: "{problem_detail}",
    firstFrameTemplate: "Close-up of skin texture, showing problem area, detailed macro shot",
    videoPromptTemplate: "Slow zoom in, highlighting texture details",
  },
  {
    sceneType: "solution",
    duration: 8,
    visualTemplate: "产品介绍：{product}使用过程",
    narrationTemplate: "试试{product}，{selling_point_1}，{selling_point_2}",
    subtitleTemplate: "{product} | {selling_point_1}",
    firstFrameTemplate: "Hands holding {product}, applying to face, soft morning light, aesthetic composition",
    videoPromptTemplate: "Application process, smooth motion, product texture visible",
  },
  {
    sceneType: "proof",
    duration: 7,
    visualTemplate: "效果展示：使用前后对比",
    narrationTemplate: "{proof_statement}",
    subtitleTemplate: "{proof_text}",
    firstFrameTemplate: "Split screen before/after, glowing healthy skin, bright natural light",
    videoPromptTemplate: "Transition from dull to radiant, smiling face",
  },
  {
    sceneType: "cta",
    duration: 5,
    visualTemplate: "行动号召：产品+购买引导",
    narrationTemplate: "{cta_statement}",
    subtitleTemplate: "{cta_text}",
    firstFrameTemplate: "Product on vanity table, price tag, shopping bag, bright cheerful setting",
    videoPromptTemplate: "Product highlight, subtle zoom, call-to-action elements",
  },
];

// ============================================================
// 核心生成逻辑
// ============================================================

/**
 * 生成分镜脚本
 */
export function generateStoryboard(input: VideoInput): Storyboard {
  const platformConfig = PLATFORM_CONFIGS[input.platform] ?? {
    aspectRatio: '9:16' as const,
    resolution: '1080x1920',
    maxDuration: 30,
    recommendedDuration: 15,
    styleCharacteristics: ['快节奏'],
  }

  // 确定时长
  const targetDuration = Math.min(
    input.duration || platformConfig.recommendedDuration,
    platformConfig.maxDuration
  );

  // 选择模板
  const templates = targetDuration <= 15 ? TEMPLATE_15S : TEMPLATE_30S;

  // 生成创意方向
  const creativeDirection = generateCreativeDirection(input, platformConfig);

  // 填充模板生成分镜
  const shots = templates.map((template, index) =>
    fillTemplate(template, input, index + 1, platformConfig)
  );

  // 计算总时长
  const totalDuration = shots.reduce((sum, shot) => sum + shot.duration, 0);

  // 推荐引擎
  const recommendedEngine = recommendEngine(input);

  return {
    shots,
    totalDuration,
    totalShots: shots.length,
    recommendedEngine,
    creativeDirection,
  };
}

/**
 * 生成创意方向描述
 */
function generateCreativeDirection(
  input: VideoInput,
  platformConfig: PlatformConfig
): string {
  const style = input.style || platformConfig.styleCharacteristics[0];
  const platformName = getPlatformName(input.platform);

  return `${platformName}${style}风${input.duration}秒${input.product}种草视频`;
}

/**
 * 填充模板
 */
function fillTemplate(
  template: ShotTemplate,
  input: VideoInput,
  shotNumber: number,
  platformConfig: PlatformConfig
): StoryboardShot {
  const { product, sellingPoints, targetAudience } = input;

  // 提取卖点
  const sp1 = sellingPoints[0] || "高品质";
  const sp2 = sellingPoints[1] || "";

  // 生成 Hook 文案
  const hooks = generateHooks(input);
  const ctas = generateCTAs(input);

  // 替换模板变量
  const visualDescription = template.visualTemplate
    .replace("{product}", product)
    .replace("{target_audience}", targetAudience)
    .replace("{problem}", hooks.problem);

  const narration = template.narrationTemplate
    .replace("{product}", product)
    .replace("{selling_point_1}", sp1)
    .replace("{selling_point_2}", sp2)
    .replace("{hook_statement}", hooks.statement)
    .replace("{problem}", hooks.problem)
    .replace("{problem_detail}", hooks.detail)
    .replace("{proof_statement}", hooks.proof)
    .replace("{cta_statement}", ctas.statement);

  const subtitle = template.subtitleTemplate
    .replace("{product}", product)
    .replace("{selling_point_1}", sp1)
    .replace("{hook_text}", hooks.text)
    .replace("{problem}", hooks.problem)
    .replace("{problem_detail}", hooks.detail)
    .replace("{proof_text}", hooks.proof)
    .replace("{cta_text}", ctas.text);

  const firstFramePrompt = template.firstFrameTemplate
    .replace("{product}", product)
    .replace("{target_audience}", targetAudience);

  const videoPrompt = template.videoPromptTemplate
    .replace("{product}", product)
    .replace("{target_audience}", targetAudience);

  // 计算时间范围
  const startTime = (shotNumber - 1) * template.duration;
  const endTime = startTime + template.duration;

  return {
    shotId: String(shotNumber).padStart(2, "0"),
    timeRange: `${startTime}-${endTime}s`,
    duration: template.duration,
    scene: getSceneName(template.sceneType),
    visualDescription,
    camera: getCameraMovement(template.sceneType),
    narration,
    subtitle,
    firstFramePrompt,
    videoPrompt,
    generationMethod: template.sceneType === "solution" || template.sceneType === "cta"
      ? "image_to_video"
      : "text_to_video",
    transitionToNext: shotNumber < 3 ? "fade" : "cut",
  };
}

// ============================================================
// 文案生成
// ============================================================

interface HookSet {
  statement: string;
  problem: string;
  detail: string;
  proof: string;
  text: string;
}

interface CTASet {
  statement: string;
  text: string;
}

/**
 * 生成 Hook 文案
 */
function generateHooks(input: VideoInput): HookSet {
  const { category, sellingPoints } = input;
  const sp = sellingPoints[0] || "";

  // 根据品类选择 Hook 模板
  const hooksByCategory: Record<string, HookSet> = {
    "护肤品": {
      statement: "熬夜后皮肤状态差？",
      problem: "暗沉、细纹",
      detail: "熬夜后肌肤暗沉无光，细纹悄悄爬上脸",
      proof: `用了${sp}，7天看见改变`,
      text: "熬夜党救星",
    },
    "彩妆": {
      statement: "脱妆尴尬？",
      problem: "脱妆、卡粉",
      detail: "出门2小时就脱妆，卡粉到怀疑人生",
      proof: `持妆12小时，${sp}`,
      text: "持久不脱妆",
    },
    "食品": {
      statement: "下午3点又饿了？",
      problem: "饿、没精神",
      detail: "下午犯困又饿，工作效率直线下降",
      proof: `一口回血，${sp}`,
      text: "办公室必备",
    },
    "服装": {
      statement: "明天穿什么？",
      problem: "没衣服穿、搭配难",
      detail: "衣柜满满，却总觉得没衣服穿",
      proof: `百搭不出错，${sp}`,
      text: "懒人穿搭",
    },
  };

  return hooksByCategory[category] || {
    statement: "还在用老方法？",
    problem: "效率低、效果差",
    detail: "传统方法费时费力，效果还不理想",
    proof: `全新体验，${sp}`,
    text: "升级你的选择",
  };
}

/**
 * 生成 CTA 文案
 */
function generateCTAs(input: VideoInput): CTASet {
  const platformCTAs: Record<string, CTASet> = {
    xiaohongshu: {
      statement: "点击左下角，get同款",
      text: "👇 左下角链接",
    },
    douyin: {
      statement: "点击小黄车，立即下单",
      text: "🛒 购物车",
    },
    bilibili: {
      statement: "一键三连，评论区见",
      text: "👍 点赞关注",
    },
    weibo: {
      statement: "转发抽奖，福利多多",
      text: "🎁 转发有礼",
    },
  };

  return platformCTAs[input.platform] || {
    statement: "立即体验",
    text: "👉 立即购买",
  };
}

// ============================================================
// 辅助函数
// ============================================================

function getPlatformName(platform: string): string {
  const names: Record<string, string> = {
    xiaohongshu: "小红书",
    douyin: "抖音",
    bilibili: "B站",
    weibo: "微博",
  };
  return names[platform] || platform;
}

function getSceneName(sceneType: string): string {
  const names: Record<string, string> = {
    hook: "Hook 引入",
    problem: "痛点放大",
    solution: "产品介绍",
    proof: "效果证明",
    cta: "行动号召",
  };
  return names[sceneType] || sceneType;
}

function getCameraMovement(sceneType: string): string {
  const movements: Record<string, string> = {
    hook: "特写，手持微晃",
    problem: "慢推，聚焦细节",
    solution: "平移，环绕展示",
    proof: "分屏，对比切换",
    cta: "固定，中心构图",
  };
  return movements[sceneType] || "固定机位";
}

function recommendEngine(input: VideoInput): "seedance" | "minimax-h3" {
  // 小红书/抖音 → Seedance
  if (input.platform === "xiaohongshu" || input.platform === "douyin") {
    return "seedance";
  }

  // 护肤品/彩妆（人物出镜多）→ Seedance
  if (input.category === "护肤品" || input.category === "彩妆") {
    return "seedance";
  }

  return "seedance";
}

// ============================================================
// 首帧图提示词优化
// ============================================================

/**
 * 优化首帧图提示词（用于 GPT Image 2）
 */
export function optimizeFirstFramePrompt(
  basePrompt: string,
  platform: string
): string {
  const platformEnhancements: Record<string, string> = {
    xiaohongshu: "lifestyle photography, natural lighting, relatable scene, warm tone",
    douyin: "dynamic composition, vibrant colors, eye-catching, trendy style",
    bilibili: "clean aesthetic, anime-influenced, youthful energy",
    weibo: "celebrity style, polished look, high fashion",
  };

  const enhancement = platformEnhancements[platform] || "professional photography";

  return `${basePrompt}, ${enhancement}, 8k, highly detailed, commercial quality`;
}

/**
 * 验证分镜脚本
 */
export function validateStoryboard(storyboard: Storyboard): string[] {
  const errors: string[] = [];

  // 检查总时长
  if (storyboard.totalDuration > 30) {
    errors.push("总时长超过 30 秒，建议缩短以保证质量");
  }

  // 检查单镜时长
  for (const shot of storyboard.shots) {
    if (shot.duration > 10) {
      errors.push(`镜 ${shot.shotId} 时长 ${shot.duration}s 超过 10s 限制`);
    }
  }

  // 检查首帧提示词
  for (const shot of storyboard.shots) {
    if (shot.generationMethod === "image_to_video" && !shot.firstFramePrompt) {
      errors.push(`镜 ${shot.shotId} 使用图生视频但缺少首帧提示词`);
    }
  }

  // 检查旁白长度（每秒约 3-4 个字）
  for (const shot of storyboard.shots) {
    const maxChars = shot.duration * 4;
    if (shot.narration.length > maxChars) {
      errors.push(`镜 ${shot.shotId} 旁白过长（${shot.narration.length}字 > ${maxChars}字）`);
    }
  }

  return errors;
}
