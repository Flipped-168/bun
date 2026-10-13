import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { join } from "node:path";

const fixture = join(import.meta.dir, "prepare-stack-trace-fixture.js");

// What Node.js v26.3.0 prints for each scenario of the fixture. "default" is the engine's own format.
// These are the ways to write the property, each one the first touch in a new realm.
const expected = {
  "assign": "ONE",
  "delete after assign": ["ONE", ["undefined", "default"], "TWO"],
  "delete first": ["default", "ONE"],
  "accessor": ["GETTER", "SETTER", "callsites"],
  "__defineGetter__": "GETTER",
  "define value": "DEFINED",
  "define value, not writable": "DEFINED",
  "define enumerable only": [[true, true, "default"], "ONE"],
  "Reflect.defineProperty": "DEFINED",
  "Object.defineProperties": "DEFINED",
  "Object.assign": "ASSIGNED",
  "Reflect.set": "SET",
  "Object.seal, then assign": ["default", "ONE"],
  "Object.freeze, then assign": ["default", "default"],
  "not callable": ["default", "default", "default", "default", "default"],
  "assign, then restore the first value": ["ONE", true, "default"],
  "assign the first value back": "default",
  "inherited from Function.prototype": ["INHERITED", "REPLACED"],
  "inherited from a new prototype": "INHERITED",
  "a formatter that deletes itself": ["ONCE", "default"],
  "a formatter that installs another": ["FIRST", "SECOND"],
  "a getter that reads another stack": ["GETTER", "default"],
  "a getter that throws": "getter threw",
  "other properties first": ["default", "ONE"],
};

// The formatter remembers where the property is on the constructor's Structure. These leave that
// Structure in dictionary mode, collected, or with its address in use again.
const expectedWithRememberedLocation = {
  "seventy delete and assign cycles": ["CYCLE 69", "default", "ASSIGNED", "GETTER", "DEFINED", "default"],
  "collections between writes that move the property":
    "default, default, ASSIGNED 2, GETTER 3, ASSIGNED 4, ASSIGNED 4, default, default, ASSIGNED 8, GETTER 9, ASSIGNED 10, ASSIGNED 10, default, default, ASSIGNED 14, GETTER 15, ASSIGNED 16, ASSIGNED 16",
  "a seeded walk of writes, prototype changes and collections":
    "default x2, C0 x3, default x2, P1, G2 x6, C4 x2, D5 x2, C6 x4, C7, A8 x4, G10 x6, C11 x3, G12 x2, P3 x3, G14 x11, D18, G19 x3, G21 x4",
};

// These call the default formatter, which the Error of a node:vm context does not have.
const expectedWithTheDefaultFormatter = {
  "error-callsites, then depd": ["callsites", "Error", "Inherits: not an Error instance", "default", "callsites"],
  "the default formatter with an object that is not an Error": [
    "Error",
    "Named: with a message",
    "TypeError",
    "TypeError",
  ],
};

async function run(...cmd: string[]) {
  await using proc = Bun.spawn({ cmd: [bunExe(), ...cmd], env: bunEnv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  return { stdout: stdout.trim(), stderr, exitCode, signalCode: proc.signalCode };
}

// The JSON a fixture printed, or what it printed instead.
async function runForJSON(...cmd: string[]) {
  const { stdout, stderr, exitCode } = await run(...cmd);
  let result: unknown = { stdout, stderr };
  try {
    result = JSON.parse(stdout);
  } catch {}
  return { result, exitCode };
}

const runFixture = (...args: string[]) => runForJSON(fixture, ...args);

describe("Error.prepareStackTrace is read from the Error constructor when a stack is formatted", () => {
  // One process for each. The write forms not listed here run in a ShadowRealm below,
  // which has the same kind of global object as the main realm.
  const inTheMainRealm = {
    "delete after assign": expected["delete after assign"],
    "accessor": expected["accessor"],
    ...expectedWithTheDefaultFormatter,
  };
  test.concurrent.each(Object.entries(inTheMainRealm))("%s", async (scenario, result) => {
    expect(await runFixture("main", scenario)).toEqual({ result, exitCode: 0 });
  });

  // The rest run alone: full collections, many realms and a Worker take seconds in a debug
  // build, and more when other processes compete for the cores.
  test.each(Object.entries(expectedWithRememberedLocation))("%s", async (scenario, result) => {
    expect(await runFixture("main", scenario)).toEqual({ result, exitCode: 0 });
  });

  test("each write form in a fresh ShadowRealm", async () => {
    expect(await runFixture("ShadowRealm", ...Object.keys(expected))).toEqual({ result: expected, exitCode: 0 });
  });

  test("in a fresh node:vm context", async () => {
    // The Error of a node:vm context starts without the property.
    const scenarios = [
      ...["assign", "delete after assign", "delete first", "accessor", "define value", "not callable"],
      ...["inherited from Function.prototype", "a formatter that deletes itself"],
      ...["a getter that reads another stack", "a getter that throws"],
    ];
    expect(await runFixture("node:vm", ...scenarios)).toEqual({
      result: Object.fromEntries(scenarios.map(scenario => [scenario, expected[scenario]])),
      exitCode: 0,
    });
  });

  test("in a Worker", async () => {
    const scenarios = ["delete after assign", "accessor"];
    expect(await runFixture("Worker", ...scenarios)).toEqual({
      result: Object.fromEntries(scenarios.map(scenario => [scenario, expected[scenario]])),
      exitCode: 0,
    });
  }, 30_000);
});

// An error holds the functions in its trace weakly, and these are garbage by the first read of `.stack`.
const errorWithDeadFrames = `new Function('"use strict"; function inner() { try { return new Error("x"); } finally {} } try { return inner(); } finally {}')()`;

test.concurrent.each([
  [
    "the getter runs Bun.gc(true)",
    `const e = ${errorWithDeadFrames};
     Object.defineProperty(Error, "prepareStackTrace", { get() { Bun.gc(true); } });
     console.log(e.stack.split("\\n")[0] + " | " + /at (\\w+)/.exec(e.stack)[1]);`,
    "Error: x | inner",
  ],
  [
    "the getter reads the lazy .stack of the error that is being formatted",
    `const e = new Error("x");
     (function capture() { Error.captureStackTrace(e); })();
     let entered = false;
     Object.defineProperty(Error, "prepareStackTrace", { get() { if (!entered) { entered = true; void e.stack; } } });
     console.log(e.stack.split("\\n")[0] + " | " + /at (\\w+)/.exec(e.stack)?.[1]);`,
    "Error: x | capture",
  ],
  [
    "a write through a Proxy made in a node:vm context",
    `import vm from "node:vm";
     const proxy = vm.runInContext("new Proxy(E, {})", vm.createContext({ E: Error }));
     proxy.prepareStackTrace = () => "FROM PROXY";
     console.log(new Error("x").stack);`,
    "FROM PROXY",
  ],
])("a getter or a write from another realm cannot break the formatting: %s", async (_, source, expected) => {
  const { stdout, exitCode, signalCode } = await run("-e", source);
  expect({ stdout, exitCode, signalCode }).toEqual({ stdout: expected, exitCode: 0, signalCode: null });
});

// Node.js captures call sites natively for its own modules, so whatever the program did to
// Error.prepareStackTrace or Error.stackTraceLimit is neither used nor changed by them.
test.concurrent("util.getCallSites and url.parse do not read or write the program's hook", async () => {
  using dir = tempDir("prepare-stack-trace-builtins", {
    "node_modules/library/index.js": `
      const util = require("node:util");
      const url = require("node:url");
      function sites() {
        return util.getCallSites(2).map(site => site.functionName);
      }
      // From a file in node_modules, url.parse looks at the stack before it warns.
      function parse() {
        return url.parse("http://example.com/path").pathname;
      }
      module.exports = { sites, parse };
    `,
    "main.js": `
      const library = require("library");
      const calls = { get: 0, set: 0, formatter: 0 };
      const describe = () => {
        const descriptor = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
        return descriptor ? Object.keys(descriptor).sort().join() : "absent";
      };
      const results = {};
      function check(state) {
        const before = describe();
        results[state] = [library.sites().join(), library.parse(), describe() === before];
      }
      const formatter = () => {
        calls.formatter++;
        return "USER";
      };
      const get = () => (calls.get++, formatter);
      const set = () => void calls.set++;
      Object.defineProperty(Error, "prepareStackTrace", { configurable: true, get, set });
      check("accessor");
      Object.defineProperty(Error, "prepareStackTrace", { configurable: true, get, set: undefined });
      check("getter only");
      Object.defineProperty(Error, "prepareStackTrace", { configurable: true, writable: false, value: formatter });
      check("not writable");
      delete Error.prepareStackTrace;
      check("deleted");
      Object.defineProperty(Error, "stackTraceLimit", { configurable: true, get: () => (calls.get++, 0), set });
      check("stackTraceLimit accessor");
      console.log(JSON.stringify({ results, calls }));
    `,
  });
  const unchanged = ["sites,check", "/path", true];
  expect(await runForJSON(join(String(dir), "main.js"))).toEqual({
    result: {
      results: {
        "accessor": unchanged,
        "getter only": unchanged,
        "not writable": unchanged,
        "deleted": unchanged,
        "stackTraceLimit accessor": unchanged,
      },
      calls: { get: 0, set: 0, formatter: 0 },
    },
    exitCode: 0,
  });
});
