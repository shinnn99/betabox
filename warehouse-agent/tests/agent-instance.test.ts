import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAgentInstanceId } from "../src/agent-instance";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function withDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "agent-instance-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("restart on the same machine keeps the same instance id", () => {
  withDir((dir) => {
    const file = join(dir, "data", "agent-instance-id");
    const first = loadAgentInstanceId(file);
    assert.match(first, UUID_RE);
    assert.equal(loadAgentInstanceId(file), first);
    assert.equal(readFileSync(file, "utf8").trim(), first);
  });
});

test("two machines (separate data dirs) get different ids", () => {
  withDir((a) =>
    withDir((b) => {
      assert.notEqual(
        loadAgentInstanceId(join(a, "agent-instance-id")),
        loadAgentInstanceId(join(b, "agent-instance-id")),
      );
    }),
  );
});

test("a corrupted file is replaced with a valid id", () => {
  withDir((dir) => {
    const file = join(dir, "agent-instance-id");
    writeFileSync(file, "rac", "utf8");
    const id = loadAgentInstanceId(file);
    assert.match(id, UUID_RE);
    assert.equal(readFileSync(file, "utf8").trim(), id);
  });
});
