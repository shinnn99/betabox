import tls from "node:tls";
// Vercel edge POP hkg1 (và có thể các POP khác của Vercel/Cloudfront khu vực
// APAC) reset socket khi Node OpenSSL đàm phán TLS 1.3 với một số bộ cipher
// mặc định — biểu hiện: `fetch('https://*.vercel.app')` timeout hoặc
// ECONNRESET NGAY sau ClientHello, trong khi curl.exe (schannel) cùng máy OK
// và Node cùng version gọi google/github TLS 1.3 OK. Ép trần TLS 1.2 cho
// toàn process khiến OpenSSL không gửi TLS 1.3 extensions → edge chấp nhận.
// Không hạ security thực sự: TLS 1.2 với ECDHE-AES-GCM vẫn là baseline
// hiện đại. Nếu sau này Vercel POP không còn reset, có thể bỏ dòng này.
tls.DEFAULT_MAX_VERSION = "TLSv1.2";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, type AgentConfig, type ScannerPin } from "./config";
import { sendScan, type ScanPayload } from "./sender";
import { ScanQueue, type QueuedScan } from "./queue";
import { ScannerSession, type ScannerBinding } from "./scanner";
import { sendHeartbeat } from "./heartbeat";
import { listLocalPorts, postDiscovery, type PortInfo } from "./discovery";
import {
  fetchClipUploadUrl,
  fetchAllActiveCameraCredentials,
  fetchRecordingCredentials,
  notifyClipUploadComplete,
  pollCommandsWithState,
  postClipCutResult,
  reportCommandResult,
  type AgentCommand,
} from "./commands";
import { DesiredStore } from "./desired-store";
import { RecordingLifecycle } from "./recording-lifecycle";
import { SegmentIndex } from "./segment-index";
import {
  checkSegmentsExist,
  cleanupOrphanClipArtifacts,
  cutClip,
  isBrowserSafeCodec,
  probeDurationSeconds,
  probeFileVideoCodec,
  type CutSegmentInput,
} from "./clip-cutter";
import { CLIPS_SUBDIR, probeCodec, testCameraConnection } from "./recording";
import { promises as fsp } from "node:fs";
import { existsSync } from "node:fs";
import { EncodeGate } from "./encode-gate";
import { describeFetchError, LogRateLimiter } from "./fetch-error";
import { installFatalHandlers, swallow } from "./fatal";
import { uploadWithTimeout } from "./upload";
import { PidRegistry } from "./pid-registry";
import { recoverZombieFfmpeg } from "./ffmpeg-boot-recovery";
import {
  verifyStaleMarker,
  quarantineStaleGeneration,
} from "./stale-recovery";

/**
 * Rate limiter dùng chung cho các fetch loop trong index.ts (heartbeat,
 * poll-commands). Log lần đầu + im 5 phút + tổng kết — tránh spam khi
 * Vercel POP reset intermittent.
 *
 * Tách singleton toàn module vì mỗi loop (heartbeat/poll-commands) chạy
 * setInterval riêng, key khác nhau — 1 limiter chứa nhiều key OK.
 */
const fetchLogLimiter = new LogRateLimiter();
import { probeTargets, reportProbes } from "./camera-probe";

/**
 * The agent runs three things on timers:
 *   1. Discovery (DISCOVERY_INTERVAL_MS): enumerate local serial ports,
 *      tell the backend what we see, learn which device_code each port
 *      maps to via identity, then reconcile open ScannerSessions.
 *   2. Heartbeat (HEARTBEAT_INTERVAL_MS): liveness ping.
 *   3. Queue flush (RETRY_INTERVAL_MS): retry scans that failed to POST.
 *
 * COM port is treated as runtime/debug only. We never persist mapping
 * by COM — discovery does the rebind work on every tick.
 */
async function main(): Promise<void> {
  installFatalHandlers();
  const config = loadConfig();

  // pkg-aware path: khi chạy trong exe (`process.pkg` truthy), __dirname
  // trỏ tới snapshot filesystem (read-only) — không ghi được. Data queue
  // phải đặt cạnh exe thật (`process.execPath`) để persist.
  //
  // Khi chạy dev (tsx / node), __dirname trỏ tới dist/, giữ như cũ.
  //
  // Font bundle (readonly, chỉ đọc): luôn dùng __dirname vì pkg đã bundle
  // vào snapshot, agent chỉ cần read.
  const isPackaged = "pkg" in process;
  const dataDir = isPackaged
    ? resolve(dirname(process.execPath), "data")
    : resolve(__dirname, "..", "data");

  const queue = new ScanQueue(resolve(dataDir, "pending-scans.jsonl"));
  const desiredStore = new DesiredStore(
    resolve(dataDir, "desired-recording.json"),
  );
  // CRIT-1 (B2): PID registry persist ffmpeg PID + boot recovery kill
  // zombie sau kill -9 agent.
  const pidRegistry = new PidRegistry(resolve(dataDir, "ffmpeg-pids.json"));
  const recordingRoot = resolve(process.cwd(), config.recordingDir);
  const segmentIndex = new SegmentIndex({
    backendUrl: config.backendUrl,
    agentCode: config.agentCode,
    agentSecret: config.agentSecret,
    recordingRoot,
    segmentWatchPollMs: config.segmentWatchPollMs,
    recoveryScanDays: config.recoveryScanDays,
    queuePath: resolve(dataDir, "pending-segment-reports.jsonl"),
  });
  // 3b-2: 1-in-flight encode gate. Chỉ 1 flag, dùng cho poll body
  // (encoding_busy) + wrap runCutClip. Không có queue local.
  const encodeGate = new EncodeGate();

  const lifecycle = new RecordingLifecycle({
    backendUrl: config.backendUrl,
    agentCode: config.agentCode,
    agentSecret: config.agentSecret,
    ffmpegBin: config.ffmpegPath,
    ffprobeBin: config.ffprobePath,
    recordingRoot,
    desiredStore,
    credentialsRetryMs: config.recordingCredentialsRetryMs,
    segmentIndex,
    pidRegistry,
  });

  console.log(
    `Warehouse agent starting — code=${config.agentCode}, backend=${config.backendUrl}, pinned=${config.pinnedScanners.length}, recordingDir=${recordingRoot}`,
  );

  // Active sessions, keyed by device_code (NOT by port path).
  const sessions = new Map<string, ScannerSession>();

  async function tryDeliver(payload: ScanPayload, { fromQueue }: { fromQueue: boolean }) {
    try {
      const result = await sendScan({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        payload,
      });
      if (result.ok) {
        const body = result.body as {
          duplicate?: boolean;
          scan_type?: "staff_qr" | "waybill";
          recognized_staff?: { staff_code: string; full_name: string } | null;
          session_action?: { action: string } | null;
          packing_result?: { status: string; assignment_method?: string } | null;
          warning?: { code: string; message?: string } | null;
        } | null;
        const dup = body?.duplicate ? " (dup)" : "";
        const warn = body?.warning ? ` [WARN: ${body.warning.code}]` : "";
        const staff = body?.recognized_staff
          ? ` [STAFF: ${body.recognized_staff.staff_code} - ${body.recognized_staff.full_name}]`
          : "";
        const session = body?.session_action
          ? ` [SESSION: ${body.session_action.action}]`
          : "";
        const packing = body?.packing_result
          ? ` [PACK: ${body.packing_result.status}${
              body.packing_result.assignment_method &&
              body.packing_result.assignment_method !== "none"
                ? ` via ${body.packing_result.assignment_method}`
                : ""
            }]`
          : "";
        const displayValue =
          body?.scan_type === "staff_qr" ? "<STAFF_QR>" : payload.raw_value;
        const tag = fromQueue ? "[OK-RETRY]" : "[OK]";
        console.log(
          `${tag}${dup}${warn}${staff}${session}${packing} ${payload.scanner_device_code} ${payload.port} -> ${displayValue}`,
        );
        return true;
      }
      console.error(
        `[FAIL ${result.status}] ${payload.scanner_device_code} ${payload.port} -> ${payload.raw_value} :: ${JSON.stringify(result.body)}`,
      );
      return false;
    } catch (err) {
      console.error(
        `[NET-FAIL] ${payload.scanner_device_code} ${payload.port} -> ${payload.raw_value} :: ${(err as Error).message}`,
      );
      return false;
    }
  }

  function onScan({
    binding,
    rawValue,
  }: { binding: ScannerBinding; rawValue: string }): void {
    const payload: ScanPayload = {
      agent_event_id: randomUUID(),
      scanner_device_code: binding.deviceCode,
      port: binding.port,
      raw_value: rawValue,
      scanned_at: new Date().toISOString(),
      source: "serial",
      device_identity_snapshot:
        Object.keys(binding.identity).length > 0 ? binding.identity : null,
    };
    void (async () => {
      const ok = await tryDeliver(payload, { fromQueue: false });
      if (!ok) {
        try {
          await queue.append(payload);
          console.log(
            `[QUEUED] ${payload.scanner_device_code} ${payload.port} -> ${payload.raw_value}`,
          );
        } catch (err) {
          console.error(`[QUEUE-FAIL] ${(err as Error).message}`);
        }
      }
    })();
  }

  function openOrRebind(binding: ScannerBinding): void {
    const existing = sessions.get(binding.deviceCode);
    if (existing) {
      const prev = existing.getBinding();
      if (prev.port !== binding.port) {
        console.log(
          `[reconcile] ${binding.deviceCode} moved ${prev.port} -> ${binding.port}`,
        );
      }
      existing.rebind(binding);
      return;
    }
    const session = new ScannerSession(
      binding,
      config.flushDebounceMs,
      config.reconnectDelayMs,
      onScan,
    );
    sessions.set(binding.deviceCode, session);
    session.start();
  }

  function closeSession(deviceCode: string, reason: string): void {
    const s = sessions.get(deviceCode);
    if (!s) return;
    console.log(`[reconcile] closing ${deviceCode} — ${reason}`);
    s.stop();
    sessions.delete(deviceCode);
  }

  /**
   * Pull the local port list, send it to backend discovery, then update
   * sessions to match the (device_code -> COM path) mapping the backend
   * returned.
   *
   * Priority:
   *   1. Discovery match — every port the backend resolved by identity.
   *      This is the normal path once a scanner has been paired in UI.
   *   2. Env-pinned SCANNERS_JSON — legacy fallback for scanners without
   *      a unique identity (cheap chips, empty serial). Pins are skipped
   *      whenever the same device_code is already paired in DB; that
   *      prevents a stale COM number in .env from fighting a fresh
   *      identity-driven binding.
   */
  async function reconcile(config: AgentConfig): Promise<void> {
    let ports: PortInfo[] = [];
    try {
      ports = await listLocalPorts();
    } catch (err) {
      console.error(`[discovery] listLocalPorts failed: ${(err as Error).message}`);
    }

    const discovery = await postDiscovery({
      backendUrl: config.backendUrl,
      agentCode: config.agentCode,
      agentSecret: config.agentSecret,
      ports,
    });

    const desired = new Map<string, ScannerBinding>();

    // 1) Discovery wins.
    if (discovery) {
      for (const p of discovery.ports) {
        if (!p.match) continue;
        desired.set(p.match.device_code, {
          deviceCode: p.match.device_code,
          port: p.path,
          baudRate: config.defaultBaudRate,
          identity: p.identity,
        });
      }
    }

    // 2) Pin fallback — only for device_codes that aren't already paired
    //    in DB (so an obsolete pin doesn't shadow the real binding) AND
    //    aren't already covered by discovery match.
    const pairedInDb = new Set(discovery?.paired_device_codes ?? []);
    for (const pin of config.pinnedScanners) {
      if (desired.has(pin.scanner_device_code)) continue;
      if (pairedInDb.has(pin.scanner_device_code)) {
        console.warn(
          `[reconcile] pin for ${pin.scanner_device_code} skipped — device already paired by identity in DB`,
        );
        continue;
      }
      desired.set(pin.scanner_device_code, {
        deviceCode: pin.scanner_device_code,
        port: pin.port,
        baudRate: pin.baudRate,
        identity: {},
      });
    }

    for (const binding of desired.values()) {
      openOrRebind(binding);
    }
    for (const code of [...sessions.keys()]) {
      if (!desired.has(code)) {
        closeSession(code, "no longer discovered");
      }
    }
  }

  /**
   * Xử lý một command đã claim từ cloud và báo kết quả về.
   *
   * At-least-once: cùng một command có thể được giao 2 lần nếu handler
   * chậm hơn visibility timeout (30s cho PING, 2 phút mặc định). Mọi
   * type job mới thêm sau này phải idempotent theo command.id.
   *
   * Lát 1 chỉ hỗ trợ 'ping'. Type khác báo failed với 'unknown_type' —
   * không crash agent.
   */
  async function handleCommand(command: AgentCommand): Promise<void> {
    if (command.type === "ping") {
      console.log(`[COMMAND PING] ${command.id}`, command.payload);
      const r = await reportCommandResult({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        commandId: command.id,
        status: "done",
        result: {
          pong: true,
          agent_local_time: new Date().toISOString(),
        },
      });
      if (!r.ok) {
        // 409 stale_command là hợp lệ (reaper đã kéo về pending trong
        // lúc mình xử lý) — chỉ log, không retry ở tầng này. Lần poll
        // sau sẽ nhận lại command với cùng id.
        console.warn(
          `[COMMAND-REPORT-FAIL ${r.status}] ${command.id} :: ${JSON.stringify(r.body)}`,
        );
      }
      return;
    }

    if (command.type === "start_recording") {
      const p = command.payload as { camera_id?: string; session_id?: string; camera_code?: string };
      if (!p.camera_id || !p.session_id) {
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: "start_recording payload missing camera_id or session_id",
        });
        return;
      }
      console.log(`[COMMAND START_RECORDING] ${command.id} camera=${p.camera_id}`);
      const outcome = await lifecycle.startOne({
        cameraId: p.camera_id,
        cameraCode: p.camera_code ?? p.camera_id,
        sessionId: p.session_id,
      });
      if (outcome.ok) {
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "done",
          result: {
            skipped: outcome.skipped,
            pid: outcome.pid ?? null,
            output_dir: outcome.outputDir ?? null,
          },
        });
      } else {
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: `${outcome.reason} (kind=${outcome.kind}) :: ${outcome.stderrTail.slice(-500)}`,
        });
      }
      return;
    }

    if (command.type === "stop_recording") {
      const p = command.payload as { camera_id?: string; session_id?: string };
      if (!p.camera_id || !p.session_id) {
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: "stop_recording payload missing camera_id or session_id",
        });
        return;
      }
      console.log(`[COMMAND STOP_RECORDING] ${command.id} camera=${p.camera_id}`);
      const outcome = await lifecycle.stopOne({
        cameraId: p.camera_id,
        sessionId: p.session_id,
      });
      await reportCommandResult({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        commandId: command.id,
        status: "done",
        result: { stopped: outcome.stopped, forced: outcome.forced },
      });
      return;
    }

    if (command.type === "cut_clip") {
      const p = command.payload as {
        clip_id?: string;
        replaces_clip_id?: string | null;
        packing_event_id?: string;
        camera_id?: string;
        waybill_code?: string;
        target_start?: string;
        target_end?: string;
        cut_start?: string;
        cut_end?: string;
        segments?: CutSegmentInput[];
        partial_coverage?: boolean;
        covered_range?: { lower?: string; upper?: string };
        gaps?: unknown;
        total_gap_seconds?: number;
        audit?: {
          end_reason?: string | null;
          next_scan_boundary?: string | null;
          next_scan_scanned_at?: string | null;
          session_end_ended_at?: string | null;
          pre_seconds?: number | null;
          before_next_seconds?: number | null;
          default_post_seconds?: number | null;
        };
      };
      if (
        !p.clip_id ||
        !p.packing_event_id ||
        !p.camera_id ||
        !p.waybill_code ||
        !p.cut_start ||
        !p.cut_end ||
        !p.target_start ||
        !p.target_end ||
        !Array.isArray(p.segments) ||
        p.segments.length === 0
      ) {
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: "cut_clip payload missing required fields (need clip_id + others)",
        });
        return;
      }
      console.log(
        `[COMMAND CUT_CLIP] ${command.id} clip=${p.clip_id} pe=${p.packing_event_id} segments=${p.segments.length} replaces=${p.replaces_clip_id ?? "null"}`,
      );

      // Safe-retry pipeline S4:
      //   1. Cắt vào temp file `{pe}.{command_id}.tmp.mp4`.
      //   2. ffprobe validate duration.
      //   3. Codec guard: chỉ h264/avc1 (Q5 chốt).
      //   4. Fetch signed URL (backend tính path v2 theo clip_id).
      //   5. PUT temp file lên bucket.
      //   6. Notify upload-complete → backend verify + gọi RPC promote.
      //   7. Local promote: rename canonical → .bak (nếu tồn tại), rename tmp → canonical.
      //   8. Xóa .bak sau khi thành công.
      //   Nếu bất kỳ bước 1-7 fail: xóa tmp, GIỮ canonical, callback failed.
      //
      // Codec guard replaces_clip_id: khi có replaces_clip_id, agent
      // BẮT BUỘC cắt mới vào tmp — KHÔNG idempotent-reuse canonical
      // cũ (chốt Q5). Auto-poll enqueue lần đầu (replaces_clip_id=null,
      // canonical không tồn tại) cũng đi qua tmp pipeline như retry.
      // Nghĩa là ta không dùng idempotent-reuse trong safe path.
      // Trade-off (chốt 2026-07-06 Q4): dùng chung 1 path đồng nhất,
      // không tối ưu lần đầu, dễ verify và audit.

      const canonicalRel = `${CLIPS_SUBDIR}/${p.packing_event_id}.mp4`;
      const canonicalAbs = resolve(recordingRoot, canonicalRel);
      const tmpRel = `${CLIPS_SUBDIR}/${p.packing_event_id}.${command.id}.tmp.mp4`;
      const tmpAbs = resolve(recordingRoot, tmpRel);
      const bakRel = `${CLIPS_SUBDIR}/${p.packing_event_id}.${command.id}.bak.mp4`;
      const bakAbs = resolve(recordingRoot, bakRel);
      const clipName = `${p.packing_event_id}.mp4`;

      const targetDurationS = (Date.parse(p.target_end) - Date.parse(p.target_start)) / 1000;

      // Local cleanup helper cho fail path: xóa tmp/bak nếu tồn tại,
      // canonical KHÔNG BAO GIỜ đụng ở fail path.
      const cleanupTmp = async () => {
        await fsp.unlink(tmpAbs).catch(() => {});
      };
      const restoreBak = async () => {
        if (existsSync(bakAbs)) {
          try {
            await fsp.rename(bakAbs, canonicalAbs);
            console.warn(
              `[clip-cutter] restored canonical from bak: pe=${p.packing_event_id}`,
            );
          } catch (err) {
            console.error(
              `[clip-cutter] CRITICAL: bak restore failed pe=${p.packing_event_id}: ${(err as Error).message}. ` +
                `Manual recovery: rename ${bakAbs} → ${canonicalAbs}`,
            );
          }
        }
      };

      // Common fail path: post cut result failed + report command failed.
      const failCommand = async (
        errorMessage: string,
        extraGenerationParams: Record<string, unknown> = {},
      ) => {
        await cleanupTmp();
        await postClipCutResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          clipId: p.clip_id!,
          packingEventId: p.packing_event_id!,
          cameraId: p.camera_id!,
          waybillCode: p.waybill_code!,
          outcome: "failed",
          errorMessage,
          sourceFiles: p.segments!.map((s) => s.file_path),
          generationParams: { ...(p.audit ?? {}), ...extraGenerationParams },
        });
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: errorMessage,
        });
      };

      // === STEP 1: Check segments tồn tại ===
      const exists = await checkSegmentsExist({
        recordingRoot,
        segments: p.segments,
      });
      if (!exists.ok) {
        console.warn(
          `[clip-cutter] segments_missing_on_disk clip=${p.clip_id} missing=${exists.missing.join(", ")}`,
        );
        await failCommand(
          `segments_missing_on_disk: ${exists.missing.join(", ")}`,
          { missing: exists.missing },
        );
        return;
      }

      // === STEP 2: Signal 'encoding' (cloud update progress_state) ===
      await postClipCutResult({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        clipId: p.clip_id,
        packingEventId: p.packing_event_id,
        cameraId: p.camera_id,
        waybillCode: p.waybill_code,
        outcome: "encoding",
        sourceFiles: p.segments.map((s) => s.file_path),
        generationParams: {
          cut_mode: "copy",
          burn_in: false,
          ...(p.audit ?? {}),
        },
      });

      // === STEP 3: Cut vào TMP file (không đụng canonical) ===
      const cutStartIso = p.cut_start;
      const cutEndIso = p.cut_end;
      const segments = p.segments;

      const cutResult = await encodeGate.run(() =>
        cutClip({
          ffmpegBin: config.ffmpegPath,
          ffprobeBin: config.ffprobePath,
          recordingRoot,
          outputAbsPath: tmpAbs,
          cutStart: new Date(cutStartIso),
          cutEnd: new Date(cutEndIso),
          segments,
        }),
      );

      if (!cutResult.ok) {
        console.error(
          `[clip-cutter] cut failed clip=${p.clip_id} :: ${cutResult.errorMessage}`,
        );
        await failCommand(cutResult.errorMessage ?? "cut_clip failed", {
          stderr_tail: cutResult.stderrTail.slice(-500),
          elapsed_ms: cutResult.elapsedMs,
        });
        return;
      }

      // === STEP 4: Codec guard — CHỈ H.264 (codec_name='h264' hoặc codec_tag_string='avc1') ===
      const codecProbe = await probeFileVideoCodec(config.ffprobePath, tmpAbs);
      if (!isBrowserSafeCodec(codecProbe)) {
        const display = codecProbe.codecName ?? codecProbe.codecTag ?? "unknown";
        console.error(
          `[clip-cutter] codec guard failed clip=${p.clip_id} name=${codecProbe.codecName ?? "null"} tag=${codecProbe.codecTag ?? "null"}`,
        );
        await failCommand(`unsupported_output_codec: ${display}`, {
          output_codec_name: codecProbe.codecName,
          output_codec_tag: codecProbe.codecTag,
          codec_probed: codecProbe.probed,
        });
        return;
      }

      console.log(
        `[clip-cutter] tmp cut ok clip=${p.clip_id} size=${cutResult.fileSizeBytes} ` +
          `duration=${cutResult.durationSeconds.toFixed(2)}s ` +
          `codec_name=${codecProbe.codecName} codec_tag=${codecProbe.codecTag} ` +
          `elapsed=${cutResult.elapsedMs}ms`,
      );

      // === STEP 5: Fetch signed upload URL (backend tính path v2 từ clip_id) ===
      const urlResult = await fetchClipUploadUrl({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        clipId: p.clip_id,
        packingEventId: p.packing_event_id,
      });
      if (!urlResult.ok) {
        console.error(
          `[clip-cutter] fetchClipUploadUrl failed clip=${p.clip_id}: ${urlResult.error} http=${urlResult.status}`,
        );
        await failCommand(`signed_url_fetch_failed: ${urlResult.error}`);
        return;
      }

      // === STEP 6: PUT tmp lên bucket ===
      let fileBuf: Buffer;
      try {
        fileBuf = await fsp.readFile(tmpAbs);
      } catch (err) {
        await failCommand(`read_tmp_failed: ${(err as Error).message}`);
        return;
      }
      const uploadResult = await uploadWithTimeout(urlResult.signedUrl, fileBuf, {
        contentType: "video/mp4",
      });
      if (!uploadResult.ok) {
        await failCommand(
          `upload_put_failed[${uploadResult.errorKind}]: ${uploadResult.errorMessage ?? "unknown"} attempts=${uploadResult.attempts} elapsed=${uploadResult.totalElapsedMs}ms`,
        );
        return;
      }
      const uploadElapsedMs = uploadResult.totalElapsedMs;

      // === STEP 7: Notify upload-complete → backend verify + RPC promote ===
      // Backend endpoint clip-upload-complete gọi promote_clip_generation
      // trong tx: nếu OK → row DB đã promote (ready + bucket_path v2).
      // Nếu fail → giữ nguyên trạng thái pending, agent tự cleanup tmp.
      const notify = await notifyClipUploadComplete({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        clipId: p.clip_id,
        packingEventId: p.packing_event_id,
        fileSizeBytes: cutResult.fileSizeBytes,
      });
      if (!notify.ok) {
        console.error(
          `[clip-cutter] notify_complete failed clip=${p.clip_id}: ${notify.error}`,
        );
        // Không tự xóa object đã upload — TTL 72h sẽ dọn nếu promote không xảy ra.
        await failCommand(`notify_complete_failed: ${notify.error}`);
        return;
      }

      // === STEP 8: Local promote canonical với rollback ===
      // A) Nếu canonical hiện tại tồn tại → rename → .bak.
      // B) Rename tmp → canonical.
      // C) Nếu bất kỳ bước A/B fail sau khi bucket đã promote:
      //    - restore .bak về canonical (nếu có).
      //    - log CRITICAL cho ops (DB đã ready path v2, ổ local
      //      trỏ file cũ → user vẫn xem được từ bucket qua signed URL).
      //
      // KHÔNG xóa tmp khi promote fail — giữ file cho boot recovery
      // (S10 Mạch 2). Ghi kèm marker `{tmp}.stale` để boot cleanup
      // biết đây là temp của generation ĐÃ ready (bucket + DB), cần
      // recover local, KHÔNG sweep dù > 24h.
      const stalePath = `${tmpAbs}.stale`;
      const markStale = async () => {
        try {
          await fsp.writeFile(
            stalePath,
            JSON.stringify(
              {
                clip_id: p.clip_id,
                packing_event_id: p.packing_event_id,
                command_id: command.id,
                bucket_path: urlResult.bucketPath,
                created_at: new Date().toISOString(),
                reason: "local_canonical_stale",
              },
              null,
              2,
            ),
            "utf8",
          );
        } catch (err) {
          console.error(
            `[clip-cutter] write .stale marker failed clip=${p.clip_id}: ${(err as Error).message}`,
          );
        }
      };

      let hadBak = false;
      try {
        if (existsSync(canonicalAbs)) {
          await fsp.rename(canonicalAbs, bakAbs);
          hadBak = true;
        }
      } catch (err) {
        console.error(
          `[clip-cutter] rename canonical → bak failed clip=${p.clip_id}: ${(err as Error).message}`,
        );
        // DB + bucket đã promote thành công. Ổ local: giữ tmp + marker
        // .stale để boot recovery tự xử. Canonical CŨ vẫn còn ở
        // {pe_id}.mp4 — user có thể xem từ bucket qua signed URL.
        await markStale();
        await postClipCutResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          clipId: p.clip_id,
          packingEventId: p.packing_event_id,
          cameraId: p.camera_id,
          waybillCode: p.waybill_code,
          outcome: "done",
          clipPath: canonicalRel,
          clipName,
          clipStartedAt: p.target_start,
          clipEndedAt: p.target_end,
          durationSeconds: Math.round(cutResult.durationSeconds),
          durationDriftSeconds: cutResult.durationDriftSeconds,
          fileSizeBytes: cutResult.fileSizeBytes,
          isPartial: p.partial_coverage ?? false,
          coveredRangeLower: p.covered_range?.lower ?? null,
          coveredRangeUpper: p.covered_range?.upper ?? null,
          sourceFiles: p.segments.map((s) => s.file_path),
          generationParams: {
            cut_mode: "copy",
            burn_in: false,
            local_canonical_rename_failed: true,
            local_canonical_stale: true,
            local_recovery_tmp_path: tmpRel,
            output_codec_name: codecProbe.codecName,
            output_codec_tag: codecProbe.codecTag,
            elapsed_ms: cutResult.elapsedMs,
            upload_elapsed_ms: uploadElapsedMs,
            total_gap_seconds: p.total_gap_seconds ?? 0,
            gaps: p.gaps ?? [],
            ...(p.audit ?? {}),
          },
        });
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "done",
          result: {
            local_canonical_stale: true,
            local_recovery_tmp_path: tmpRel,
            bucket_path: urlResult.bucketPath,
            file_size_bytes: cutResult.fileSizeBytes,
          },
        });
        return;
      }

      try {
        await fsp.rename(tmpAbs, canonicalAbs);
      } catch (err) {
        console.error(
          `[clip-cutter] rename tmp → canonical failed clip=${p.clip_id}: ${(err as Error).message}`,
        );
        if (hadBak) await restoreBak();
        // DB + bucket đã promote OK; ổ local giữ file cũ. Giữ tmp +
        // marker cho boot recovery. Không call failCommand vì bucket
        // + DB đã ready. Report done + flag.
        await markStale();
        await postClipCutResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          clipId: p.clip_id,
          packingEventId: p.packing_event_id,
          cameraId: p.camera_id,
          waybillCode: p.waybill_code,
          outcome: "done",
          clipPath: canonicalRel,
          clipName,
          clipStartedAt: p.target_start,
          clipEndedAt: p.target_end,
          durationSeconds: Math.round(cutResult.durationSeconds),
          durationDriftSeconds: cutResult.durationDriftSeconds,
          fileSizeBytes: cutResult.fileSizeBytes,
          isPartial: p.partial_coverage ?? false,
          coveredRangeLower: p.covered_range?.lower ?? null,
          coveredRangeUpper: p.covered_range?.upper ?? null,
          sourceFiles: p.segments.map((s) => s.file_path),
          generationParams: {
            cut_mode: "copy",
            burn_in: false,
            local_tmp_rename_failed: true,
            local_canonical_stale: true,
            local_recovery_tmp_path: tmpRel,
            output_codec_name: codecProbe.codecName,
            output_codec_tag: codecProbe.codecTag,
            elapsed_ms: cutResult.elapsedMs,
            upload_elapsed_ms: uploadElapsedMs,
            total_gap_seconds: p.total_gap_seconds ?? 0,
            gaps: p.gaps ?? [],
            ...(p.audit ?? {}),
          },
        });
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "done",
          result: {
            local_canonical_stale: true,
            bucket_path: urlResult.bucketPath,
            file_size_bytes: cutResult.fileSizeBytes,
          },
        });
        return;
      }

      // Rename OK — dọn .bak. Nếu bak unlink fail, để cleanup .bak > 24h boot dọn.
      if (hadBak) {
        await fsp.unlink(bakAbs).catch(() => {});
      }

      console.log(
        `[clip-cutter] promoted clip=${p.clip_id} pe=${p.packing_event_id} ` +
          `size=${cutResult.fileSizeBytes} bucket=${urlResult.bucketPath} ` +
          `cut_elapsed=${cutResult.elapsedMs}ms upload_elapsed=${uploadElapsedMs}ms`,
      );

      await postClipCutResult({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        clipId: p.clip_id,
        packingEventId: p.packing_event_id,
        cameraId: p.camera_id,
        waybillCode: p.waybill_code,
        outcome: "done",
        clipPath: canonicalRel,
        clipName,
        clipStartedAt: p.target_start,
        clipEndedAt: p.target_end,
        durationSeconds: Math.round(cutResult.durationSeconds),
        durationDriftSeconds: cutResult.durationDriftSeconds,
        fileSizeBytes: cutResult.fileSizeBytes,
        isPartial: p.partial_coverage ?? false,
        coveredRangeLower: p.covered_range?.lower ?? null,
        coveredRangeUpper: p.covered_range?.upper ?? null,
        sourceFiles: p.segments.map((s) => s.file_path),
        generationParams: {
          cut_mode: "copy",
          burn_in: false,
          output_codec_name: codecProbe.codecName,
          output_codec_tag: codecProbe.codecTag,
          ss_seconds: (Date.parse(p.cut_start) - Date.parse(p.segments[0].started_at)) / 1000,
          t_seconds: (Date.parse(p.cut_end) - Date.parse(p.cut_start)) / 1000,
          elapsed_ms: cutResult.elapsedMs,
          upload_elapsed_ms: uploadElapsedMs,
          total_gap_seconds: p.total_gap_seconds ?? 0,
          gaps: p.gaps ?? [],
          ...(p.audit ?? {}),
        },
      });

      await reportCommandResult({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        commandId: command.id,
        status: "done",
        result: {
          clip_path: canonicalRel,
          bucket_path: urlResult.bucketPath,
          file_size_bytes: cutResult.fileSizeBytes,
          duration_seconds: Math.round(cutResult.durationSeconds),
          duration_drift_seconds: cutResult.durationDriftSeconds,
          is_partial: p.partial_coverage ?? false,
          cut_elapsed_ms: cutResult.elapsedMs,
          upload_elapsed_ms: uploadElapsedMs,
        },
      });
      // Không dùng `targetDurationS` trong safe path (không phải idempotent-reuse).
      // Log vẫn tham chiếu qua durationDriftSeconds. Ép TS narrowing:
      void targetDurationS;
      void probeDurationSeconds;
      return;
    }

    if (command.type === "upload_clip") {
      // Safe-retry S4 (2026-07-06): upload đã gộp vào `cut_clip` pipeline.
      // Command `upload_clip` chỉ có thể do backend legacy (chưa deploy
      // Safe Retry) enqueue → agent version mới báo failed rõ ràng để ops
      // biết mismatch protocol. Mạch 2 sẽ loại hẳn command này ở backend.
      console.warn(
        `[upload_clip] DEPRECATED after Safe Retry (2026-07-06). Command ignored.`,
      );
      await reportCommandResult({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        commandId: command.id,
        status: "failed",
        error: "upload_clip_deprecated_after_safe_retry",
      });
      return;
    }

    if (command.type === "probe_codec") {
      const p = command.payload as { camera_id?: string };
      if (!p.camera_id) {
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: "probe_codec payload missing camera_id",
        });
        return;
      }
      console.log(`[COMMAND PROBE_CODEC] ${command.id} camera=${p.camera_id}`);
      // Load RTSP url qua endpoint credentials (KHÔNG gửi credential
      // qua payload agent_commands — nguyên tắc từ Lát 2).
      let rtspUrl: string;
      let transport: "tcp" | "udp";
      try {
        const creds = await fetchRecordingCredentials({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          cameraIds: [p.camera_id],
        });
        const cred = creds.find((c) => c.camera_id === p.camera_id);
        if (!cred) {
          throw new Error("camera credential not returned by backend");
        }
        rtspUrl = cred.rtsp_url;
        transport = cred.transport;
      } catch (err) {
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: `credentials_fetch_failed: ${(err as Error).message}`,
        });
        return;
      }

      const probe = await probeCodec(config.ffprobePath, rtspUrl, transport);
      if (probe.ok) {
        console.log(
          `[probe_codec] camera=${p.camera_id} codec=${probe.codec} warning=${probe.codecWarning ?? "none"}`,
        );
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "done",
          result: {
            codec: probe.codec,
            warning: probe.codecWarning,
          },
        });
      } else {
        console.warn(
          `[probe_codec] camera=${p.camera_id} FAILED reason=${probe.reason}`,
        );
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: `probe_failed: ${probe.reason}`,
        });
      }
      return;
    }

    if (command.type === "test_camera_connection") {
      const p = command.payload as { camera_id?: string; transport?: "tcp" | "udp" | "auto" };
      if (!p.camera_id) {
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: "test_camera_connection payload missing camera_id",
        });
        return;
      }
      console.log(`[COMMAND TEST_CAMERA_CONNECTION] ${command.id} camera=${p.camera_id}`);
      let rtspUrl: string;
      let credTransport: "tcp" | "udp";
      try {
        const creds = await fetchRecordingCredentials({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          cameraIds: [p.camera_id],
        });
        const cred = creds.find((c) => c.camera_id === p.camera_id);
        if (!cred) {
          throw new Error("camera credential not returned by backend");
        }
        rtspUrl = cred.rtsp_url;
        credTransport = cred.transport;
      } catch (err) {
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: `credentials_fetch_failed: ${(err as Error).message}`,
        });
        return;
      }
      // Payload transport override cred transport nếu client chỉ định cụ thể;
      // "auto"/undefined → dùng cred transport (đã fallback tcp/udp trong recording start).
      const requested = p.transport ?? "auto";
      const useTransport: "tcp" | "udp" =
        requested === "tcp" || requested === "udp" ? requested : credTransport;

      const result = await testCameraConnection(
        config.ffmpegPath,
        rtspUrl,
        useTransport,
      );
      if (result.ok) {
        console.log(
          `[test_camera_connection] camera=${p.camera_id} OK transport=${result.transportUsed} duration=${result.durationMs}ms`,
        );
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "done",
          result: {
            message: "Kết nối camera thành công.",
            duration_ms: result.durationMs,
            transport_used: result.transportUsed,
          },
        });
      } else {
        console.warn(
          `[test_camera_connection] camera=${p.camera_id} FAILED reason=${result.reason}`,
        );
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: `test_failed: ${result.reason}`,
        });
      }
      return;
    }

    console.warn(`[COMMAND UNKNOWN] ${command.id} type=${command.type}`);
    await reportCommandResult({
      backendUrl: config.backendUrl,
      agentCode: config.agentCode,
      agentSecret: config.agentSecret,
      commandId: command.id,
      status: "failed",
      error: "unknown_type",
    });
  }

  async function pollOnce(): Promise<void> {
    let commands: AgentCommand[] = [];
    try {
      commands = await pollCommandsWithState({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        activeRecordings: lifecycle.snapshotActive(),
        encodingBusy: encodeGate.isBusy(),
      });
    } catch (err) {
      // pollCommandsWithState nội bộ chưa có retry — nhưng poll chạy mỗi
      // 3s, tự nó là "retry loop tự nhiên". Không cần retry nội bộ vì
      // sẽ chồng lên lần poll kế. Log qua rate limiter cho gọn.
      const desc = describeFetchError(err);
      const codeMatch = desc.match(/code=(\w+)/);
      const code = codeMatch ? codeMatch[1] : "unknown";
      const verdict = fetchLogLimiter.tick(`poll-commands:${code}`);
      if (verdict.kind === "log_first") {
        console.error(`[COMMAND-POLL-FAIL] ${desc}`);
      } else if (verdict.kind === "log_summary") {
        console.error(
          `[COMMAND-POLL] still failing (${code}): ${verdict.count + 1} lần trong 5m`,
        );
      }
      return;
    }
    for (const cmd of commands) {
      try {
        await handleCommand(cmd);
      } catch (err) {
        console.error(
          `[COMMAND-HANDLER-ERROR] ${cmd.id} :: ${(err as Error).message}`,
        );
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: cmd.id,
          status: "failed",
          error: (err as Error).message.slice(0, 500),
        }).catch(() => undefined);
      }
    }
  }

  // Heartbeat so the backend dashboard knows the agent is alive.
  // sendHeartbeat đã retry 3 lần với backoff — chỉ đến đây khi tất cả
  // fail. Log qua rate limiter (lần đầu + tổng kết mỗi 5m).
  //
  // NTP guard: sendHeartbeat đo drift qua /api/warehouse/time-check
  // trước POST. Log warning khi drift > 30s để user biết. Rate limit
  // qua fetchLogLimiter (không spam mỗi 30s).
  async function ping(): Promise<void> {
    try {
      const r = await sendHeartbeat({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
      });
      if (!r.ok) console.error(`[HEARTBEAT-FAIL ${r.status}]`);
      // Log drift khi > ngưỡng. 30s = default backend badge threshold.
      // Chia key theo bucket để log lại nếu drift đổi cấp độ (30s →
      // 300s là bug nặng hơn, đáng log riêng).
      if (r.driftSeconds !== null && r.driftSeconds > 30) {
        const bucket =
          r.driftSeconds > 3600 ? "over_1h" :
          r.driftSeconds > 300 ? "over_5m" :
          "over_30s";
        const verdict = fetchLogLimiter.tick(`ntp-drift:${bucket}`);
        if (verdict.kind === "log_first") {
          console.warn(
            `[NTP-DRIFT] agent clock lệch ~${r.driftSeconds}s so với server. ` +
            `Kiểm tra Windows Time Service: w32tm /query /status. ` +
            `Nếu bị tắt: w32tm /config /manualpeerlist:"pool.ntp.org" /syncfromflags:manual /reliable:yes /update && w32tm /resync`,
          );
        } else if (verdict.kind === "log_summary") {
          console.warn(
            `[NTP-DRIFT] still lệch (${bucket}): ${verdict.count + 1} lần trong 5m — check w32tm`,
          );
        }
      }
    } catch (err) {
      const desc = describeFetchError(err);
      const codeMatch = desc.match(/code=(\w+)/);
      const code = codeMatch ? codeMatch[1] : "unknown";
      const verdict = fetchLogLimiter.tick(`heartbeat:${code}`);
      if (verdict.kind === "log_first") {
        console.error(`[HEARTBEAT-THREW] ${desc} (retry+backoff exhausted)`);
      } else if (verdict.kind === "log_summary") {
        console.error(
          `[HEARTBEAT] still failing (${code}): ${verdict.count + 1} lần trong 5m`,
        );
      }
    }
  }

  // Boot: first discovery + first ping in parallel.
  await Promise.all([reconcile(config), ping()]);

  // Clip output directory + dọn concat.txt orphan lúc boot (nếu agent
  // crash giữa cắt clip lần trước).
  const clipsDir = resolve(recordingRoot, CLIPS_SUBDIR);
  await fsp.mkdir(clipsDir, { recursive: true });

  // Font extract cho burn/mark đã xoá 2026-07-05 — đường clip chốt
  // "video thuần", không burn, không overlay. Thông tin đơn ở panel
  // dashboard. Không có kế hoạch thêm lại font ở agent.
  try {
    // HIGH-13 (B4): inject DB verifier + quarantine helper. Recovery chỉ
    // rename tmp → canonical khi backend xác nhận marker khớp
    // order_proof_clips row. Nếu backend unavailable, giữ nguyên files.
    const cleanup = await cleanupOrphanClipArtifacts(clipsDir, undefined, {
      verifyMarker: (marker) =>
        verifyStaleMarker({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          marker,
        }),
      quarantine: (args) => quarantineStaleGeneration(args),
    });
    const hasAction =
      cleanup.concat_removed +
        cleanup.stale_recovered +
        cleanup.stale_recovery_failed +
        cleanup.tmp_orphan_removed +
        cleanup.bak_orphan_removed >
      0;
    if (hasAction) {
      console.log(
        `[clip-cleanup] boot: ` +
          `concat=${cleanup.concat_removed} ` +
          `stale_recovered=${cleanup.stale_recovered} ` +
          `stale_failed=${cleanup.stale_recovery_failed} ` +
          `tmp_orphan=${cleanup.tmp_orphan_removed} ` +
          `bak_orphan=${cleanup.bak_orphan_removed}`,
      );
    }
  } catch (err) {
    console.warn(`[clip-cleanup] boot cleanup failed: ${(err as Error).message}`);
  }

  // Segment index: bắt đầu watcher poll + flush queue.
  segmentIndex.start();

  // CRIT-1 (B2) boot recovery: đọc PID registry, kill zombie ffmpeg từ
  // lần chạy trước bị kill -9 hoặc crash native. Phải chạy TRƯỚC
  // lifecycle.boot vì boot có thể spawn ffmpeg mới; nếu zombie chưa
  // chết, ffmpeg mới sẽ bị camera 1-connection RTSP reject.
  //
  // Chạy tuần tự (await) chứ không fire-and-forget: cần chờ zombie chết
  // trước khi spawn mới. Fail của boot recovery không block agent —
  // chỉ log rồi tiếp tục.
  try {
    const rec = await recoverZombieFfmpeg(pidRegistry);
    if (rec.totalEntries > 0) {
      console.log(
        `[boot-recovery] result total=${rec.totalEntries} killed=${rec.killed} already_dead=${rec.alreadyDead} pid_reused=${rec.pidReused} errors=${rec.errors}`,
      );
    }
  } catch (err) {
    console.error(
      `[boot-recovery] fatal error, continuing: ${(err as Error).message}`,
    );
  }

  // Boot recording lifecycle: đọc desired file, gọi cloud lấy credential
  // (retry mãi nếu mạng chưa lên — log leo thang theo ngưỡng), spawn
  // song song bằng allSettled. Chạy nền để không block startup.
  // Sau khi boot xong, kích boot recovery của segment index dựa trên
  // camera đã sống dậy (backfill segment sinh trong lúc agent chết).
  swallow(
    lifecycle.boot().then(() => {
      const active = lifecycle.activeCameraInfos();
      return segmentIndex.bootRecovery(active);
    }),
    "lifecycle.boot+bootRecovery",
  );

  const discoveryTimer = setInterval(() => {
    swallow(reconcile(config), "reconcile");
  }, config.discoveryIntervalMs);
  const heartbeatTimer = setInterval(ping, config.heartbeatIntervalMs);
  const pollTimer = setInterval(() => {
    swallow(pollOnce(), "pollOnce");
  }, config.pollIntervalMs);

  // Camera probe (mở rộng):
  //   Nguồn A — lifecycle.probeTargets(): camera đang recording hoặc đang
  //     long-retry vì tắt vật lý (giữ nguyên hành vi cũ).
  //   Nguồn B — cloud fetch all_active: mọi camera status='active' của org,
  //     kể cả chưa recording. Để UI hiện Online cho camera vừa cấu hình,
  //     không bắt user Test kết nối tay hoặc chờ Start recording.
  // Union theo cameraId (A tinh — có rtspUrl tin cậy từ config file/desired;
  // B chỉ dùng cho camera A không có).
  //
  // Nếu fetch B fail (mạng flake) → skip, dùng A một mình như cũ. Không
  // block probe loop.
  const cameraProbeTimer = setInterval(async () => {
    const localTargets = lifecycle.probeTargets();
    const localIds = new Set(localTargets.map((t) => t.cameraId));

    let allActiveTargets: Array<{ cameraId: string; cameraCode: string; rtspUrl: string }> = [];
    try {
      const creds = await fetchAllActiveCameraCredentials({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
      });
      allActiveTargets = creds
        .filter((c) => !localIds.has(c.camera_id))
        .map((c) => ({
          cameraId: c.camera_id,
          cameraCode: c.camera_code,
          rtspUrl: c.rtsp_url,
        }));
    } catch (err) {
      // Log nhưng không throw — probe local vẫn chạy.
      console.warn(
        `[camera-probe] fetch all_active failed: ${(err as Error).message}`,
      );
    }

    const targets = [...localTargets, ...allActiveTargets];
    if (targets.length === 0) return;
    const results = await probeTargets(targets);
    // Fast recovery: probe biết trước ffmpeg — nếu camera sống lại
    // (probe ok 2 nhịp liên tiếp) trong khi state đang chờ long-retry
    // timer 5', trigger spawn ngay không đợi hết timer.
    for (const r of results) {
      lifecycle.notifyProbeResult(r.camera_id, r.ok);
    }
    await reportProbes({
      backendUrl: config.backendUrl,
      agentCode: config.agentCode,
      agentSecret: config.agentSecret,
      probes: results,
    });
  }, config.cameraProbeIntervalMs);

  // Retry queued scans periodically.
  const flushTimer = setInterval(async () => {
    const items = await queue.readAll().catch((): QueuedScan[] => []);
    if (items.length === 0) return;
    const remaining: QueuedScan[] = [];
    for (const item of items) {
      // Older queued payloads may not have source/identity. Backfill so
      // the backend never sees a malformed body.
      const payload: ScanPayload = {
        ...item.payload,
        source: item.payload.source ?? "serial",
        device_identity_snapshot:
          item.payload.device_identity_snapshot ?? null,
      };
      const ok = await tryDeliver(payload, { fromQueue: true });
      if (!ok) {
        remaining.push({ ...item, attempt: item.attempt + 1 });
      }
    }
    try {
      await queue.rewrite(remaining);
    } catch (err) {
      console.error(`[QUEUE-REWRITE-FAIL] ${(err as Error).message}`);
    }
  }, config.retryIntervalMs);

  const shutdown = () => {
    console.log("Shutting down warehouse agent...");
    clearInterval(flushTimer);
    clearInterval(heartbeatTimer);
    clearInterval(discoveryTimer);
    clearInterval(pollTimer);
    clearInterval(cameraProbeTimer);
    for (const s of sessions.values()) s.stop();
    // Graceful stop mọi ffmpeg đang chạy để moov trailer segment cuối
    // được ghi. Không await — process.exit sẽ chạy sau delay.
    swallow(lifecycle.shutdown(), "lifecycle.shutdown");
    swallow(segmentIndex.stop(), "segmentIndex.stop");
    // HIGH-19 (B4): flush pending queue writes để không mất scan/segment
    // report chưa flush do coalesce timer.
    swallow(queue.flushNow(), "queue.flushNow");
    setTimeout(() => process.exit(0), 1500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Silence ScannerPin-unused warning if no pins are configured.
  void ({} as ScannerPin);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
