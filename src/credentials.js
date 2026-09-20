"use strict";
function credentialsFor(config, environment = process.env) {
  return Object.fromEntries(
    ["username", "password"].map((field) => [
      field,
      config[`${field}Env`]
        ? environment[config[`${field}Env`]]
        : config[field],
    ]),
  );
}
module.exports = { credentialsFor };
