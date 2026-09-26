"use strict";
const fs = require("fs");
const path = require("path");
const soap = require("soap");
const ROOT = path.resolve(__dirname, "../..");
const assets = new Map();

function asset(relativePath, encoding) {
  if (!assets.has(relativePath))
    assets.set(
      relativePath,
      fs.readFileSync(path.join(ROOT, relativePath), encoding),
    );
  return assets.get(relativePath);
}
function attachService(server, services, name) {
  const filename = `wsdl/${name}_service.wsdl`;
  return new Promise((resolve, reject) =>
    soap.listen(server, {
      path: `/onvif/${name}_service`,
      services,
      xml: asset(filename, "utf8"),
      uri: path.join(ROOT, filename),
      forceSoap12Headers: true,
      callback: (error, service) => (error ? reject(error) : resolve(service)),
    }),
  );
}
function routeRequest(camera, request, response) {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname === "/snapshot.png" && camera.snapshot.path) {
    camera.snapshot.handle(request, response);
    return;
  }
  if (
    camera.events &&
    (pathname === "/onvif/events_service" ||
      pathname.startsWith("/onvif/events_service/"))
  ) {
    void camera.events.handle(request, response);
    return;
  }
  const routes = {
    "/healthz": () => [
      "application/json",
      JSON.stringify({
        camera: camera.config.name,
        motion: camera.events?.active ?? null,
        subscriptions: camera.events?.subscriptions.size ?? 0,
        source: camera.sourceStatus ?? null,
      }),
    ],
    "/snapshot.png": () => ["image/png", asset("resources/snapshot.png")],
  };
  const route = routes[pathname];
  const [contentType, body] = route
    ? route()
    : ["text/plain", "404 Not Found\n"];
  response.writeHead(route ? 200 : 404, { "Content-Type": contentType });
  response.end(body);
}
module.exports = { attachService, routeRequest, asset };
