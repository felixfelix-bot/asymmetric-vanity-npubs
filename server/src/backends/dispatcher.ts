/**
 * Backend dispatcher — selects the best available grinding backend.
 *
 * Priority chain: GPU (CUDA) → Rana (Rust CPU) → Browser (client-side fallback)
 *
 * The dispatcher holds references to all three backends and the detector.
 * On each `dispatchGrind()` call, it checks current availability and tries
 * backends in priority order, falling through on errors or unavailability.
 */

import type { GrindBackend, GrindParams, GrindResult } from "../types.js";
import type { ServerConfig } from "../types.js";

import type { Logger, BackendAvailability } from "./types.js";
import { consoleLogger } from "./types.js";
import { BackendDetector } from "./detector.js";
import { GpuBackend, createGpuBackend } from "./gpu-backend.js";
import { RanaBackend, createRanaBackend } from "./rana-backend.js";
import { BrowserBackend, createBrowserBackend } from "./browser-backend.js";

/**
 * The backend dispatcher manages the priority chain for grinding work.
 *
 * It owns instances of all three backends (GPU, rana, browser) and a
 * BackendDetector for runtime availability checks. Call `dispatchGrind()`
 * with GrindParams to get a GrindResult from the best available backend.
 */
export class BackendDispatcher {
  private readonly gpuBackend: GpuBackend;
  private readonly ranaBackend: RanaBackend;
  private readonly browserBackend: BrowserBackend;
  private readonly detector: BackendDetector;
  private readonly logger: Logger;

  constructor(config: ServerConfig, logger: Logger = consoleLogger) {
    this.logger = logger;
    this.gpuBackend = createGpuBackend(config, logger);
    this.ranaBackend = createRanaBackend(config, logger);
    this.browserBackend = createBrowserBackend(logger);
    this.detector = new BackendDetector(config, { logger });
  }

  /**
   * Start the dispatcher: run initial detection and begin periodic re-detection.
   */
  async start(): Promise<BackendAvailability> {
    const availability = await this.detector.start();
    this.gpuBackend.available = availability.gpu;
    this.ranaBackend.available = availability.rana;
    this.logger.info(
      `Dispatcher started: gpu=${availability.gpu}, rana=${availability.rana}, browser=true`
    );
    return availability;
  }

  /**
   * Stop the dispatcher: kill any running subprocesses and stop detection timer.
   */
  stop(): void {
    this.detector.stop();
    this.ranaBackend.kill();
  }

  /**
   * Get the latest backend availability snapshot.
   */
  async getAvailability(): Promise<BackendAvailability> {
    return this.detector.getLatestAvailability();
  }

  /**
   * Dispatch a grinding request to the best available backend.
   *
   * Tries backends in priority order: GPU → Rana → Browser.
   * Falls through on unavailability or errors.
   *
   * @param params - Grinding parameters
   * @returns Result from the first backend that responds, or browser fallback
   */
  async dispatchGrind(params: GrindParams): Promise<GrindResult> {
    const availability = await this.detector.getLatestAvailability();

    // --- 1. GPU (highest priority) ---
    if (availability.gpu) {
      try {
        this.logger.info("Dispatching to GPU backend");
        const result = await this.gpuBackend.grind(params);
        if (result.found || result.backend === "gpu") {
          return result;
        }
        // GPU available but didn't find → fall through to rana
        this.logger.warn("GPU backend returned without match, falling back to rana");
      } catch (e) {
        this.logger.warn("GPU backend failed, falling back to rana", e);
      }
    }

    // --- 2. Rana (CPU, medium priority) ---
    if (availability.rana) {
      try {
        this.logger.info("Dispatching to rana backend");
        const result = await this.ranaBackend.grind(params);
        if (result.found || result.backend === "rana") {
          return result;
        }
        // Rana available but didn't find (timeout) → fall through to browser
        this.logger.warn("Rana backend returned without match, falling back to browser");
      } catch (e) {
        this.logger.warn("Rana backend failed, falling back to browser", e);
      }
    }

    // --- 3. Browser fallback (always available) ---
    this.logger.info("Dispatching to browser fallback");
    return this.browserBackend.grind(params);
  }

  /**
   * Get the list of all backends (for health/status reporting).
   */
  getBackends(): GrindBackend[] {
    return [this.gpuBackend, this.ranaBackend, this.browserBackend];
  }

  /**
   * Run health checks on all backends.
   *
   * @returns Map of backend name to health status
   */
  async healthCheckAll(): Promise<Record<string, boolean>> {
    const [gpu, rana, browser] = await Promise.all([
      this.gpuBackend.healthCheck(),
      this.ranaBackend.healthCheck(),
      this.browserBackend.healthCheck(),
    ]);
    return { gpu, rana, browser };
  }
}

/**
 * Factory: create a backend dispatcher from server config.
 */
export function createDispatcher(
  config: ServerConfig,
  logger?: Logger
): BackendDispatcher {
  return new BackendDispatcher(config, logger);
}