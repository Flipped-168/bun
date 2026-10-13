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
  "an accessor is read two times for one stack": ["CALLED ON Error", 2],
  "a getter that gives a function, then null": ["TypeError", "globalThis.Error.prepareStackTrace is not a function", 2],
  "a getter gives a formatter that throws": [true, "LATER"],
  "other properties first": ["default", "ONE"],
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
  "a formatter that calls the default, and a capture whose caller is not on the stack": "Error",
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
    "a stack overflow, read where it is caught": ["default", "default", "default", 0],
  };
  test.concurrent.each(Object.entries(inTheMainRealm))("%s", async (scenario, result) => {
    expect(await runFixture("main", scenario)).toEqual({ result, exitCode: 0 });
  });

  // These two make many realms, which takes seconds in a debug build, so each one runs alone.
  test("each scenario in a fresh ShadowRealm", async () => {
    expect(await runFixture("ShadowRealm", ...Object.keys(expected))).toEqual({ result: expected, exitCode: 0 });
  });

  test("in a fresh node:vm context", async () => {
    // The Error of a node:vm context starts without the property.
    const scenarios = [
      ...["assign", "delete after assign", "delete first", "accessor", "define value", "not callable"],
      ...["inherited from Function.prototype", "a formatter that deletes itself"],
      ...["a getter that reads another stack", "a getter that throws"],
      ...["an accessor is read two times for one stack", "a getter that gives a function, then null"],
    ];
    expect(await runFixture("node:vm", ...scenarios)).toEqual({
      result: Object.fromEntries(scenarios.map(scenario => [scenario, expected[scenario]])),
      exitCode: 0,
    });
  });
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
  [
    // Node.js throws again at each read. Here the first read throws and the error keeps its default stack.
    "the getter throws, and the stack is read again",
    `Object.defineProperty(Error, "prepareStackTrace", { get() { throw new RangeError("getter threw"); } });
     const e = new Error("boom");
     const target = {};
     const thrown = read => { try { read(); return "no throw"; } catch (error) { return error.message; } };
     const first = [thrown(() => e.stack), thrown(() => Error.captureStackTrace(target))];
     const kept = [e.stack, target.stack].map(stack => /^Error(: boom)?\\n    at /.test(stack));
     console.log(JSON.stringify([first, kept]));`,
    `[["getter threw","getter threw"],[true,true]]`,
  ],
])("a getter or a write from another realm cannot break the formatting: %s", async (_, source, expected) => {
  const { stdout, exitCode, signalCode } = await run("-e", source);
  expect({ stdout, exitCode, signalCode }).toEqual({ stdout: expected, exitCode: 0, signalCode: null });
});

// An error made in a node:vm context. Each line is what Node.js v26.3.0 prints.
test.concurrent("the Error of the main context formats for a node:vm context that has no formatter", async () => {
  const source = `
    const vm = require("node:vm");
    Error.prepareStackTrace = function (error, callSites) {
      return "MAIN, called on the main Error: " + (this === Error) + ", call sites: " + Array.isArray(callSites);
    };
    console.log(vm.runInNewContext("new Error('x')").stack);
    console.log(vm.runInNewContext("Error.prepareStackTrace = function () { return 'CONTEXT, called on its Error: ' + (this === Error); }; new Error('x').stack"));
    console.log(vm.runInNewContext("Error.prepareStackTrace = 'not a function'; new Error('x').stack"));
    Error.prepareStackTrace = undefined;
    console.log(vm.runInNewContext("new Error('x')").stack.split("\\n")[0]);
  `;
  const { stdout, exitCode } = await run("-e", source);
  expect({ stdout: stdout.split("\n"), exitCode }).toEqual({
    stdout: [
      "MAIN, called on the main Error: true, call sites: true",
      "CONTEXT, called on its Error: true",
      "MAIN, called on the main Error: true, call sites: true",
      "Error: x",
    ],
    exitCode: 0,
  });
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
      // url.parse from a library must find its caller in node_modules and not warn (DEP0169).
      const warnings = [];
      process.on("warning", warning => warnings.push(warning.code ?? warning.name));
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
      Error.prepareStackTrace = function whileFormatting() {
        results["inside a formatter"] = [library.sites().join(), library.parse()];
        return "FORMATTED";
      };
      void new Error("boom").stack;
      delete Error.prepareStackTrace;
      Object.defineProperty(Error, "stackTraceLimit", { configurable: true, get: () => (calls.get++, 0), set });
      check("stackTraceLimit accessor");
      // A warning is emitted on a later tick.
      setImmediate(() => console.log(JSON.stringify({ results, calls, warnings })));
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
        "inside a formatter": ["sites,whileFormatting", "/path"],
        "stackTraceLimit accessor": unchanged,
      },
      calls: { get: 0, set: 0, formatter: 0 },
      warnings: [],
    },
    exitCode: 0,
  });
});
