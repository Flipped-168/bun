import assert from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import test from "node:test";
import { isStringOneByteRepresentation } from "node:v8";
import { printed } from "./texts.mjs";

// One byte per character where the text allows it. The writers then get the
// bytes 0xFF and 0xFE of a frame as the characters of a string.
const texts = printed.map(text =>
  /^[\x00-\xff]*$/.test(text) ? Buffer.from(text, "latin1").toString("latin1") : text,
);

test("console.log", () => {
  assert.ok(isStringOneByteRepresentation(texts[9]));
  for (const text of texts) console.log(text);
});
test("process.stdout.write", () => {
  for (const text of texts) process.stdout.write(text + "\n");
});
test("fs.writeSync", () => {
  for (const text of texts) fs.writeSync(1, text + "\n");
});
test("a child process", async () => {
  const script = "import('./texts.mjs').then(({ printed }) => { for (const text of printed) console.log(text); })";
  const [code] = await once(spawn(process.execPath, ["-e", script], { stdio: "inherit" }), "exit");
  assert.strictEqual(code, 0);
});
test("an open line", () => {
  process.stdout.write("open: " + texts[0]);
});
test("fails", () => {
  assert.strictEqual(1, 2);
});
test("f\u00e4ils \u00ff\u00fe", () => {
  throw new Error("m\u00e9ssage \u00ff\u00fe end");
});
test("fails \u{1f600}", () => {
  throw new Error("h\u00e9llo \u{1f600}");
});
test("passes", () => {});
