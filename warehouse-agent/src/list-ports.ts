import { SerialPort } from "serialport";

async function main(): Promise<void> {
  const ports = await SerialPort.list();
  if (ports.length === 0) {
    console.log("(no serial ports detected)");
    return;
  }
  for (const p of ports) {
    const info = p as { friendlyName?: string };
    const label = [p.manufacturer, info.friendlyName, p.productId, p.vendorId]
      .filter(Boolean)
      .join(" ");
    console.log(`${p.path} - ${label || "(unknown)"}`);
  }
}

main().catch((err) => {
  console.error("[list-ports] failed:", err);
  process.exit(1);
});
