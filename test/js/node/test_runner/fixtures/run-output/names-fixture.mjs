import test from "node:test";
import { printed } from "./texts.mjs";

test("prints", () => {
  for (const text of printed.slice(4, 8)) console.log(text);
});
test("fails", () => {
  throw new Error("after the printed names");
});
