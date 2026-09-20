"use strict";

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      server.off("listening", ready);
      reject(error);
    };
    const ready = () => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", ready);
    try {
      server.listen(port, host);
    } catch (error) {
      server.off("error", failed);
      failed(error);
    }
  });
}
function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}
module.exports = { listen, closeServer };
