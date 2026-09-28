export type EventFailureKind = "network" | "timeout" | "http_4xx" | "http_5xx";

export interface EventFailureTrigger {
  agentId: string;
  eventName: string;
  targetType: string | null;
  targetId: string | null;
  failureKind: EventFailureKind;
  httpStatus: number | null;
  errorCode: string | null;
  occurredAt: string;
  correlationId: string;
}

const SAFE_TOKEN = /^[a-zA-Z0-9_.:-]+$/;
const FAILURE_KINDS = new Set<EventFailureKind>(["network", "timeout", "http_4xx", "http_5xx"]);

function token(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max && SAFE_TOKEN.test(value)
    ? value
    : null;
}

export function shouldDiagnoseHttpStatus(status: number): boolean {
  return status >= 400 && status <= 599;
}

/** Bóc phòng thủ; cố ý không nhận raw message/body vì có thể chứa bí mật. */
export function parseEventFailure(body: unknown, now = new Date()): EventFailureTrigger | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const agentId = token(value.agent_id, 64);
  const eventName = token(value.event_name, 80);
  const kindToken = token(value.failure_kind, 24);
  const correlationId = token(value.correlation_id, 64);
  if (!agentId || !eventName || !kindToken || !FAILURE_KINDS.has(kindToken as EventFailureKind) || !correlationId) {
    return null;
  }
  const failureKind = kindToken as EventFailureKind;
  const httpStatus = typeof value.http_status === "number" ? Math.trunc(value.http_status) : null;
  if (failureKind === "http_4xx" && (httpStatus === null || httpStatus < 400 || httpStatus > 499)) return null;
  if (failureKind === "http_5xx" && (httpStatus === null || httpStatus < 500 || httpStatus > 599)) return null;

  return {
    agentId,
    eventName,
    targetType: token(value.target_type, 40),
    targetId: token(value.target_id, 80),
    failureKind,
    httpStatus,
    errorCode: token(value.error_code, 80),
    occurredAt:
      typeof value.occurred_at === "string" && Number.isFinite(Date.parse(value.occurred_at))
        ? new Date(value.occurred_at).toISOString()
        : now.toISOString(),
    correlationId,
  };
}
