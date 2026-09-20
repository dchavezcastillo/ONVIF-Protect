"use strict";

const SOURCE_TOKEN = "video_src_token";
const SOURCE_CONFIG_TOKEN = "video_src_config_token";
const PROFILE_DEFINITIONS = [
  {
    key: "highQuality",
    token: "main_stream",
    name: "MainStream",
    encoder: "hq",
  },
  { key: "lowQuality", token: "sub_stream", name: "SubStream", encoder: "lq" },
];
const resolution = ({ width, height }) => ({ Width: width, Height: height });
const mediaUri = (Uri) => ({
  MediaUri: {
    Uri,
    InvalidAfterConnect: false,
    InvalidAfterReboot: false,
    Timeout: "PT30S",
  },
});

function createProfile(definition, stream, source, count) {
  const { encoder, token, name } = definition;
  return {
    Name: name,
    attributes: { token },
    VideoSourceConfiguration: {
      Name: "VideoSource",
      UseCount: count,
      attributes: { token: SOURCE_CONFIG_TOKEN },
      SourceToken: SOURCE_TOKEN,
      Bounds: {
        attributes: { x: 0, y: 0, width: source.width, height: source.height },
      },
    },
    VideoEncoderConfiguration: {
      attributes: { token: `encoder_${encoder}_config_token` },
      Name:
        encoder === "hq"
          ? "CardinalHqCameraConfiguration"
          : "CardinalLqCameraConfiguration",
      UseCount: 1,
      Encoding: "H264",
      Resolution: resolution(stream),
      Quality: stream.quality,
      RateControl: {
        FrameRateLimit: stream.framerate,
        EncodingInterval: 1,
        BitrateLimit: stream.bitrate,
      },
      H264: { GovLength: stream.framerate, H264Profile: "Main" },
      SessionTimeout: "PT1000S",
    },
  };
}

function createMediaService(config) {
  const definitions = PROFILE_DEFINITIONS.filter(({ key }) => config[key]);
  const profiles = definitions.map((definition) =>
    createProfile(
      definition,
      config[definition.key],
      config.highQuality,
      definitions.length,
    ),
  );
  const videoSource = {
    attributes: { token: SOURCE_TOKEN },
    Framerate: config.highQuality.framerate,
    Resolution: resolution(config.highQuality),
  };
  const streamFor = (token) =>
    token === "sub_stream" && config.lowQuality
      ? config.lowQuality
      : config.highQuality;
  const operations = {
    GetProfiles: () => ({ Profiles: profiles }),
    GetVideoSources: () => ({ VideoSources: [videoSource] }),
    GetStreamUri: ({ ProfileToken } = {}) =>
      mediaUri(
        `rtsp://${config.hostname}:${config.ports.rtsp}${streamFor(ProfileToken).rtsp}`,
      ),
    GetSnapshotUri: ({ ProfileToken } = {}) => {
      const snapshot =
        streamFor(ProfileToken).snapshot || config.highQuality.snapshot;
      return mediaUri(
        snapshot
          ? `http://${config.hostname}:${config.ports.snapshot}${snapshot}`
          : `http://${config.hostname}:${config.ports.server}/snapshot.png`,
      );
    },
  };
  return { profiles, videoSource, operations };
}
module.exports = { createMediaService, SOURCE_TOKEN, SOURCE_CONFIG_TOKEN };
