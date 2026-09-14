import { createServer, type Server, type ServerResponse } from "node:http";

export class StationNotifier {
  private readonly clients = new Set<ServerResponse>();
  private server: Server | null = null;

  start(port = 17891): Promise<void> {
    if (this.server) return Promise.resolve();
    this.server = createServer((req, res) => {
      if (req.url !== "/events") { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "http://127.0.0.1" });
      res.write(": connected\n\n"); this.clients.add(res);
      req.on("close", () => this.clients.delete(res));
    });
    return new Promise((resolve, reject) => this.server!.once("error", reject).listen(port, "127.0.0.1", resolve));
  }

  publish(order: unknown): void {
    const message = `event: current-order\ndata: ${JSON.stringify(order)}\n\n`;
    for (const client of this.clients) client.write(message);
  }

  stop(): Promise<void> { return new Promise((resolve) => { if (!this.server) return resolve(); this.server.close(() => resolve()); this.server = null; }); }
}
