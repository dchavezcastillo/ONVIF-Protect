"use strict";
const argparse = require("argparse");
const readline = require("readline");
const stream = require("stream");
const yaml = require("yaml");
const { readConfig } = require("./config");
const { run } = require("./application");
const logger = require("simple-node-logger-se").createSimpleLogger();

async function interactiveConfig() {
  const output = new stream.Writable({
    write(chunk, encoding, callback) {
      if (!this.muted || chunk.toString().includes("\n"))
        process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  const ask = (question) =>
    new Promise((resolve) => rl.question(question, resolve));
  try {
    const hostname = await ask("Onvif Server (host:port): ");
    const username = await ask("Onvif Username: ");
    output.muted = true;
    process.stdout.write("Onvif Password: ");
    const password = await ask("");
    output.muted = false;
    const config = await require("./config-builder").createConfig(
      hostname,
      username,
      password,
    );
    console.log(yaml.stringify(config));
  } finally {
    rl.close();
  }
}
async function main(argv = process.argv.slice(2)) {
  const parser = new argparse.ArgumentParser({
    description:
      "Virtual ONVIF cameras for RTSP sources with optional motion adapters",
  });
  parser.add_argument("-v", "--version", { action: "store_true" });
  parser.add_argument("-cc", "--create-config", { action: "store_true" });
  parser.add_argument("-d", "--debug", { action: "store_true" });
  parser.add_argument("--check-config", {
    action: "store_true",
    help: "Validate YAML and event credentials without opening network listeners",
  });
  parser.add_argument("config", { nargs: "?" });
  const args = parser.parse_args(argv);
  if (args.version) {
    console.log(require("../package.json").version);
    return;
  }
  if (args.create_config) {
    await interactiveConfig();
    return;
  }
  if (!args.config) throw Error("Specify a configuration filename");
  const config = readConfig(args.config);
  if (args.check_config) {
    console.log(`Configuration valid: ${config.onvif.length} cameras`);
    return;
  }
  if (args.debug) logger.setLevel("debug");
  const app = await run(config, { debug: args.debug, logger });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
    } catch (error) {
      logger.error(error.message);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
module.exports = { main };
