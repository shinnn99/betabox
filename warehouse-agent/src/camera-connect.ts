import { spawn } from "node:child_process";
import { getOnvifStreams, OnvifError, type OnvifStreamInfo } from "./onvif-auth";

export const COMMON_RTSP_PATHS = [
  "/Streaming/Channels/101",
  "/Streaming/Channels/1",
  "/h264Preview_01_main",
  "/cam/realmonitor?channel=1&subtype=0",
  "/live/ch00_0",
  "/live/av0",
  "/stream1",
  "/videoMain",
] as const;

export class CameraConnectError extends Error {
  constructor(
    public readonly code: "AUTH_FAILED" | "NO_RTSP_STREAM",
    message: string,
  ) {
    super(message);
    this.name = "CameraConnectError";
  }
}

export interface CameraConnectResult {
  manufacturer?: string;
  model?: string;
  rtspPath: string;
  rtspSubstreamPath?: string;
}

interface ConnectOptions {
  onvifEndpoint: string;
  username: string;
  password: string;
  host: string;
  ffmpegBin: string;
  rtspPaths?: string[];
  timeoutMs?: number;
}

interface ConnectDependencies {
  getStreams?: typeof getOnvifStreams;
  probe?: (url: string, ffmpegBin: string, timeoutMs: number) => Promise<"ok" | "auth_failed" | "failed">;
}

function withCredentials(rawUrl: string, username: string, password: string): string {
  const url = new URL(rawUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

function toRtspUrl(host: string, pathOrUrl: string): string {
  if (/^rtsp:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const normalizedPath = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `rtsp://${host}${normalizedPath}`;
}

function safePath(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.pathname}${url.search}` || "/";
}

function dedupe(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function probeFrame(
  rtspUrl: string,
  ffmpegBin: string,
  timeoutMs: number,
): Promise<"ok" | "auth_failed" | "failed"> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegBin,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtsp_transport",
        "tcp",
        "-i",
        rtspUrl,
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    let stderr = "";
    let settled = false;
    const finish = (result: "ok" | "auth_failed" | "failed") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
    });
    child.on("error", () => finish("failed"));
    child.on("close", (code) => {
      if (code === 0) return finish("ok");
      return finish(/401|403|unauthorized|authentication failed/i.test(stderr) ? "auth_failed" : "failed");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("failed");
    }, timeoutMs);
    timer.unref();
  });
}

export async function connectCamera(
  options: ConnectOptions,
  dependencies: ConnectDependencies = {},
): Promise<CameraConnectResult> {
  const getStreams = dependencies.getStreams ?? getOnvifStreams;
  const probe = dependencies.probe ?? probeFrame;
  const timeoutMs = options.timeoutMs ?? 10_000;
  let info: OnvifStreamInfo = {};

  const controller = new AbortController();
  const onvifTimer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    info = await getStreams(options.onvifEndpoint, options.username, options.password, {
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof OnvifError && error.code === "AUTH_FAILED") {
      throw new CameraConnectError("AUTH_FAILED", "Camera rejected the supplied credentials");
    }
    // Unsupported/broken ONVIF is allowed to fall back to known RTSP paths.
  } finally {
    clearTimeout(onvifTimer);
  }

  const candidates = dedupe([
    info.mainStream,
    ...(options.rtspPaths ?? COMMON_RTSP_PATHS),
  ]);
  for (const candidate of candidates) {
    const cleanUrl = toRtspUrl(options.host, candidate);
    const result = await probe(
      withCredentials(cleanUrl, options.username, options.password),
      options.ffmpegBin,
      timeoutMs,
    );
    if (result === "auth_failed") {
      throw new CameraConnectError("AUTH_FAILED", "Camera rejected the supplied credentials");
    }
    if (result === "ok") {
      const connected: CameraConnectResult = {
        rtspPath: safePath(cleanUrl),
      };
      if (info.manufacturer) connected.manufacturer = info.manufacturer;
      if (info.model) connected.model = info.model;
      if (info.subStream) connected.rtspSubstreamPath = safePath(info.subStream);
      return connected;
    }
  }
  throw new CameraConnectError("NO_RTSP_STREAM", "No working RTSP stream was found");
}
