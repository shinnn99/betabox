import { createHash, randomBytes } from "node:crypto";

const SOAP_NS = "http://www.w3.org/2003/05/soap-envelope";
const WSSE_NS =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
const WSU_NS =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";
const PASSWORD_DIGEST =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest";
const BASE64_ENCODING =
  "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary";

export class OnvifError extends Error {
  constructor(
    public readonly code:
      | "AUTH_FAILED"
      | "HTTP_ERROR"
      | "SOAP_FAULT"
      | "INVALID_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "OnvifError";
  }
}

export interface OnvifStreamInfo {
  mainStream?: string;
  subStream?: string;
  manufacturer?: string;
  model?: string;
}

interface OnvifOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

interface Profile {
  token: string;
  name: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function usernameToken(username: string, password: string): string {
  const nonce = randomBytes(16);
  const created = new Date().toISOString();
  const digest = createHash("sha1")
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)]))
    .digest("base64");
  return [
    "<wsse:Security s:mustUnderstand=\"1\">",
    "<wsse:UsernameToken>",
    `<wsse:Username>${escapeXml(username)}</wsse:Username>`,
    `<wsse:Password Type=\"${PASSWORD_DIGEST}\">${digest}</wsse:Password>`,
    `<wsse:Nonce EncodingType=\"${BASE64_ENCODING}\">${nonce.toString("base64")}</wsse:Nonce>`,
    `<wsu:Created>${created}</wsu:Created>`,
    "</wsse:UsernameToken>",
    "</wsse:Security>",
  ].join("");
}

function envelope(username: string, password: string, body: string): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<s:Envelope xmlns:s="${SOAP_NS}" xmlns:wsse="${WSSE_NS}" xmlns:wsu="${WSU_NS}">`,
    `<s:Header>${usernameToken(username, password)}</s:Header>`,
    `<s:Body>${body}</s:Body>`,
    "</s:Envelope>",
  ].join("");
}

function xmlValue(xml: string, localName: string): string | undefined {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(
    new RegExp(`<(?:[\\w.-]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}>`, "i"),
  );
  return match?.[1]?.trim();
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function isAuthFault(xml: string): boolean {
  return /NotAuthorized|Unauthorized|ter:InvalidArgVal|Sender not authorized/i.test(xml);
}

async function soapCall(
  endpoint: string,
  action: string,
  body: string,
  username: string,
  password: string,
  options: OnvifOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": `application/soap+xml; charset=utf-8; action="${action}"`,
      },
      body: envelope(username, password, body),
      signal: options.signal,
    });
  } catch (error) {
    throw new OnvifError(
      "HTTP_ERROR",
      `ONVIF request failed: ${error instanceof Error ? error.message : "network error"}`,
    );
  }

  const xml = await response.text();
  if (response.status === 401 || response.status === 403 || isAuthFault(xml)) {
    throw new OnvifError("AUTH_FAILED", "Camera rejected the ONVIF credentials");
  }
  if (!response.ok) {
    throw new OnvifError("HTTP_ERROR", `ONVIF HTTP ${response.status}`);
  }
  if (/<(?:[\w.-]+:)?Fault(?:\s|>)/i.test(xml)) {
    const reason = decodeXml(xmlValue(xml, "Text") ?? "Unknown SOAP fault");
    throw new OnvifError("SOAP_FAULT", `ONVIF SOAP fault: ${reason}`);
  }
  return xml;
}

function parseProfiles(xml: string): Profile[] {
  const profiles: Profile[] = [];
  const re = /<(?:[\w.-]+:)?Profiles\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?Profiles>/gi;
  for (const match of xml.matchAll(re)) {
    const token = match[1].match(/\btoken=["']([^"']+)["']/i)?.[1];
    if (!token) continue;
    profiles.push({ token: decodeXml(token), name: decodeXml(xmlValue(match[2], "Name") ?? "") });
  }
  return profiles;
}

function selectProfiles(profiles: Profile[]): { main?: Profile; sub?: Profile } {
  const subPattern = /sub|minor|secondary|low|mobile|extra/i;
  const mainPattern = /main|primary|high|major/i;
  const main = profiles.find((p) => mainPattern.test(p.name)) ?? profiles[0];
  const sub = profiles.find((p) => p.token !== main?.token && subPattern.test(p.name))
    ?? profiles.find((p) => p.token !== main?.token);
  return { main, sub };
}

async function getStreamUri(
  endpoint: string,
  profile: Profile | undefined,
  username: string,
  password: string,
  options: OnvifOptions,
): Promise<string | undefined> {
  if (!profile) return undefined;
  const xml = await soapCall(
    endpoint,
    "http://www.onvif.org/ver10/media/wsdl/GetStreamUri",
    `<trt:GetStreamUri xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${escapeXml(profile.token)}</trt:ProfileToken></trt:GetStreamUri>`,
    username,
    password,
    options,
  );
  const uri = xmlValue(xml, "Uri");
  return uri ? decodeXml(uri) : undefined;
}

export async function getOnvifStreams(
  deviceEndpoint: string,
  username: string,
  password: string,
  options: OnvifOptions = {},
): Promise<OnvifStreamInfo> {
  const deviceInfoXml = await soapCall(
    deviceEndpoint,
    "http://www.onvif.org/ver10/device/wsdl/GetDeviceInformation",
    '<tds:GetDeviceInformation xmlns:tds="http://www.onvif.org/ver10/device/wsdl"/>',
    username,
    password,
    options,
  );
  const capabilitiesXml = await soapCall(
    deviceEndpoint,
    "http://www.onvif.org/ver10/device/wsdl/GetCapabilities",
    '<tds:GetCapabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><tds:Category>Media</tds:Category></tds:GetCapabilities>',
    username,
    password,
    options,
  );
  const mediaEndpoint = decodeXml(xmlValue(capabilitiesXml, "XAddr") ?? deviceEndpoint);
  const profilesXml = await soapCall(
    mediaEndpoint,
    "http://www.onvif.org/ver10/media/wsdl/GetProfiles",
    '<trt:GetProfiles xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>',
    username,
    password,
    options,
  );
  const selected = selectProfiles(parseProfiles(profilesXml));
  if (!selected.main) {
    throw new OnvifError("INVALID_RESPONSE", "ONVIF returned no media profiles");
  }
  const [mainStream, subStream] = await Promise.all([
    getStreamUri(mediaEndpoint, selected.main, username, password, options),
    getStreamUri(mediaEndpoint, selected.sub, username, password, options),
  ]);
  if (!mainStream) {
    throw new OnvifError("INVALID_RESPONSE", "ONVIF returned no main stream URI");
  }
  return {
    manufacturer: decodeXml(xmlValue(deviceInfoXml, "Manufacturer") ?? "") || undefined,
    model: decodeXml(xmlValue(deviceInfoXml, "Model") ?? "") || undefined,
    mainStream,
    subStream,
  };
}
