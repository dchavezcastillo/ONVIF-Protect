"use strict";
const { version } = require("../../package.json");
const VERSION = Object.freeze({ Major: 2, Minor: 5 });
const disabled = (...names) =>
  Object.fromEntries(names.map((name) => [name, false]));

function dateParts(date, utc) {
  const get = (field) => date[`get${utc ? "UTC" : ""}${field}`]();
  return {
    Time: {
      Hour: get("Hours"),
      Minute: get("Minutes"),
      Second: get("Seconds"),
    },
    Date: { Year: get("FullYear"), Month: get("Month") + 1, Day: get("Date") },
  };
}
function systemTime(now = new Date()) {
  const offset = now.getTimezoneOffset();
  const minutes = Math.abs(offset) % 60;
  const standardOffset = Math.max(
    ...[0, 6].map((month) =>
      new Date(now.getFullYear(), month, 1).getTimezoneOffset(),
    ),
  );
  return {
    SystemDateAndTime: {
      DateTimeType: "NTP",
      DaylightSavings: offset < standardOffset,
      TimeZone: {
        TZ: `UTC${offset < 0 ? "-" : "+"}${Math.floor(Math.abs(offset) / 60)}${minutes ? `:${minutes}` : ""}`,
      },
      UTCDateTime: dateParts(now, true),
      LocalDateTime: dateParts(now, false),
      Extension: {},
    },
  };
}
function deviceCapabilities(address) {
  return {
    XAddr: address,
    Network: {
      ...disabled("IPFilter", "ZeroConfiguration", "IPVersion6", "DynDNS"),
      Extension: { Dot11Configuration: false, Extension: {} },
    },
    System: {
      ...disabled(
        "DiscoveryResolve",
        "DiscoveryBye",
        "RemoteDiscovery",
        "SystemBackup",
        "SystemLogging",
        "FirmwareUpgrade",
      ),
      SupportedVersions: { ...VERSION },
      Extension: {
        ...disabled(
          "HttpFirmwareUpgrade",
          "HttpSystemBackup",
          "HttpSystemLogging",
          "HttpSupportInformation",
        ),
        Extension: {},
      },
    },
    IO: {
      InputConnectors: 0,
      RelayOutputs: 0,
      Extension: { Auxiliary: false, AuxiliaryCommands: "", Extension: {} },
    },
    Security: {
      ...disabled(
        "TLS1.1",
        "TLS1.2",
        "OnboardKeyGeneration",
        "AccessPolicyConfig",
        "X.509Token",
        "SAMLToken",
        "KerberosToken",
        "RELToken",
      ),
      Extension: {
        "TLS1.0": false,
        Extension: disabled("Dot1X", "RemoteUserHandling"),
      },
    },
    Extension: {},
  };
}
function createDeviceService(config, media, events) {
  const endpoint = (name) =>
    `http://${config.hostname}:${config.ports.server}/onvif/${name}_service`;
  const capabilities = () => ({
    Device: deviceCapabilities(endpoint("device")),
    Media: {
      XAddr: endpoint("media"),
      StreamingCapabilities: {
        RTPMulticast: false,
        RTP_TCP: true,
        RTP_RTSP_TCP: true,
        Extension: {},
      },
      Extension: {
        ProfileCapabilities: { MaximumNumberOfProfiles: media.profiles.length },
      },
    },
    ...(events
      ? {
          Events: {
            XAddr: events.base,
            WSSubscriptionPolicySupport: false,
            WSPullPointSupport: true,
            WSPausableSubscriptionManagerInterfaceSupport: false,
          },
        }
      : {}),
  });
  return {
    GetSystemDateAndTime: () => systemTime(),
    GetCapabilities: ({ Category } = {}) => {
      const requested = new Set([].concat(Category ?? "All"));
      return {
        Capabilities: Object.fromEntries(
          Object.entries(capabilities()).filter(
            ([name]) => requested.has("All") || requested.has(name),
          ),
        ),
      };
    },
    GetServices: () => ({
      Service: ["device", "media", ...(events ? ["events"] : [])].map(
        (name) => ({
          Namespace: `http://www.onvif.org/ver10/${name}/wsdl`,
          XAddr: name === "events" ? events.base : endpoint(name),
          Version: { ...VERSION },
        }),
      ),
    }),
    GetDeviceInformation: () => ({
      Manufacturer: "Onvif",
      Model: "Cardinal",
      FirmwareVersion: version,
      SerialNumber: `${config.name.replace(" ", "_")}-0000`,
      HardwareId: `${config.name.replace(" ", "_")}-1001`,
    }),
  };
}
module.exports = { createDeviceService, systemTime };
