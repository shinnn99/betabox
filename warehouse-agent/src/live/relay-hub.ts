import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface RelayPath {
  name: string;
  source: string;
}

export interface RelayHubOptions {
  binary: string;
  runtimeDir: string;
  dashboardOrigin: string;
  restartDelayMs?: number;
  spawnProcess?: typeof spawn;
}

const SAFE_PATH_RE = /^[a-z0-9]+$/;
const STARTUP_TIMEOUT_MS = 10_000;

export function relayPathName(cameraCode: string, stream: "main" | "sub"): string {
  if (!cameraCode.trim()) throw new Error("Camera code is required for relay path");
  // MediaMTX splits environment-backed map keys at underscores and lowercases
  // them. Hex preserves the original UTF-8 code while producing a safe key.
  const encoded = Buffer.from(cameraCode, "utf8").toString("hex");
  return `c${encoded}${stream === "main" ? "m" : "s"}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function normalizeRelayPaths(paths: RelayPath[]): RelayPath[] {
  const byName = new Map<string, RelayPath>();
  for (const path of paths) {
    if (!SAFE_PATH_RE.test(path.name)) {
      throw new Error(`Invalid MediaMTX path name: ${path.name}`);
    }
    const source = new URL(path.source);
    if (source.protocol !== "rtsp:" && source.protocol !== "rtsps:") {
      throw new Error(`Invalid MediaMTX source protocol for ${path.name}`);
    }
    byName.set(path.name, { name: path.name, source: path.source });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The generated file intentionally contains no camera credentials. */
export function buildRelayConfig(paths: RelayPath[], dashboardOrigin: string): string {
  const normalized = normalizeRelayPaths(paths);
  const entries = normalized.length > 0
    ? normalized.map(({ name }) => [
        `  ${name}:`,
        "    sourceOnDemand: true",
        "    sourceOnDemandStartTimeout: 10s",
        "    sourceOnDemandCloseAfter: 10s",
        "    rtspTransport: tcp",
      ].join("\n")).join("\n")
    : "  all_others:\n    source: publisher";
  return [
    "logLevel: info",
    "metrics: false",
    "pprof: false",
    "playback: false",
    "rtsp: true",
    "rtspTransports: [tcp]",
    "rtspAddress: 127.0.0.1:8554",
    "rtmp: false",
    "hls: false",
    "webrtc: true",
    "webrtcAddress: 127.0.0.1:8889",
    "webrtcLocalUDPAddress: 127.0.0.1:8189",
    "webrtcLocalTCPAddress: 127.0.0.1:8189",
    "webrtcIPsFromInterfaces: false",
    "webrtcAdditionalHosts: [127.0.0.1]",
    `webrtcAllowOrigins: [${yamlString(dashboardOrigin)}]`,
    "moq: false",
    "srt: false",
    "api: false",
    "paths:",
    entries,
    "",
  ].join("\n");
}

export function buildRelayEnvironment(paths: RelayPath[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const path of normalizeRelayPaths(paths)) {
    // Keep RTSP sources out of mediamtx.generated.yml. The child process still
    // receives them, but the runtime config file stays safe to inspect/share.
    env[`MTX_PATHS_${path.name.toUpperCase()}_SOURCE`] = path.source;
  }
  return env;
}

function redactCredentials(line: string): string {
  return line.replace(/(rtsps?:\/\/)([^\s/@]+)@/gi, "$1***@");
}

export class RelayHub {
  private process: ChildProcessWithoutNullStreams | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private desiredPaths: RelayPath[] = [];
  private stopping = false;
  private generation = 0;
  private readonly configPath: string;
  private readonly restartDelayMs: number;
  private readonly spawnProcess: typeof spawn;

  constructor(private readonly options: RelayHubOptions) {
    this.configPath = join(options.runtimeDir, "mediamtx.generated.yml");
    this.restartDelayMs = options.restartDelayMs ?? 5_000;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async reconcile(paths: RelayPath[]): Promise<void> {
    const normalized = normalizeRelayPaths(paths);
    if (JSON.stringify(normalized) === JSON.stringify(this.desiredPaths) && this.process) return;
    this.desiredPaths = normalized;
    this.generation += 1;
    await this.restart(this.generation);
  }

  private async restart(generation: number): Promise<void> {
    await this.stopProcess();
    if (this.stopping || generation !== this.generation) return;
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(
      this.configPath,
      buildRelayConfig(this.desiredPaths, this.options.dashboardOrigin),
      { encoding: "utf8", mode: 0o600 },
    );
    const child = this.spawnProcess(this.options.binary, [this.configPath], {
      windowsHide: true,
      stdio: "pipe",
      env: { ...process.env, ...buildRelayEnvironment(this.desiredPaths) },
    });
    this.process = child;
    await new Promise<void>((resolve, reject) => {
      let startupSettled = false;
      let ready = false;
      let rtspReady = false;
      let webRtcReady = false;
      let startupOutput = "";

      const finishStartup = (error?: Error) => {
        if (startupSettled) return;
        startupSettled = true;
        clearTimeout(startupTimer);
        if (error) reject(error);
        else resolve();
      };

      const handleOutput = (chunk: Buffer, warning: boolean) => {
        const clean = redactCredentials(chunk.toString().trim());
        if (clean) {
          startupOutput = `${startupOutput}\n${clean}`.slice(-2_000);
          if (warning) console.warn(`[mediamtx] ${clean}`);
          else console.log(`[mediamtx] ${clean}`);
        }
        if (/\[RTSP\].*started with listeners/i.test(clean)) rtspReady = true;
        if (/\[WebRTC\].*started with listeners/i.test(clean)) webRtcReady = true;
        if (rtspReady && webRtcReady) {
          ready = true;
          finishStartup();
        }
      };

      const startupTimer = setTimeout(() => {
        child.kill("SIGTERM");
        finishStartup(new Error(`MediaMTX startup timed out:${startupOutput}`));
      }, STARTUP_TIMEOUT_MS);
      startupTimer.unref();

      child.stdout.on("data", (chunk: Buffer) => handleOutput(chunk, false));
      child.stderr.on("data", (chunk: Buffer) => handleOutput(chunk, true));
      child.once("error", (error) => {
        console.error(`[mediamtx] spawn failed: ${error.message}`);
        finishStartup(new Error(`MediaMTX spawn failed: ${error.message}`));
      });
      child.once("exit", (code, signal) => {
        if (this.process === child) this.process = null;
        if (!ready) {
          finishStartup(new Error(
            `MediaMTX exited before readiness (code=${code ?? "null"}, signal=${signal ?? "none"}):${startupOutput}`,
          ));
          return;
        }
        if (this.stopping || generation !== this.generation) return;
        console.warn(`[mediamtx] exited code=${code ?? "null"} signal=${signal ?? "none"}; restarting`);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          void this.restart(generation).catch((error) => {
            console.error(`[mediamtx] restart failed: ${(error as Error).message}`);
          });
        }, this.restartDelayMs);
        this.restartTimer.unref();
      });
    });
  }

  private async stopProcess(): Promise<void> {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.process;
    this.process = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1_500);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.generation += 1;
    await this.stopProcess();
    await unlink(this.configPath).catch(() => undefined);
  }
}
