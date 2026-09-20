"use strict";
// Compatibility exports for existing programmatic consumers.
module.exports = {
  ...require("./transport/digest"),
  ...require("./event-stream/alert-parser"),
  HikvisionSource: require("./event-stream/source").EventStreamSource,
  ...require("./motion-router"),
};
