"use strict";
const net = require("net");
const { listen, closeServer } = require("./transport/server");
function createProxy(host, port, targetHost, targetPort) {
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: targetHost, port: targetPort });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.setKeepAlive(true, 30000);
      socket.setNoDelay(true);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    const timeout = setTimeout(() => {
      client.destroy();
      upstream.destroy();
    }, 10000);
    upstream.once("connect", () => clearTimeout(timeout));
    upstream.once("close", () => clearTimeout(timeout));
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.maxConnections = 128;
  let closing;
  return {
    start: () => {
      if (closing) return Promise.reject(Error("Proxy is closed"));
      return listen(server, port, host);
    },
    close: () =>
      (closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await closeServer(server);
      })()),
  };
}
module.exports = { createProxy };
