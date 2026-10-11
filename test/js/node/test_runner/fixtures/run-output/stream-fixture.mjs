import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";

// What a reporter of results could use, removed or changed after node:test loaded.
globalThis.JSON = undefined;
delete globalThis.TextEncoder;
Error.isError = undefined;
Object.prototype.toJSON = () => undefined;
Array.prototype.toJSON = () => "changed";

let server;
test("first", async () => {
  server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  console.log("port " + server.address().port);
});
// Ends when the script that called run() connects. It does that when it has the result of the first test.
test("second", async () => {
  const [socket] = await once(server, "connection");
  socket.destroy();
  server.close();
});
test("third", () => {
  throw new Error("after the changes");
});
