"use strict";
const { parseStringPromise, processors } = require("xml2js");
const ENTITIES = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&apos;",
};
const escapeXml = (value) =>
  String(value).replace(/[<>&"']/g, (character) => ENTITIES[character]);
const textValue = (value) => (typeof value === "object" ? value?._ : value);
function parseXml(document) {
  if (/<!DOCTYPE|<!ENTITY/i.test(document)) throw Error("Unsupported XML");
  return parseStringPromise(document, {
    explicitArray: false,
    tagNameProcessors: [processors.stripPrefix],
  });
}
module.exports = { escapeXml, parseXml, textValue };
