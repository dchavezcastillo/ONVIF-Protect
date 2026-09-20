"use strict";
function duration(value, fallback, max) {
  if (value === undefined) return fallback;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  const ms = m
    ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) throw Error("Invalid duration");
  return Math.min(ms, max);
}
module.exports = { duration };
