"use strict";
const soap = require("soap");
const { randomUUID } = require("crypto");
const path = require("path");
const REQUEST_OPTIONS = Object.freeze({ timeout: 15000 });
const STREAM_SETUP = Object.freeze({
  Stream: "RTP-Unicast",
  Transport: { Protocol: "RTSP" },
});
const area = (profile) => {
  const { Width, Height } = profile.VideoEncoderConfiguration.Resolution;
  return Width * Height;
};
const pathOf = (uri) => {
  const url = new URL(uri);
  return url.pathname + url.search;
};

async function connectService(name, endpoint, credentials) {
  const client = await soap.createClientAsync(
    path.join(__dirname, `../wsdl/${name}_service.wsdl`),
    {
      forceSoap12Headers: true,
      wsdl_options: REQUEST_OPTIONS,
    },
  );
  client.setEndpoint(endpoint);
  client.setSecurity(
    new soap.WSSecurity(credentials.username, credentials.password, {
      hasNonce: true,
      passwordType: "PasswordDigest",
    }),
  );
  return client;
}
async function discoverMediaEndpoint(device, fallback) {
  try {
    const [result] = await device.GetCapabilitiesAsync(
      { Category: "Media" },
      REQUEST_OPTIONS,
    );
    return result.Capabilities?.Media?.XAddr || fallback;
  } catch {
    // Some recorders accept Media operations at their Device endpoint.
    return fallback;
  }
}
async function collectProfiles(client) {
  const [result] = await client.GetProfilesAsync({}, REQUEST_OPTIONS);
  const groups = new Map();
  for (const profile of result.Profiles || []) {
    if (!profile.VideoSourceConfiguration || !profile.VideoEncoderConfiguration)
      continue;
    const ProfileToken = profile.attributes.token;
    const [stream] = await client.GetStreamUriAsync(
      { StreamSetup: STREAM_SETUP, ProfileToken },
      REQUEST_OPTIONS,
    );
    let snapshotUri;
    try {
      const [snapshot] = await client.GetSnapshotUriAsync(
        { ProfileToken },
        REQUEST_OPTIONS,
      );
      snapshotUri = snapshot.MediaUri?.Uri;
    } catch {
      /* A snapshot endpoint is optional. */
    }
    const source = profile.VideoSourceConfiguration.SourceToken;
    if (!groups.has(source)) groups.set(source, []);
    groups
      .get(source)
      .push({ ...profile, streamUri: stream.MediaUri.Uri, snapshotUri });
  }
  if (!groups.size)
    throw Error("No usable video profiles returned by the device");
  return [...groups.values()];
}
function destinations(profiles) {
  const stream = new URL(profiles[0].streamUri);
  const snapshotProfile = profiles.find((profile) => profile.snapshotUri);
  const snapshot = snapshotProfile
    ? new URL(snapshotProfile.snapshotUri)
    : null;
  if (
    stream.protocol !== "rtsp:" ||
    (snapshot && snapshot.protocol !== "http:")
  )
    throw Error(
      "Config generator supports RTSP and HTTP snapshots; HTTPS snapshots require an external proxy",
    );
  for (const profile of profiles) {
    const url = new URL(profile.streamUri);
    if (
      url.protocol !== "rtsp:" ||
      url.hostname !== stream.hostname ||
      (url.port || "554") !== (stream.port || "554")
    )
      throw Error(
        "Profiles use different RTSP destinations; configure separate virtual cameras manually",
      );
    if (!profile.snapshotUri) continue;
    const image = new URL(profile.snapshotUri);
    if (
      image.protocol !== "http:" ||
      image.hostname !== stream.hostname ||
      (image.port || "80") !== (snapshot.port || "80")
    )
      throw Error(
        "Snapshot and stream destinations differ; configure an external proxy",
      );
  }
  return { stream, snapshot };
}
function streamSettings(profile, quality) {
  const encoder = profile.VideoEncoderConfiguration;
  return {
    rtsp: pathOf(profile.streamUri),
    ...(profile.snapshotUri ? { snapshot: pathOf(profile.snapshotUri) } : {}),
    width: encoder.Resolution.Width,
    height: encoder.Resolution.Height,
    framerate: encoder.RateControl.FrameRateLimit,
    bitrate: encoder.RateControl.BitrateLimit,
    quality,
  };
}
function cameraSettings(group, index, origin) {
  const profiles = [...group].sort((left, right) => area(right) - area(left));
  const main = profiles[0];
  const { stream, snapshot } = destinations(profiles);
  return {
    mac: "<ONVIF PROXY MAC ADDRESS HERE>",
    ports: { server: 8081 + index, rtsp: 8554, snapshot: 8580 },
    name: main.VideoSourceConfiguration.Name,
    uuid: randomUUID(),
    highQuality: streamSettings(main, 4),
    lowQuality: streamSettings(profiles.at(-1), 1),
    target: {
      hostname: stream.hostname,
      ports: {
        rtsp: Number(stream.port || 554),
        snapshot: Number(snapshot ? snapshot.port || 80 : origin.port || 80),
      },
    },
  };
}
async function createConfig(hostname, username, password) {
  const origin = new URL(`http://${hostname}`);
  const credentials = { username, password };
  const endpoint = `${origin.origin}/onvif/device_service`;
  const device = await connectService("device", endpoint, credentials);
  const media = await connectService(
    "media",
    await discoverMediaEndpoint(device, endpoint),
    credentials,
  );
  const groups = await collectProfiles(media);
  return {
    onvif: groups.map((group, index) => cameraSettings(group, index, origin)),
  };
}
module.exports = { createConfig };
