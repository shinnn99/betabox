import { createHmac } from "node:crypto";

export type SignedHeaders = Record<string, string> & {
  "content-type": "application/json";
};

export function signBody(params: {
  agentCode: string;
  agentSecret: string;
  body: string;
  now?: number;
}): SignedHeaders {
  const timestamp = String(params.now ?? Date.now());
  const message = `${timestamp}.${params.body}`;
  const signature = createHmac("sha256", params.agentSecret)
    .update(message)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-agent-code": params.agentCode,
    "x-agent-timestamp": timestamp,
    "x-agent-signature": signature,
  };
}
