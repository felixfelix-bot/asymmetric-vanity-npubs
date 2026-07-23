/**
 * GPU (CUDA) grinding backend — stub implementation.
 *
 * The GPU backend will use a fork of v0l/cuda_vanity with offset grinding
 * support (P + d·G in a CUDA kernel). This stub returns "not available"
 * until the CUDA binary is built and integrated (Phase 4).
 *
 * The stub still implements the full GrindBackend interface so the
 * dispatcher can reference it without conditional imports.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import type { GrindBackend, GrindParams, GrindResult } from "../types.js";
import type { Logger } from "./types.js";
import { consoleLogger } from "./types.js";
import type { ServerConfig } from "../types.js";

/**
 * GPU backend using a CUDA subprocess (cuda_vanity fork).
 *
 * Currently a stub — `available` is always false and `grind()` throws.
 * When the CUDA binary is ready (Phase 4), this will spawn the GPU
 * process and parse JSON output.
 */
export class GpuBackend implements GrindBackend {
  name = "gpu" as const;
  available = false;
  estimatedRate = 0;
  private readonly binaryPath: string;
  private readonly logger: Logger;

  constructor(config: ServerConfig, logger: Logger = consoleLogger) {
    this.binaryPath = config.gpuBinaryPath;
    this.logger = logger;
  }

  /**
   * Health check: verify the GPU binary exists and responds to --probe.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.binaryPath || !existsSync(this.binaryPath)) {
      return false;
    }
    try {
      return await new Promise<boolean>((resolve) => {
        const proc = spawn(this.binaryPath, ["--probe"], { timeout: 5000 });
        proc.on("error", () => resolve(false));
        proc.on("close", (code) => resolve(code === 0));
      });
    } catch {
      return false;
    }
  }

  /**
   * Grind using the GPU backend.
   *
   * Not yet implemented — throws an error directing the caller to fall
   * through to the next backend in the priority chain.
   */
  async grind(_params: GrindParams): Promise<GrindResult> {
    this.logger.warn("GPU backend grind() called but not yet implemented");
    throw new Error(
      "GPU backend not yet implemented (Phase 4). Falling back to next backend."
    );
  }
}

/**
 * Factory: create a GPU backend instance from server config.
 */
export function createGpuBackend(
  config: ServerConfig,
  logger?: Logger
): GpuBackend {
  return new GpuBackend(config, logger);
}