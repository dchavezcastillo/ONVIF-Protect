"use strict";
const http = require("http");
const https = require("https");
const { authorization } = require("../transport/digest");
const { credentialsFor } = require("../credentials");
const { AlertParser } = require("./alert-parser");
class EventStreamSource {
  constructor(config, onEvent, logger) {
    this.config = config;
    this.onEvent = onEvent;
    this.logger = logger;
    this.stopped = true;
    this.failures = 0;
    this.status = { connected: false, lastEvent: null, reconnects: 0 };
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  stop() {
    this.stopped = true;
    this.cancelAttempt?.();
    clearTimeout(this.timer);
    this.request?.destroy();
    this.response?.destroy();
    this.status.connected = false;
  }
  connect() {
    if (this.stopped) return;
    const config = this.config;
    const url = new URL(config.url);
    const uri = url.pathname + url.search;
    const { username, password } = credentialsFor(config);
    let finished = false;
    this.cancelAttempt = () => {
      finished = true;
    };
    const retry = (reason) => {
      if (finished || this.stopped) return;
      finished = true;
      this.status.connected = false;
      this.request?.destroy();
      this.response?.destroy();
      const delay =
        Math.min(30000, 1000 * 2 ** Math.min(this.failures++, 5)) +
        Math.floor(Math.random() * 250);
      this.status.reconnects++;
      this.logger.warn(
        `Events ${config.id}: ${reason}; reconnect in ${delay}ms`,
      );
      this.timer = setTimeout(() => this.connect(), delay);
    };
    const open = (auth, attempts = 0) => {
      if (finished || this.stopped) return;
      const transport = url.protocol === "https:" ? https : http;
      this.request = transport.get(
        url,
        {
          headers: {
            Accept: "multipart/mixed",
            ...(auth ? { Authorization: auth } : {}),
          },
        },
        (res) => {
          if (finished || this.stopped) {
            res.destroy();
            return;
          }
          this.response = res;
          if (res.statusCode === 401 && attempts < 2) {
            try {
              const header = authorization(
                res.headers["www-authenticate"] || "",
                username,
                password,
                uri,
              );
              res.destroy();
              open(header, attempts + 1);
            } catch (error) {
              res.destroy();
              retry(error.message);
            }
            return;
          }
          if (res.statusCode !== 200) {
            res.destroy();
            retry(`HTTP ${res.statusCode}`);
            return;
          }
          this.status.connected = true;
          this.logger.info(`Events ${config.id}: connected`);
          const parser = new AlertParser(
            (event) => {
              this.status.lastEvent = new Date().toISOString();
              this.onEvent(event);
            },
            () =>
              this.logger.warn(`Events ${config.id}: malformed XML ignored`),
          );
          res.on("data", (chunk) => {
            this.failures = 0;
            parser.feed(chunk);
          });
          res.on("end", () => retry("stream ended"));
          res.on("error", () => retry("stream error"));
          res.on("close", () => retry("stream closed"));
        },
      );
      this.request.setTimeout(config.idleTimeoutMs || 90000, () =>
        retry("stream timeout"),
      );
      this.request.on("error", (error) =>
        retry(error.code || "connection error"),
      );
    };
    open();
  }
}

module.exports = { EventStreamSource };
