import { writeFile, rm, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

/**
 * FFmpeg 视频合成管道
 * 用于多镜拼接、字幕叠加、BGM 添加
 */

// ============================================================
// 类型定义
// ============================================================

export interface VideoCompositionConfig {
  /** 输入视频片段路径列表 */
  inputVideos: string[];
  /** 输出路径 */
  outputPath: string;
  /** 字幕文件路径（可选） */
  subtitlePath?: string;
  /** BGM 路径（可选） */
  bgmPath?: string;
  /** 转场效果 */
  transitions?: TransitionConfig[];
  /** 输出格式 */
  outputFormat?: OutputFormat;
}

export interface TransitionConfig {
  /** 转场位置（第几个片段后） */
  position: number;
  /** 转场类型 */
  type: "fade" | "slide" | "zoom" | "wipe";
  /** 转场时长（秒） */
  duration: number;
}

export interface OutputFormat {
  /** 分辨率 */
  resolution: "1080x1920" | "1080x1440" | "1920x1080" | "1080x1080";
  /** 帧率 */
  fps?: number;
  /** 视频码率 */
  videoBitrate?: string;
  /** 音频码率 */
  audioBitrate?: string;
}

export interface CompositionResult {
  /** 是否成功 */
  success: boolean;
  /** 输出路径 */
  outputPath?: string;
  /** 视频信息 */
  videoInfo?: VideoInfo;
  /** 错误信息 */
  error?: string;
}

export interface VideoInfo {
  /** 时长（秒） */
  duration: number;
  /** 分辨率 */
  resolution: string;
  /** 文件大小 */
  fileSize: string;
  /** 码率 */
  bitrate: string;
}

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_OUTPUT_FORMAT: OutputFormat = {
  resolution: "1080x1920",
  fps: 30,
  videoBitrate: "5000k",
  audioBitrate: "128k",
};

// ============================================================
// 核心合成函数
// ============================================================

/**
 * 合成视频（基础拼接）
 */
export async function composeVideo(
  config: VideoCompositionConfig
): Promise<CompositionResult> {
  try {
    // 1. 验证输入
    const validationError = validateInputs(config);
    if (validationError) {
      return { success: false, error: validationError };
    }

    // 2. 检查 FFmpeg 是否可用
    const ffmpegAvailable = await checkFFmpeg();
    if (!ffmpegAvailable) {
      return {
        success: false,
        error: "FFmpeg 未安装，请先安装 FFmpeg: https://ffmpeg.org/download.html",
      };
    }

    // 3. 生成 concat 文件
    const concatFile = await generateConcatFile(config.inputVideos);

    // 4. 构建 FFmpeg 命令
    const ffmpegCmd = buildFFmpegCommand(config, concatFile);

    // 5. 执行合成
    const ffmpegResult = await execFileAsync('ffmpeg', ffmpegCmd.split(' ').filter(Boolean))

    // 6. 获取视频信息
    const videoInfo = await getVideoInfo(config.outputPath);

    // 7. 清理临时文件
    await cleanup(concatFile);

    return {
      success: true,
      outputPath: config.outputPath,
      videoInfo,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================
// FFmpeg 命令构建
// ============================================================

/**
 * 构建 FFmpeg 命令
 */
function buildFFmpegCommand(
  config: VideoCompositionConfig,
  concatFile: string
): string {
  const format = config.outputFormat || DEFAULT_OUTPUT_FORMAT;
  const [width, height] = format.resolution.split("x");

  let cmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}"`;

  // 添加字幕
  if (config.subtitlePath) {
    cmd += ` -vf "subtitles=${config.subtitlePath}:force_style='FontSize=24,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,Outline=2'"`;
  }

  // 添加 BGM
  if (config.bgmPath) {
    cmd += ` -i "${config.bgmPath}" -shortest`;
    cmd += ` -c:a aac -b:a ${format.audioBitrate}`;
  } else {
    cmd += " -c:a copy";
  }

  // 视频编码参数
  cmd += ` -c:v libx264 -preset fast -crf 23`;
  cmd += ` -r ${format.fps}`;
  cmd += ` -b:v ${format.videoBitrate}`;
  cmd += ` -s ${format.resolution}`;

  // 输出格式优化（平台适配）
  if (config.outputFormat?.resolution === "1080x1920") {
    // 抖音 9:16 优化
    cmd += " -pix_fmt yuv420p -tag:v hvc1";
  }

  // 输出路径
  cmd += ` "${config.outputPath}"`;

  return cmd;
}

/**
 * 生成 concat 文件（用于无转场拼接）
 */
async function generateConcatFile(videoPaths: string[]): Promise<string> {
  const concatContent = videoPaths
    .map(path => `file '${path}'`)
    .join("\n");

  const concatFile = `/tmp/video_concat_${Date.now()}.txt`;
  await writeFile(concatFile, concatContent);
  return concatFile;
}

// ============================================================
// 带转场的复杂合成
// ============================================================

/**
 * 合成视频（带转场效果）
 * 使用 FFmpeg filter_complex 实现
 */
export async function composeVideoWithTransitions(
  config: VideoCompositionConfig
): Promise<CompositionResult> {
  try {
    const validationError = validateInputs(config);
    if (validationError) {
      return { success: false, error: validationError };
    }

    const ffmpegAvailable = await checkFFmpeg();
    if (!ffmpegAvailable) {
      return {
        success: false,
        error: "FFmpeg 未安装",
      };
    }

    // 构建复杂的 filter_complex 命令
    const filterComplex = buildFilterComplex(config);
    const cmd = `ffmpeg -y ${filterComplex.inputs} -filter_complex "${filterComplex.filter}" -map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 23 "${config.outputPath}"`;

    // 对含引号的参数，去掉首尾引号（execFile 不经 shell）
    const filteredCmd = cmd.replace(/\"/g, '')
    await execFileAsync('ffmpeg', filteredCmd.trim().split(/\s+/).filter(Boolean))


    const videoInfo = await getVideoInfo(config.outputPath);

    return {
      success: true,
      outputPath: config.outputPath,
      videoInfo,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 构建 filter_complex 滤镜图
 */
function buildFilterComplex(config: VideoCompositionConfig): {
  inputs: string;
  filter: string;
} {
  const videos = config.inputVideos;
  const transitions = config.transitions || [];

  // 输入声明
  let inputs = "";
  videos.forEach((video, i) => {
    inputs += `-i "${video}" `;
  });

  // 构建滤镜链
  let filter = "";
  const streamLabels: string[] = [];

  // 为每个视频添加 scale 滤镜
  videos.forEach((_, i) => {
    const [width, height] = (config.outputFormat?.resolution || "1080x1920").split("x");
    filter += `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2[v${i}]; `;
    streamLabels.push(`[v${i}]`);
  });

  // 添加转场（简化版：使用 xfade 滤镜）
  if (transitions.length > 0 && videos.length > 1) {
    let current = "[v0]";
    for (let i = 1; i < videos.length; i++) {
      const transition = transitions.find(t => t.position === i - 1);
      if (transition) {
        const transitionType = getFFmpegTransitionType(transition.type);
        filter += `${current}[v${i}]xfade=transition=${transitionType}:duration=${transition.duration}:offset=${i * 5 - transition.duration}[vtmp${i}]; `;
        current = `[vtmp${i}]`;
      } else {
        filter += `${current}[v${i}]concat=n=2:v=1:a=0[vtmp${i}]; `;
        current = `[vtmp${i}]`;
      }
    }
    filter += `${current}[outv]; `;
  } else {
    // 无转场，直接拼接
    filter += `${streamLabels.join("")}concat=n=${videos.length}:v=1:a=0[outv]; `;
  }

  // 音频处理
  filter += `${videos.map((_, i) => `[${i}:a]`).join("")}amix=inputs=${videos.length}:duration=longest[outa]`;

  return { inputs, filter };
}

/**
 * 转场类型映射
 */
function getFFmpegTransitionType(type: string): string {
  const mapping: Record<string, string> = {
    fade: "fade",
    slide: "slideleft",
    zoom: "zoomin",
    wipe: "wipeleft",
  };
  return mapping[type] || "fade";
}

// ============================================================
// 字幕生成
// ============================================================

export interface SubtitleEntry {
  /** 序号 */
  index: number;
  /** 开始时间（秒） */
  startTime: number;
  /** 结束时间（秒） */
  endTime: number;
  /** 字幕文本 */
  text: string;
}

/**
 * 生成 SRT 字幕文件
 */
export async function generateSRT(
  entries: SubtitleEntry[],
  outputPath: string
): Promise<string> {
  const srtContent = entries
    .map(entry => {
      const start = formatTime(entry.startTime);
      const end = formatTime(entry.endTime);
      return `${entry.index}\n${start} --> ${end}\n${entry.text}\n`;
    })
    .join("\n");

  await writeFile(outputPath, srtContent);
  return outputPath;
}

/**
 * 从分镜脚本生成字幕
 */
export async function generateSubtitlesFromStoryboard(
  shots: Array<{
    shotId: string;
    timeRange: string;
    subtitle: string;
  }>,
  outputPath: string
): Promise<string> {
  const entries: SubtitleEntry[] = shots.map((shot, index) => {
    // timeRange 形如 "0-5s" / "5-10s"，容错解析起止秒
    const split = shot.timeRange.replace(/s$/i, '').split('-')
    const s0 = split[0] !== undefined ? Number(split[0]) : NaN
    const s1 = split[1] !== undefined ? Number(split[1]) : NaN
    const startTime = Number.isFinite(s0) ? s0 : 0
    const endTime = Number.isFinite(s1) ? s1 : startTime + 5
    return {
      index: index + 1,
      startTime,
      endTime,
      text: shot.subtitle,
    };
  });

  return generateSRT(entries, outputPath);
}

/**
 * 格式化时间为 SRT 格式
 */
function formatTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

// ============================================================
// 视频信息获取
// ============================================================

/**
 * 获取视频信息
 */
export async function getVideoInfo(videoPath: string): Promise<VideoInfo> {
  try {
    const result = await execFileAsync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', videoPath])
    const info = JSON.parse(result.stdout)
    const videoStream = info.streams.find((s: any) => s.codec_type === "video");
    const format = info.format;

    return {
      duration: parseFloat(format.duration),
      resolution: `${videoStream.width}x${videoStream.height}`,
      fileSize: formatSize(parseInt(format.size)),
      bitrate: format.bit_rate,
    };
  } catch {
    return {
      duration: 0,
      resolution: "unknown",
      fileSize: "unknown",
      bitrate: "unknown",
    };
  }
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 检查 FFmpeg 是否可用
 */
async function checkFFmpeg(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 10000 })
    return true
  } catch {
    return false
  }
}

/**
 * 验证输入
 */
function validateInputs(config: VideoCompositionConfig): string | null {
  if (!config.inputVideos || config.inputVideos.length === 0) {
    return "至少需要一段输入视频";
  }

  if (!config.outputPath) {
    return "需要指定输出路径";
  }

  return null;
}

/**
 * 清理临时文件
 */
async function cleanup(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true })
  } catch {
    // 忽略清理错误
  }
}

/**
 * 格式化文件大小
 */
function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

// ============================================================
// 终版渲染（字幕 burn-in + BGM + 多平台导出）
// ============================================================

/**
 * 检查 ffmpeg 是否内置指定滤镜（如 subtitles/drawtext）
 */
async function hasFilter(filterName: string): Promise<boolean> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("ffmpeg", ["-filters"]);
    return new RegExp(`^ *\.{1,2} *${filterName}`).test(stdout);
  } catch {
    return false;
  }
}

/**
 * 终版渲染：把多个分镜片段合成交付成片（字幕 burn-in + BGM + 多平台导出）。
 *
 * 采用分阶段方法（比单个巨型 filter_complex 更稳健）：
 *   Stage 1: 拼接分镜（scale+pad 统一分辨率、re-encode）→ tmp.concat.mp4
 *   Stage 2: 字幕 burn-in 到画面 → tmp.sub.mp4（可选，依赖 ffmpeg 带 libass）
 *   Stage 3: BGM 混入音轨 → 最终成片（可选）
 */
export async function renderFinalVideo(
  config: VideoCompositionConfig
): Promise<CompositionResult> {
  try {
    const validationError = validateInputs(config);
    if (validationError) return { success: false, error: validationError };

    if (!(await checkFFmpeg())) {
      return { success: false, error: "FFmpeg 未安装，请先安装 FFmpeg: https://ffmpeg.org/download.html" };
    }

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { tmpdir } = await import("node:os");
    const { randomBytes } = await import("node:crypto");
    const execFileAsync = promisify(execFile);

    const format = config.outputFormat || DEFAULT_OUTPUT_FORMAT;
    const [width, height] = format.resolution.split("x");
    const tag = randomBytes(4).toString("hex");
    const tmpRoot = tmpdir();
    const concatPath = join(tmpRoot, `mapro-concat-${tag}.mp4`);
    const subPath = join(tmpRoot, `mapro-sub-${tag}.mp4`);
    const finalPath = config.outputPath;

    // ── Stage 0: 生成 concat 文件列表 ──
    const concatFile = join(tmpRoot, `mapro-concat-list-${tag}.txt`);
    const concatPayload = config.inputVideos.map((p) => `file '${p}'`).join("\n");
    await writeFile(concatFile, concatPayload);

    // ── Stage 1: 拼接并统一分辨率（re-encode）──
    // scale + pad 到目标分辨率，避免不同尺寸分镜拼接时报错
    const vfFilter =
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
      `setsar=1,fps=${format.fps ?? 30}`;
    await execFileAsync(
      "ffmpeg",
      [
        "-y", "-f", "concat", "-safe", "0", "-i", concatFile,
        "-vf", vfFilter,
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-b:v", format.videoBitrate ?? "5000k",
        "-r", String(format.fps ?? 30),
        "-pix_fmt", "yuv420p",
        concatPath,
      ],
      { timeout: 5 * 60_000 },
    );

    // ── Stage 2: 字幕 burn-in（可选，需 ffmpeg 内置 libass/subtitles 滤镜）──
    let current = concatPath;
    if (config.subtitlePath) {
      const subtitlesAvailable = await hasFilter("subtitles");
      if (!subtitlesAvailable) {
        // 环境缺少 libass，无法 burn-in；降级为保留字幕文件并由调用方决定
        console.warn("[renderFinalVideo] 当前 ffmpeg 无 subtitles 滤镜，跳过字幕 burn-in（字幕文件仍保留为 .srt）");
      } else {
        await execFileAsync(
          "ffmpeg",
          [
            "-y", "-i", concatPath,
            "-vf",
            `subtitles='${config.subtitlePath}':force_style='FontSize=22,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=2,Alignment=2'`,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "copy",
            subPath,
          ],
          { timeout: 5 * 60_000 },
        );
        current = subPath;
      }
    }

    // ── Stage 3: BGM 混入 + 最终编码（可选）──
    if (config.bgmPath) {
      // 默认 BGM 压低到 20% 音量铺底（concat 已含音轨，直接混入）
      await execFileAsync(
        "ffmpeg",
        [
          "-y", "-i", current, "-i", config.bgmPath,
          "-filter_complex",
          "[1:a]volume=0.2[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[outa]",
          "-map", "0:v", "-map", "[outa]",
          "-c:v", "copy",
          "-c:a", "aac", "-b:a", format.audioBitrate ?? "128k",
          finalPath,
        ],
        { timeout: 5 * 60_000 },
      );
    } else {
      // 无 BGM：直接复制字幕后的文件（Stage 2 已含 burn-in）到最终路径
      const { copyFileSync } = await import("node:fs");
      copyFileSync(current, finalPath);
    }

    // 清理临时文件
    await cleanup(concatFile);
    await cleanup(concatPath);
    await cleanup(subPath);

    const videoInfo = await getVideoInfo(finalPath);
    return { success: true, outputPath: finalPath, videoInfo };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * BGM 音乐匹配建议（简易规则：按平台给 BGM 类型建议）
 */
// ============================================================
// 平台适配输出
// ============================================================

/**
 * BGM 音乐匹配建议（简易规则：按视频节奏/平台给 BGM 类型建议）
 */
export function suggestBgm(platform: string, emotionalArc?: string[]): { type: string; mood: string; bpm: string } {
  const map: Record<string, { type: string; mood: string; bpm: string }> = {
    douyin: { type: "电子/卡点", mood: "快节奏、强节拍", bpm: "120-140" },
    xiaohongshu: { type: "软流行/轻快", mood: "自然、有温度", bpm: "90-110" },
    bilibili: { type: "背景铺底", mood: "不抢主体、留白", bpm: "80-100" },
    weibo: { type: "流行/氛围", mood: "时尚、精致", bpm: "100-120" },
  };
  const base = map[platform] ?? map.xiaohongshu!;
  return base;
}

// ============================================================
// 平台适配输出
// ============================================================

export const PLATFORM_OUTPUT_FORMATS: Record<string, OutputFormat> = {
  douyin: {
    resolution: "1080x1920",
    fps: 30,
    videoBitrate: "8000k",
    audioBitrate: "128k",
  },
  xiaohongshu: {
    resolution: "1080x1440",
    fps: 30,
    videoBitrate: "6000k",
    audioBitrate: "128k",
  },
  bilibili: {
    resolution: "1920x1080",
    fps: 30,
    videoBitrate: "8000k",
    audioBitrate: "192k",
  },
  weibo: {
    resolution: "1080x1080",
    fps: 30,
    videoBitrate: "6000k",
    audioBitrate: "128k",
  },
};

/**
 * 获取平台适配的输出格式
 */
export function getPlatformOutputFormat(platform: string): OutputFormat {
  return PLATFORM_OUTPUT_FORMATS[platform] || DEFAULT_OUTPUT_FORMAT;
}
