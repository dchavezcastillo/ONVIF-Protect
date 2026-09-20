#!/usr/bin/env node
"use strict";
if (require.main === module) {
  require("./src/cli")
    .main()
    .catch((error) => {
      console.error(error.message || String(error));
      process.exitCode = 1;
    });
}
module.exports = { run: require("./src/application").run };
