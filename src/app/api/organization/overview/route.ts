import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isError, requirePermission } from "@/lib/supabase/guard";

export const runtime = "nodejs";

interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  address: string | null;
  status: string;
  created_at: string;
  stations_count: number;
  devices_count: number;
  staff_count: number;
}

interface DeviceAlert {
  id: string;
  code: string;
  kind: "camera" | "scanner";
  name: string | null;
  status: string;
  last_seen_at: string | null;
}

interface OrganizationOverview {
  organization: {
    id: string;
    name: string;
    slug: string | null;
    status: string;
    owner_name: string | null;
  };
  totals: {
    warehouses: number;
    warehouses_active: number;
    stations: number;
    stations_in_use: number;
    devices: number;
    devices_online: number;
    devices_offline: number;
    staff: number;
    staff_active_today: number;
    pending_invites: number;
  };
  warehouses: WarehouseRow[];
  device_alerts: DeviceAlert[];
}

export async function GET() {
  const ctx = await requirePermission("organization.view");
  if (isError(ctx)) return ctx;

  const admin = createAdminClient();
  const orgId = ctx.organizationId;

  try {
    const [orgRes, warehousesRes, stationsRes, devicesRes, staffRes, sessionsRes] =
      await Promise.all([
        admin
          .from("organizations")
          .select("id, name, slug, status, created_at")
          .eq("id", orgId)
          .maybeSingle(),
        admin
          .from("warehouses")
          .select("id, code, name, address, status, created_at")
          .eq("organization_id", orgId)
          .order("code"),
        admin
          .from("packing_stations")
          .select("id, warehouse_id, status")
          .eq("organization_id", orgId)
          .neq("status", "archived"),
        admin
          .from("station_devices")
          .select(
            "id, device_code, device_type, name, status, connection_status, last_seen_at, config_json",
          )
          .eq("organization_id", orgId)
          .neq("status", "archived"),
        admin
          .from("staff_profiles")
          .select("id, status")
          .eq("organization_id", orgId),
        admin
          .from("staff_work_sessions")
          .select("staff_id")
          .eq("organization_id", orgId)
          .eq("status", "active"),
      ]);

    // Owner profile: pick user_profile with role=owner|admin in this org
    const { data: ownerProfile } = await admin
      .from("user_profiles")
      .select("id, full_name, role")
      .eq("organization_id", orgId)
      .in("role", ["owner", "admin"])
      .order("role")
      .limit(1)
      .maybeSingle();

    const org = orgRes.data;
    if (!org) {
      return NextResponse.json(
        { error: "organization_not_found" },
        { status: 404 },
      );
    }

    const warehouses = (warehousesRes.data ?? []) as Array<{
      id: string;
      code: string;
      name: string;
      address: string | null;
      status: string;
      created_at: string;
    }>;

    const stations = (stationsRes.data ?? []) as Array<{
      id: string;
      warehouse_id: string;
      status: string;
    }>;

    const devices = (devicesRes.data ?? []) as Array<{
      id: string;
      device_code: string;
      device_type: string;
      name: string | null;
      status: string;
      connection_status: string | null;
      last_seen_at: string | null;
      config_json: Record<string, unknown> | null;
    }>;

    const staff = (staffRes.data ?? []) as Array<{ id: string; status: string }>;
    const sessions = (sessionsRes.data ?? []) as Array<{
      staff_id: string;
    }>;

    // Map staff per warehouse via staff_warehouse_assignments
    const { data: assignments } = await admin
      .from("staff_warehouse_assignments")
      .select("staff_id, warehouse_id")
      .eq("organization_id", orgId)
      .is("unassigned_at", null);

    const staffPerWarehouse = new Map<string, Set<string>>();
    for (const a of assignments ?? []) {
      const set = staffPerWarehouse.get(a.warehouse_id as string) ?? new Set<string>();
      set.add(a.staff_id as string);
      staffPerWarehouse.set(a.warehouse_id as string, set);
    }

    // Devices per warehouse — link via station -> warehouse
    const stationToWarehouse = new Map<string, string>();
    for (const s of stations) stationToWarehouse.set(s.id, s.warehouse_id);

    const { data: deviceAssignsRaw } = await admin
      .from("station_device_assignments")
      .select("device_id, station_id")
      .eq("organization_id", orgId)
      .is("unassigned_at", null);
    const deviceToWarehouse = new Map<string, string>();
    for (const da of deviceAssignsRaw ?? []) {
      const wId = stationToWarehouse.get(da.station_id as string);
      if (wId) deviceToWarehouse.set(da.device_id as string, wId);
    }

    const stationsByWarehouse = new Map<string, number>();
    for (const s of stations) {
      stationsByWarehouse.set(
        s.warehouse_id,
        (stationsByWarehouse.get(s.warehouse_id) ?? 0) + 1,
      );
    }
    const devicesByWarehouse = new Map<string, number>();
    for (const d of devices) {
      if (d.device_type === "camera" || d.device_type === "scanner") {
        const wId = deviceToWarehouse.get(d.id);
        if (wId) {
          devicesByWarehouse.set(wId, (devicesByWarehouse.get(wId) ?? 0) + 1);
        }
      }
    }

    const warehouseRows: WarehouseRow[] = warehouses.map((w) => ({
      id: w.id,
      code: w.code,
      name: w.name,
      address: w.address,
      status: w.status,
      created_at: w.created_at,
      stations_count: stationsByWarehouse.get(w.id) ?? 0,
      devices_count: devicesByWarehouse.get(w.id) ?? 0,
      staff_count: staffPerWarehouse.get(w.id)?.size ?? 0,
    }));

    // Totals
    const realDevices = devices.filter(
      (d) => d.device_type === "camera" || d.device_type === "scanner",
    );
    const devicesOnline = realDevices.filter(
      (d) => d.connection_status === "online" || d.status === "active",
    ).length;
    const devicesOffline = realDevices.length - devicesOnline;

    const activeStaffIds = new Set<string>();
    for (const s of sessions) activeStaffIds.add(s.staff_id);

    // Device alerts: offline or error scanners + offline cameras
    const now = Date.now();
    const deviceAlerts: DeviceAlert[] = [];
    for (const d of realDevices) {
      if (deviceAlerts.length >= 5) break;
      const isOffline =
        d.connection_status === "offline" ||
        (d.status !== "active" && d.connection_status !== "online");
      if (isOffline) {
        deviceAlerts.push({
          id: d.id,
          code: d.device_code,
          kind: d.device_type as "camera" | "scanner",
          name: d.name,
          status: "offline",
          last_seen_at: d.last_seen_at,
        });
      }
    }
    deviceAlerts.sort((a, b) => {
      const ta = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
      const tb = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
      return tb - ta;
    });
    void now;

    const response: OrganizationOverview = {
      organization: {
        id: org.id as string,
        name: org.name as string,
        slug: (org.slug as string | null) ?? null,
        status: (org.status as string) ?? "active",
        owner_name: (ownerProfile?.full_name as string | null) ?? null,
      },
      totals: {
        warehouses: warehouses.length,
        warehouses_active: warehouses.filter((w) => w.status === "active").length,
        stations: stations.length,
        stations_in_use: stations.filter((s) => s.status === "active").length,
        devices: realDevices.length,
        devices_online: devicesOnline,
        devices_offline: devicesOffline,
        staff: staff.length,
        staff_active_today: activeStaffIds.size,
        pending_invites: 0,
      },
      warehouses: warehouseRows,
      device_alerts: deviceAlerts,
    };

    return NextResponse.json(response);
  } catch (err) {
    return NextResponse.json(
      { error: "overview_failed", message: (err as Error).message },
      { status: 500 },
    );
  }
}
