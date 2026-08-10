import { writeFile } from 'node:fs/promises'

/**
 * 视频生成引擎统一接口
 * 支持 Seedance（字节/火山方舟）和 MiniMax H3
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
  task_id?: string
  status?: string
  video_url?: string
  output_url?: string
  error_message?: string
  error?: string
  message?: string
}

type VideoTaskJson = VideoTaskResponse

// ============================================================
// Seedance 引擎（火山方舟）
// ============================================================

const SEEDANCE_DEFAULT_CONFIG: VideoEngineConfig = {
  apiKey: process.env.VOLCENGINE_API_KEY || "",
  baseUrl: "https://ark.volcengine.com/api/v3",
  timeout: 120000, // 2 分钟超时
};

/**
 * 使用 Seedance 生成视频
 */
export async function generateVideoWithSeedance(
  request: VideoGenerationRequest,
  config: VideoEngineConfig = SEEDANCE_DEFAULT_CONFIG
): Promise<VideoGenerationResult> {
  const startTime = Date.now();

  try {
    // 1. 创建视频生成任务
    const createResponse = await fetch(`${config.baseUrl}/CreateVideoGenTask`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "seedance",
        prompt: request.prompt,
        duration: request.duration,
        aspect_ratio: request.aspectRatio,
        ...(request.firstFrameImage && {
          first_frame_image: request.firstFrameImage,
        }),
        ...(request.sourceVideoUrl && {
          source_video_url: request.sourceVideoUrl,
        }),
      }),
    });

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      throw new Error(`Seedance API error: ${createResponse.status} - ${errorText}`);
    }

    const createData = await createResponse.json() as VideoTaskJson;
    const taskId = createData.task_id;

    if (!taskId) {
      throw new Error("Seedance API returned no task_id");
    }

    // 2. 轮询任务状态
    const result = await pollVideoTask(taskId, "seedance", config);

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

// ============================================================
// MiniMax H3 引擎
// ============================================================

const MINIMAX_DEFAULT_CONFIG: VideoEngineConfig = {
  apiKey: process.env.MINIMAX_API_KEY || "",
  baseUrl: "https://api.minimaxi.chat/v1",
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
        model: "minimax-h3",
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
    const taskId = createData.task_id;

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
// 统一轮询逻辑
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

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    try {
      let statusUrl: string;
      let headers: Record<string, string>;

      if (engine === "seedance") {
        statusUrl = `${config.baseUrl}/GetVideoGenTask?task_id=${taskId}`;
        headers = { "Authorization": `Bearer ${config.apiKey}` };
      } else {
        statusUrl = `${config.baseUrl}/video_generation?task_id=${taskId}`;
        headers = { "Authorization": `Bearer ${config.apiKey}` };
      }

      const response = await fetch(statusUrl, { headers });
      
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
          error: data.error_message || data.error || "Unknown error",
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
 * 根据 request.engine 自动选择对应引擎
 */
export async function generateVideo(
  request: VideoGenerationRequest
): Promise<VideoGenerationResult> {
  switch (request.engine) {
    case "seedance":
      return generateVideoWithSeedance(request);
    case "minimax-h3":
      return generateVideoWithMiniMax(request);
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
  requests: VideoGenerationRequest[]
): Promise<VideoGenerationResult[]> {
  // 并行生成所有片段
  const results = await Promise.all(
    requests.map(req => generateVideo(req))
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
