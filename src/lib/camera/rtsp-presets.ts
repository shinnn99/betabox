// Preset RTSP path templates per camera/NVR brand, used by the manual add
// form. Zero server-side impact — the output is a plain path string that
// gets fed into the same `rtsp_path` field the operator would otherwise
// type by hand.
//
// The point of this file is to shave typos and vendor-lookup time off the
// onboarding of NVR-fronted deployments (Hikvision/Dahua NVRs are the
// dominant topology in VN warehouses, and their child cameras live inside
// the NVR's private subnet — the operator has to pull RTSP by channel
// from the NVR IP, not scan for the camera itself).

export interface CameraBrandPreset {
  id: string;
  label: string;
  // null path = user types it by hand (custom option). Otherwise the
  // template is rendered by `applyPreset()`.
  pathTemplate: string | null;
  needsChannel: boolean;
  hint?: string;
}

// Hikvision ISAPI channel encoding: `/Streaming/Channels/CCSS` where
// CC = channel number (1..N, NOT zero-padded) and SS = stream type
// (01 = main, 02 = sub). So channel 1 main → 101, channel 2 main → 201,
// channel 10 main → 1001. We only expose main-stream today; sub-stream
// can be added later if a warehouse needs bandwidth-limited recording.
//
// Older Hikvision firmwares (and some VN retail EZVIZ units) speak the
// legacy path `/h264/ch{channel}/main/av_stream` instead. Not covered
// here — add a separate preset id if a customer hits it.
function hikvisionMainStream(channel: number): string {
  return `/Streaming/Channels/${channel}01`;
}

// Dahua/Imou share the same RTSP grammar (Imou is Dahua's consumer brand).
// subtype=0 is main stream, subtype=1 is sub stream.
function dahuaMainStream(channel: number): string {
  return `/cam/realmonitor?channel=${channel}&subtype=0`;
}

export const CAMERA_BRAND_PRESETS: CameraBrandPreset[] = [
  {
    id: "hikvision",
    label: "Hikvision (NVR / IP camera)",
    pathTemplate: "/Streaming/Channels/{channel}01",
    needsChannel: true,
  },
  {
    id: "dahua",
    label: "Dahua (NVR / IP camera)",
    pathTemplate: "/cam/realmonitor?channel={channel}&subtype=0",
    needsChannel: true,
  },
  {
    id: "imou",
    label: "Imou (dòng tiêu dùng của Dahua)",
    pathTemplate: "/cam/realmonitor?channel={channel}&subtype=0",
    needsChannel: true,
  },
  {
    id: "ezviz",
    label: "EZVIZ (dòng tiêu dùng của Hikvision)",
    pathTemplate: "/Streaming/Channels/{channel}01",
    needsChannel: true,
    // EZVIZ retail units in VN ship with RTSP disabled by default and
    // use the sticker verification code as the password. The operator
    // has to enable RTSP inside the EZVIZ mobile app first.
    hint: "Mật khẩu là verification code in trên thân camera. Cần bật RTSP trong app EZVIZ trước khi test.",
  },
  {
    id: "generic-ch1",
    label: "Chung /ch1/main",
    pathTemplate: "/ch1/main",
    needsChannel: false,
  },
  {
    id: "custom",
    label: "Khác / nhập tay",
    pathTemplate: null,
    needsChannel: false,
  },
];

// Render a preset's path with the given channel. Returns null if the
// preset id is unknown, the preset is `custom`, or the channel is not a
// positive integer. Callers should treat null as "don't auto-fill; leave
// whatever the user has typed".
export function applyPreset(id: string, channel: number): string | null {
  const preset = CAMERA_BRAND_PRESETS.find((p) => p.id === id);
  if (!preset || !preset.pathTemplate) return null;
  if (!preset.needsChannel) return preset.pathTemplate;
  if (!Number.isInteger(channel) || channel < 1) return null;
  return preset.pathTemplate.replace("{channel}", String(channel));
}

// Best-effort reverse lookup: given a path string, guess which preset
// produced it. Used when opening the edit form so the dropdown lands on
// the right brand instead of falling back to "custom". Returns
// { presetId, channel } or null if no preset matches.
//
// We match against the concrete rendered form, so a path a customer
// typed by hand that happens to match `/Streaming/Channels/101` will be
// reported as Hikvision — that's fine: the dropdown just changes label,
// the path input stays the same string.
export function detectPreset(
  path: string,
): { presetId: string; channel: number } | null {
  if (!path) return null;
  const hik = path.match(/^\/Streaming\/Channels\/(\d+)01$/);
  if (hik) {
    // Reject `/Streaming/Channels/01` (missing channel) and the sub-stream
    // form `/Streaming/Channels/102` (ends in 02 not 01). The regex above
    // already enforces the `01` suffix; here we just parse the channel.
    const ch = Number(hik[1]);
    if (Number.isInteger(ch) && ch >= 1) {
      return { presetId: "hikvision", channel: ch };
    }
  }
  const dahua = path.match(
    /^\/cam\/realmonitor\?channel=(\d+)&subtype=0$/,
  );
  if (dahua) {
    const ch = Number(dahua[1]);
    if (Number.isInteger(ch) && ch >= 1) {
      return { presetId: "dahua", channel: ch };
    }
  }
  if (path === "/ch1/main") {
    return { presetId: "generic-ch1", channel: 1 };
  }
  return null;
}
