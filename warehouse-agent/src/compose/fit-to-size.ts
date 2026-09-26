import { runFfmpeg } from "./clip-composer";
import { ffmpegRateArgs, videoRateFor, type VideoRate } from "./bitrate";

/**
 * Nén lại MỘT LẦN một clip vượt ngưỡng tải lên cho vừa (bản 0.13.0).
 *
 * Trước 0.13.0 clip vượt ngưỡng bị vứt: đã cắt xong, đã tốn CPU, rồi báo
 * `proof_clip_too_large`. Đường cắt một góc chép thẳng luồng camera
 * (`-c copy`), nên dung lượng đi theo bitrate CAMERA — kiện hoàn 310s ở
 * camera 4 Mbps là ~150 MB. Có bước này thì cả hai đường (ghép hai góc, chép
 * một góc) đều vừa ngưỡng — điều kiện để khai `adaptive_clip_bitrate`.
 *
 * Người gọi chạy trong encodeGate (CPU) và tự kiểm lại dung lượng sau khi
 * nén: vẫn vượt thì từ chối như cũ.
 */
export async function reencodeToFit(options: {
  ffmpegBin: string;
  inputPath: string;
  outputPath: string;
  durationSeconds: number;
  maxOutputBytes: number;
  timeoutMs?: number;
}): Promise<VideoRate> {
  const rate = videoRateFor(options.durationSeconds, options.maxOutputBytes);
  await runFfmpeg(
    options.ffmpegBin,
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", options.inputPath,
      "-an", "-c:v", "libx264", "-preset", "veryfast",
      ...ffmpegRateArgs(rate),
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      options.outputPath,
    ],
    options.timeoutMs ?? 15 * 60_000,
  );
  return rate;
}
