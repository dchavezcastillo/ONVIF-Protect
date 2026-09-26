"use strict";
const http = require("http");
const { authorization } = require("./transport/digest");
const { credentialsFor } = require("./credentials");

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const MAX_ACTIVE = 4;

// Serve the current image at the legacy URL cached by already adopted clients.
// Digest must be calculated for the source path, not the incoming /snapshot.png.
class Snapshot {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.path = config.highQuality.snapshot || config.lowQuality?.snapshot;
    this.active = new Set();
    this.closed = false;
  }
  handle(request, response) {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    if (this.closed || this.active.size >= MAX_ACTIVE) {
      response.writeHead(503, { "Retry-After": "1", "Cache-Control": "no-store" });
      response.end();
      return;
    }
    let upstream, body, timer, finished = false;
    const finish = (status, payload = "Snapshot unavailable\n", type = "text/plain") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.active.delete(cancel);
      response.off("close", cancel);
      upstream?.destroy();
      body?.destroy();
      if (status && !response.destroyed) {
        response.writeHead(status, {
          "Content-Type": type,
          "Content-Length": Buffer.byteLength(payload),
          "Cache-Control": "no-store",
        });
        response.end(request.method === "HEAD" ? undefined : payload);
      }
    };
    const cancel = () => finish(0);
    const fail = (status, reason) => {
      if (finished) return;
      this.logger.warn(`Snapshot ${this.config.name}: ${reason}`);
      finish(status);
    };
    this.active.add(cancel);
    response.once("close", cancel);
    timer = setTimeout(() => fail(504, "source timeout"), TIMEOUT_MS);
    const open = (auth, attempt = 0) => {
      if (finished) return;
      try {
        upstream = http.get({
          hostname: this.config.target.hostname,
          port: this.config.target.ports.snapshot,
          path: this.path,
          agent: false,
          headers: {
            Accept: "image/jpeg, image/png",
            ...(auth ? { Authorization: auth } : {}),
          },
        }, (res) => {
          if (finished) { res.destroy(); return; }
          body = res;
          res.on("error", () => fail(502, "source response error"));
          if (res.statusCode === 401 && this.config.snapshotAuth && attempt < 2) {
            try {
              const { username, password } = credentialsFor(this.config.snapshotAuth);
              const header = authorization(res.headers["www-authenticate"] || "",
                username, password, this.path);
              res.destroy();
              open(header, attempt + 1);
            } catch {
              fail(502, "source authentication failed");
            }
            return;
          }
          if (res.statusCode !== 200) {
            fail(502, `source HTTP ${res.statusCode}`);
            return;
          }
          const type = (res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
          if (!["image/jpeg", "image/png"].includes(type)) {
            fail(502, "source did not return JPEG or PNG");
            return;
          }
          if (Number(res.headers["content-length"]) > MAX_BYTES) {
            fail(502, "source image too large");
            return;
          }
          const chunks = [];
          let size = 0;
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BYTES) { fail(502, "source image too large"); return; }
            chunks.push(chunk);
          });
          res.once("end", () => {
            if (finished) return;
            const image = Buffer.concat(chunks);
            const valid = type === "image/jpeg"
              ? image.length >= 4 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
              : image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
            if (!valid) { fail(502, "invalid source image"); return; }
            finish(200, image, type);
          });
        });
        upstream.on("error", () => fail(502, "source connection failed"));
      } catch {
        fail(502, "source request failed");
      }
    };
    open();
  }
  close() {
    this.closed = true;
    for (const cancel of this.active) cancel();
  }
}
module.exports = { Snapshot };
