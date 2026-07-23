/**
 * Auto-detection of available grinding backends.
 *
 * Probes the system for:
 *   1. GPU (CUDA) — checks for nvidia-smi and/or the cuda_vanity binary
 *   2. Rana (Rust CPU) — checks if the rana binary exists and runs
 *   3. Browser — always available as the final fallback
 *
 * Detection runs at startup and is re-run on a configurable interval
 * (default 60 s) so that backends appearing/disappearing at runtime
 * are picked up.
 */

import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import type { BackendAvailability, GpuInfo, RanaInfo, Logger } from "./types.js";
import { consoleLogger } from "./types.js";
import type { ServerConfig } from "../types.js";

/** Promisified execFile for clean async/await usage. */
function execFileAsync(
  file: string,
  args: string[],
  timeoutMs = 10_000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && "code" in error === false) {
          // Node throws for spawn errors; signal errors have code
          reject(error);
          return;
        }
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: error ? Number((error as NodeJS.ErrnoException).code) || 1 : 0,
        });
      }
    );
    // Safety: kill if still running after timeout
    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/** Check if a file exists and is executable. */
async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Parse nvidia-smi GPU info output. */
function parseGpuInfo(stdout: string): GpuInfo | undefined {
  // nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader
  // Output example: "NVIDIA GeForce RTX 4090, 24564 MiB, 8.9"
  const lines = stdout.trim().split("\n");
  if (lines.length === 0) return undefined;
  const parts = lines[0].split(",").map((s) => s.trim());
  if (parts.length < 3) return undefined;
  return {
    name: parts[0],
    memoryMb: parseInt(parts[1], 10) || 0,
    computeCapability: parts[2],
    cudaCores: 0, // nvidia-smi doesn't report core count directly
  };
}

/**
 * Detect GPU availability.
 *
 * Strategy:
 *   1. If a GPU binary path is configured and exists, try `--probe`
 *   2. If nvidia-smi is available, query it for GPU info
 *   3. Otherwise GPU is unavailable
 */
async function detectGpu(
  config: ServerConfig,
  logger: Logger
): Promise<{ available: boolean; info?: GpuInfo }> {
  if (!config.enableGpu) {
    return { available: false };
  }

  // Try the configured GPU binary first
  if (config.gpuBinaryPath && config.gpuBinaryPath !== "cuda_vanity") {
    const exe = await isExecutable(config.gpuBinaryPath);
    if (exe) {
      try {
        const result = await execFileAsync(config.gpuBinaryPath, ["--probe"]);
        if (result.exitCode === 0) {
          return { available: true, info: undefined };
        }
      } catch {
        logger.debug("GPU binary --probe failed");
      }
    }
  }

  // Fall back to nvidia-smi detection
  try {
    const result = await execFileAsync("nvidia-smi", [
      "--query-gpu=name,memory.total,compute_cap",
      "--format=csv,noheader",
    ]);
    if (result.exitCode === 0 && result.stdout.trim()) {
      const info = parseGpuInfo(result.stdout);
      logger.info("GPU detected via nvidia-smi", info?.name ?? "unknown");
      return { available: true, info };
    }
  } catch {
    logger.debug("nvidia-smi not available");
  }

  return { available: false };
}

/**
 * Detect rana binary availability.
 *
 * Runs `rana --version` (or `--help` as fallback) to confirm the binary
 * is present and executable.
 */
async function detectRana(
  config: ServerConfig,
  logger: Logger
): Promise<{ available: boolean; info?: RanaInfo }> {
  if (!config.enableRana) {
    return { available: false };
  }

  const binaryPath = config.ranaBinaryPath;

  // If it's an absolute/relative path, check file exists
  if (path.isAbsolute(binaryPath) || binaryPath.includes("/")) {
    if (!existsSync(binaryPath)) {
      logger.debug(`Rana binary not found at ${binaryPath}`);
      return { available: false };
    }
    const exe = await isExecutable(binaryPath);
    if (!exe) {
      logger.debug(`Rana binary not executable: ${binaryPath}`);
      return { available: false };
    }
  }

  // Try --version first
  try {
    const result = await execFileAsync(binaryPath, ["--version"], 5_000);
    if (result.exitCode === 0 && result.stdout.trim()) {
      const version = result.stdout.trim();
      logger.info(`Rana detected: ${version}`);
      return {
        available: true,
        info: { version, binaryPath: path.resolve(binaryPath) },
      };
    }
  } catch {
    // Try --help as fallback (some CLIs don't have --version)
    try {
      const result = await execFileAsync(binaryPath, ["--help"], 5_000);
      if (result.exitCode === 0) {
        logger.info("Rana detected via --help");
        return {
          available: true,
          info: {
            version: "unknown",
            binaryPath: path.resolve(binaryPath),
          },
        };
      }
    } catch {
      logger.debug("Rana binary not reachable");
    }
  }

  return { available: false };
}

/**
 * Run a full backend detection cycle.
 *
 * @param config - Server configuration (binary paths, enable flags)
 * @param logger - Optional logger
 * @returns Availability snapshot for all backends
 */
export async function detectBackends(
  config: ServerConfig,
  logger: Logger = consoleLogger
): Promise<BackendAvailability> {
  logger.info("Running backend detection...");

  const [gpuResult, ranaResult] = await Promise.all([
    detectGpu(config, logger),
    detectRana(config, logger),
  ]);

  const availability: BackendAvailability = {
    gpu: gpuResult.available,
    gpuInfo: gpuResult.info,
    rana: ranaResult.available,
    ranaInfo: ranaResult.info,
    browser: true, // always available
    detectedAt: Date.now(),
  };

  logger.info(
    `Detection complete: gpu=${availability.gpu}, rana=${availability.rana}, browser=${availability.browser}`
  );

  return availability;
}

// ---------------------------------------------------------------------------
// Periodic detection manager
// ---------------------------------------------------------------------------

/**
 * Manages periodic backend detection.
 *
 * Holds the latest availability snapshot and re-runs detection on a timer.
 * Other modules call `getLatestAvailability()` to get the current state.
 */
export class BackendDetector {
  private latest: BackendAvailability | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly config: ServerConfig;
  private readonly logger: Logger;

  constructor(
    config: ServerConfig,
    options?: { intervalMs?: number; logger?: Logger }
  ) {
    this.config = config;
    this.intervalMs = options?.intervalMs ?? 60_000;
    this.logger = options?.logger ?? consoleLogger;
  }

  /** Run an initial detection and start the periodic timer. */
  async start(): Promise<BackendAvailability> {
    this.latest = await detectBackends(this.config, this.logger);
    this.timer = setInterval(() => {
      detectBackends(this.config, this.logger)
        .then((avail) => {
          this.latest = avail;
        })
        .catch((err) => {
          this.logger.error("Periodic detection failed", err);
        });
    }, this.intervalMs);
    return this.latest;
  }

  /** Stop the periodic timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get the latest availability snapshot (runs a fresh detection if none yet). */
  async getLatestAvailability(): Promise<BackendAvailability> {
    if (!this.latest) {
      this.latest = await detectBackends(this.config, this.logger);
    }
    return this.latest;
  }

  /** Force a re-detection now. */
  async refresh(): Promise<BackendAvailability> {
    this.latest = await detectBackends(this.config, this.logger);
    return this.latest;
  }
}