/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BaseTool, ToolResult, Icon } from 'deepv-code-core';
import { Type } from '@google/genai';
import { ImageGeneratorAdapter, UnauthorizedError } from 'deepv-code-core';
import { proxyAuthManager } from 'deepv-code-core';
import { logger } from 'deepv-code-core';

const ALLOWED_RATIOS = ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const ALLOWED_SIZES = ['1K', '2K'];
const DEFAULT_RATIO = 'auto';
const DEFAULT_SIZE = '1K';
const POLL_INTERVAL_MS = 2000;
const TIMEOUT_BUFFER_SECONDS = 120;

export interface NanobananaGenerateParams {
  prompt: string;
  ratio?: string;
  image_size?: string;
}

/**
 * Core tool for AI-driven image generation via NanoBanana.
 *
 * When the AI calls this tool, it submits an image generation task,
 * polls-waits for completion, downloads the result images to local temp files,
 * and returns the local file paths in llmContent.
 *
 * The Feishu agent loop can then detect these paths via sendDetectedFiles()
 * and automatically upload+send them to the Feishu chat.
 *
 * In CLI mode, the paths are displayed and optionally auto-opened.
 */
export class NanobananaGenerateTool extends BaseTool<NanobananaGenerateParams, ToolResult> {
  static readonly Name: string = 'nanobanana_generate';

  constructor() {
    super(
      NanobananaGenerateTool.Name,
      'NanoBanana Generate',
      'Generate images using the NanoBanana AI image generation service. ' +
        'Provide a text prompt describing the desired image, optionally specify aspect ratio and size. ' +
        'The tool returns local file paths of the generated images. ' +
        'In Feishu/Lark mode, generated images are automatically sent to the chat. ' +
        'In CLI mode, images are saved locally and can be opened. ' +
        'Allowed ratios: ' + ALLOWED_RATIOS.join(', ') + '. ' +
        'Allowed sizes: ' + ALLOWED_SIZES.join(', ') + '.',
      Icon.LightBulb,
      {
        type: Type.OBJECT,
        properties: {
          prompt: {
            type: Type.STRING,
            description: 'Text prompt describing the image to generate. Be specific about style, composition, colors, and subject.',
          },
          ratio: {
            type: Type.STRING,
            description: `Aspect ratio of the generated image. Allowed values: ${ALLOWED_RATIOS.join(', ')}. Default: auto.`,
          },
          image_size: {
            type: Type.STRING,
            description: `Image resolution size. Allowed values: ${ALLOWED_SIZES.join(', ')}. Default: 1K.`,
          },
        },
        required: ['prompt'],
      },
    );
  }

  validateToolParams(params: NanobananaGenerateParams): string | null {
    if (!params.prompt || params.prompt.trim() === '') {
      return 'prompt is required and cannot be empty';
    }
    if (params.ratio) {
      if (!ALLOWED_RATIOS.includes(params.ratio)) {
        return `Invalid ratio "${params.ratio}". Allowed: ${ALLOWED_RATIOS.join(', ')}`;
      }
    }
    if (params.image_size) {
      if (!ALLOWED_SIZES.includes(params.image_size)) {
        return `Invalid image_size "${params.image_size}". Allowed: ${ALLOWED_SIZES.join(', ')}`;
      }
    }
    return null;
  }

  getDescription(params: NanobananaGenerateParams): string {
    return `Generating image: "${params.prompt}" (${params.ratio || DEFAULT_RATIO}, ${params.image_size || DEFAULT_SIZE})`;
  }

  async execute(
    params: NanobananaGenerateParams,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: ${validationError}`,
        returnDisplay: validationError,
      };
    }

    const adapter = ImageGeneratorAdapter.getInstance();
    const ratio = params.ratio || DEFAULT_RATIO;
    const imageSize = params.image_size || DEFAULT_SIZE;

    try {
      // Submit generation task
      updateOutput?.('Submitting image generation task...');
      const task = await adapter.submitImageGenerationTask(params.prompt, ratio, undefined, imageSize, undefined);

      const estimatedTime = task.task_info.estimated_time || 60;
      const timeoutMs = (estimatedTime + TIMEOUT_BUFFER_SECONDS) * 1000;
      const startTime = Date.now();

      updateOutput?.(`Task submitted (id: ${task.task_id}, estimated: ~${estimatedTime}s). Waiting for completion...`);

      // Poll for completion
      const resultUrls = await pollForCompletion(
        adapter,
        task.task_id,
        startTime,
        timeoutMs,
        signal,
        updateOutput,
      );

      if (resultUrls.length === 0) {
        return {
          llmContent: 'Image generation completed but no result URLs were returned.',
          returnDisplay: 'No images generated',
        };
      }

      // Download images to local temp files
      updateOutput?.(`Downloading ${resultUrls.length} image(s) to local files...`);
      const localPaths = await downloadImagesToLocal(resultUrls, signal);

      if (localPaths.length === 0) {
        return {
          llmContent: `Image generation completed but failed to download images files. URLs(s): ${resultUrls.join(', ')}`,
          returnDisplay: 'Failed to download images',
        };
      }

      const pathsDisplay = localPaths.join('\n');
      updateOutput?.(`Images(s) saved to: ${pathsDisplay}`);

      return {
        llmContent: `Image generation completed. Generated ${localPaths.length} image(s).\n\nLocal file paths:\n${pathsDisplay}\n\nYou can share these images with the user or send them directly if in a Feishu/Lark chat.`,
        returnDisplay: `Generated ${localPaths.length} image(s): ${pathsDisplay}`,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (err instanceof UnauthorizedError) {
        return {
          llmContent: 'Image generation requires authentication. Please log in to Easy Code first. Do NOT retry this tool until the user logs in.',
          returnDisplay: 'Authentication required',
        };
      }

      return {
        llmContent: `Image generation failed: ${errorMsg}`,
        returnDisplay: `Error: ${errorMsg}`,
      };
    }
  }
}

/**
 * Poll the image generation task until completion or timeout.
 */
async function pollForCompletion(
  adapter: ImageGeneratorAdapter,
  taskId: string,
  startTime: number,
  timeoutMs: number,
  signal: AbortSignal,
  updateOutput?: (output: string) => void,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    let lastProgress = -1;

    const pollInterval = setInterval(async () => {
      try {
        if (signal.aborted) {
          clearInterval(pollInterval);
          reject(new Error('Aborted'));
          return;
        }

        const elapsedMs = Date.now() - startTime;
        if (elapsedMs > timeoutMs) {
          clearInterval(pollInterval);
          reject(new Error(`Image generation timed out after ${Math.round(elapsedMs / 1000)} seconds`));
          return;
        }

        const status = await adapter.getImageTaskStatus(taskId);
        const progress = status.progress ?? 0;

        // Report progress changes
        if (progress > lastProgress) {
          lastProgress = progress;
          updateOutput?.(`Progress: ${progress}%`);
        }

        if (status.status === 'completed') {
          clearInterval(pollInterval);
          resolve(status.result_urls || []);
          return;
        } else if (status.status === 'failed') {
          clearInterval(pollInterval);
          reject(new Error(status.error_message || 'Image generation failed'));
          return;
        }
      } catch (pollErr) {
        clearInterval(pollInterval);
        reject(pollErr);
      }
    }, POLL_INTERVAL_MS);
  });
}

/**
 * Download images from remote URLs to local temp files.
 * Returns array of local file paths.
 */
async function downloadImagesToLocal(
  urls: string[],
  signal: AbortSignal,
): Promise<string[]> {
  const localPaths: string[] = [];

  // Use project root's .easycode/nanobanana/ directory for temp storage
  const projectRoot = process.cwd();
  const outputDir = path.join(projectRoot, '.easycode', 'nanobanana');
  fs.mkdirSync(outputDir, { recursive: true });

  for (const url of urls) {
    if (signal.aborted) break;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        logger.warn(`Failed to download image from ${url}: ${response.status}`);
        continue;
      }

      // Determine extension from URL or default to png
      const urlPath = new URL(url).pathname;
      const ext = path.extname(urlPath) || '.png';
      const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
      const localPath = path.join(outputDir, filename);

      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(localPath, buffer);

      localPaths.push(localPath);
    } catch (downloadErr) {
      logger.warn(`Failed to download image from ${url}: ${downloadErr}`);
    }
  }

  return localPaths;
}
