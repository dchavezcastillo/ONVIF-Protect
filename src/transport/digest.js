"use strict";
const { createHash, randomBytes } = require("crypto");
function authorization(challenge, username, password, uri) {
  if (!/^Digest\s/i.test(challenge))
    throw Error("DVR must support HTTP Digest authentication");
  const fields = {};
  for (const m of challenge.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g))
    fields[m[1].toLowerCase()] = m[2] ?? m[3];
  const algorithm = (fields.algorithm || "MD5").toUpperCase();
  if (
    !["MD5", "MD5-SESS", "SHA-256", "SHA-256-SESS"].includes(algorithm) ||
    !fields.nonce ||
    !fields.realm
  )
    throw Error("Unsupported Digest challenge");
  const hash = (value) =>
    createHash(algorithm.startsWith("MD5") ? "md5" : "sha256")
      .update(value)
      .digest("hex");
  const cnonce = randomBytes(16).toString("hex"),
    nc = "00000001";
  const qop = fields.qop
    ? fields.qop
        .split(",")
        .map((x) => x.trim())
        .find((x) => x === "auth")
    : undefined;
  if (fields.qop && !qop) throw Error("Unsupported Digest qop");
  let ha1 = hash(`${username}:${fields.realm}:${password}`);
  if (algorithm.endsWith("-SESS"))
    ha1 = hash(`${ha1}:${fields.nonce}:${cnonce}`);
  const ha2 = hash(`GET:${uri}`);
  const response = hash(
    qop
      ? `${ha1}:${fields.nonce}:${nc}:${cnonce}:${qop}:${ha2}`
      : `${ha1}:${fields.nonce}:${ha2}`,
  );
  const quote = (value) => '"' + String(value).replace(/["\\]/g, "\\$&") + '"';
  const values = {
    username,
    realm: fields.realm,
    nonce: fields.nonce,
    uri,
    response,
  };
  if (fields.opaque) values.opaque = fields.opaque;
  let result =
    "Digest " +
    Object.entries(values)
      .map(([k, v]) => `${k}=${quote(v)}`)
      .join(", ") +
    `, algorithm=${algorithm}`;
  if (qop) result += `, qop=auth, nc=${nc}, cnonce=${quote(cnonce)}`;
  else if (algorithm.endsWith("-SESS")) result += `, cnonce=${quote(cnonce)}`;
  return result;
}

module.exports = { authorization };
