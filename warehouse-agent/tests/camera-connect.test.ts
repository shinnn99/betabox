import assert from "node:assert/strict";
import test from "node:test";
import { CameraConnectError, connectCamera } from "../src/camera-connect";
import { getOnvifStreams, OnvifError } from "../src/onvif-auth";

function xmlResponse(body: string, status = 200): Response {
  return new Response(
    `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${body}</s:Body></s:Envelope>`,
    { status, headers: { "content-type": "application/soap+xml" } },
  );
}

test("ONVIF performs device info, capabilities, profiles and stream URI calls", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const responses = [
    xmlResponse("<tds:GetDeviceInformationResponse><tds:Manufacturer>Acme</tds:Manufacturer><tds:Model>Cam X</tds:Model></tds:GetDeviceInformationResponse>"),
    xmlResponse("<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>http://10.0.0.2/onvif/media_service</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>"),
    xmlResponse('<trt:GetProfilesResponse><trt:Profiles token="main"><tt:Name>MainStream</tt:Name></trt:Profiles><trt:Profiles token="sub"><tt:Name>SubStream</tt:Name></trt:Profiles></trt:GetProfilesResponse>'),
    xmlResponse("<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://10.0.0.2/main</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>"),
    xmlResponse("<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://10.0.0.2/sub</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>"),
  ];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), body: String(init?.body ?? "") });
    const response = responses.shift();
    assert.ok(response);
    return response;
  };

  const result = await getOnvifStreams(
    "http://10.0.0.2/onvif/device_service",
    "operator",
    "top-secret",
    { fetchImpl },
  );

  assert.deepEqual(result, {
    manufacturer: "Acme",
    model: "Cam X",
    mainStream: "rtsp://10.0.0.2/main",
    subStream: "rtsp://10.0.0.2/sub",
  });
  assert.equal(requests.length, 5);
  assert.equal(requests[0].url, "http://10.0.0.2/onvif/device_service");
  assert.equal(requests[2].url, "http://10.0.0.2/onvif/media_service");
  assert.match(requests[0].body, /PasswordDigest/);
  assert.doesNotMatch(requests[0].body, /top-secret/);
});

test("ONVIF maps HTTP authentication failures without trying media calls", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return xmlResponse("", 401);
  };
  await assert.rejects(
    getOnvifStreams("http://camera/onvif/device_service", "admin", "wrong", { fetchImpl }),
    (error: unknown) => error instanceof OnvifError && error.code === "AUTH_FAILED",
  );
  assert.equal(calls, 1);
});

test("connectCamera falls back in order and returns paths without credentials", async () => {
  const probed: string[] = [];
  const result = await connectCamera(
    {
      onvifEndpoint: "http://10.0.0.3/onvif/device_service",
      host: "10.0.0.3:554",
      username: "admin@example.com",
      password: "p@ss:/word",
      ffmpegBin: "ffmpeg",
      rtspPaths: ["/first", "/second"],
    },
    {
      getStreams: async () => {
        throw new OnvifError("HTTP_ERROR", "ONVIF unsupported");
      },
      probe: async (url) => {
        probed.push(url);
        return url.includes("/second") ? "ok" : "failed";
      },
    },
  );
  assert.equal(probed.length, 2);
  assert.match(probed[0], /^rtsp:\/\/admin%40example\.com:p%40ss%3A%2Fword@10\.0\.0\.3:554\/first$/);
  assert.deepEqual(result, { rtspPath: "/second" });
  assert.doesNotMatch(JSON.stringify(result), /p@ss|word|admin@example/);
});

test("connectCamera stops immediately after RTSP reports bad credentials", async () => {
  let probes = 0;
  await assert.rejects(
    connectCamera(
      {
        onvifEndpoint: "http://10.0.0.4/onvif/device_service",
        host: "10.0.0.4",
        username: "admin",
        password: "wrong",
        ffmpegBin: "ffmpeg",
        rtspPaths: ["/one", "/two", "/three"],
      },
      {
        getStreams: async () => {
          throw new OnvifError("HTTP_ERROR", "ONVIF unsupported");
        },
        probe: async () => {
          probes += 1;
          return "auth_failed";
        },
      },
    ),
    (error: unknown) => error instanceof CameraConnectError && error.code === "AUTH_FAILED",
  );
  assert.equal(probes, 1);
});

test("connectCamera does not probe RTSP after ONVIF rejects credentials", async () => {
  let probes = 0;
  await assert.rejects(
    connectCamera(
      {
        onvifEndpoint: "http://10.0.0.5/onvif/device_service",
        host: "10.0.0.5",
        username: "admin",
        password: "wrong",
        ffmpegBin: "ffmpeg",
      },
      {
        getStreams: async () => {
          throw new OnvifError("AUTH_FAILED", "denied");
        },
        probe: async () => {
          probes += 1;
          return "failed";
        },
      },
    ),
    (error: unknown) => error instanceof CameraConnectError && error.code === "AUTH_FAILED",
  );
  assert.equal(probes, 0);
});
