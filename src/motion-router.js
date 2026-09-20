"use strict";
function matches(motion, sourceId, event) {
  if (!motion || motion.source !== sourceId) return false;
  const channel =
    motion.channelField === "dynChannelID"
      ? event.dynamicChannel
      : event.channel;
  return (
    String(motion.channel) === channel &&
    (motion.eventTypes || ["VMD"]).includes(event.type)
  );
}
class MotionRouter {
  constructor(cameras, logger) {
    this.cameras = cameras;
    this.logger = logger;
    this.timers = new Map();
    this.closed = false;
  }
  route(sourceId, event) {
    if (this.closed) return;
    for (const camera of this.cameras) {
      if (!matches(camera.config.motion, sourceId, event)) continue;
      this.cancelReset(camera);
      camera.events.setMotion(event.active);
      this.logger.debug(`Motion ${camera.config.name}: ${event.active}`);
      const timeout = camera.config.motion.resetAfterMs ?? 30000;
      if (event.active && timeout > 0) this.scheduleReset(camera, timeout);
    }
  }
  cancelReset(camera) {
    clearTimeout(this.timers.get(camera));
    this.timers.delete(camera);
  }
  scheduleReset(camera, timeout) {
    const timer = setTimeout(() => {
      camera.events.setMotion(false);
      this.timers.delete(camera);
    }, timeout);
    timer.unref();
    this.timers.set(camera, timer);
  }
  close() {
    this.closed = true;
    for (const camera of this.timers.keys()) this.cancelReset(camera);
  }
}
module.exports = { MotionRouter };
