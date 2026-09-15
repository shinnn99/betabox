import type { Role } from "@/lib/auth";

export type StationCameraRole = "proof_primary" | "proof_qr";

export type StationLiveScope = "admin" | "station" | "forbidden";

export function resolveStationLiveScope(input: {
  role: Role;
  isPlatform: boolean;
  requestedStationId: string;
  assignedStationId: string | null;
}): StationLiveScope {
  if (input.isPlatform || input.role === "owner" || input.role === "admin") {
    return "admin";
  }
  if (
    input.role === "packer" &&
    input.assignedStationId === input.requestedStationId
  ) {
    return "station";
  }
  return "forbidden";
}

/** Must stay byte-for-byte compatible with warehouse-agent relayPathName(). */
export function relayPathName(
  cameraCode: string,
  stream: "main" | "sub",
): string {
  if (!cameraCode.trim()) throw new Error("Camera code is required");
  const encoded = Buffer.from(cameraCode, "utf8").toString("hex");
  return `c${encoded}${stream === "main" ? "m" : "s"}`;
}

export function buildWhepUrl(baseUrl: string, pathName: string): string {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("MediaMTX WebRTC base URL must use http or https");
  }
  base.pathname = `${base.pathname.replace(/\/$/, "")}/${pathName}/whep`;
  return base.toString();
}
