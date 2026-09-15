import "server-only";

export interface RtspParts {
  ip: string;
  port: number;
  username: string;
  password: string | null;
  path: string;
}

// EZVIZ-style verification codes routinely contain '#', '@', ':' — characters
// that have grammatical meaning inside an RTSP URL. We must URL-encode the
// userinfo segment, NOT the path. encodeURIComponent handles the userinfo
// rules conservatively (it encodes more than strictly required, which is
// safe — ffmpeg/VLC accept percent-encoded userinfo).
function encodeUserInfo(value: string): string {
  return encodeURIComponent(value);
}

function normalizePath(path: string): string {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

export function buildRtspUrl(parts: RtspParts): string {
  const hasUser = parts.username && parts.username.trim().length > 0;
  // Some cameras in "local compatibility mode" accept anonymous RTSP —
  // emit a URL without userinfo when neither username nor password are
  // configured, so ffmpeg won't synthesize a bogus userinfo segment.
  if (!hasUser && !parts.password) {
    return `rtsp://${parts.ip}:${parts.port}${normalizePath(parts.path)}`;
  }
  const userInfo = parts.password
    ? `${encodeUserInfo(parts.username)}:${encodeUserInfo(parts.password)}`
    : encodeUserInfo(parts.username);
  return `rtsp://${userInfo}@${parts.ip}:${parts.port}${normalizePath(parts.path)}`;
}

// Remove the complete userinfo segment so neither camera username nor password
// can escape through application/FFmpeg logs. This also accepts arbitrary log
// text, not only a bare URL, because FFmpeg embeds the input URL in stderr.
export function maskRtspUrl(url: string): string {
  return url.replace(/(rtsps?:\/\/)[^\s/@]+@/gi, "$1***@");
}
