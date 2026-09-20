"use strict";
const { randomUUID } = require("crypto");
const { duration } = require("./duration");
const MAX_SUBSCRIPTIONS = 32;
const MAX_QUEUE = 256;

class Subscriptions {
  constructor() {
    this.active = false;
    this.entries = new Map();
    this.sweeper = setInterval(() => this.expire(), 1000);
    this.sweeper.unref();
    this.closed = false;
  }
  expire() {
    for (const [id, subscription] of this.entries) {
      if (subscription.expires <= Date.now()) this.remove(id);
    }
  }
  require(id) {
    this.expire();
    const subscription = this.entries.get(id);
    if (!subscription) throw Error("Unknown or expired subscription");
    return subscription;
  }
  remove(id) {
    const subscription = this.entries.get(id);
    this.entries.delete(id);
    subscription?.wake?.();
  }
  close() {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const id of this.entries.keys()) this.remove(id);
  }
  enqueue(subscription, initialized = false) {
    subscription.queue.push({
      active: this.active,
      time: new Date().toISOString(),
      initialized,
    });
    if (subscription.queue.length > MAX_QUEUE)
      subscription.queue.splice(0, subscription.queue.length - MAX_QUEUE);
    subscription.wake?.();
  }
  setMotion(active) {
    if (this.closed || this.active === active) return;
    this.active = active;
    this.expire();
    for (const subscription of this.entries.values())
      this.enqueue(subscription);
  }
  create(termination) {
    if (this.closed) throw Error("Events service is closed");
    this.expire();
    if (this.entries.size >= MAX_SUBSCRIPTIONS)
      throw Error("Subscription limit reached");
    const id = randomUUID();
    const subscription = { expires: this.deadline(termination), queue: [] };
    this.entries.set(id, subscription);
    this.enqueue(subscription, true);
    return { id, subscription };
  }
  deadline(value) {
    return Date.now() + duration(value, 60000, 3600000);
  }
  renew(id, termination) {
    const subscription = this.require(id);
    subscription.expires = this.deadline(termination);
    return subscription;
  }
  async pull(id, args, response) {
    const subscription = this.require(id);
    const limit = Number(args.MessageLimit);
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw Error("MessageLimit must be a positive integer");
    if (subscription.wake)
      throw Error("Concurrent PullMessages is unsupported");
    const timeout = Math.min(
      duration(args.Timeout, 60000, 60000),
      subscription.expires - Date.now(),
    );
    if (!subscription.queue.length && timeout > 0 && !response.destroyed) {
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          response.off("close", finish);
          subscription.wake = null;
          resolve();
        };
        const timer = setTimeout(finish, timeout);
        subscription.wake = finish;
        response.once("close", finish);
      });
    }
    this.require(id);
    return {
      subscription,
      messages: response.destroyed
        ? []
        : subscription.queue.splice(0, Math.min(limit, MAX_QUEUE)),
    };
  }
}
module.exports = { Subscriptions };
