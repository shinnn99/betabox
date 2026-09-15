import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWhepUrl,
  relayPathName,
  resolveStationLiveScope,
} from "../src/lib/live/station-streams.ts";

const STATION_A = "11111111-1111-4111-8111-111111111111";
const STATION_B = "22222222-2222-4222-8222-222222222222";

test("relay path matches agent UTF-8 hex convention", () => {
  assert.equal(relayPathName("CAM_01", "main"), "c43414d5f3031m");
  assert.equal(relayPathName("CAM_01", "sub"), "c43414d5f3031s");
});

test("WHEP URL is built without camera credentials", () => {
  assert.equal(
    buildWhepUrl("http://127.0.0.1:8889", "c43414d5f3031m"),
    "http://127.0.0.1:8889/c43414d5f3031m/whep",
  );
});

test("owner/admin/platform can select a station in the current organization", () => {
  assert.equal(
    resolveStationLiveScope({
      role: "owner",
      isPlatform: false,
      requestedStationId: STATION_A,
      assignedStationId: null,
    }),
    "admin",
  );
  assert.equal(
    resolveStationLiveScope({
      role: "admin",
      isPlatform: false,
      requestedStationId: STATION_B,
      assignedStationId: STATION_A,
    }),
    "admin",
  );
  assert.equal(
    resolveStationLiveScope({
      role: "viewer",
      isPlatform: true,
      requestedStationId: STATION_B,
      assignedStationId: null,
    }),
    "admin",
  );
});

test("packer can view only the station assigned to that account", () => {
  assert.equal(
    resolveStationLiveScope({
      role: "packer",
      isPlatform: false,
      requestedStationId: STATION_A,
      assignedStationId: STATION_A,
    }),
    "station",
  );
  assert.equal(
    resolveStationLiveScope({
      role: "packer",
      isPlatform: false,
      requestedStationId: STATION_B,
      assignedStationId: STATION_A,
    }),
    "forbidden",
  );
});

test("non-live roles are denied", () => {
  assert.equal(
    resolveStationLiveScope({
      role: "warehouse_manager",
      isPlatform: false,
      requestedStationId: STATION_A,
      assignedStationId: STATION_A,
    }),
    "forbidden",
  );
});
