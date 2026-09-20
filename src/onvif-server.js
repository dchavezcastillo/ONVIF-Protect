"use strict";
const http = require("http");
const os = require("os");
const { Events } = require("./events");
const { createMediaService } = require("./onvif/media");
const { createDeviceService } = require("./onvif/device");
const { Discovery } = require("./onvif/discovery");
const { attachService, routeRequest, asset } = require("./onvif/http");
const { listen, closeServer } = require("./transport/server");

function addressForMac(mac) {
  return (
    Object.values(os.networkInterfaces())
      .flat()
      .find(
        (network) =>
          network.family === "IPv4" &&
          network.mac.toLowerCase() === mac.toLowerCase(),
      )?.address ?? null
  );
}
class OnvifServer {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    config.hostname ||= addressForMac(config.mac);
    this.events = config.motion ? new Events(this.eventAddress()) : null;
    const media = createMediaService(config);
    this.profiles = media.profiles;
    this.videoSource = media.videoSource;
    this.onvif = {
      DeviceService: {
        Device: createDeviceService(config, media, this.events),
      },
      MediaService: { Media: media.operations },
    };
    this.discovery = new Discovery(config, logger);
    this.closed = false;
  }
  eventAddress() {
    return `http://${this.config.hostname}:${this.config.ports.server}/onvif/events_service`;
  }
  getHostname() {
    return this.config.hostname;
  }
  listen(request, response) {
    routeRequest(this, request, response);
  }
  async startServer() {
    if (this.closed || this.server)
      throw Error("Camera cannot be started in its current state");
    asset("resources/snapshot.png");
    this.server = http.createServer(this.listen.bind(this));
    Object.assign(this.server, {
      requestTimeout: 15000,
      headersTimeout: 10000,
      maxConnections: 256,
    });
    try {
      this.deviceService = await attachService(
        this.server,
        this.onvif,
        "device",
      );
      this.mediaService = await attachService(this.server, this.onvif, "media");
      await listen(this.server, this.config.ports.server, this.config.hostname);
      this.config.ports.server = this.server.address().port;
      if (this.events) this.events.base = this.eventAddress();
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async startDiscovery() {
    if (this.closed) throw Error("Camera is closed");
    await this.discovery.start();
  }
  enableDebugOutput() {
    if (this.debugEnabled) return;
    this.debugEnabled = true;
    for (const name of ["device", "media"]) {
      this[`${name}Service`].on("request", (_, operation) =>
        this.logger.debug(`${name}: ${operation}`),
      );
    }
  }
  close() {
    if (!this.closing) {
      this.closed = true;
      this.events?.close();
      this.closing = Promise.all([
        this.discovery.close(),
        closeServer(this.server),
      ]).then(() => undefined);
    }
    return this.closing;
  }
}
module.exports = {
  createServer: (config, logger) => new OnvifServer(config, logger),
};
