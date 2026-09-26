"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const soap = require("soap");
const { once } = require("events");
const { Events } = require("../src/events");
const {
  AlertParser,
  MotionRouter,
  HikvisionSource,
  authorization,
} = require("../src/hikvision");
const { validateConfig, readConfig } = require("../src/config");
const { createServer } = require("../src/onvif-server");
const { createProxy } = require("../src/tcp-proxy");
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const xml = (channel, state = "active", type = "VMD") =>
  `<EventNotificationAlert xmlns="http://www.hikvision.com/ver20/XMLSchema"><channelID>${channel}</channelID><eventType>${type}</eventType><eventState>${state}</eventState></EventNotificationAlert>`;
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
async function call(url, op, content = "") {
  return fetch(url, {
    method: "POST",
    body: `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:e="http://www.onvif.org/ver10/events/wsdl" xmlns:wsa="http://www.w3.org/2005/08/addressing"><s:Header><wsa:MessageID>urn:uuid:test</wsa:MessageID></s:Header><s:Body><e:${op}>${content}</e:${op}></s:Body></s:Envelope>`,
  }).then(async (r) => ({ status: r.status, body: await r.text() }));
}
async function subscription(url) {
  const result = await call(url, "CreatePullPointSubscription");
  assert.equal(result.status, 200);
  return /<wsa:Address>([^<]+)/.exec(result.body)[1];
}
const pull = (url, timeout = "PT0S") =>
  call(
    url,
    "PullMessages",
    `<Timeout>${timeout}</Timeout><MessageLimit>100</MessageLimit>`,
  );

test("configuration accepts video-only settings and rejects duplicates and missing credentials", () => {
  const config = readConfig(path.join(__dirname, "../config.hikvision.example.yaml"), {
    checkSecrets: false,
  });
  assert.equal(config.onvif.length, 2);
  assert.throws(() => validateConfig(config), /missing username/);
  delete config.eventSources;
  config.onvif.forEach((c) => delete c.motion);
  validateConfig(config);
  config.onvif[1].mac = config.onvif[0].mac;
  assert.throws(() => validateConfig(config), /duplicate MAC/);
});

test("ISAPI multipart fragments, malformed XML, multiple documents, bounded noise", () => {
  const events = [];
  const parser = new AlertParser((e) => events.push(e));
  const payload = Buffer.from(
    "--boundary\r\nContent-Type: application/xml\r\n\r\n" +
      xml(1) +
      "\r\n--boundary\r\n" +
      xml(2, "inactive"),
  );
  for (let i = 0; i < payload.length; i += 7)
    parser.feed(payload.subarray(i, i + 7));
  assert.deepEqual(
    events.map((e) => [e.channel, e.active]),
    [
      ["1", true],
      ["2", false],
    ],
  );
  parser.feed(Buffer.from(xml(1, "active", "videoloss")));
  assert.equal(events[2].type, "videoloss");
  parser.feed(
    Buffer.from("<EventNotificationAlert><bad></EventNotificationAlert>"),
  );
  parser.feed(Buffer.alloc(300000, 65));
  assert.ok(parser.buffer.length <= 128);
});

test("per-camera routing, event filtering, duplicate suppression and reset timer", async () => {
  const cameras = [1, 2].map((channel) => ({
    config: {
      name: String(channel),
      motion: { source: "dvr", channel, resetAfterMs: 25 },
    },
    events: new Events("http://localhost"),
  }));
  const router = new MotionRouter(cameras, logger);
  try {
    router.route("other", { channel: "1", type: "VMD", active: true });
    assert.equal(cameras[0].events.active, false);
    router.route("dvr", { channel: "1", type: "videoloss", active: true });
    assert.equal(cameras[0].events.active, false);
    router.route("dvr", { channel: "1", type: "VMD", active: true });
    assert.equal(cameras[0].events.active, true);
    assert.equal(cameras[1].events.active, false);
    await delay(40);
    assert.equal(cameras[0].events.active, false);
    cameras[1].config.motion.channelField = "dynChannelID";
    router.route("dvr", {
      channel: "99",
      dynamicChannel: "2",
      type: "VMD",
      active: true,
    });
    assert.equal(cameras[1].events.active, true);
  } finally {
    router.close();
    cameras.forEach((c) => c.events.close());
  }
});

test("SOAP event subscription lifecycle, independent queues, long polling and faults", async (t) => {
  const events = new Events("");
  const server = http.createServer((req, res) => events.handle(req, res));
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}/onvif/events_service`;
  events.base = base;
  t.after(() => {
    events.close();
    server.closeAllConnections();
    server.close();
  });
  assert.match(
    (await call(base, "GetEventProperties")).body,
    /CellMotionDetector/,
  );
  const a = await subscription(base),
    b = await subscription(base);
  assert.match((await pull(a)).body, /PropertyOperation="Initialized"/);
  await pull(b);
  const pending = pull(a, "PT2S");
  await delay(20);
  events.setMotion(true);
  assert.match((await pending).body, /Name="IsMotion" Value="true"/);
  assert.match((await pull(b)).body, /Name="IsMotion" Value="true"/);
  events.setMotion(true);
  assert.doesNotMatch((await pull(a)).body, /NotificationMessage/);
  events.setMotion(false);
  assert.match((await pull(a)).body, /Name="IsMotion" Value="false"/);
  assert.equal(
    (await call(a, "Renew", "<TerminationTime>PT5M</TerminationTime>")).status,
    200,
  );
  await call(a, "SetSynchronizationPoint");
  assert.match((await pull(a)).body, /Initialized/);
  await call(a, "Unsubscribe");
  assert.equal((await pull(a)).status, 500);
  assert.equal((await call(base, "Subscribe")).status, 500);
  assert.equal(
    (await call(b, "PullMessages", "<MessageLimit>NaN</MessageLimit>")).status,
    500,
  );
  const expired = await subscription(base);
  const id = expired.split("/").at(-1);
  events.subscriptions.get(id).expires = Date.now() - 1;
  assert.equal((await pull(expired)).status, 500);
  for (let i = 0; i < 600; i++) events.setMotion(i % 2 === 0);
  assert.equal(events.subscriptions.get(b.split("/").at(-1)).queue.length, 256);
});

test("Digest RFC example and algorithm validation", () => {
  const result = authorization(
    'Digest realm="test", nonce="123", qop="auth,auth-int", algorithm=MD5',
    "user",
    "pass",
    "/events",
  );
  assert.match(result, /qop=auth/);
  assert.match(result, /response="[a-f0-9]{32}"/);
  assert.throws(
    () => authorization('Basic realm="test"', "x", "y", "/"),
    /Digest/,
  );
  assert.throws(
    () =>
      authorization(
        'Digest realm="test", nonce="123", algorithm=invalid',
        "x",
        "y",
        "/",
      ),
    /Unsupported/,
  );
});

test("simulated Digest DVR forwards motion end-to-end and reconnects after EOF", async (t) => {
  let connects = 0;
  let validDigest = false;
  const dvr = http.createServer((req, res) => {
    if (!req.headers.authorization) {
      res.writeHead(401, {
        "WWW-Authenticate":
          'Digest realm="DVR", nonce="abc", qop="auth", algorithm=MD5',
      });
      res.end();
      return;
    }
    const values = Object.fromEntries(
      [
        ...req.headers.authorization.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g),
      ].map((m) => [m[1], m[2] ?? m[3]]),
    );
    const hash = (s) =>
      require("crypto").createHash("md5").update(s).digest("hex");
    validDigest =
      values.response ===
      hash(
        `${hash("user:DVR:pass")}:abc:${values.nc}:${values.cnonce}:auth:${hash("GET:/ISAPI/Event/notification/alertStream")}`,
      );
    if (!validDigest) {
      res.writeHead(403);
      res.end();
      return;
    }
    connects++;
    res.writeHead(200, { "Content-Type": "multipart/mixed; boundary=alarm" });
    res.end("--alarm\r\n" + xml(2));
  });
  const port = await listen(dvr);
  const cameras = [1, 2].map((channel) => ({
    config: { motion: { source: "dvr", channel } },
    events: new Events(""),
  }));
  const router = new MotionRouter(cameras, logger);
  const eventHttp = http.createServer((req, res) =>
    cameras[1].events.handle(req, res),
  );
  const eventPort = await listen(eventHttp);
  cameras[1].events.base = `http://127.0.0.1:${eventPort}/onvif/events_service`;
  const sub = await subscription(cameras[1].events.base);
  await pull(sub);
  const source = new HikvisionSource(
    {
      id: "dvr",
      url: `http://127.0.0.1:${port}/ISAPI/Event/notification/alertStream`,
      username: "user",
      password: "pass",
    },
    (e) => router.route("dvr", e),
    logger,
  );
  t.after(() => {
    source.stop();
    router.close();
    cameras.forEach((c) => c.events.close());
    dvr.closeAllConnections();
    dvr.close();
    eventHttp.closeAllConnections();
    eventHttp.close();
  });
  source.start();
  const motion = await pull(sub, "PT2S");
  assert.match(motion.body, /Name="IsMotion" Value="true"/);
  assert.ok(validDigest);
  assert.equal(cameras[0].events.active, false);
  await delay(1400);
  assert.ok(connects >= 2);
});

test("device/media SOAP operations work with offline WSDL and live legacy snapshot", async (t) => {
  const config = readConfig(path.join(__dirname, "../config.hikvision.example.yaml"), {
    checkSecrets: false,
  }).onvif[0];
  config.hostname = "127.0.0.1";
  config.ports.server = 0;
  const snapshot = fs.readFileSync(path.join(__dirname, "../resources/snapshot.png"));
  const source = http.createServer((req, res) => {
    assert.equal(req.url, config.highQuality.snapshot);
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(snapshot);
  });
  config.target.hostname = "127.0.0.1";
  config.target.ports.snapshot = await listen(source);
  t.after(() => new Promise((resolve) => source.close(resolve)));
  const camera = createServer(config, logger);
  t.after(() => camera.close());
  await camera.startServer();
  const port = camera.server.address().port;
  const device = await soap.createClientAsync(
    path.join(__dirname, "../wsdl/device_service.wsdl"),
    {
      endpoint: `http://127.0.0.1:${port}/onvif/device_service`,
      forceSoap12Headers: true,
    },
  );
  const media = await soap.createClientAsync(
    path.join(__dirname, "../wsdl/media_service.wsdl"),
    {
      endpoint: `http://127.0.0.1:${port}/onvif/media_service`,
      forceSoap12Headers: true,
    },
  );
  assert.equal(
    (await device.GetDeviceInformationAsync({}))[0].Model,
    "Cardinal",
  );
  assert.ok(
    (await device.GetSystemDateAndTimeAsync({}))[0].SystemDateAndTime
      .UTCDateTime,
  );
  const services = (
    await device.GetServicesAsync({ IncludeCapability: false })
  )[0].Service;
  assert.equal(services.length, 3);
  const caps = (await device.GetCapabilitiesAsync({ Category: "All" }))[0]
    .Capabilities;
  assert.equal(caps.Events.WSPullPointSupport, true);
  assert.equal((await media.GetProfilesAsync({}))[0].Profiles.length, 2);
  assert.equal(
    (await media.GetVideoSourcesAsync({}))[0].VideoSources[0].attributes.token,
    "video_src_token",
  );
  assert.match(
    (await media.GetStreamUriAsync({ ProfileToken: "sub_stream" }))[0].MediaUri
      .Uri,
    /\/102$/,
  );
  assert.match(
    (await media.GetSnapshotUriAsync({ ProfileToken: "main_stream" }))[0]
      .MediaUri.Uri,
    /\/101\/picture$/,
  );
  const image = await fetch(`http://127.0.0.1:${port}/snapshot.png`);
  assert.equal(image.status, 200);
  assert.equal(
    (await image.arrayBuffer()).byteLength,
    fs.statSync(path.join(__dirname, "../resources/snapshot.png")).size,
  );
  const event = await call(
    `http://127.0.0.1:${port}/onvif/events_service`,
    "GetServiceCapabilities",
  );
  assert.equal(event.status, 200);
});

test("TCP passthrough preserves bytes and closes connections", async (t) => {
  const upstream = net.createServer((socket) => socket.pipe(socket));
  const targetPort = await listen(upstream);
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const proxy = createProxy("127.0.0.1", port, "127.0.0.1", targetPort);
  await proxy.start();
  t.after(async () => {
    await proxy.close();
    upstream.close();
  });
  const client = net.connect(port, "127.0.0.1");
  await once(client, "connect");
  const bytes = Buffer.from([0, 255, 3, 1]);
  client.write(bytes);
  const [response] = await once(client, "data");
  assert.deepEqual(response, bytes);
  client.destroy();
});

test("config generator discovers Media endpoint and preserves two profiles and nondefault ports", async (t) => {
  const config = readConfig(path.join(__dirname, "../config.hikvision.example.yaml"), {
    checkSecrets: false,
  }).onvif[0];
  config.hostname = "127.0.0.1";
  config.ports.server = 0;
  const camera = createServer(config, logger);
  t.after(() => camera.close());
  await camera.startServer();
  config.ports.server = camera.server.address().port;
  const result = await require("../src/config-builder").createConfig(
    `127.0.0.1:${config.ports.server}`,
    "user",
    "pass",
  );
  assert.equal(result.onvif.length, 1);
  assert.equal(result.onvif[0].highQuality.rtsp, "/Streaming/Channels/101");
  assert.equal(result.onvif[0].lowQuality.rtsp, "/Streaming/Channels/102");
  assert.equal(result.onvif[0].target.ports.rtsp, 8554);
  assert.equal(result.onvif[0].target.ports.snapshot, 8580);
  assert.equal(result.onvif[0].mac, "<ONVIF PROXY MAC ADDRESS HERE>");
});

test("every vendored schema import resolves locally", () => {
  const root = path.join(__dirname, "../wsdl");
  for (const file of [
    ...fs.readdirSync(root).filter((f) => f.endsWith(".wsdl")),
    ...fs.readdirSync(path.join(root, "vendor")).map((f) => "vendor/" + f),
  ]) {
    const content = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of content.matchAll(
      /<(?:\w+:)?(?:import|include)\b[^>]*(?:schemaLocation|location)\s*=\s*["']([^"']+)["']/g,
    )) {
      assert.ok(
        !/^https?:/.test(match[1]),
        `${file}: remote import ${match[1]}`,
      );
      assert.ok(
        fs.existsSync(path.resolve(root, path.dirname(file), match[1])),
        `${file}: missing ${match[1]}`,
      );
    }
  }
});

test("discovery ignores malformed XML and responds to valid Probe without extra sockets", async (t) => {
  const dgram = require("dgram");
  const config = readConfig(path.join(__dirname, "../config.hikvision.example.yaml"), {
    checkSecrets: false,
  }).onvif[0];
  config.hostname = "127.0.0.1";
  const camera = createServer(config, logger);
  t.after(() => camera.close());
  await camera.startDiscovery();
  const client = dgram.createSocket("udp4");
  t.after(() => client.close());
  client.bind(0, "127.0.0.1");
  await once(client, "listening");
  client.send(Buffer.from("<broken"), 3702, "127.0.0.1");
  client.send(
    Buffer.from(
      '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body/></s:Envelope>',
    ),
    3702,
    "127.0.0.1",
  );
  const received = once(client, "message", {
    signal: AbortSignal.timeout(2000),
  });
  client.send(
    Buffer.from(
      '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><s:Header><wsa:MessageID>uuid:test-probe</wsa:MessageID></s:Header><s:Body><d:Probe/></s:Body></s:Envelope>',
    ),
    3702,
    "127.0.0.1",
  );
  const [response] = await received;
  assert.match(response.toString(), /ProbeMatches/);
  assert.match(response.toString(), /uuid:test-probe/);
  assert.match(response.toString(), new RegExp(config.uuid));
});

test("RTSP-only camera advertises one profile, no Events, and snapshot fallback", async (t) => {
  const config = readConfig(path.join(__dirname, "../config.hikvision.example.yaml"), {
    checkSecrets: false,
  }).onvif[0];
  delete config.motion;
  delete config.lowQuality;
  delete config.highQuality.snapshot;
  config.hostname = "127.0.0.1";
  config.ports.server = 0;
  const camera = createServer(config, logger);
  t.after(() => camera.close());
  await camera.startServer();
  const port = camera.server.address().port;
  config.ports.server = port;
  const media = await soap.createClientAsync(
    path.join(__dirname, "../wsdl/media_service.wsdl"),
    {
      endpoint: `http://127.0.0.1:${port}/onvif/media_service`,
      forceSoap12Headers: true,
    },
  );
  assert.equal((await media.GetProfilesAsync({}))[0].Profiles.length, 1);
  assert.equal(
    (await media.GetSnapshotUriAsync({ ProfileToken: "main_stream" }))[0]
      .MediaUri.Uri,
    `http://127.0.0.1:${port}/snapshot.png`,
  );
  assert.equal(camera.events, null);
  assert.equal(
    camera.onvif.DeviceService.Device.GetServices({}).Service.length,
    2,
  );
  assert.equal(
    camera.onvif.DeviceService.Device.GetCapabilities({ Category: "All" })
      .Capabilities.Events,
    undefined,
  );
});

test('generic RTSP configuration accepts multiple vendors without event credentials', () => {
  const config = readConfig(path.join(__dirname, '../config.example.yaml'));
  assert.equal(config.eventSources, undefined);
  assert.equal(config.onvif[0].motion, undefined);
  const second = structuredClone(config.onvif[0]);
  second.name = 'Another NVR';
  second.mac = 'a2:a2:a2:a2:a2:a2';
  second.uuid = '15b21259-77d9-441f-9913-3ccd8a82e431';
  second.target.hostname = 'nvr.local';
  second.target.ports.rtsp = 8555;
  second.highQuality.rtsp = '/cam/realmonitor?channel=4&subtype=0';
  config.onvif.push(second);
  validateConfig(config);
  for (const entry of config.onvif) {
    entry.hostname = '127.0.0.1';
    const camera = createServer(entry, logger);
    assert.equal(camera.events, null);
    assert.equal(camera.onvif.MediaService.Media.GetStreamUri({ProfileToken:'main_stream'}).MediaUri.Uri,
      `rtsp://127.0.0.1:8554${entry.highQuality.rtsp}`);
  }
});

test('event adapter selection is explicit and backward compatible', () => {
  const {createEventSource} = require('../src/event-sources');
  const source = {id:'dvr',url:'http://127.0.0.1/events',username:'u',password:'p'};
  assert.ok(createEventSource(source, () => {}, logger) instanceof HikvisionSource);
  assert.ok(createEventSource({...source,type:'hikvision-isapi'}, () => {}, logger) instanceof HikvisionSource);
  assert.throws(() => createEventSource({...source,type:'unknown'}, () => {}, logger), /Unsupported event source/);
  const config = readConfig(path.join(__dirname, '../config.example.yaml'));
  config.eventSources = [{...source,type:'unknown'}];
  assert.throws(() => validateConfig(config), /unsupported event source/);
});
