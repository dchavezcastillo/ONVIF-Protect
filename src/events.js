"use strict";
const { parseXml, escapeXml, textValue } = require("./transport/xml");
const { Subscriptions } = require("./onvif/subscriptions");
const wire = require("./onvif/event-xml");
const SUBSCRIPTION_OPERATIONS = new Set([
  "PullMessages",
  "Renew",
  "Unsubscribe",
  "SetSynchronizationPoint",
]);
const iso = (value) => new Date(value ?? Date.now()).toISOString();
const times = (subscription) =>
  `<tev:CurrentTime>${iso()}</tev:CurrentTime><tev:TerminationTime>${iso(subscription.expires)}</tev:TerminationTime>`;

function validateFilter(filter) {
  if (!filter) return;
  const expression = textValue(filter.TopicExpression);
  if (
    filter.MessageContent ||
    typeof expression !== "string" ||
    !/^\w+:RuleEngine\/CellMotionDetector\/Motion$/.test(expression.trim())
  )
    throw Error("Unsupported filter");
}
function responseAction(operation) {
  if (["Renew", "Unsubscribe"].includes(operation))
    return `http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/${operation}Response`;
  return `${wire.NS}/${SUBSCRIPTION_OPERATIONS.has(operation) ? "PullPointSubscription" : "EventPortType"}/${operation}Response`;
}
async function readRequest(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65536) throw Error("Request too large");
    chunks.push(chunk);
  }
  const { Envelope } = await parseXml(Buffer.concat(chunks).toString("utf8"));
  const operations = Object.keys(Envelope?.Body || {}).filter(
    (key) => key !== "$",
  );
  if (operations.length !== 1) throw Error("Expected one SOAP operation");
  const operation = operations[0];
  return {
    operation,
    args: Envelope.Body[operation] || {},
    messageId: textValue(Envelope.Header?.MessageID),
  };
}

class Events {
  constructor(base) {
    this.base = base;
    this.store = new Subscriptions();
  }
  get active() {
    return this.store.active;
  }
  get subscriptions() {
    return this.store.entries;
  }
  setMotion(active) {
    this.store.setMotion(active);
  }
  close() {
    this.store.close();
  }
  notification(event) {
    return wire.notification(this.base, event);
  }
  async dispatch(operation, args, id, response) {
    if (SUBSCRIPTION_OPERATIONS.has(operation)) this.store.require(id);
    switch (operation) {
      case "GetServiceCapabilities":
        return wire.capabilities;
      case "GetEventProperties":
        return wire.properties;
      case "CreatePullPointSubscription": {
        validateFilter(args.Filter);
        const { id, subscription } = this.store.create(
          args.InitialTerminationTime,
        );
        return `<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa:Address>${escapeXml(this.base)}/${id}</wsa:Address></tev:SubscriptionReference><wsnt:CurrentTime>${iso()}</wsnt:CurrentTime><wsnt:TerminationTime>${iso(subscription.expires)}</wsnt:TerminationTime></tev:CreatePullPointSubscriptionResponse>`;
      }
      case "PullMessages": {
        const { subscription, messages } = await this.store.pull(
          id,
          args,
          response,
        );
        return `<tev:PullMessagesResponse>${times(subscription)}${messages.map((event) => this.notification(event)).join("")}</tev:PullMessagesResponse>`;
      }
      case "Renew": {
        const subscription = this.store.renew(id, args.TerminationTime);
        return `<wsnt:RenewResponse><wsnt:TerminationTime>${iso(subscription.expires)}</wsnt:TerminationTime><wsnt:CurrentTime>${iso()}</wsnt:CurrentTime></wsnt:RenewResponse>`;
      }
      case "Unsubscribe":
        this.store.remove(id);
        return "<wsnt:UnsubscribeResponse/>";
      case "SetSynchronizationPoint":
        this.store.enqueue(this.store.require(id), true);
        return "<tev:SetSynchronizationPointResponse/>";
      default:
        throw Error("Unsupported operation");
    }
  }
  async handle(request, response) {
    let messageId;
    const reply = (body, action, status = 200) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, {
        "Content-Type": "application/soap+xml; charset=utf-8",
      });
      response.end(wire.envelope(body, action, messageId));
    };
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" });
      response.end();
      return;
    }
    try {
      const parsed = await readRequest(request);
      messageId = parsed.messageId;
      const pathname = new URL(request.url, "http://localhost").pathname;
      const match = /^\/onvif\/events_service(?:\/([^/]+))?$/.exec(pathname);
      if (
        !match ||
        (!SUBSCRIPTION_OPERATIONS.has(parsed.operation) && match[1])
      )
        throw Error("Invalid endpoint");
      const body = await this.dispatch(
        parsed.operation,
        parsed.args,
        match[1],
        response,
      );
      reply(body, responseAction(parsed.operation));
    } catch (error) {
      reply(
        `<s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text xml:lang="en">${escapeXml(error.message)}</s:Text></s:Reason></s:Fault>`,
        "http://www.w3.org/2005/08/addressing/fault",
        500,
      );
    }
  }
}
module.exports = {
  Events,
  esc: escapeXml,
  duration: require("./onvif/duration").duration,
};
