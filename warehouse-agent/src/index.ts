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
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, type AgentConfig, type ScannerPin } from "./config";
import { sendScan, type ScanPayload } from "./sender";
import { ScanQueue, type QueuedScan } from "./queue";
import { ScannerSession, type ScannerBinding } from "./scanner";
import { sendHeartbeat } from "./heartbeat";
import { listLocalPorts, postDiscovery, type PortInfo } from "./discovery";
import {
  fetchClipUploadUrl,
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
  cleanupOrphanConcatFiles,
  cutClip,
  probeDurationSeconds,
  type CutSegmentInput,
} from "./clip-cutter";
import { CLIPS_SUBDIR, probeCodec, testCameraConnection } from "./recording";
import { promises as fsp } from "node:fs";
import { existsSync } from "node:fs";
import { EncodeGate } from "./encode-gate";
import { describeFetchError, LogRateLimiter } from "./fetch-error";

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
  const config = loadConfig();
  const queue = new ScanQueue(resolve(__dirname, "..", "data", "pending-scans.jsonl"));
  const desiredStore = new DesiredStore(
    resolve(__dirname, "..", "data", "desired-recording.json"),
  );
  const recordingRoot = resolve(process.cwd(), config.recordingDir);
  const segmentIndex = new SegmentIndex({
    backendUrl: config.backendUrl,
    agentCode: config.agentCode,
    agentSecret: config.agentSecret,
    recordingRoot,
    segmentWatchPollMs: config.segmentWatchPollMs,
    recoveryScanDays: config.recoveryScanDays,
    queuePath: resolve(__dirname, "..", "data", "pending-segment-reports.jsonl"),
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
        packing_event_id?: string;
        camera_id?: string;
        waybill_code?: string;
        target_start?: string;
        target_end?: string;
        cut_start?: string;
        cut_end?: string;
        work_started_at?: string;
        work_ended_at?: string | null;
        segments?: CutSegmentInput[];
        partial_coverage?: boolean;
        covered_range?: { lower?: string; upper?: string };
        gaps?: unknown;
        total_gap_seconds?: number;
        // Chống nghi cắt ghép: dấu chèn tại điểm nối gap. Cloud tính,
        // agent render mp4 tmp + đan xen concat.
        marks?: Array<{
          after_segment_index: number;
          gap_seconds: number;
          kind: "mark_short" | "black_full";
          duration_seconds: number;
        }>;
      };
      if (
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
          error: "cut_clip payload missing required fields",
        });
        return;
      }
      console.log(
        `[COMMAND CUT_CLIP] ${command.id} packing_event=${p.packing_event_id} segments=${p.segments.length} partial=${p.partial_coverage ?? false}`,
      );

      const outputRel = `${CLIPS_SUBDIR}/${p.packing_event_id}.mp4`;
      const outputAbs = resolve(recordingRoot, outputRel);
      const clipName = `${p.packing_event_id}.mp4`;

      // Idempotent: nếu clip đã tồn tại + probe data hợp lệ → gửi `done`
      // với data probe (KHÔNG `skipped`).
      //
      // Trước (2026-07-03): dùng `skipped` với giả định "cloud giữ row
      // cũ". Rà DB thấy 0 row nhưng 32 command done trong 10 phút cho
      // 1 pe_id — vòng lặp: agent skip idempotent → cloud không update
      // DB (outcome=skipped early-return) → /watch thấy chưa có row →
      // enqueue lại → agent skip → ...
      //
      // Fix (C): probe duration + size từ file có sẵn → gửi outcome=done
      // với data thật. Backend insert row status=ready → /watch tick sau
      // thấy ready + enqueue upload → hết loop.
      //
      // Trước tick sau, `hasRecentEnqueuedCut` cooldown 60s ở /watch chặn
      // dội bất kể lý do — lưới cho ca report fail (mạng).
      const targetDurationS = (Date.parse(p.target_end) - Date.parse(p.target_start)) / 1000;
      if (existsSync(outputAbs)) {
        try {
          const st = await fsp.stat(outputAbs);
          if (st.size > 0) {
            const probedDuration = await probeDurationSeconds(config.ffprobePath, outputAbs);
            if (probedDuration !== null && probedDuration > 0) {
              const drift = Math.abs(targetDurationS - probedDuration);
              await postClipCutResult({
                backendUrl: config.backendUrl,
                agentCode: config.agentCode,
                agentSecret: config.agentSecret,
                packingEventId: p.packing_event_id,
                cameraId: p.camera_id,
                waybillCode: p.waybill_code,
                outcome: "done",
                clipPath: outputRel,
                clipName,
                clipStartedAt: p.cut_start,
                clipEndedAt: p.cut_end,
                durationSeconds: probedDuration,
                durationDriftSeconds: drift,
                fileSizeBytes: st.size,
                isPartial: p.partial_coverage ?? false,
                coveredRangeLower: p.covered_range?.lower ?? null,
                coveredRangeUpper: p.covered_range?.upper ?? null,
                sourceFiles: p.segments.map((s) => s.file_path),
                generationParams: {
                  cut_mode: "copy",
                  idempotent_reuse: true,
                  total_gap_seconds: p.total_gap_seconds ?? 0,
                },
              });
              await reportCommandResult({
                backendUrl: config.backendUrl,
                agentCode: config.agentCode,
                agentSecret: config.agentSecret,
                commandId: command.id,
                status: "done",
                result: {
                  idempotent_reuse: true,
                  clip_path: outputRel,
                  file_size_bytes: st.size,
                  duration_seconds: probedDuration,
                },
              });
              console.log(
                `[clip-cutter] idempotent-reuse packing_event=${p.packing_event_id} size=${st.size} duration=${probedDuration}s`,
              );
              return;
            }
            // Probe fail hoặc duration <= 0 → file có mà không đọc được.
            // Coi như file hỏng, cắt lại (fall through).
            console.warn(
              `[clip-cutter] existing file probe failed packing_event=${p.packing_event_id} size=${st.size} — recutting`,
            );
          }
        } catch {
          // stat lỗi — cắt lại
        }
      }

      // Kiểm segments tồn tại trên ổ trước khi build concat.
      const exists = await checkSegmentsExist({
        recordingRoot,
        segments: p.segments,
      });
      if (!exists.ok) {
        console.warn(
          `[clip-cutter] segments_missing_on_disk packing_event=${p.packing_event_id} missing=${exists.missing.join(", ")}`,
        );
        await postClipCutResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          packingEventId: p.packing_event_id,
          cameraId: p.camera_id,
          waybillCode: p.waybill_code,
          outcome: "failed",
          errorMessage: `segments_missing_on_disk: ${exists.missing.join(", ")}`,
          sourceFiles: p.segments.map((s) => s.file_path),
          generationParams: { missing: exists.missing },
        });
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: `segments_missing_on_disk: ${exists.missing.join(", ")}`,
        });
        return;
      }

      // 3b-1: nếu payload có work_started_at → burn-in. work_started_at
      // là mốc scan gốc (khớp log tuyệt đối), tách khỏi target_start
      // (đã cộng pre-roll) và cut_start (thêm GOP pad). Xem
      // enqueueCutClip trong backend.
      const workStarted = p.work_started_at ?? null;
      const workEnded = p.work_ended_at ?? null;
      const burnIn = workStarted
        ? {
            fontPath: burnFontPath,
            waybillCode: p.waybill_code,
            workStartedAt: workStarted,
            workEndedAt: workEnded,
            isPartial: p.partial_coverage ?? false,
            totalGapSeconds: p.total_gap_seconds ?? 0,
            position: config.burnPosition,
            fontSizeRatio: config.burnFontSizeRatio,
            fontColor: config.burnFontColor,
            borderColor: config.burnBorderColor,
            borderWidth: config.burnBorderWidth,
            warningColor: config.burnWarningColor,
          }
        : null;

      // 3b-2: gate 1-in-flight. Poll-filter + claim-limit-1 đã ngăn
      // 2 cut_clip cùng lúc, gate là assertion phòng thủ fail-loud
      // nếu logic filter lỗi. Trước encode: gửi outcome='encoding'
      // để cloud upsert row với progress_state='encoding' (UI hiện
      // "đang cắt clip"). Sau encode: outcome final như trước.
      await postClipCutResult({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        packingEventId: p.packing_event_id,
        cameraId: p.camera_id,
        waybillCode: p.waybill_code,
        outcome: "encoding",
        sourceFiles: p.segments.map((s) => s.file_path),
        generationParams: {
          cut_mode: burnIn ? "reencode" : "copy",
          burn_in: burnIn ? true : false,
        },
      });

      // Gán biến local để giữ narrowing khi vào closure encodeGate.run.
      const cutStartIso = p.cut_start;
      const cutEndIso = p.cut_end;
      const segments = p.segments;
      const marks = p.marks ?? [];

      // Chống nghi cắt ghép: chuẩn bị config render mark nếu payload
      // có marks. Resolution mặc định 1920x1080 (EZVIZ H1c chuẩn); nếu
      // camera khác resolution → khác resolution segment → concat -c copy
      // sẽ ffmpeg complain. Nhưng gap-mark là ca hiếm (camera offline
      // thật), chấp nhận reencode để nhất quán resolution nếu cần.
      // 1920x1080 = default an toàn cho EZVIZ hiện có.
      const markRenderConfig = marks.length > 0
        ? {
            fontPath: burnFontPath,
            resolution: "1920x1080",
            fontColor: config.burnFontColor,
            warningColor: config.burnWarningColor,
          }
        : undefined;

      const cutResult = await encodeGate.run(() =>
        cutClip({
          ffmpegBin: config.ffmpegPath,
          ffprobeBin: config.ffprobePath,
          recordingRoot,
          outputAbsPath: outputAbs,
          cutStart: new Date(cutStartIso),
          cutEnd: new Date(cutEndIso),
          segments,
          burnIn,
          marks,
          markRenderConfig,
        }),
      );

      if (!cutResult.ok) {
        console.error(
          `[clip-cutter] cut failed packing_event=${p.packing_event_id} :: ${cutResult.errorMessage}`,
        );
        await postClipCutResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          packingEventId: p.packing_event_id,
          cameraId: p.camera_id,
          waybillCode: p.waybill_code,
          outcome: "failed",
          errorMessage: cutResult.errorMessage,
          sourceFiles: p.segments.map((s) => s.file_path),
          generationParams: { stderr_tail: cutResult.stderrTail.slice(-500), elapsed_ms: cutResult.elapsedMs },
        });
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: cutResult.errorMessage ?? "cut_clip failed",
        });
        return;
      }

      console.log(
        `[clip-cutter] done packing_event=${p.packing_event_id} size=${cutResult.fileSizeBytes} duration=${cutResult.durationSeconds.toFixed(2)}s drift=${cutResult.durationDriftSeconds.toFixed(3)}s elapsed=${cutResult.elapsedMs}ms partial=${p.partial_coverage ?? false} target_duration=${targetDurationS.toFixed(2)}s`,
      );

      await postClipCutResult({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        packingEventId: p.packing_event_id,
        cameraId: p.camera_id,
        waybillCode: p.waybill_code,
        outcome: "done",
        clipPath: outputRel,
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
          cut_mode: burnIn ? "reencode" : "copy",
          burn_in: burnIn ? true : false,
          ss_seconds: (Date.parse(p.cut_start) - Date.parse(p.segments[0].started_at)) / 1000,
          t_seconds: (Date.parse(p.cut_end) - Date.parse(p.cut_start)) / 1000,
          elapsed_ms: cutResult.elapsedMs,
          total_gap_seconds: p.total_gap_seconds ?? 0,
          gaps: p.gaps ?? [],
        },
      });

      await reportCommandResult({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        commandId: command.id,
        status: "done",
        result: {
          clip_path: outputRel,
          file_size_bytes: cutResult.fileSizeBytes,
          duration_seconds: Math.round(cutResult.durationSeconds),
          duration_drift_seconds: cutResult.durationDriftSeconds,
          is_partial: p.partial_coverage ?? false,
          elapsed_ms: cutResult.elapsedMs,
        },
      });
      return;
    }

    if (command.type === "upload_clip") {
      // 3c: đọc clip từ _clips/, xin signed URL, PUT lên bucket, báo
      // complete. Upload là I/O-bound trên mạng → KHÔNG qua
      // encodeGate (gate chỉ áp encode CPU-heavy).
      const p = command.payload as {
        packing_event_id?: string;
        bucket_path?: string;
      };
      if (!p.packing_event_id) {
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: "upload_clip payload missing packing_event_id",
        });
        return;
      }
      console.log(`[COMMAND UPLOAD_CLIP] ${command.id} packing_event=${p.packing_event_id}`);

      const clipAbs = resolve(recordingRoot, CLIPS_SUBDIR, `${p.packing_event_id}.mp4`);
      if (!existsSync(clipAbs)) {
        // Permanent: clip file mất khỏi _clips → không upload được,
        // cần quay về cut. Reconcile phía cloud sẽ thấy row ready
        // nhưng bucket null + upload_clip failed → nếu user retry
        // qua endpoint retry, cut sẽ chạy lại. Report failed rõ.
        console.warn(`[upload_clip] clip file missing on disk: ${clipAbs}`);
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: `clip_missing_on_disk: ${clipAbs}`,
        });
        return;
      }

      // Xin signed upload URL
      const urlResult = await fetchClipUploadUrl({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        packingEventId: p.packing_event_id,
      });
      if (!urlResult.ok) {
        console.error(`[upload_clip] fetchClipUploadUrl failed: ${urlResult.error} (http ${urlResult.status})`);
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: `signed_url_fetch_failed: ${urlResult.error}`,
        });
        return;
      }

      // PUT file lên signed URL. Đọc file vào buffer (clip max
      // ~100MB theo bucket cap, phần lớn <10MB).
      let fileBuf: Buffer;
      let fileSize: number;
      try {
        fileBuf = await fsp.readFile(clipAbs);
        fileSize = fileBuf.byteLength;
      } catch (err) {
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: `read_clip_failed: ${(err as Error).message}`,
        });
        return;
      }

      const uploadStart = Date.now();
      try {
        const putRes = await fetch(urlResult.signedUrl, {
          method: "PUT",
          headers: { "Content-Type": "video/mp4" },
          body: fileBuf,
          redirect: "manual",
        });
        if (!putRes.ok) {
          let bodyText = "";
          try { bodyText = await putRes.text(); } catch { /* ignore */ }
          throw new Error(`http_${putRes.status}: ${bodyText.slice(0, 200)}`);
        }
      } catch (err) {
        console.error(`[upload_clip] PUT failed: ${(err as Error).message}`);
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: `upload_put_failed: ${(err as Error).message}`,
        });
        return;
      }
      const uploadElapsedMs = Date.now() - uploadStart;

      // Notify complete
      const notify = await notifyClipUploadComplete({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        packingEventId: p.packing_event_id,
        fileSizeBytes: fileSize,
      });
      if (!notify.ok) {
        await reportCommandResult({
          backendUrl: config.backendUrl,
          agentCode: config.agentCode,
          agentSecret: config.agentSecret,
          commandId: command.id,
          status: "failed",
          error: `notify_complete_failed: ${notify.error}`,
        });
        return;
      }

      console.log(`[upload_clip] done packing_event=${p.packing_event_id} size=${fileSize} upload_elapsed=${uploadElapsedMs}ms`);
      await reportCommandResult({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
        commandId: command.id,
        status: "done",
        result: {
          bucket_path: urlResult.bucketPath,
          file_size_bytes: fileSize,
          upload_elapsed_ms: uploadElapsedMs,
        },
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
  async function ping(): Promise<void> {
    try {
      const r = await sendHeartbeat({
        backendUrl: config.backendUrl,
        agentCode: config.agentCode,
        agentSecret: config.agentSecret,
      });
      if (!r.ok) console.error(`[HEARTBEAT-FAIL ${r.status}]`);
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

  // Font path cho burn-in (3b-1). Path tuyệt đối, độc lập cwd.
  // Fail-loud nếu font missing được kiểm ở clip-cutter, không kiểm
  // ở đây — chỉ resolve path một lần.
  const burnFontPath = resolve(__dirname, "..", "assets", "fonts", "NotoSans-Bold.ttf");
  try {
    const removed = await cleanupOrphanConcatFiles(clipsDir);
    if (removed > 0) {
      console.log(`[clip-cutter] cleaned up ${removed} orphan .concat.txt file(s) at boot`);
    }
  } catch (err) {
    console.warn(`[clip-cutter] orphan cleanup failed: ${(err as Error).message}`);
  }

  // Segment index: bắt đầu watcher poll + flush queue.
  segmentIndex.start();

  // Boot recording lifecycle: đọc desired file, gọi cloud lấy credential
  // (retry mãi nếu mạng chưa lên — log leo thang theo ngưỡng), spawn
  // song song bằng allSettled. Chạy nền để không block startup.
  // Sau khi boot xong, kích boot recovery của segment index dựa trên
  // camera đã sống dậy (backfill segment sinh trong lúc agent chết).
  void lifecycle.boot().then(() => {
    const active = lifecycle.activeCameraInfos();
    return segmentIndex.bootRecovery(active);
  });

  const discoveryTimer = setInterval(() => {
    void reconcile(config);
  }, config.discoveryIntervalMs);
  const heartbeatTimer = setInterval(ping, config.heartbeatIntervalMs);
  const pollTimer = setInterval(() => {
    void pollOnce();
  }, config.pollIntervalMs);

  // Camera probe: TCP-connect RTSP port của mọi camera trong lifecycle
  // state (bao gồm cả camera đang long-retry vì tắt vật lý), batch
  // report ok/fail. Backend đọc `cameras.last_probe_at + last_probe_ok`
  // + `warehouse_agents.last_seen_at` để phân biệt 4 nhánh Online /
  // Offline / Mất kết nối kho / Chưa test.
  const cameraProbeTimer = setInterval(async () => {
    const targets = lifecycle.probeTargets();
    if (targets.length === 0) return;
    const results = await probeTargets(targets);
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
    void lifecycle.shutdown();
    void segmentIndex.stop();
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
