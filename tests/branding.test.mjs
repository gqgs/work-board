import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

test("favicon assets are local and the SVG is the verified public wiki original", async () => {
  const html = await readFile(new URL("../docs/index.html", import.meta.url), "utf8");
  assert.match(html, /<link rel="icon" href="\.\/assets\/eigendynamics-icon\.png" type="image\/png" sizes="192x192">/);
  assert.match(html, /<link rel="icon" href="\.\/assets\/eigendynamics-icon\.svg" type="image\/svg\+xml" sizes="any">/);
  const svg = await readFile(new URL("../docs/assets/eigendynamics-icon.svg", import.meta.url));
  assert.equal(createHash("sha256").update(svg).digest("hex"), "93df555c555040ec7c14bb538e2e2a972cae23a92b134fafc7706b640d46ba84");
  assert.doesNotMatch(svg.toString(), /<script|<image|\bhref=|url\(/i);
  const png = await readFile(new URL("../docs/assets/eigendynamics-icon.png", import.meta.url));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.subarray(12, 16).toString(), "IHDR");
  assert.equal(png.readUInt32BE(16), 192);
  assert.equal(png.readUInt32BE(20), 192);
  assert.equal(png[25], 6, "PNG is RGBA");
});
