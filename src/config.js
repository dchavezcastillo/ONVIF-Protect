"use strict";
const fs = require("fs");
const net = require("net");
const yaml = require("yaml");
const { supportsEventSource } = require("./event-sources");
const { credentialsFor } = require("./credentials");
const MAC = /^(?:[a-f\d]{2}:){5}[a-f\d]{2}$/i;
const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const fail = (message) => {
  throw Error(`Configuration: ${message}`);
};
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isPath = (value) => typeof value === "string" && value.startsWith("/");
function port(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    fail(`invalid port ${label}`);
}
function unique(value, seen, label) {
  if (seen.has(value)) fail(`duplicate ${label}`);
  seen.add(value);
}
function validateSources(entries = [], checkSecrets) {
  if (!Array.isArray(entries)) fail("eventSources must be a list");
  const sources = new Map();
  for (const source of entries) {
    if (
      !isRecord(source) ||
      typeof source.id !== "string" ||
      !source.id ||
      sources.has(source.id)
    )
      fail("eventSources require unique id");
    if (!supportsEventSource(source.type ?? undefined))
      fail(`unsupported event source type: ${source.type}`);
    let url;
    try {
      url = new URL(source.url);
    } catch {
      fail(`invalid URL for ${source.id}`);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      fail("event URL must use HTTP(S) without embedded credentials");
    if (checkSecrets) {
      for (const [field, value] of Object.entries(credentialsFor(source))) {
        if (typeof value !== "string" || !value)
          fail(`missing ${field} or ${field}Env for ${source.id}`);
        if (/[\r\n]/.test(value)) fail(`invalid ${field} for ${source.id}`);
      }
    }
    if (
      source.idleTimeoutMs !== undefined &&
      (!Number.isInteger(source.idleTimeoutMs) || source.idleTimeoutMs < 1000)
    )
      fail("idleTimeoutMs must be >=1000");
    sources.set(source.id, source);
  }
  return sources;
}
function validateProfile(profile, label) {
  if (!isRecord(profile) || !isPath(profile.rtsp))
    fail(`invalid ${label}.rtsp`);
  for (const field of ["width", "height", "framerate", "bitrate", "quality"]) {
    if (!Number.isFinite(profile[field]) || profile[field] <= 0)
      fail(`invalid ${label}.${field}`);
  }
  if (profile.snapshot && !isPath(profile.snapshot))
    fail("snapshot must be a path");
}
function validateMotion(motion, sources, name) {
  if (!isRecord(motion) || !sources.has(motion.source))
    fail(`unknown motion source for ${name}`);
  if (!/^\d+$/.test(String(motion.channel)) || Number(motion.channel) < 1)
    fail("motion.channel must be a positive channel ID");
  if (
    motion.channelField &&
    !["channelID", "dynChannelID"].includes(motion.channelField)
  )
    fail("invalid motion.channelField");
  if (
    motion.resetAfterMs !== undefined &&
    (!Number.isInteger(motion.resetAfterMs) || motion.resetAfterMs < 0)
  )
    fail("invalid resetAfterMs");
  if (
    motion.eventTypes &&
    (!Array.isArray(motion.eventTypes) ||
      !motion.eventTypes.length ||
      motion.eventTypes.some((type) => typeof type !== "string" || !type))
  )
    fail("invalid eventTypes");
}
function validateCamera(camera, sources, identities) {
  if (
    !isRecord(camera) ||
    typeof camera.name !== "string" ||
    !camera.name.trim()
  )
    fail("camera name is required");
  if (!MAC.test(camera.mac)) fail(`invalid MAC for ${camera.name}`);
  if (!UUID.test(camera.uuid)) fail(`invalid UUID for ${camera.name}`);
  unique(camera.mac.toLowerCase(), identities.macs, `MAC ${camera.mac}`);
  unique(camera.uuid.toLowerCase(), identities.uuids, "UUID");
  if (camera.hostname && net.isIP(camera.hostname) !== 4)
    fail("hostname must be a local IPv4 address");
  if (
    !isRecord(camera.target) ||
    typeof camera.target.hostname !== "string" ||
    !/^[a-z\d._-]+$/i.test(camera.target.hostname)
  )
    fail(`invalid target for ${camera.name}`);
  for (const kind of ["server", "rtsp"])
    port(camera.ports?.[kind], `${camera.name}.${kind}`);
  port(camera.target.ports?.rtsp, `${camera.name}.target.rtsp`);
  validateProfile(camera.highQuality, `${camera.name}.highQuality`);
  if (camera.lowQuality)
    validateProfile(camera.lowQuality, `${camera.name}.lowQuality`);
  const needsSnapshot =
    camera.highQuality.snapshot ||
    camera.lowQuality?.snapshot ||
    camera.ports.snapshot ||
    camera.target.ports.snapshot;
  if (needsSnapshot) {
    port(camera.ports.snapshot, "snapshot");
    port(camera.target.ports.snapshot, "target.snapshot");
  }
  if (camera.motion) validateMotion(camera.motion, sources, camera.name);
}
function validateConfig(config, { checkSecrets = true } = {}) {
  if (!Array.isArray(config?.onvif) || !config.onvif.length)
    fail("onvif must be a nonempty list");
  const sources = validateSources(config.eventSources, checkSecrets);
  const identities = { macs: new Set(), uuids: new Set() };
  for (const camera of config.onvif)
    validateCamera(camera, sources, identities);
  return config;
}
function readConfig(filename, options) {
  return validateConfig(yaml.parse(fs.readFileSync(filename, "utf8")), options);
}
module.exports = { validateConfig, readConfig };
