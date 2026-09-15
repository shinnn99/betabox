"use client";

import { useEffect, useRef, useState } from "react";
import { Expand, Minimize, ScanLine, VideoOff } from "lucide-react";
import WebRtcPlayer from "./WebRtcPlayer";

export interface LiveCameraSource {
  id: string;
  code: string;
  name: string;
  online: boolean;
  whep_url: string;
}

export default function LiveLayout({
  stationLabel,
  overview,
  qr,
}: {
  stationLabel: string;
  overview: LiveCameraSource | null;
  qr: LiveCameraSource | null;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Keep this visual contract in sync with the proof composer:
  // `warehouse-agent/src/compose/clip-composer.ts` renders the final MP4 with
  // the same overview-full-frame + QR-top-right-PiP layout.
  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreen(document.fullscreenElement === frameRef.current);
    };
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
    };
  }, []);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await frameRef.current?.requestFullscreen?.();
  };

  return (
    <div
      ref={frameRef}
      className="group relative aspect-video w-full overflow-hidden rounded-xl bg-slate-950 shadow-inner"
    >
      {overview ? (
        <WebRtcPlayer
          key={overview.id}
          endpoint={overview.whep_url}
          label={`Toàn cảnh · ${overview.name}`}
          className="absolute inset-0"
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-400">
          <VideoOff className="h-8 w-8" />
          <p className="text-sm">Bàn chưa có camera toàn cảnh</p>
        </div>
      )}

      {qr ? (
        <WebRtcPlayer
          key={qr.id}
          endpoint={qr.whep_url}
          label={`Góc QR · ${qr.name}`}
          className="absolute right-3 top-3 z-10 h-1/3 w-1/3 rounded-lg border border-white shadow-xl"
        />
      ) : (
        <div className="absolute right-3 top-3 flex h-1/3 w-1/3 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/50 bg-slate-900/85 px-2 text-center text-white shadow-xl">
          <ScanLine className="h-5 w-5 text-slate-300" />
          <span className="text-[10px] sm:text-xs">Chưa có camera QR</span>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-gradient-to-t from-black/90 via-black/65 to-transparent px-3 pb-3 pt-8 text-white">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{stationLabel}</p>
          <p className="text-[10px] text-white/70">Trực tiếp · Không lưu trên trình duyệt</p>
        </div>
        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          aria-label={isFullscreen ? "Thoát toàn màn hình" : "Xem toàn màn hình"}
          aria-pressed={isFullscreen}
          title={isFullscreen ? "Thoát toàn màn hình" : "Xem toàn màn hình"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white opacity-100 backdrop-blur-sm hover:bg-white/20 lg:opacity-0 lg:group-hover:opacity-100 lg:focus:opacity-100"
        >
          {isFullscreen ? (
            <Minimize className="h-4 w-4" />
          ) : (
            <Expand className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}
