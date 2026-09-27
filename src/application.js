"use strict";
const { validateConfig } = require("./config");
const { createServer } = require("./onvif-server");
const { createProxy } = require("./tcp-proxy");
const { MotionRouter } = require("./motion-router");
const { createEventSource } = require("./event-sources");

async function run(
  config,
  {
    debug = false,
    discovery = true,
    logger = require("simple-node-logger-se").createSimpleLogger(),
  } = {},
) {
  validateConfig(config);
  config = structuredClone(config);
  const cameras = [],
    proxies = [],
    sources = [];
  const router = new MotionRouter(cameras, logger);
  let closing;
  const close = () => (closing ??= cleanup());
  const cleanup = async () => {
    const failures = [];
    for (const source of sources) {
      try {
        source.stop();
      } catch (error) {
        failures.push(error);
      }
    }
    router.close();
    const results = await Promise.allSettled([
      ...cameras.map((camera) => camera.close()),
      ...proxies.map((proxy) => proxy.close()),
    ]);
    failures.push(
      ...results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason),
    );
    if (failures.length) throw new AggregateError(failures, "Shutdown failed");
  };
  try {
    const endpoints = new Set();
    for (const entry of config.onvif) {
      const camera = createServer(entry, logger);
      cameras.push(camera);
      if (!camera.getHostname())
        throw Error(`No local IPv4 address for MAC ${entry.mac}`);
      for (const type of ["server", "rtsp", "snapshot"]) {
        if (!entry.ports[type]) continue;
        const endpoint = `${camera.getHostname()}:${entry.ports[type]}`;
        if (endpoints.has(endpoint))
          throw Error(`Duplicate listener ${endpoint}`);
        endpoints.add(endpoint);
      }
    }
    for (const camera of cameras) {
      const entry = camera.config;
      await camera.startServer();
      if (debug) camera.enableDebugOutput();
      for (const type of ["rtsp", "snapshot"]) {
        if (!entry.ports[type]) continue;
        const proxy = createProxy(
          camera.getHostname(),
          entry.ports[type],
          type === "snapshot"
            ? (entry.target.snapshotHostname ?? entry.target.hostname)
            : entry.target.hostname,
          entry.target.ports[type],
        );
        proxies.push(proxy);
        await proxy.start();
      }
      if (discovery) await camera.startDiscovery();
      logger.info(
        `Camera ${entry.name}: ${camera.getHostname()}:${entry.ports.server}`,
      );
    }
    for (const entry of config.eventSources || []) {
      if (!cameras.some((camera) => camera.config.motion?.source === entry.id))
        continue;
      const source = createEventSource(
        entry,
        (event) => router.route(entry.id, event),
        logger,
      );
      sources.push(source);
      for (const camera of cameras)
        if (camera.config.motion?.source === entry.id)
          camera.sourceStatus = source.status;
      source.start();
    }
    return { close, cameras, sources };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Startup and cleanup failed",
      );
    }
    throw error;
  }
}
module.exports = { run };
