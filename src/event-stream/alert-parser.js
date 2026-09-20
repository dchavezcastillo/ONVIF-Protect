"use strict";
const { StringDecoder } = require("string_decoder");
const { parseString, processors } = require("xml2js");
// Framing by complete XML roots ignores multipart headers and JPEG attachments.
// The buffer and each document are bounded independently of stream lifetime.
class AlertParser {
  constructor(onEvent, onError = () => {}) {
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.onEvent = onEvent;
    this.onError = onError;
  }
  feed(chunk) {
    this.buffer += this.decoder.write(chunk);
    for (;;) {
      const start = this.buffer.search(/<(?:\w+:)?EventNotificationAlert\b/);
      if (start < 0) {
        this.buffer = this.buffer.slice(-128);
        return;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      const end = /<\/(?:\w+:)?EventNotificationAlert\s*>/.exec(this.buffer);
      if (!end) {
        if (this.buffer.length > 262144) {
          this.buffer = "";
          this.onError(Error("ISAPI document too large"));
        }
        return;
      }
      const xml = this.buffer.slice(0, end.index + end[0].length);
      this.buffer = this.buffer.slice(xml.length);
      if (xml.length > 262144 || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
        this.onError(Error("Invalid ISAPI document"));
        continue;
      }
      parseString(
        xml,
        { explicitArray: false, tagNameProcessors: [processors.stripPrefix] },
        (err, result) => {
          if (err) {
            this.onError(err);
            return;
          }
          const event = result?.EventNotificationAlert;
          if (!event || !["active", "inactive"].includes(event.eventState))
            return;
          this.onEvent({
            channel: String(event.channelID ?? ""),
            dynamicChannel: String(event.dynChannelID ?? ""),
            type: event.eventType,
            active: event.eventState === "active",
          });
        },
      );
    }
  }
}

module.exports = { AlertParser };
