"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const { once } = require("node:events");
const { createHash } = require("node:crypto");
const { createServer } = require("../src/onvif-server");
const { readConfig, validateConfig } = require("../src/config");
const { closeServer } = require("../src/transport/server");
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const png = fs.readFileSync(require.resolve("../resources/snapshot.png"));
async function fixture(t, handler, overrides = {}) {
  const upstream = http.createServer(handler);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => closeServer(upstream));
  const config = readConfig(require.resolve("../config.example.yaml")).onvif[0];
  config.hostname = "127.0.0.1";
  config.ports.server = 0;
  config.ports.snapshot = 8580;
  config.highQuality.snapshot = "/real/snapshot?channel=1";
  config.target.hostname = "127.0.0.1";
  config.target.ports.snapshot = upstream.address().port;
  Object.assign(config, overrides);
  const camera = createServer(config, logger);
  t.after(() => camera.close());
  await camera.startServer();
  return { camera, url: `http://127.0.0.1:${camera.server.address().port}/snapshot.png` };
}

test("cached snapshot URL returns live image with source-path Digest, preserving camera identity", async (t) => {
  let requests = 0;
  const { camera, url } = await fixture(t, (req, res) => {
    requests++;
    assert.equal(req.url, "/real/snapshot?channel=1");
    assert.equal(req.headers.cookie, undefined);
    if (!req.headers.authorization) {
      res.writeHead(401, { "WWW-Authenticate": 'Digest realm="snapshot", nonce="nonce", qop="auth", algorithm=MD5' });
      res.end(); return;
    }
    const fields = Object.fromEntries([...req.headers.authorization.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(m => [m[1], m[2] ?? m[3]]));
    const hash = v => createHash("md5").update(v).digest("hex");
    assert.equal(fields.username, "snapshot-user");
    assert.equal(fields.uri, req.url);
    assert.equal(fields.response, hash(`${hash('snapshot-user:snapshot:secret')}:nonce:${fields.nc}:${fields.cnonce}:auth:${hash('GET:' + req.url)}`));
    res.writeHead(200, { "Content-Type": "image/png" }); res.end(png);
  }, { snapshotAuth: { username: "snapshot-user", password: "secret" } });
  const identity = [camera.config.mac, camera.config.uuid, camera.config.hostname];
  const response = await fetch(url, { headers: { Authorization: "Basic do-not-forward", Cookie: "do-not-forward" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(requests, 2);
  assert.deepEqual([camera.config.mac, camera.config.uuid, camera.config.hostname], identity);
  assert.match(camera.onvif.MediaService.Media.GetSnapshotUri({}).MediaUri.Uri, /:8580\/real\/snapshot\?channel=1$/);
});

test("JPEG is served with its real type at .png URL and HEAD has no body", async (t) => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
  const { url } = await fixture(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end(jpeg);
  });
  const response = await fetch(url);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(jpeg.length));
  assert.equal(await head.text(), "");
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
});

test("source errors, redirects, invalid images and oversized responses fail without returning the placeholder", async (t) => {
  for (const mode of ["unauthorized", "redirect", "html", "invalid", "large", "chunked-large", "truncated"]) {
    await t.test(mode, async (t) => {
      const { url } = await fixture(t, (req, res) => {
        if (mode === "unauthorized") { res.writeHead(401); res.end(); }
        else if (mode === "redirect") { res.writeHead(302, { Location: "http://example.invalid/" }); res.end(); }
        else if (mode === "html") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("login"); }
        else if (mode === "large") { res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": 9 * 1024 * 1024 }); res.end(); }
        else if (mode === "chunked-large") { res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end(Buffer.alloc(9 * 1024 * 1024)); }
        else if (mode === "truncated") { res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": 100 }); res.write("partial"); setImmediate(() => res.destroy()); }
        else { res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end("not an image"); }
      });
      const response = await fetch(url);
      assert.equal(response.status, 502);
      assert.equal(await response.text(), "Snapshot unavailable\n");
    });
  }
});

test("legacy placeholder remains available for cameras without a configured snapshot", async (t) => {
  const { camera, url } = await fixture(t, () => assert.fail("unexpected source request"));
  camera.snapshot.path = undefined;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});

test("snapshot requests are bounded and cancelled when a client disconnects or camera closes", async (t) => {
  const { camera, url } = await fixture(t, () => {});
  const requests = Array.from({ length: 4 }, () => {
    const req = http.get(url); req.on("error", () => {}); return req;
  });
  t.after(() => requests.forEach(req => req.destroy()));
  async function waitFor(count) {
    for (let i = 0; i < 100 && camera.snapshot.active.size !== count; i++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(camera.snapshot.active.size, count);
  }
  await waitFor(4);
  assert.equal((await fetch(url)).status, 503);
  requests[0].destroy();
  await waitFor(3);
  await camera.close();
  assert.equal(camera.snapshot.active.size, 0);
  await camera.close();
});

test("snapshot credentials require a path and valid configured secrets", () => {
  const config = readConfig(require.resolve("../config.example.yaml"));
  const camera = config.onvif[0];
  camera.snapshotAuth = { username: "user", password: "secret" };
  assert.throws(() => validateConfig(config), /configure a snapshot path/);
  camera.highQuality.snapshot = "/snapshot";
  camera.ports.snapshot = 8580;
  camera.target.ports.snapshot = 80;
  validateConfig(config);
  camera.snapshotAuth.password = "";
  assert.throws(() => validateConfig(config), /snapshotAuth password/);
  camera.snapshotAuth = { usernameEnv: "SNAPSHOT_TEST_UNSET_USER", passwordEnv: "SNAPSHOT_TEST_UNSET_PASS" };
  validateConfig(config, { checkSecrets: false });
  assert.throws(() => validateConfig(config), /snapshotAuth username/);
});

test("incorrect Digest credentials stop after bounded retries", async (t) => {
  let attempts = 0;
  const { url } = await fixture(t, (req, res) => {
    attempts++;
    res.writeHead(401, { "WWW-Authenticate": 'Digest realm="snapshot", nonce="bad", qop="auth"' });
    res.end();
  }, { snapshotAuth: { username: "user", password: "wrong" } });
  const response = await fetch(url);
  assert.equal(response.status, 502);
  assert.equal(attempts, 3);
});

test("a stalled source times out and releases its request slot", async (t) => {
  const { camera, url } = await fixture(t, () => {});
  const response = await fetch(url);
  assert.equal(response.status, 504);
  assert.equal(camera.snapshot.active.size, 0);
});

test("camera snapshots stay isolated and use each configured source path", async (t) => {
  const first = await fixture(t, (req, res) => {
    assert.equal(req.url, "/real/snapshot?channel=1");
    res.writeHead(200, { "Content-Type": "image/png" }); res.end(png);
  });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
  const second = await fixture(t, (req, res) => {
    assert.equal(req.url, "/other/channel/2");
    res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end(jpeg);
  });
  second.camera.snapshot.path = "/other/channel/2";
  const responses = await Promise.all([fetch(first.url), fetch(second.url)]);
  assert.deepEqual(Buffer.from(await responses[0].arrayBuffer()), png);
  assert.deepEqual(Buffer.from(await responses[1].arrayBuffer()), jpeg);
});
