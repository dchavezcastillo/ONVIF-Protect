"use strict";
const dgram = require("dgram");
const { randomUUID } = require("crypto");
const { parseXml, escapeXml, textValue } = require("../transport/xml");
const MULTICAST_ADDRESS = "239.255.255.250";
const DISCOVERY_PORT = 3702;

class Discovery {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.sequence = 0;
    this.instance = Math.floor(Date.now() / 1000);
    this.socket = null;
  }
  async start() {
    if (this.socket) throw Error("Discovery already started");
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;
    socket.on("error", (error) =>
      this.logger.error(
        `Discovery ${this.config.name}: ${error.code || error.message}`,
      ),
    );
    socket.on("message", (packet, remote) => void this.respond(packet, remote));
    try {
      await new Promise((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(DISCOVERY_PORT, () => {
          try {
            socket.addMembership(MULTICAST_ADDRESS, this.config.hostname);
            socket.setMulticastInterface(this.config.hostname);
            socket.off("error", reject);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async respond(packet, remote) {
    if (packet.length > 16384) return;
    let envelope;
    try {
      envelope = (await parseXml(packet.toString())).Envelope;
    } catch {
      return;
    }
    const probe = envelope?.Body?.Probe;
    const messageId = textValue(envelope?.Header?.MessageID);
    const types = textValue(probe?.Types) || "";
    if (
      probe === undefined ||
      typeof messageId !== "string" ||
      typeof types !== "string"
    )
      return;
    if (
      types &&
      !types
        .split(/\s+/)
        .some((type) => type.split(":").at(-1) === "NetworkVideoTransmitter")
    )
      return;
    const socket = this.socket;
    if (!socket) return;
    this.logger.debug(
      `Discovery ${this.config.name}: ${remote.address}:${remote.port}`,
    );
    const address = `http://${this.config.hostname}:${this.config.ports.server}/onvif/device_service`;
    const response = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
      <s:Header><a:MessageID>urn:uuid:${randomUUID()}</a:MessageID><a:RelatesTo>${escapeXml(messageId)}</a:RelatesTo>
      <a:To s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:To>
      <a:Action s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</a:Action>
      <d:AppSequence s:mustUnderstand="true" InstanceId="${this.instance}" MessageNumber="${++this.sequence}"/></s:Header>
      <s:Body><d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>urn:uuid:${escapeXml(this.config.uuid)}</a:Address></a:EndpointReference>
      <d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/hardware/Onvif onvif://www.onvif.org/name/Cardinal onvif://www.onvif.org/location/</d:Scopes>
      <d:XAddrs>${escapeXml(address)}</d:XAddrs><d:MetadataVersion>1</d:MetadataVersion></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>`;
    socket.send(Buffer.from(response), remote.port, remote.address, (error) => {
      if (error) this.logger.warn(`Discovery send: ${error.code}`);
    });
  }
  close() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        socket.close(resolve);
      } catch {
        resolve();
      }
    });
  }
}
module.exports = { Discovery };
