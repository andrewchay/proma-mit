import { writeFile } from 'node:fs/promises'

/**
 * 视频生成引擎统一接口
 * 支持 Seedance（字节/火山方舟）和 MiniMax H3
 *
 * 引擎配置（apiKey/baseUrl）可由上层（渠道凭据解析器）显式注入，
 * 未注入时回退到环境变量 VOLCENGINE_API_KEY / MINIMAX_API_KEY。
 */

// ============================================================
// 类型定义
// ============================================================

export interface VideoGenerationRequest {
  /** 视频描述提示词 */
  prompt: string;
  /** 生成引擎 */
  engine: "seedance" | "minimax-h3";
  /** 生成方式 */
  method: "text_to_video" | "image_to_video" | "video_extend";
  /** 时长（秒） */
  duration: 5 | 10;
  /** 宽高比 */
  aspectRatio: "9:16" | "16:9" | "1:1" | "3:4";
  /** 引擎模型 ID（如 doubao-seedance-2-5-260628；缺省使用各引擎默认） */
  model?: string;
  /** 首帧图片（base64 或 URL，用于 image_to_video） */
  firstFrameImage?: string;
  /** 待延长的视频（用于 video_extend） */
  sourceVideoUrl?: string;
}

export interface VideoGenerationResult {
  /** 任务状态 */
  status: "pending" | "processing" | "success" | "failed";
  /** 任务 ID */
  taskId: string;
  /** 视频 URL（成功时） */
  videoUrl?: string;
  /** 错误信息 */
  error?: string;
  /** 引擎类型 */
  engine: string;
  /** 创建时间 */
  createdAt: number;
  /** 完成时间 */
  completedAt?: number;
}

export interface VideoEngineConfig {
  apiKey: string;
  baseUrl: string;
  timeout?: number;
}

/** 视频任务创建/查询响应（按厂商返回字段宽松建模） */
interface VideoTaskResponse {
  id?: string
  task_id?: string
  status?: string
  video_url?: string
  output_url?: string
  result_url?: string
  error_message?: string
  error?: string | { message?: string; code?: string }
  message?: string
  content?: Array<{ type?: string; text?: string; video_url?: string; url?: string }>
  data?: { content?: Array<{ type?: string; video_url?: string; url?: string }> }
}

type VideoTaskJson = VideoTaskResponse

// ============================================================
// Seedance 引擎（火山方舟 · 内容生成任务 API）
// ============================================================

const SEEDANCE_DEFAULT_MODEL = "doubao-seedance-2-5-260628";

const SEEDANCE_DEFAULT_CONFIG: VideoEngineConfig = {
  apiKey: process.env.VOLCENGINE_API_KEY || "",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  timeout: 120000, // 2 分钟超时
};

/** Seedance contents/generations/tasks 请求的 content 项 */
export interface SeedanceContentItem {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

/**
 * 使用 Seedance 生成视频（火山方舟 contents/generations/tasks 接口）
 *
 * 创建任务：POST {baseUrl}/contents/generations/tasks
 *   返回 { id: "cgt-xxx" }
 * 查询任务：GET  {baseUrl}/contents/generations/tasks/{id}
 *   成功时 status=succeeded，视频 URL 位于 content[].video_url
 */
export async function generateVideoWithSeedance(
  request: VideoGenerationRequest,
  config: VideoEngineConfig = SEEDANCE_DEFAULT_CONFIG
): Promise<VideoGenerationResult> {
  const startTime = Date.now();
  const model = request.model ?? SEEDANCE_DEFAULT_MODEL;

  try {
    // 1. 创建视频生成任务
    const createUrl = `${config.baseUrl}/contents/generations/tasks`;
    const content = buildSeedanceContent(request);

    const createResponse = await fetch(createUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        content,
      }),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      throw new Error(`Seedance API error: ${createResponse.status} - ${errorText}`);
    }

    const createData = await createResponse.json() as VideoTaskJson;
    const taskId = createData.id || createData.task_id;

    if (!taskId) {
      throw new Error("Seedance API returned no task id");
    }

    // 2. 轮询任务状态
    const result = await pollSeedanceTask(taskId, config);

    return {
      ...result,
      createdAt: startTime,
      completedAt: Date.now(),
    };
  } catch (error) {
    return {
      status: "failed",
      taskId: "",
      error: error instanceof Error ? error.message : String(error),
      engine: "seedance",
      createdAt: startTime,
    };
  }
}

/**
 * 组装 Seedance 文本提示词（prompt + 生成参数）
 *
 * 火山方舟把时长/宽高比/分辨率等以 "--key value" 形式追加在 prompt 文本尾部：
 *   "...文案... --ratio 9:16 --fps 24 --resolution 720p --duration 5"
 */
function buildSeedanceTextPrompt(request: VideoGenerationRequest): string {
  const parts = [request.prompt];
  parts.push(`--ratio ${request.aspectRatio}`);
  parts.push("--fps 24");
  parts.push("--resolution 720p");
  parts.push(`--duration ${request.duration}`);
  return parts.join(" ");
}

/**
 * 组装 Seedance content 数组。
 *
 * - 文生视频（text_to_video）：仅含 text（提示词 + 生成参数）
 * - 图生视频（image_to_video）：在 text 后追加 image_url 首帧图
 * - 首帧图支持公网 URL 或 base64 data URL（data:image/<fmt>;base64,...）
 *
 * 注意：image_to_video 但未提供 firstFrameImage 时，不追加 image_url
 * （由调用方保证降级为 text_to_video，或在此处静默按文生视频处理）。
 */
export function buildSeedanceContent(request: VideoGenerationRequest): SeedanceContentItem[] {
  const content: SeedanceContentItem[] = [
    { type: "text", text: buildSeedanceTextPrompt(request) },
  ];
  if (request.method === "image_to_video" && request.firstFrameImage) {
    content.push({
      type: "image_url",
      image_url: { url: request.firstFrameImage },
    });
  }
  return content;
}

/**
 * 轮询 Seedance 视频生成任务
 * @param taskId 任务 ID
 * @param config 引擎配置
 * @param maxAttempts 最大轮询次数（默认 60 次，每 5 秒一次，共 300 秒）
 */
async function pollSeedanceTask(
  taskId: string,
  config: VideoEngineConfig,
  maxAttempts: number = 60
): Promise<VideoGenerationResult> {
  const pollInterval = 5000; // 5 秒
  const statusUrl = `${config.baseUrl}/contents/generations/tasks/${taskId}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    try {
      const response = await fetch(statusUrl, {
        headers: { "Authorization": `Bearer ${config.apiKey}` },
      });

      if (!response.ok) {
        console.warn(`Poll attempt ${attempt + 1} failed: ${response.status}`);
        continue;
      }

      const data = await response.json() as VideoTaskJson;
      const status = data.status;

      if (status === "succeeded" || status === "completed") {
        const videoUrl = extractSeedanceVideoUrl(data);
        if (!videoUrl) {
          return {
            status: "failed",
            taskId,
            error: "任务成功但未找到视频 URL",
            engine: "seedance",
            createdAt: Date.now(),
          };
        }
        return {
          status: "success",
          taskId,
          videoUrl,
          engine: "seedance",
          createdAt: Date.now(),
        };
      }

      if (status === "failed") {
        return {
          status: "failed",
          taskId,
          error: typeof data.error === "string" ? data.error : (data.error?.message ?? "Unknown error"),
          engine: "seedance",
          createdAt: Date.now(),
        };
      }

      // 仍在处理中（queued / running / processing ...），继续轮询
      console.log(`Seedance task ${taskId} status: ${status}, attempt ${attempt + 1}/${maxAttempts}`);
    } catch (error) {
      console.warn(`Poll error on attempt ${attempt + 1}:`, error);
    }
  }

  // 超时
  return {
    status: "failed",
    taskId,
    error: `Polling timeout after ${maxAttempts} attempts`,
    engine: "seedance",
    createdAt: Date.now(),
  };
}

/**
 * 从查询结果中提取视频 URL。
 * 兼容火山方舟标准结构（content[].video_url）与部分聚合商的兼容结构（result_url / data.content）。
 */
function extractSeedanceVideoUrl(data: VideoTaskJson): string | undefined {
  // 标准结构：content 数组里 type=video_url 的项
  const contentUrl = data.content
    ?.map((item) => item.video_url || item.url)
    .find((url): url is string => !!url);
  if (contentUrl) return contentUrl;

  // 嵌套兼容结构（老张 API 等聚合商）
  const nestedUrl = data.data?.content
    ?.map((item) => item.video_url || item.url)
    .find((url): url is string => !!url);
  if (nestedUrl) return nestedUrl;

  // 顶层 result_url / output_url / video_url 兜底
  return data.result_url || data.output_url || data.video_url;
}

// ============================================================
// MiniMax H3 引擎
// ============================================================

const MINIMAX_DEFAULT_CONFIG: VideoEngineConfig = {
  apiKey: process.env.MINIMAX_API_KEY || "",
  baseUrl: "https://api.minimaxi.com/v1",
  timeout: 120000,
};

/**
 * 使用 MiniMax H3 生成视频
 */
export async function generateVideoWithMiniMax(
  request: VideoGenerationRequest,
  config: VideoEngineConfig = MINIMAX_DEFAULT_CONFIG
): Promise<VideoGenerationResult> {
  const startTime = Date.now();

  try {
    // 1. 创建视频生成任务
    const createResponse = await fetch(`${config.baseUrl}/video_generation`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model ?? "minimax-h3",
        prompt: request.prompt,
        duration: request.duration,
        aspect_ratio: request.aspectRatio,
        ...(request.firstFrameImage && {
          first_frame_image: request.firstFrameImage,
        }),
      }),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      throw new Error(`MiniMax API error: ${createResponse.status} - ${errorText}`);
    }

    const createData = await createResponse.json() as VideoTaskJson;
    const taskId = createData.task_id || createData.id;

    if (!taskId) {
      throw new Error("MiniMax API returned no task_id");
    }

    // 2. 轮询任务状态
    const result = await pollVideoTask(taskId, "minimax-h3", config);

    return {
      ...result,
      createdAt: startTime,
      completedAt: Date.now(),
    };
  } catch (error) {
    return {
      status: "failed",
      taskId: "",
      error: error instanceof Error ? error.message : String(error),
      engine: "minimax-h3",
      createdAt: startTime,
    };
  }
}

// ============================================================
// 通用轮询逻辑（MiniMax 等非 Seedance 引擎）
// ============================================================

/**
 * 轮询视频生成任务状态
 * @param taskId 任务 ID
 * @param engine 引擎类型
 * @param config 引擎配置
 * @param maxAttempts 最大轮询次数（默认 30 次，每 5 秒一次，共 150 秒）
 */
async function pollVideoTask(
  taskId: string,
  engine: string,
  config: VideoEngineConfig,
  maxAttempts: number = 30
): Promise<VideoGenerationResult> {
  const pollInterval = 5000; // 5 秒
  const statusUrl = `${config.baseUrl}/video_generation?task_id=${taskId}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    try {
      const response = await fetch(statusUrl, {
        headers: { "Authorization": `Bearer ${config.apiKey}` },
      });

      if (!response.ok) {
        console.warn(`Poll attempt ${attempt + 1} failed: ${response.status}`);
        continue;
      }

      const data = await response.json() as VideoTaskJson;

      // 检查任务状态
      if (data.status === "success" || data.status === "completed") {
        return {
          status: "success",
          taskId,
          videoUrl: data.video_url || data.output_url,
          engine,
          createdAt: Date.now(),
        };
      }

      if (data.status === "failed" || data.status === "error") {
        return {
          status: "failed",
          taskId,
          error: typeof data.error === "string" ? data.error : (data.error_message ?? "Unknown error"),
          engine,
          createdAt: Date.now(),
        };
      }

      // 仍在处理中，继续轮询
      console.log(`Video task ${taskId} status: ${data.status}, attempt ${attempt + 1}/${maxAttempts}`);
    } catch (error) {
      console.warn(`Poll error on attempt ${attempt + 1}:`, error);
    }
  }

  // 超时
  return {
    status: "failed",
    taskId,
    error: `Polling timeout after ${maxAttempts} attempts`,
    engine,
    createdAt: Date.now(),
  };
}

// ============================================================
// 统一接口
// ============================================================

/**
 * 统一视频生成接口
 * 根据 request.engine 自动选择对应引擎；可注入 engineConfig（渠道凭据）。
 */
export async function generateVideo(
  request: VideoGenerationRequest,
  engineConfig?: VideoEngineConfig
): Promise<VideoGenerationResult> {
  switch (request.engine) {
    case "seedance":
      return generateVideoWithSeedance(request, engineConfig);
    case "minimax-h3":
      return generateVideoWithMiniMax(request, engineConfig);
    default:
      return {
        status: "failed",
        taskId: "",
        error: `Unsupported engine: ${request.engine}`,
        engine: request.engine,
        createdAt: Date.now(),
      };
  }
}

/**
 * 批量生成视频片段（用于多镜分镜）
 */
export async function generateVideoBatch(
  requests: VideoGenerationRequest[],
  engineConfig?: VideoEngineConfig
): Promise<VideoGenerationResult[]> {
  // 并行生成所有片段
  const results = await Promise.all(
    requests.map((req) => generateVideo(req, engineConfig))
  );
  return results;
}

// ============================================================
// 引擎选择策略
// ============================================================

export interface EngineSelectionCriteria {
  /** 是否包含人物出镜 */
  hasHuman?: boolean;
  /** 投放平台 */
  platform?: "douyin" | "xiaohongshu" | "bilibili" | "weibo";
  /** 运动类型 */
  motionType?: "static" | "dynamic" | "physics";
  /** 预算级别 */
  budget?: "low" | "medium" | "high";
}

/**
 * 根据场景推荐视频生成引擎
 */
export function recommendEngine(criteria: EngineSelectionCriteria): "seedance" | "minimax-h3" {
  const { hasHuman, platform, motionType } = criteria;

  // 人物出镜 → Seedance（字节人脸数据优势）
  if (hasHuman) return "seedance";

  // 抖音平台 → Seedance（原生优化）
  if (platform === "douyin") return "seedance";

  // 大运动/物理特效 → MiniMax H3
  if (motionType === "dynamic" || motionType === "physics") return "minimax-h3";

  // 默认推荐 Seedance
  return "seedance";
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 下载视频到本地
 */
export async function downloadVideo(
  videoUrl: string,
  outputPath: string
): Promise<string> {
  const response = await fetch(videoUrl);

  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(outputPath, buffer)

  return outputPath;
}

/**
 * 检查引擎可用性
 */
export async function checkEngineHealth(engine: "seedance" | "minimax-h3"): Promise<boolean> {
  try {
    const config = engine === "seedance" ? SEEDANCE_DEFAULT_CONFIG : MINIMAX_DEFAULT_CONFIG;

    // 简单检查 API Key 是否配置
    if (!config.apiKey) return false;

    // TODO: 可以添加更完整的健康检查（如调用 list models API）
    return true;
  } catch {
    return false;
  }
}
