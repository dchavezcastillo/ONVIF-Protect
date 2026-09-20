"use strict";
const DEFAULT_TYPE = "hikvision-isapi";
const adapters = new Map([
  [DEFAULT_TYPE, () => require("./event-stream/source").EventStreamSource],
]);
function supportsEventSource(type = DEFAULT_TYPE) {
  return adapters.has(type);
}
function createEventSource(config, onEvent, logger) {
  const type = config.type ?? DEFAULT_TYPE;
  const load = adapters.get(type);
  if (!load) throw Error(`Unsupported event source type: ${type}`);
  const Source = load();
  return new Source(config, onEvent, logger);
}
module.exports = { createEventSource, supportsEventSource };
