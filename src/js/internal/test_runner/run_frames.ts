// The wire between a node:test run() child and the run() that spawned it.
//
// The child reports each finished test in-band on stdout, the pipe its own
// output travels on, like node's v8-serializer reporter. One event is one frame:
//
//   0xFF "bun:test:run" <u32 big-endian payload length> <payload> 0xFE
//
// and the payload is the UTF-8 JSON of { type, data }. The parent finds frames in
// the raw stdout bytes, before any text decoding. No UTF-8 encoder emits 0xFF
// or 0xFE, so text a test prints can neither start a frame nor stand where one
// ends, and every byte outside a frame is test:stdout. node splits the same
// way (runner.js FileTest.parseMessage) around the V8 serializer header
// 0xFF 0x0F; the tag keeps a node parent from handing one of these frames to
// its V8 deserializer.

const kLeadByte = 0xff;
const kEndByte = 0xfe;
const kTag = "bun:test:run";
const kPrefixLength = 1 + kTag.length;
const kHeaderLength = kPrefixLength + 4;
// The bound of a `bun test --parallel` frame (cli/test/parallel/Frame.rs).
const kMaxPayloadLength = 64 * 1024 * 1024;
// How far an error's `cause` chain goes over the wire.
const kMaxCauseDepth = 8;

// The events a child reports. A new one also needs its shape in decodeRunEvent().
export type RunEvent = { type: "test:pass" | "test:fail"; data: Record<string, any> };

// -----------------------------------------------------------------------------
// Child side
// -----------------------------------------------------------------------------

// node:test loads this module in a run() child before the file under test
// runs, so these are the ones that file has not replaced.
const JSONStringify = JSON.stringify;
const isError = Error.isError;
const encoder = new TextEncoder();
const { writeSync } = require("node:fs");
const printError = console.error;

// What the parent gets in place of an error the child could not read or encode.
function standInError(why: string) {
  return {
    __proto__: null,
    message: `The error of this test could not be reported: ${why}`,
    code: "ERR_TEST_FAILURE",
    failureType: "testCodeFailure",
    name: "Error",
  };
}

// Errors cross the process boundary as plain JSON; the parent rebuilds an Error.
function serializeRunError(error: unknown, depth = 0) {
  try {
    if (isError(error)) {
      const cause = (error as { cause?: unknown }).cause;
      return {
        __proto__: null,
        message: (error as Error).message,
        stack: (error as Error).stack,
        code: (error as { code?: string }).code,
        failureType: (error as { failureType?: string }).failureType,
        name: (error as Error).name,
        cause: cause !== undefined && depth < kMaxCauseDepth ? serializeRunError(cause, depth + 1) : undefined,
      };
    }
    return { __proto__: null, message: String(error), stack: undefined, code: undefined, name: "Error" };
  } catch {
    return standInError("reading it threw");
  }
}

// The frame of an event, or the reason it has none.
function encodeRunFrame(type: RunEvent["type"], data: Record<string, unknown>): Uint8Array | string {
  let payload: Uint8Array;
  try {
    // No prototype, like `data` and the errors in it: a toJSON that the file
    // under test put on every object does not apply.
    payload = encoder.encode(JSONStringify({ __proto__: null, type, data }));
  } catch {
    return "it has no JSON form";
  }
  const { length } = payload;
  if (length > kMaxPayloadLength) return `it is larger than ${kMaxPayloadLength >> 20} MiB`;
  const frame = new Uint8Array(kHeaderLength + length + 1);
  frame[0] = kLeadByte;
  for (let i = 0; i < kTag.length; i++) frame[i + 1] = kTag.charCodeAt(i);
  frame[kPrefixLength] = length >>> 24;
  frame[kPrefixLength + 1] = (length >>> 16) & 0xff;
  frame[kPrefixLength + 2] = (length >>> 8) & 0xff;
  frame[kPrefixLength + 3] = length & 0xff;
  frame.set(payload, kHeaderLength);
  frame[kHeaderLength + length] = kEndByte;
  return frame;
}

// The sink of process.stdout, or null when process.stdout is not the stream
// of fd 1 (the file replaced it, or this is a worker thread).
let stdoutSink: import("bun").FileSink | null | undefined;
let notSentNoted = false;

// A failure that did not go out must not leave the file green: the exit code
// fails it. stderr says why, once.
function verdictNotSent(type: RunEvent["type"], name: unknown, why: unknown) {
  if (type === "test:fail") process.exitCode ||= 1;
  if (notSentNoted) return;
  notSentNoted = true;
  const shown = typeof name === "string" ? JSONStringify(name.length > 100 ? name.slice(0, 100) + "..." : name) : "";
  printError(`node:test: the result of test ${shown} was not reported to run():`, why);
}

// Sends one event. A frame goes through the sink of process.stdout, so it
// stays behind what process.stdout has queued.
function writeRunFrame(type: RunEvent["type"], data: Record<string, unknown>) {
  // The one array of an event. Without a prototype, a toJSON on every array
  // does not apply to it either.
  if (data.tags !== undefined) data.tags = Object.setPrototypeOf((data.tags as string[]).slice(), null);
  let frame = encodeRunFrame(type, data);
  // The label of expectFailure and the error are values of the file under test:
  // too large, or one that JSON cannot hold. The verdict goes out without them.
  if (typeof frame === "string" && data.expectFailure !== undefined && data.expectFailure !== true) {
    data = { __proto__: null, ...data, expectFailure: true };
    frame = encodeRunFrame(type, data);
  }
  if (typeof frame === "string" && data.error !== undefined) {
    frame = encodeRunFrame(type, { __proto__: null, ...data, error: standInError(frame) });
  }
  if (typeof frame === "string") return verdictNotSent(type, data.name, frame);
  try {
    let sink = stdoutSink;
    if (sink === undefined) {
      const found: unknown = process.stdout[require("internal/fs/streams").kWriteStreamFastPath];
      sink = stdoutSink = typeof found === "object" && found !== null ? (found as import("bun").FileSink) : null;
    }
    if (sink === null) {
      for (let offset = 0; offset < frame.length; ) offset += writeSync(1, frame, offset);
      return;
    }
    const pending = sink.write(frame);
    if ($isPromise(pending)) pending.then(undefined, err => verdictNotSent(type, data.name, err));
  } catch (err) {
    verdictNotSent(type, data.name, err);
  }
}

// -----------------------------------------------------------------------------
// Parent side
// -----------------------------------------------------------------------------

// The Error a serialized error stands for, or undefined when it is not one
// serializeRunError() writes.
function rebuildError(serialized: unknown, depth: number): Error | undefined {
  if (typeof serialized !== "object" || serialized === null || $isArray(serialized)) return undefined;
  Object.setPrototypeOf(serialized, null);
  const { message, stack, name, code, failureType, cause } = serialized as Record<string, any>;
  // A test can fail with an error whose `message` is an object, and Error()
  // throws on one that has no string form.
  const messageIsObject = typeof message === "object" && message !== null;
  const error = new Error(messageIsObject ? undefined : message);
  if (messageIsObject) error.message = message;
  error.stack = stack;
  if (name !== undefined && name !== "Error") error.name = name;
  if (code !== undefined) (error as any).code = code;
  if (failureType !== undefined) (error as any).failureType = failureType;
  if (cause !== undefined && depth < kMaxCauseDepth) {
    const rebuiltCause = rebuildError(cause, depth + 1);
    if (rebuiltCause === undefined) return undefined;
    error.cause = rebuiltCause;
  }
  return error;
}

// The event in a frame's payload, with its error rebuilt, or undefined when the
// payload is not one the child side writes. A test can write bytes to stdout,
// so this is stricter than node, which republishes whatever `type` a frame
// names (runner.js:321).
function decodeRunEvent(decoder: TextDecoder, payload: Uint8Array): RunEvent | undefined {
  let event;
  try {
    event = JSON.parse(decoder.decode(payload));
  } catch {
    return undefined;
  }
  if (typeof event !== "object" || event === null) return undefined;
  const { type, data } = event;
  if (type !== "test:pass" && type !== "test:fail") return undefined;
  if (typeof data !== "object" || data === null || $isArray(data)) return undefined;
  // From here on every field is read as an own property.
  Object.setPrototypeOf(data, null);
  const { nesting, error } = data;
  if (nesting !== undefined && typeof nesting !== "number") return undefined;
  if (error !== undefined) {
    const rebuilt = rebuildError(error, 0);
    if (rebuilt === undefined) return undefined;
    data.error = rebuilt;
  }
  return event;
}

// Splits a run() child's stdout into events and printed text. `onText` gets one
// line at a time; a line the child left open is closed before the next event,
// so a test's output stays ahead of its verdict. `onDamaged` is told of each
// frame that began like one of the child's and does not end where its length
// says: another writer of the same stdout printed inside it, or the child ended
// while writing it, and its verdict is lost.
function createRunOutputDecoder(
  onText: (message: string) => void,
  onEvent: (event: RunEvent) => void,
  onDamaged: () => void,
) {
  // Every U+FEFF is text: closeLine() restarts this decoder, and one that
  // drops a byte order mark would drop it after each event.
  const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const payloadDecoder = new TextDecoder("utf-8", { fatal: true });
  // Decoded text after the last "\n".
  let line = "";
  // A frame that has started and is not all here: its chunks (the first byte
  // is the lead byte), their length, and the length that decides it.
  let pending: Uint8Array[] | undefined;
  let pendingLength = 0;
  let pendingNeeds = 0;

  function text(bytes: Uint8Array) {
    const decoded = textDecoder.decode(bytes, { stream: true });
    let newline = decoded.indexOf("\n");
    if (newline === -1) {
      line += decoded;
      return;
    }
    // The open line ends at the first "\n" of this text.
    const first = line + decoded.slice(0, newline + 1);
    if (first.length > 1) onText(first);
    let start = newline + 1;
    while ((newline = decoded.indexOf("\n", start)) !== -1) {
      if (newline > start) onText(decoded.slice(start, newline + 1));
      start = newline + 1;
    }
    line = decoded.slice(start);
  }

  function closeLine() {
    // A character that the bytes before an event left unfinished ends with
    // them, as U+FFFD, and not with the bytes after the event.
    line += textDecoder.decode();
    if (line.length === 0) return;
    const message = line + "\n";
    line = "";
    onText(message);
  }

  // Bytes that look like a frame and are not one are text. The scan goes on
  // right after their lead byte, so they cannot hide a real frame behind them.
  function scan(bytes: Uint8Array, ended: boolean) {
    let textStart = 0;
    let from = 0;
    for (;;) {
      const lead = bytes.indexOf(kLeadByte, from);
      if (lead === -1) break;
      from = lead + 1;
      const available = bytes.length - lead;
      const prefix = available < kPrefixLength ? available : kPrefixLength;
      let i = 1;
      while (i < prefix && bytes[lead + i] === kTag.charCodeAt(i - 1)) i++;
      if (i < prefix) continue;
      if (available < kHeaderLength) {
        if (ended) continue;
        // A header that is not all here is looked at again with the next byte.
        if (lead > textStart) text(bytes.subarray(textStart, lead));
        pending = [bytes.subarray(lead)];
        pendingLength = available;
        pendingNeeds = available + 1;
        return;
      }
      const at = lead + kPrefixLength;
      const length = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
      if (length > kMaxPayloadLength) continue;
      const payloadStart = lead + kHeaderLength;
      const needs = kHeaderLength + length + 1;
      // Neither a payload nor the end byte is a lead byte: one inside the
      // frame means it was cut, whether or not the rest of it is here yet.
      const inside = bytes.indexOf(kLeadByte, payloadStart);
      const cut = inside !== -1 && inside < lead + needs;
      if (!cut && available < needs && !ended) {
        if (lead > textStart) text(bytes.subarray(textStart, lead));
        pending = [bytes.subarray(lead)];
        pendingLength = available;
        pendingNeeds = needs;
        return;
      }
      if (cut || available < needs || bytes[lead + needs - 1] !== kEndByte) {
        // The child's payload is a JSON object, or has not started yet.
        if (available === kHeaderLength || bytes[payloadStart] === 0x7b) onDamaged();
        continue;
      }
      const event = decodeRunEvent(payloadDecoder, bytes.subarray(payloadStart, lead + needs - 1));
      if (event === undefined) continue;
      if (lead > textStart) text(bytes.subarray(textStart, lead));
      closeLine();
      onEvent(event);
      textStart = from = lead + needs;
    }
    if (textStart < bytes.length) text(bytes.subarray(textStart));
  }

  function takePending() {
    const chunks = pending!;
    pending = undefined;
    if (chunks.length === 1) return chunks[0];
    const bytes = new Uint8Array(pendingLength);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      bytes.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return bytes;
  }

  return {
    write(chunk: Uint8Array) {
      if (pending !== undefined) {
        $arrayPush(pending, chunk);
        pendingLength += chunk.length;
        // The open frame is decided when all of it is here, or when a lead
        // byte shows that it was cut. Until then its chunks are only kept.
        if (pendingLength < pendingNeeds && chunk.indexOf(kLeadByte) === -1) return;
        chunk = takePending();
      }
      scan(chunk, false);
    },
    end() {
      if (pending !== undefined) scan(takePending(), true);
      closeLine();
    },
  };
}

export default { createRunOutputDecoder, serializeRunError, writeRunFrame };
