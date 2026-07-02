import {
  startRecording,
  stopRecording,
  classifyErrorFromStderr,
  isRecording,
  listActiveRecordings,
  type RecordingSpec,
} from "./recording";
import {
  fetchRecordingCredentials,
  postRecordingStatus,
  type ActiveRecordingReport,
  type CredentialItem,
} from "./commands";
import { DesiredStore, type DesiredEntry } from "./desired-store";
import type { SegmentIndex } from "./segment-index";
import { describeFetchError } from "./fetch-error";

/**
 * Retry policy (đã chốt Lát 2):
 *
 *   Ngắn hạn (đang ghi thì ffmpeg chết): 3 lần trong 60s, backoff 2s/5s/10s.
 *     - Cạn 3 lần + lỗi VĨNH VIỄN (auth/path sai) → xóa desired,
 *       báo status='error'.
 *     - Cạn 3 lần + lỗi TẠM THỜI (mạng, host tạm chết) → chuyển sang
 *       long-retry mỗi 5 phút, KHÔNG xóa desired, KHÔNG giới hạn số lần.
 *       Camera rớt mạng lúc kho không có người phải tự ghi lại khi
 *       mạng về, không chết thầm.
 *
 *   Long-retry:
 *     - attempt 1-11: log warn mỗi lần thất bại (~55 phút).
 *     - attempt 12+ (~≥1h): log error mỗi lần + báo cloud
 *       status='error_prolonged' (chỉ 1 lần khi vượt ngưỡng, không spam).
 *
 * Cloud gửi stop_recording → dừng mọi retry, xóa desired.
 */
// Watchdog PHẢI dài hơn -rw_timeout của ffmpeg (15s) — nếu không, ffmpeg
// stall connect (host chết, không route) sẽ vượt watchdog và bị coi là
// "sống", agent ghi desired, log start ok — cho đến khi rw_timeout kích
// hoạt sau đó và ffmpeg exit → trigger respawn loop. Watchdog 20s cho
// rw_timeout 15s dư 5s an toàn.
const EARLY_EXIT_WATCHDOG_MS = 20000;
const SHORT_RETRY_BACKOFFS_MS = [2000, 5000, 10000];
const LONG_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const LONG_RETRY_ERROR_THRESHOLD = 12;

interface CamLifecycleState {
  spec: RecordingSpec;
  // Số lần retry đã dùng trong short-retry window.
  shortRetryCount: number;
  // Đang ở giai đoạn long-retry?
  inLongRetry: boolean;
  // Số lần đã fail trong long-retry.
  longRetryFailCount: number;
  // Đã báo cloud 'error_prolonged' rồi chưa (chống spam).
  prolongedReported: boolean;
  // Timer đang chờ retry, nếu có.
  pendingTimer: NodeJS.Timeout | null;
  // Cờ đã bị stop chủ động — tránh retry sau khi user đã stop.
  stopped: boolean;
}

export interface LifecycleDeps {
  backendUrl: string;
  agentCode: string;
  agentSecret: string;
  ffmpegBin: string;
  ffprobeBin: string;  // 3b-2 followup: probeCodec trước spawn
  recordingRoot: string;
  desiredStore: DesiredStore;
  credentialsRetryMs: number;
  segmentIndex: SegmentIndex;
}

/**
 * Orchestrator: quản toàn bộ vòng đời recording của mọi camera trong
 * agent. Không expose từng hàm nhỏ — chỉ 4 method: startOne, stopOne,
 * boot, snapshotActive.
 */
export class RecordingLifecycle {
  private readonly states = new Map<string, CamLifecycleState>();
  private desired = new Map<string, DesiredEntry>();

  constructor(private readonly deps: LifecycleDeps) {}

  snapshotActive(): ActiveRecordingReport[] {
    return listActiveRecordings().map((r) => ({
      session_id: r.spec.sessionId,
      camera_id: r.spec.cameraId,
      pid: r.pid,
      started_at: r.startedAt.toISOString(),
    }));
  }

  /**
   * Danh sách camera đang thật sự có ffmpeg + spec — dùng cho boot
   * recovery quét ổ đúng thư mục.
   */
  activeCameraInfos(): Array<{ cameraId: string; cameraCode: string; sessionId: string }> {
    return listActiveRecordings().map((r) => ({
      cameraId: r.spec.cameraId,
      cameraCode: r.spec.cameraCode,
      sessionId: r.spec.sessionId,
    }));
  }

  /**
   * Boot flow. Đọc desired file → gọi cloud lấy credential → spawn
   * ffmpeg song song bằng allSettled (một camera hỏng không kéo cả rổ).
   * Nếu mạng chưa lên (fetch credential fail), retry mỗi
   * credentialsRetryMs và log leo thang theo ngưỡng.
   */
  async boot(): Promise<void> {
    this.desired = await this.deps.desiredStore.load();
    if (this.desired.size === 0) {
      console.log("[recording-lifecycle] no desired cameras, nothing to boot");
      return;
    }
    const cameraIds = Array.from(this.desired.keys());
    console.log(
      `[recording-lifecycle] boot with ${cameraIds.length} desired camera(s): ${cameraIds.join(", ")}`,
    );

    let credentials: CredentialItem[] = [];
    let attempt = 0;
    // Không bỏ cuộc — kho mất mạng lâu là sự cố, nhưng bỏ cuộc =
    // camera chết thầm cho đến khi có người bấm start. Retry mãi,
    // leo thang log.
    while (credentials.length === 0) {
      attempt++;
      try {
        credentials = await fetchRecordingCredentials({
          backendUrl: this.deps.backendUrl,
          agentCode: this.deps.agentCode,
          agentSecret: this.deps.agentSecret,
          cameraIds,
        });
      } catch (err) {
        this.logCredentialAttempt(attempt, describeFetchError(err), cameraIds);
        await new Promise((r) => setTimeout(r, this.deps.credentialsRetryMs));
        continue;
      }
      if (credentials.length === 0) {
        // Backend trả về rỗng — nghĩa là mọi camera_id trong desired
        // không còn thuộc org agent (bị xóa hoặc đổi org). Không retry,
        // xóa hết desired để boot lần sau sạch.
        console.warn(
          "[recording-lifecycle] backend returned no matching cameras; clearing desired file",
        );
        this.desired.clear();
        await this.deps.desiredStore.save(this.desired);
        return;
      }
    }

    // Xóa các camera có trong desired nhưng backend không trả (bị
    // xóa / đổi org).
    const returnedIds = new Set(credentials.map((c) => c.camera_id));
    for (const cid of Array.from(this.desired.keys())) {
      if (!returnedIds.has(cid)) {
        console.warn(
          `[recording-lifecycle] camera ${cid} in desired but backend didn't return it; dropping`,
        );
        this.desired.delete(cid);
      }
    }
    await this.deps.desiredStore.save(this.desired);

    // Spawn song song, một quả hỏng không kéo cả rổ.
    const results = await Promise.allSettled(
      credentials.map((cred) => this.spawnFromCredential(cred)),
    );
    let ok = 0;
    let fail = 0;
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) ok++;
      else fail++;
    }
    console.log(`[recording-lifecycle] boot done: ${ok} ok, ${fail} failed`);
  }

  private logCredentialAttempt(attempt: number, errMsg: string, cameraIds: string[]): void {
    const pending = cameraIds.length;
    if (attempt <= 5) {
      console.log(
        `[credentials] attempt ${attempt} failed (${errMsg}); ${pending} camera(s) pending`,
      );
    } else if (attempt <= 12) {
      console.warn(
        `[credentials] attempt ${attempt} failed (${errMsg}); still no credentials, ${pending} camera(s) pending`,
      );
    } else {
      console.error(
        `[credentials] CRITICAL: attempt ${attempt}, ~${Math.round((attempt * this.deps.credentialsRetryMs) / 60000)} min without credentials; cameras pending: ${cameraIds.join(", ")}`,
      );
    }
  }

  private async spawnFromCredential(cred: CredentialItem): Promise<boolean> {
    const desiredEntry = this.desired.get(cred.camera_id);
    if (!desiredEntry) return false;
    const spec: RecordingSpec = {
      cameraId: cred.camera_id,
      cameraCode: cred.camera_code,
      sessionId: desiredEntry.session_id,
      rtspUrl: cred.rtsp_url,
      transport: cred.transport,
      segmentSeconds: cred.segment_seconds,
    };
    return this.startInternal(spec, /*isFreshStart=*/ false);
  }

  /**
   * Bắt đầu recording cho camera theo lệnh start_recording từ cloud.
   * Idempotent theo camera_id. Nếu camera đã đang ghi (map RAM) →
   * skipped, coi done.
   */
  async startOne(params: {
    cameraId: string;
    cameraCode: string;
    sessionId: string;
  }): Promise<
    | { ok: true; skipped: boolean; pid?: number; outputDir?: string }
    | { ok: false; reason: string; kind: "permanent" | "transient"; stderrTail: string }
  > {
    // Idempotent guard TRƯỚC khi làm gì. Nếu đã ghi → skipped.
    if (isRecording(params.cameraId)) {
      return { ok: true, skipped: true };
    }

    // Lấy credential (không lưu password local). Nếu mạng lỗi ở đây
    // → coi transient error.
    let creds: CredentialItem[];
    try {
      creds = await fetchRecordingCredentials({
        backendUrl: this.deps.backendUrl,
        agentCode: this.deps.agentCode,
        agentSecret: this.deps.agentSecret,
        cameraIds: [params.cameraId],
      });
    } catch (err) {
      return {
        ok: false,
        reason: `credentials_fetch_failed: ${describeFetchError(err)}`,
        kind: "transient",
        stderrTail: "",
      };
    }
    const cred = creds.find((c) => c.camera_id === params.cameraId);
    if (!cred) {
      // Camera không thuộc org agent, hoặc bị xóa. Vĩnh viễn.
      return {
        ok: false,
        reason: "camera_not_in_org",
        kind: "permanent",
        stderrTail: "",
      };
    }

    const spec: RecordingSpec = {
      cameraId: cred.camera_id,
      cameraCode: cred.camera_code,
      sessionId: params.sessionId,
      rtspUrl: cred.rtsp_url,
      transport: cred.transport,
      segmentSeconds: cred.segment_seconds,
    };

    const spawned = await this.startInternal(spec, /*isFreshStart=*/ true);
    if (spawned) {
      const active = listActiveRecordings().find((r) => r.spec.cameraId === params.cameraId);
      return {
        ok: true,
        skipped: false,
        pid: active?.pid,
        outputDir: undefined,
      };
    }
    // startInternal đã kill state. Trạng thái đã lưu trong state map
    // — thất bại sớm không ghi desired.
    return {
      ok: false,
      reason: "early_exit",
      kind: "transient",
      stderrTail: "",
    };
  }

  /**
   * Đường chung cho boot spawn và start_recording. isFreshStart=true
   * nghĩa là lệnh mới từ cloud — nếu spawn OK phải ghi vào desired.
   * isFreshStart=false là boot — desired đã có sẵn.
   */
  private async startInternal(spec: RecordingSpec, isFreshStart: boolean): Promise<boolean> {
    const state: CamLifecycleState = this.states.get(spec.cameraId) ?? {
      spec,
      shortRetryCount: 0,
      inLongRetry: false,
      longRetryFailCount: 0,
      prolongedReported: false,
      pendingTimer: null,
      stopped: false,
    };
    state.spec = spec;
    state.stopped = false;
    this.states.set(spec.cameraId, state);

    const outcome = await startRecording({
      ffmpegBin: this.deps.ffmpegBin,
      ffprobeBin: this.deps.ffprobeBin,
      recordingRoot: this.deps.recordingRoot,
      spec,
      earlyExitWatchdogMs: EARLY_EXIT_WATCHDOG_MS,
      onUnexpectedExit: (info) => this.onUnexpectedExit(info.spec, info.lastStderr),
    });

    if (!outcome.ok) {
      const kind = classifyErrorFromStderr(outcome.stderrTail);
      console.warn(
        `[recording-lifecycle] start failed camera=${spec.cameraCode} reason=${outcome.reason} kind=${kind}`,
      );
      // Không ghi desired khi start fail. Với boot (isFreshStart=false),
      // desired đã có sẵn — nếu vĩnh viễn thì phải xóa để lần boot sau
      // không loop chết-lên-chết-lên.
      if (kind === "permanent") {
        this.desired.delete(spec.cameraId);
        await this.deps.desiredStore.save(this.desired);
        await this.reportStatus(spec, "error", `${outcome.reason} :: ${outcome.stderrTail.slice(-500)}`);
      } else {
        // Transient khi boot: giữ desired, schedule long-retry.
        if (!isFreshStart) {
          await this.reportStatus(spec, "degraded", outcome.reason);
          this.scheduleLongRetry(spec);
        }
      }
      this.states.delete(spec.cameraId);
      return false;
    }

    // Spawn thành công. Ghi desired nếu là fresh start.
    if (isFreshStart) {
      this.desired.set(spec.cameraId, {
        camera_id: spec.cameraId,
        session_id: spec.sessionId,
        desired_since: new Date().toISOString(),
      });
      await this.deps.desiredStore.save(this.desired);
    }
    state.shortRetryCount = 0;
    state.inLongRetry = false;
    state.longRetryFailCount = 0;
    state.prolongedReported = false;
    await this.reportStatus(
      spec,
      "recording",
      null,
      outcome.pid,
      outcome.codecDetected,
      outcome.codecWarning,
    );
    // 3a-1: segment-index bắt đầu theo dõi thư mục camera này.
    // Idempotent: gọi lại chỉ cập nhật sessionId, không tạo watcher mới.
    await this.deps.segmentIndex.onRecordingStarted({
      cameraId: spec.cameraId,
      cameraCode: spec.cameraCode,
      sessionId: spec.sessionId,
    });
    return true;
  }

  private onUnexpectedExit(spec: RecordingSpec, stderrTail: string): void {
    const state = this.states.get(spec.cameraId);
    if (!state) return;
    if (state.stopped) return; // stop chủ động, không retry
    const kind = classifyErrorFromStderr(stderrTail);
    console.warn(
      `[recording-lifecycle] unexpected exit camera=${spec.cameraCode} kind=${kind} short_retry=${state.shortRetryCount}`,
    );
    if (kind === "permanent") {
      this.desired.delete(spec.cameraId);
      void this.deps.desiredStore.save(this.desired);
      void this.reportStatus(spec, "error", `permanent :: ${stderrTail.slice(-500)}`);
      // Segment cuối vừa đóng — báo ended_at, tháo watcher hẳn.
      void this.deps.segmentIndex.onRecordingStopped(spec.cameraId);
      this.states.delete(spec.cameraId);
      return;
    }
    // Transient: sẽ respawn. Đóng segment ffmpeg cũ nhưng GIỮ watcher
    // để bắt file mới do ffmpeg respawn tạo. Gap giữa ended_at cũ và
    // started_at mới sẽ hiện đúng trong bảng — đây là ca test 3 (kill
    // ffmpeg) trong nghiệm thu.
    void this.deps.segmentIndex.onFfmpegExitedForRespawn(spec.cameraId);
    if (state.shortRetryCount < SHORT_RETRY_BACKOFFS_MS.length) {
      const delay = SHORT_RETRY_BACKOFFS_MS[state.shortRetryCount];
      state.shortRetryCount++;
      console.log(
        `[recording-lifecycle] respawn attempt ${state.shortRetryCount}/${SHORT_RETRY_BACKOFFS_MS.length} camera=${spec.cameraCode} in ${delay}ms`,
      );
      state.pendingTimer = setTimeout(() => {
        state.pendingTimer = null;
        void this.startInternal(spec, /*isFreshStart=*/ false);
      }, delay);
      return;
    }
    // Cạn short-retry với lỗi transient → chuyển sang long-retry.
    // KHÔNG xóa desired. Camera rớt mạng lâu vẫn phải tự dậy khi mạng
    // về, không chết thầm.
    state.inLongRetry = true;
    void this.reportStatus(spec, "degraded", `short_retry_exhausted :: ${stderrTail.slice(-500)}`);
    this.scheduleLongRetry(spec);
  }

  private scheduleLongRetry(spec: RecordingSpec): void {
    const state = this.states.get(spec.cameraId);
    if (!state) return;
    if (state.stopped) return;
    if (state.pendingTimer) {
      clearTimeout(state.pendingTimer);
    }
    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = null;
      void this.longRetryAttempt(spec);
    }, LONG_RETRY_INTERVAL_MS);
  }

  private async longRetryAttempt(spec: RecordingSpec): Promise<void> {
    const state = this.states.get(spec.cameraId);
    if (!state) return;
    if (state.stopped) return;

    const ok = await this.startInternal(spec, /*isFreshStart=*/ false);
    const stateAfter = this.states.get(spec.cameraId);
    if (ok) {
      // Recording sống lại — startInternal đã reset counters.
      return;
    }
    if (!stateAfter) return;
    stateAfter.longRetryFailCount++;
    if (stateAfter.longRetryFailCount >= LONG_RETRY_ERROR_THRESHOLD && !stateAfter.prolongedReported) {
      stateAfter.prolongedReported = true;
      await this.reportStatus(spec, "error_prolonged", `long_retry_fail_count=${stateAfter.longRetryFailCount}`);
    }
    this.scheduleLongRetry(spec);
  }

  async stopOne(params: {
    cameraId: string;
    sessionId: string;
  }): Promise<{ ok: true; stopped: boolean; forced: boolean }> {
    const state = this.states.get(params.cameraId);
    if (state) {
      state.stopped = true;
      if (state.pendingTimer) {
        clearTimeout(state.pendingTimer);
        state.pendingTimer = null;
      }
    }
    const outcome = await stopRecording(params.cameraId);
    this.desired.delete(params.cameraId);
    await this.deps.desiredStore.save(this.desired);
    this.states.delete(params.cameraId);
    await this.reportStatus(
      { cameraId: params.cameraId, sessionId: params.sessionId } as RecordingSpec,
      "stopped",
      null,
    );
    // Đóng segment cuối + tháo watcher.
    await this.deps.segmentIndex.onRecordingStopped(params.cameraId);
    return { ok: true, stopped: outcome.stopped, forced: outcome.forced };
  }

  private async reportStatus(
    spec: Pick<RecordingSpec, "cameraId" | "sessionId">,
    status: "recording" | "stopped" | "error" | "degraded" | "error_prolonged" | "credentials_unavailable",
    errorMessage: string | null,
    pid?: number,
    codecDetected?: string | null,
    codecWarning?: string | null,
  ): Promise<void> {
    const r = await postRecordingStatus({
      backendUrl: this.deps.backendUrl,
      agentCode: this.deps.agentCode,
      agentSecret: this.deps.agentSecret,
      sessionId: spec.sessionId,
      cameraId: spec.cameraId,
      status,
      errorMessage,
      pid: pid ?? null,
      codecDetected: codecDetected ?? null,
      codecWarning: codecWarning ?? null,
    });
    if (!r.ok) {
      console.warn(
        `[recording-lifecycle] status report failed camera=${spec.cameraId} status=${status} http=${r.status}`,
      );
    }
  }

  async shutdown(): Promise<void> {
    // Cancel pending timers.
    for (const state of this.states.values()) {
      state.stopped = true;
      if (state.pendingTimer) clearTimeout(state.pendingTimer);
    }
    // Graceful stop tất cả recording đang chạy (giữ moov trailer).
    // Đóng segment đang mở TRƯỚC khi kill ffmpeg — nếu không, sau
    // shutdown segment cuối nằm im ended_at=null trong DB, bối rối
    // clip-resolver (3a-2) khi tra bảng. Giữ desired file — restart
    // sẽ tự dậy như bình thường.
    const active = listActiveRecordings();
    await Promise.allSettled(
      active.map(async (r) => {
        await this.deps.segmentIndex.onRecordingStopped(r.spec.cameraId);
        return stopRecording(r.spec.cameraId);
      }),
    );
  }
}
