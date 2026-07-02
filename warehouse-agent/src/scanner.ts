import { SerialPort } from "serialport";

/**
 * Runtime parameters for one logical scanner. `deviceCode` is the stable
 * server-side identifier (station_devices.device_code). `port` is whatever
 * COM path the OS is currently exposing — it can change between sessions
 * when the user unplugs/replugs the scanner, which is exactly the case
 * the manager up the stack rebinds on.
 */
export interface ScannerBinding {
  deviceCode: string;
  port: string;
  baudRate: number;
  identity: Record<string, string>;
}

export type ScannerEventHandler = (params: {
  binding: ScannerBinding;
  rawValue: string;
}) => void;

/**
 * Opens one COM port for a scanner, buffers data, flushes on CR/LF or on
 * an idle debounce window. Auto-reconnects on close — but if the port
 * path has moved to a new COM, the manager will call rebind() with the
 * new path before reconnect succeeds.
 */
export class ScannerSession {
  private port: SerialPort | null = null;
  private buffer = "";
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private binding: ScannerBinding;
  /**
   * Suppress repeated open-failure logs. Reset on first successful open
   * so a transient failure later still gets logged once.
   */
  private openFailLogged = false;

  constructor(
    initial: ScannerBinding,
    private readonly flushDebounceMs: number,
    private readonly reconnectDelayMs: number,
    private readonly onScan: ScannerEventHandler,
  ) {
    this.binding = initial;
  }

  getBinding(): ScannerBinding {
    return this.binding;
  }

  /**
   * Update the COM path or identity for this session. If the port path
   * changed and we're currently open, close so the auto-reconnect path
   * picks up the new path. Identity-only changes don't reopen.
   */
  rebind(next: ScannerBinding): void {
    const pathChanged = next.port !== this.binding.port;
    this.binding = next;
    if (pathChanged) {
      // Path changed: treat the next open attempt as a fresh try so an
      // earlier suppressed log gets a chance to surface again on the new
      // path. Then force a close so the reconnect path picks up the new
      // path automatically.
      this.openFailLogged = false;
      if (this.port) {
        try {
          if (this.port.isOpen) this.port.close();
        } catch {
          // Ignore — 'close' handler will schedule reconnect on new path.
        }
      }
    }
  }

  start(): void {
    this.open();
  }

  stop(): void {
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.port && this.port.isOpen) {
      this.port.close();
    }
  }

  isOpen(): boolean {
    return !!this.port?.isOpen;
  }

  private open(): void {
    if (this.closed) return;
    const path = this.binding.port;
    const port = new SerialPort({
      path,
      baudRate: this.binding.baudRate,
      autoOpen: false,
    });

    port.open((err) => {
      if (err) {
        if (!this.openFailLogged) {
          console.error(
            `[scanner ${this.binding.deviceCode}] open ${path} failed: ${err.message} — will retry quietly until success`,
          );
          this.openFailLogged = true;
        }
        this.scheduleReconnect();
        return;
      }
      this.openFailLogged = false;
      console.log(
        `Opened ${path} for ${this.binding.deviceCode} @ ${this.binding.baudRate} baud`,
      );
    });

    port.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    port.on("error", (err) => {
      console.error(
        `[scanner ${this.binding.deviceCode}] error on ${path}: ${err.message}`,
      );
    });
    port.on("close", () => {
      if (this.closed) return;
      console.error(
        `[scanner ${this.binding.deviceCode}] ${path} closed — reconnecting in ${this.reconnectDelayMs}ms`,
      );
      this.flushNow();
      this.scheduleReconnect();
    });

    this.port = port;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.reconnectDelayMs);
  }

  private handleChunk(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.findTerminator(this.buffer)) !== -1) {
      const code = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (code.length > 0) this.emit(code);
    }
    if (this.buffer.length > 0) {
      this.armDebounce();
    }
  }

  private findTerminator(s: string): number {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 10 || c === 13) return i;
    }
    return -1;
  }

  private armDebounce(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushNow(), this.flushDebounceMs);
  }

  private flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const code = this.buffer.trim();
    this.buffer = "";
    if (code.length > 0) this.emit(code);
  }

  private emit(rawValue: string): void {
    try {
      this.onScan({ binding: this.binding, rawValue });
    } catch (err) {
      console.error(
        `[scanner ${this.binding.deviceCode}] onScan threw: ${(err as Error).message}`,
      );
    }
  }
}
