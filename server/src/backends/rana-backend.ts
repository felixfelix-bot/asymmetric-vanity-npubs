/**
 * Rana (Rust CPU) grinding backend — subprocess wrapper.
 *
 * Spawns the rana fork binary with `--pubkey` for offset grinding mode.
 * Parses JSON output lines from stdout to detect matches.
 *
 * CLI usage:
 *   rana --pubkey npub1... --vanity-n-prefix pattern --json --timeout 300
 *
 * Output (JSON mode, one line per match):
 *   {"offset":"42","npub":"npub1mesh...","pattern":"meshmate"}
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";

import type { GrindBackend, GrindParams, GrindResult } from "../types.js";
import type { Logger } from "./types.js";
import { consoleLogger } from "./types.js";
import type { ServerConfig } from "../types.js";

/** Minimal bech32 encoder for converting raw pubkey bytes to npub string. */
// We use nostr-tools for NIP-19 encoding since it's already a dependency.
import { nip19 } from "nostr-tools";

/**
 * Rana backend: wraps the rana Rust binary as a subprocess.
 *
 * The binary is expected to support:
 *   --pubkey <npub>           Offset grinding for an existing public key
 *   --vanity-n-prefix <pat>   Comma-separated prefix patterns
 *   --vanity-n-suffix <pat>   Comma-separated suffix patterns
 *   --json                     Machine-readable JSON output
 *   --cores <N>               Number of CPU cores to use
 *   --timeout <secs>          Timeout in seconds
 *   --scan-entropy             Enable entropy scanning on matches
 *   --min-z-score <float>     Minimum z-score for entropy acceptance
 */
export class RanaBackend implements GrindBackend {
  name = "rana" as const;
  available = false;
  estimatedRate = 500_000; // ~500K keys/sec on multi-core
  private readonly binaryPath: string;
  private readonly logger: Logger;
  private currentProcess: ChildProcess | null = null;

  constructor(config: ServerConfig, logger: Logger = consoleLogger) {
    this.binaryPath = config.ranaBinaryPath;
    this.logger = logger;
  }

  /**
   * Health check: verify rana binary exists and responds to --version.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.binaryPath) return false;
    if (this.binaryPath.includes("/") && !existsSync(this.binaryPath)) {
      return false;
    }
    try {
      return await new Promise<boolean>((resolve) => {
        const proc = spawn(this.binaryPath, ["--version"], { timeout: 5000 });
        let stdout = "";
        proc.stdout?.on("data", (d) => (stdout += d.toString()));
        proc.on("error", () => resolve(false));
        proc.on("close", (code) => {
          resolve(code === 0 && stdout.toLowerCase().includes("rana"));
        });
      });
    } catch {
      return false;
    }
  }

  /**
   * Run offset grinding via the rana subprocess.
   *
   * Spawns rana with --pubkey and --json flags, monitors stdout for
   * JSON lines containing match results. Resolves on first match or
   * process exit (timeout without match).
   *
   * @param params - Grinding parameters
   * @returns Grind result with offset and vanity NPUB on success
   */
  async grind(params: GrindParams): Promise<GrindResult> {
    // Convert raw pubkey bytes to npub string for rana CLI
    const npub = nip19.npubEncode(Buffer.from(params.pubKeyBytes).toString("hex"));
    const numCores = os.cpus().length;
    const timeoutSecs = Math.floor(params.timeoutMs / 1000);

    const args: string[] = [
      "--pubkey", npub,
      "--vanity-n-prefix", params.vanityPatterns.join(","),
      "--json",
      "--cores", String(numCores),
      "--timeout", String(timeoutSecs),
    ];

    if (params.suffixPatterns && params.suffixPatterns.length > 0) {
      args.push("--vanity-n-suffix", params.suffixPatterns.join(","));
    }

    if (params.scanEntropy) {
      args.push("--scan-entropy", "--min-z-score", String(params.minZScore));
    }

    this.logger.info(`Spawning rana: ${this.binaryPath} ${args.join(" ")}`);

    return new Promise<GrindResult>((resolve, reject) => {
      const proc = spawn(this.binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.currentProcess = proc;

      let stdoutBuffer = "";
      let stderrBuffer = "";
      const startTime = Date.now();
      let resolved = false;

      proc.stdout?.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();

        // Process complete lines
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? ""; // keep partial last line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("{")) continue;

          try {
            const result = JSON.parse(trimmed) as {
              offset?: string;
              npub?: string;
              pattern?: string;
              z_score?: number;
              fingerprint?: {
                size: number;
                position: number;
                unique_chars: number;
                quality_db: number;
              };
              keys_tried?: number;
              duration_ms?: number;
            };

            if (result.offset !== undefined) {
              if (resolved) return;
              resolved = true;

              const grindResult: GrindResult = {
                found: true,
                offset: BigInt(result.offset),
                vanityNpub: result.npub,
                zScore: result.z_score,
                fingerprint: result.fingerprint
                  ? {
                      size: result.fingerprint.size,
                      position: result.fingerprint.position,
                      uniqueChars: result.fingerprint.unique_chars,
                      qualityDb: result.fingerprint.quality_db,
                    }
                  : undefined,
                keysTried: result.keys_tried ?? 0,
                durationMs: result.duration_ms ?? Date.now() - startTime,
                backend: "rana",
              };

              this.logger.info(
                `Rana found match: offset=${result.offset}, npub=${result.npub}`
              );

              // Kill the process since we have a result
              proc.kill("SIGTERM");
              this.currentProcess = null;
              resolve(grindResult);
              return;
            }
          } catch {
            // Partial JSON — wait for more data
          }
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderrBuffer += data.toString();
      });

      proc.on("error", (err) => {
        if (resolved) return;
        resolved = true;
        this.currentProcess = null;
        this.logger.error("Rana process error", err);
        reject(err);
      });

      proc.on("close", (code) => {
        if (resolved) return;
        resolved = true;
        this.currentProcess = null;

        const durationMs = Date.now() - startTime;

        if (code === 0 || code === null) {
          // Process exited without finding a match (timeout)
          this.logger.info(
            `Rana exited without match (code=${code}), duration=${durationMs}ms`
          );
          resolve({
            found: false,
            keysTried: 0,
            durationMs,
            backend: "rana",
          });
        } else {
          // Non-zero exit — log stderr but resolve as not-found
          this.logger.warn(
            `Rana exited with code ${code}: ${stderrBuffer.trim()}`
          );
          resolve({
            found: false,
            keysTried: 0,
            durationMs,
            backend: "rana",
          });
        }
      });

      // Safety: kill if our own timeout fires first
      setTimeout(() => {
        if (!resolved && proc.exitCode === null) {
          this.logger.warn("Rana timeout reached, killing process");
          proc.kill("SIGTERM");
        }
      }, params.timeoutMs + 2000); // grace period beyond rana's own timeout
    });
  }

  /**
   * Kill any running rana process (for graceful shutdown).
   */
  kill(): void {
    if (this.currentProcess) {
      this.currentProcess.kill("SIGTERM");
      this.currentProcess = null;
    }
  }
}

/**
 * Factory: create a rana backend instance from server config.
 */
export function createRanaBackend(
  config: ServerConfig,
  logger?: Logger
): RanaBackend {
  return new RanaBackend(config, logger);
}