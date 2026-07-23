/**
 * Backend interface types for the VNAAS grinding dispatcher.
 *
 * Re-exports the core types from the server-level types.ts and adds
 * backend-specific types (availability, detection results) used by
 * the detector and dispatcher modules.
 */

import type {
  GrindBackend,
  GrindParams,
  GrindResult,
  FingerprintInfo,
} from "../types.js";

// Re-export so callers can import everything from one place
export type { GrindBackend, GrindParams, GrindResult, FingerprintInfo };

// ---------------------------------------------------------------------------
// Backend availability (produced by detector.ts)
// ---------------------------------------------------------------------------

/** Information about a detected GPU device. */
export interface GpuInfo {
  /** GPU model name (e.g. "NVIDIA GeForce RTX 4090") */
  name: string;
  /** Total VRAM in megabytes */
  memoryMb: number;
  /** CUDA compute capability (e.g. "8.9") */
  computeCapability: string;
  /** Number of CUDA cores */
  cudaCores: number;
}

/** Rana binary version information. */
export interface RanaInfo {
  /** Version string from `rana --version` */
  version: string;
  /** Absolute path to the binary */
  binaryPath: string;
}

/**
 * Availability snapshot for all backends.
 * Produced by `detectBackends()` and refreshed periodically.
 */
export interface BackendAvailability {
  /** Whether a GPU (CUDA) backend is available */
  gpu: boolean;
  /** GPU details if available */
  gpuInfo?: GpuInfo;
  /** Whether the rana (Rust CPU) backend is available */
  rana: boolean;
  /** Rana details if available */
  ranaInfo?: RanaInfo;
  /** Browser fallback is always available */
  browser: boolean;
  /** Timestamp of the last detection run (epoch ms) */
  detectedAt: number;
}

// ---------------------------------------------------------------------------
// Logger interface (minimal, so backends don't depend on a specific logger)
// ---------------------------------------------------------------------------

/** Minimal logger interface used by backend modules. */
export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

/** Default console-based logger. */
export const consoleLogger: Logger = {
  info: (msg, ...args) => console.info(`[backends] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[backends] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[backends] ${msg}`, ...args),
  debug: (msg, ...args) => console.debug(`[backends] ${msg}`, ...args),
};