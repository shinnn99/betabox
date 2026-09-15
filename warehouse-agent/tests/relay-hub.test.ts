import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildRelayConfig,
  buildRelayEnvironment,
  normalizeRelayPaths,
  RelayHub,
  relayPathName,
} from "../src/live/relay-hub";

function credentialFixture(host: string, path: string): string {
  const url = new URL(`rtsp://${host}${path}`);
  url.username = "camera-user";
  url.password = "camera-password";
  return url.toString();
}

const paths = [
  { name: "cam02sub", source: credentialFixture("192.168.1.22", "/sub") },
  { name: "cam01main", source: credentialFixture("192.168.1.21", "/main") },
];

test("relay config binds listeners to localhost and pulls sources on demand", () => {
  const config = buildRelayConfig(paths, "https://betabox.example");
  assert.match(config, /rtspAddress: 127\.0\.0\.1:8554/);
  assert.match(config, /webrtcAddress: 127\.0\.0\.1:8889/);
  assert.match(config, /webrtcLocalUDPAddress: 127\.0\.0\.1:8189/);
  assert.match(config, /webrtcAllowOrigins: \["https:\/\/betabox\.example"\]/);
  assert.match(config, /moq: false/);
  assert.equal((config.match(/sourceOnDemand: true/g) ?? []).length, 2);
  assert.doesNotMatch(config, /admin|secret|192\.168/);
});

test("relay credentials stay in child-process environment only", () => {
  const env = buildRelayEnvironment(paths);
  assert.equal(env.MTX_PATHS_CAM01MAIN_SOURCE, paths[1].source);
  assert.equal(env.MTX_PATHS_CAM02SUB_SOURCE, paths[0].source);
});

test("relay path normalization is stable and rejects unsafe names", () => {
  assert.deepEqual(normalizeRelayPaths(paths).map((path) => path.name), ["cam01main", "cam02sub"]);
  assert.throws(
    () => normalizeRelayPaths([{ name: "../camera", source: paths[0].source }]),
    /Invalid MediaMTX path name/,
  );
  assert.throws(
    () => normalizeRelayPaths([{ name: "camera_main", source: paths[0].source }]),
    /Invalid MediaMTX path name/,
  );
  assert.throws(
    () => normalizeRelayPaths([{ name: "camera", source: "https://example.com/video" }]),
    /Invalid MediaMTX source protocol/,
  );
});

test("relay path names are deterministic and environment-map safe", () => {
  assert.equal(relayPathName("CAM-01", "main"), "c43414d2d3031m");
  assert.equal(relayPathName("CAM-01", "sub"), "c43414d2d3031s");
  assert.match(relayPathName("Máy QR 01", "sub"), /^[a-z0-9]+$/);
  assert.throws(() => relayPathName("  ", "main"), /Camera code is required/);
});

test(
  "packaged MediaMTX accepts the generated relay config",
  { skip: process.platform !== "win32", timeout: 10_000 },
  async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "betabox-relay-smoke-"));
    const configPath = join(runtimeDir, "mediamtx.generated.yml");
    const binaryPath = join(process.cwd(), "vendor", "mediamtx", "mediamtx.exe");
    await writeFile(configPath, buildRelayConfig(paths, "https://betabox.example"), "utf8");

    const child = spawn(binaryPath, [configPath], {
      windowsHide: true,
      stdio: "pipe",
      env: { ...process.env, ...buildRelayEnvironment(paths) },
    });

    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => {
          reject(new Error(`MediaMTX did not start in time: ${output}`));
        }, 5_000);

        const handleOutput = (chunk: Buffer) => {
          output += chunk.toString();
          if (/started with listeners/i.test(output)) {
            clearTimeout(timeout);
            resolve();
          }
        };

        child.stdout.on("data", handleOutput);
        child.stderr.on("data", handleOutput);
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`MediaMTX exited before startup (code ${code}): ${output}`));
        });
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      await rm(runtimeDir, { recursive: true, force: true });
    }
  },
);

test(
  "RelayHub rejects invalid startup without an infinite restart loop",
  { skip: process.platform !== "win32", timeout: 10_000 },
  async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "betabox-relay-invalid-"));
    const binaryPath = join(process.cwd(), "vendor", "mediamtx", "mediamtx.exe");
    let spawnCount = 0;
    const spawnWithoutSource = ((command, args, options) => {
      spawnCount += 1;
      return spawn(command, args, { ...options, env: process.env });
    }) as typeof spawn;
    const hub = new RelayHub({
      binary: binaryPath,
      runtimeDir,
      dashboardOrigin: "https://betabox.example",
      restartDelayMs: 50,
      spawnProcess: spawnWithoutSource,
    });

    try {
      await assert.rejects(() => hub.reconcile(paths), /exited before readiness/);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(spawnCount, 1);
    } finally {
      await hub.stop();
      await rm(runtimeDir, { recursive: true, force: true });
    }
  },
);
