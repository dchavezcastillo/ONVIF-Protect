"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { once, EventEmitter } = require("node:events");
const { readConfig, validateConfig } = require("../src/config");
const { run } = require("../src/application");
const { createServer } = require("../src/onvif-server");
const { Subscriptions } = require("../src/onvif/subscriptions");
const { EventStreamSource } = require("../src/event-stream/source");
const { closeServer } = require("../src/transport/server");
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const configuration = () =>
  readConfig(path.join(__dirname, "../config.example.yaml"));
async function reserve() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

test("failed startup releases the ONVIF listener and leaves caller configuration unchanged", async (t) => {
  const config = configuration();
  const onvifPort = await reserve();
  const occupied = await reserve();
  t.after(() => closeServer(occupied));
  config.onvif[0].hostname = "127.0.0.1";
  config.onvif[0].ports.server = onvifPort.address().port;
  config.onvif[0].ports.rtsp = occupied.address().port;
  const original = structuredClone(config);
  await closeServer(onvifPort);
  await assert.rejects(run(config, { discovery: false, logger }), {
    code: "EADDRINUSE",
  });
  assert.deepEqual(config, original);
  const replacement = net.createServer();
  t.after(() => closeServer(replacement));
  replacement.listen(config.onvif[0].ports.server, "127.0.0.1");
  await once(replacement, "listening");
});

test("application shutdown is idempotent and configuration is not mutated", async (t) => {
  const reservations = await Promise.all([reserve(), reserve()]);
  const config = configuration();
  config.onvif[0].hostname = "127.0.0.1";
  [config.onvif[0].ports.server, config.onvif[0].ports.rtsp] = reservations.map(
    (server) => server.address().port,
  );
  await Promise.all(reservations.map(closeServer));
  const original = structuredClone(config);
  const app = await run(config, { discovery: false, logger });
  t.after(() => app.close());
  const response = await fetch(
    `http://127.0.0.1:${config.onvif[0].ports.server}/healthz`,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).camera, config.onvif[0].name);
  const first = app.close();
  assert.equal(app.close(), first);
  await first;
  assert.deepEqual(config, original);
});

test("camera advertises its assigned event port and all requested capability categories", async (t) => {
  const config = configuration().onvif[0];
  config.hostname = "127.0.0.1";
  config.ports.server = 0;
  config.motion = { source: "events", channel: 1 };
  const camera = createServer(config, logger);
  t.after(() => camera.close());
  await camera.startServer();
  assert.equal(
    camera.events.base,
    `http://127.0.0.1:${camera.server.address().port}/onvif/events_service`,
  );
  const capabilities = camera.onvif.DeviceService.Device.GetCapabilities({
    Category: ["Device", "Events"],
  }).Capabilities;
  assert.deepEqual(Object.keys(capabilities), ["Device", "Events"]);
  assert.equal(capabilities.Device.IO.RelayOutputs, 0);
  assert.equal(camera.profiles[0].VideoSourceConfiguration.UseCount, 1);
  await camera.close();
  await camera.close();
  await assert.rejects(camera.startServer(), /current state/);
});

test("subscription shutdown releases pending pulls; disconnected consumers do not consume queued changes", async () => {
  const store = new Subscriptions();
  try {
    const { id, subscription } = store.create("PT1M");
    const response = new EventEmitter();
    response.destroyed = false;
    await store.pull(id, { MessageLimit: 1, Timeout: "PT0S" }, response);
    const pending = store.pull(
      id,
      { MessageLimit: 1, Timeout: "PT30S" },
      response,
    );
    response.destroyed = true;
    response.emit("close");
    store.setMotion(true);
    assert.deepEqual((await pending).messages, []);
    assert.equal(subscription.queue.length, 1);
    assert.equal(response.listenerCount("close"), 0);
    response.destroyed = false;
    await store.pull(id, { MessageLimit: 1, Timeout: "PT0S" }, response);
    const closing = store.pull(
      id,
      { MessageLimit: 1, Timeout: "PT30S" },
      response,
    );
    store.close();
    await assert.rejects(closing, /expired subscription/);
    assert.throws(() => store.create(), /closed/);
  } finally {
    store.close();
  }
});

test("event source ignores duplicate start and cancels reconnect after stop", async (t) => {
  let connections = 0;
  const server = http.createServer((req, res) => {
    connections++;
    res.writeHead(200);
    res.write("heartbeat\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const source = new EventStreamSource(
    { id: "test", url: `http://127.0.0.1:${server.address().port}/events` },
    () => {},
    logger,
  );
  t.after(async () => {
    source.stop();
    await closeServer(server);
  });
  source.start();
  source.start();
  for (let i = 0; i < 100 && !source.status.connected; i++) await pause(10);
  assert.equal(source.status.connected, true);
  assert.equal(connections, 1);
  source.stop();
  source.stop();
  await pause(30);
  assert.equal(source.status.connected, false);
  assert.equal(source.status.reconnects, 0);
  source.start();
  for (let i = 0; i < 100 && !source.status.connected; i++) await pause(10);
  assert.equal(source.status.connected, true);
  assert.equal(connections, 2);
});

test("invalid configuration entries report actionable validation errors", () => {
  for (const entry of [null, [], "camera"]) {
    assert.throws(
      () => validateConfig({ onvif: [entry] }),
      /Configuration: camera name/,
    );
  }
  const config = configuration();
  config.eventSources = [null];
  assert.throws(() => validateConfig(config), /Configuration: eventSources/);
});
