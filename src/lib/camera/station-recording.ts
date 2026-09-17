import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  enqueueStartRecordingV2,
  enqueueStopRecording,
} from "@/lib/agent-commands/enqueue";
import {
  getOpenSessionForStop,
  markSessionStopped,
} from "./recording-service";

/**
 * Ghi segment đi theo việc camera có gắn bàn hay không.
 *
 * Luật (giữ nguyên cách luồng kết nối camera theo bàn đã làm từ trước):
 *   - Gắn camera vào bàn ĐANG CÓ CA → bắt đầu cắt segment ngay.
 *   - Gắn vào bàn chưa có ca → chưa ghi; mở ca thì luồng mở ca tự bật.
 *   - Camera rời bàn (bỏ gắn, hoặc bị camera khác đẩy khỏi vị trí) → dừng.
 *
 * Vì sao phải có module này: ô "Bàn đang phục vụ" gọi thẳng
 * `POST /api/station-device-assignments`, mà route đó trước đây chỉ ghi phân
 * công — KHÔNG bật ghi gì. Camera gắn vào bàn đang có ca vẫn đứng im tới hết
 * ca, và đơn đóng trong khoảng đó không có video bằng chứng.
 *
 * Chiều dừng quan trọng không kém: camera về hàng đợi vẫn thuộc agent (để
 * còn xem livestream), nên agent không tự thu hồi lệnh ghi. Không dừng tường
 * minh thì một camera "chưa gắn bàn" vẫn ghi đầy ổ.
 */

const SEGMENT_SECONDS = Number(process.env.RECORDING_SEGMENT_SECONDS ?? 60);

export type StationRecordingOutcome =
  | "started"
  | "no_open_shift"
  | "no_agent"
  | "stopped"
  | "nothing_to_stop"
  | "failed";

/** Bật ghi cho camera vừa gắn vào bàn, nếu bàn đang có ca mở. */
export async function startRecordingIfShiftOpen(params: {
  organizationId: string;
  stationId: string;
  cameraId: string;
  requestedBy: string;
}): Promise<StationRecordingOutcome> {
  const admin = createAdminClient();

  const [{ count: openShifts }, { data: camera }] = await Promise.all([
    admin
      .from("staff_work_sessions")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", params.organizationId)
      .eq("station_id", params.stationId)
      .eq("status", "active"),
    admin
      .from("cameras")
      .select("id, camera_code, agent_id")
      .eq("organization_id", params.organizationId)
      .eq("id", params.cameraId)
      .maybeSingle(),
  ]);

  if ((openShifts ?? 0) === 0) return "no_open_shift";
  // Không có agent thì không máy nào ghi được — đừng đẩy lệnh vào hàng đợi
  // của một agent đoán bừa.
  if (!camera?.agent_id) return "no_agent";

  try {
    await enqueueStartRecordingV2({
      organizationId: params.organizationId,
      cameraId: camera.id,
      agentId: camera.agent_id,
      createdBy: params.requestedBy,
      transport: "tcp",
      segmentSeconds: SEGMENT_SECONDS,
      outputDir: `_agent_managed/${camera.camera_code}`,
    });
    return "started";
  } catch (error) {
    console.warn(
      `[station-recording] bật ghi camera=${camera.camera_code} thất bại: ${(error as Error).message}`,
    );
    return "failed";
  }
}

/** Dừng ghi cho camera vừa rời bàn. Không có phiên nào mở thì coi là xong. */
export async function stopRecordingForCamera(params: {
  organizationId: string;
  cameraId: string;
}): Promise<StationRecordingOutcome> {
  const admin = createAdminClient();
  const session = await getOpenSessionForStop(params.organizationId, params.cameraId);
  if (!session) return "nothing_to_stop";

  const { data: camera } = await admin
    .from("cameras")
    .select("agent_id")
    .eq("organization_id", params.organizationId)
    .eq("id", params.cameraId)
    .maybeSingle();
  if (!camera?.agent_id) return "no_agent";

  // Đã có lệnh dừng đang chờ cho đúng camera này thì không đẻ thêm.
  const { data: pending } = await admin
    .from("agent_commands")
    .select("id")
    .eq("organization_id", params.organizationId)
    .eq("type", "stop_recording")
    .in("status", ["pending", "taken"])
    .eq("payload->>camera_id", params.cameraId)
    .limit(1)
    .maybeSingle();
  if (pending) return "stopped";

  try {
    // Đánh dấu phiên đã dừng TRƯỚC khi agent xử lý — cùng thứ tự với route
    // dừng ghi, để ffmpeg thoát ra không lật phiên sang 'error'.
    await markSessionStopped(session.id);
    await enqueueStopRecording({
      organizationId: params.organizationId,
      agentId: camera.agent_id,
      cameraId: params.cameraId,
      sessionId: session.id,
    });
    return "stopped";
  } catch (error) {
    console.warn(
      `[station-recording] dừng ghi camera=${params.cameraId} thất bại: ${(error as Error).message}`,
    );
    return "failed";
  }
}
