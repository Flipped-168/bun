/**
 * TCP keep-alive of a node:http server: the `keepAlive` and `keepAliveInitialDelay` options of createServer(), and
 * socket.setKeepAlive() of the sockets the server gives to its listeners.
 *
 * The first two blocks run in both Bun and Node.js: `bun test` runs them here, and the last test runs this same
 * file under Node.js. The other blocks read the socket options of the kernel with bun:ffi, so they run in Bun only.
 * Their expected values are what Node v26.3.0 gives (read there with getsockopt(2) from a helper process), except
 * where a comment says that Bun differs.
 */
import assert from "node:assert";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { describe, test } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

type SocketEvent = "request" | "connection" | "connect" | "upgrade";
const requests: Record<SocketEvent, string> = {
  request: "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n",
  connection: "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n",
  connect: "CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n",
  upgrade: "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: tunnel\r\n\r\n",
};

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

// A client that sent `request`. It is connected and, for TLS, the handshake is done.
async function connect(port: number, secure: boolean, request: string) {
  const client = secure
    ? tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false })
    : net.connect(port, "127.0.0.1");
  await once(client, secure ? "secureConnect" : "connect");
  client.write(request);
  return client;
}

// Runs `fn` with the socket that `server` gives to the listener of `event`, and gives the result of `fn`.
async function withSocket<T>(
  server: http.Server,
  secure: boolean,
  event: SocketEvent,
  fn: (socket: net.Socket) => T | Promise<T>,
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const run = (socket: net.Socket) => void Promise.try(fn, socket).then(resolve, reject);
  if (event === "request") {
    server.on("request", (req, res) => {
      run(req.socket);
      res.end();
    });
  } else if (event === "connection") {
    server.on("connection", run);
    server.on("request", (_req, res) => res.end());
  } else {
    server.on(event, (_req, socket) => run(socket as net.Socket));
  }
  const client = await connect(await listen(server), secure, requests[event]);
  client.on("error", reject);
  try {
    return await promise;
  } finally {
    client.destroy();
    server.closeAllConnections();
    server.close();
  }
}

type KeepAliveProperties = { keepAlive: unknown; keepAliveInitialDelay: unknown };
const keepAliveOf = (server: http.Server) => {
  const { keepAlive, keepAliveInitialDelay } = server as unknown as KeepAliveProperties;
  return [keepAlive, keepAliveInitialDelay];
};

describe("server.keepAlive and server.keepAliveInitialDelay", () => {
  // [options, [keepAlive, keepAliveInitialDelay]]. The delay is an option in milliseconds and a property in seconds.
  const rows: [string, http.ServerOptions | undefined, unknown[]][] = [
    ["no options", undefined, [false, 0]],
    ["{}", {}, [false, 0]],
    ["{ keepAlive: true }", { keepAlive: true }, [true, 0]],
    [
      "{ keepAlive: 1, keepAliveInitialDelay: 30000 }",
      { keepAlive: 1 as any, keepAliveInitialDelay: 30000 },
      [true, 30],
    ],
    ["{ keepAlive: true, keepAliveInitialDelay: 1500 }", { keepAlive: true, keepAliveInitialDelay: 1500 }, [true, 1]],
    ["{ keepAlive: true, keepAliveInitialDelay: -5000 }", { keepAlive: true, keepAliveInitialDelay: -5000 }, [true, 0]],
    ["{ keepAlive: true, keepAliveInitialDelay: NaN }", { keepAlive: true, keepAliveInitialDelay: NaN }, [true, 0]],
    [
      "{ keepAlive: true, keepAliveInitialDelay: Infinity }",
      { keepAlive: true, keepAliveInitialDelay: Infinity },
      [true, 0],
    ],
    [
      "{ keepAlive: true, keepAliveInitialDelay: 2 ** 40 }",
      { keepAlive: true, keepAliveInitialDelay: 2 ** 40 },
      [true, 1099511627],
    ],
    ["{ keepAliveInitialDelay: 5000 }", { keepAliveInitialDelay: 5000 }, [false, 5]],
  ];
  for (const [label, options, expected] of rows) {
    test(`every way to make a server: ${label}`, () => {
      assert.deepStrictEqual(
        {
          "http.createServer()": keepAliveOf(http.createServer(options as http.ServerOptions)),
          "new http.Server()": keepAliveOf(new http.Server(options as http.ServerOptions)),
          // @ts-expect-error http.Server() without `new`
          "http.Server()": keepAliveOf(http.Server(options)),
          "https.createServer()": keepAliveOf(https.createServer(options as https.ServerOptions)),
        },
        {
          "http.createServer()": expected,
          "new http.Server()": expected,
          "http.Server()": expected,
          "https.createServer()": expected,
        },
      );
    });
  }

  test("a keepAliveInitialDelay that is not a number throws ERR_INVALID_ARG_TYPE", () => {
    assert.throws(() => http.createServer({ keepAlive: true, keepAliveInitialDelay: "5" as any }), {
      name: "TypeError",
      code: "ERR_INVALID_ARG_TYPE",
      message: `The "options.keepAliveInitialDelay" property must be of type number. Received type string ('5')`,
    });
    assert.throws(() => https.createServer({ keepAliveInitialDelay: null as any }), {
      name: "TypeError",
      code: "ERR_INVALID_ARG_TYPE",
      message: `The "options.keepAliveInitialDelay" property must be of type number. Received null`,
    });
  });

  test("the two are own enumerable data properties", () => {
    const server = http.createServer({ keepAlive: true, keepAliveInitialDelay: 5000 });
    assert.deepStrictEqual(
      [
        Object.getOwnPropertyDescriptor(server, "keepAlive"),
        Object.getOwnPropertyDescriptor(server, "keepAliveInitialDelay"),
      ],
      [
        { value: true, writable: true, enumerable: true, configurable: true },
        { value: 5, writable: true, enumerable: true, configurable: true },
      ],
    );
  });
});

describe("socket.setKeepAlive() of a server socket", () => {
  test("returns a Proxy of the socket that it is called on", async () => {
    const returned = await withSocket(http.createServer(), false, "request", socket => {
      const proxy = new Proxy(socket, {});
      return proxy.setKeepAlive(true, 5000) === proxy;
    });
    assert.strictEqual(returned, true);
  });

  for (const event of ["request", "connection", "connect", "upgrade"] as const) {
    test(`returns the socket of '${event}' for any arguments, also after destroy()`, async () => {
      const returned = await withSocket(http.createServer(), false, event, socket => {
        const calls: unknown[][] = [[true, 5000], [true], [], [false], ["yes", "5000"], [true, NaN], [true, -5000]];
        const open = calls.map(args => socket.setKeepAlive(...(args as [boolean, number])) === socket);
        socket.destroy();
        return [...open, socket.setKeepAlive(true, 5000) === socket];
      });
      assert.deepStrictEqual(returned, [true, true, true, true, true, true, true, true]);
    });
  }
});

// Only in Bun: bun:ffi reads the options, and Node.js must not run this file from itself again.
if (typeof Bun !== "undefined") {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const {
    bunEnv,
    isFreeBSD,
    isMacOS,
    isWindows,
    libcPathForDlopen,
    nodeExe,
    tempDir,
    tls: tlsCert,
  } = await import("harness");
  const { join } = await import("node:path");
  const { WebSocketServer } = await import("ws");

  // Opened by the first test that reads a socket option. Those tests do not run on Windows: nothing there gives the
  // SOCKET of a server connection to JavaScript.
  const openLibc = () =>
    dlopen(libcPathForDlopen(), {
      getsockopt: { args: [FFIType.int, FFIType.int, FFIType.int, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
      setsockopt: { args: [FFIType.int, FFIType.int, FFIType.int, FFIType.ptr, FFIType.u32], returns: FFIType.int },
      getsockname: { args: [FFIType.int, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
      getpeername: { args: [FFIType.int, FFIType.ptr, FFIType.ptr], returns: FFIType.int },
    });
  let libc: ReturnType<typeof openLibc> | undefined;
  const symbols = () => (libc ??= openLibc()).symbols;
  const isBSD = isMacOS || isFreeBSD;
  const SOL_SOCKET = isBSD ? 0xffff : 1;
  const SO_KEEPALIVE = isBSD ? 0x0008 : 9;
  const IPPROTO_TCP = 6;
  const TCP_NODELAY = 1;
  // Darwin names it TCP_KEEPALIVE.
  const TCP_KEEPIDLE = isMacOS ? 0x10 : isFreeBSD ? 256 : 4;
  const AF_UNIX = 1;
  const AF_INET = 2;

  function intOption(fd: number, level: number, option: number) {
    const value = new Int32Array(1);
    const length = new Uint32Array([4]);
    if (symbols().getsockopt(fd, level, option, ptr(value), ptr(length)) !== 0) {
      throw new Error(`getsockopt(${fd}, ${level}, ${option}) failed`);
    }
    return value[0];
  }

  // The two ports of a connection of 127.0.0.1, as its server end sees them. A net.Socket of the server has both.
  type Ports = { localPort?: number; remotePort?: number };

  // The family of an address that getsockname() or getpeername() wrote. Linux has a 16-bit family. The BSDs have a
  // length byte and then the family.
  const familyOf = (address: Uint8Array) => (isBSD ? address[1] : address[0] | (address[1] << 8));

  // The fd of the server end of the connection, or -1. It needs both ports: the kernel can give a client the local
  // port of a connection to another server that is still open.
  function fdOf({ localPort, remotePort }: Ports) {
    const address = new Uint8Array(128);
    const length = new Uint32Array(1);
    const { getsockname, getpeername } = symbols();
    // sin_port is bytes 2 and 3 of a sockaddr_in, in network order. A shorter address leaves the bytes of the fd before.
    const port = () => (length[0] >= 8 && familyOf(address) === AF_INET ? (address[2] << 8) | address[3] : -1);
    for (let fd = 0; fd < 1024; fd++) {
      length[0] = address.length;
      if (getpeername(fd, ptr(address), ptr(length)) !== 0 || port() !== remotePort) continue;
      length[0] = address.length;
      if (getsockname(fd, ptr(address), ptr(length)) === 0 && port() === localPort) return fd;
    }
    return -1;
  }

  // The fd of a connection that the unix listener at `path` accepted, or -1.
  function fdOfUnixConnection(path: string) {
    const address = new Uint8Array(256);
    const length = new Uint32Array(1);
    const { getsockname, getpeername } = symbols();
    for (let fd = 0; fd < 1024; fd++) {
      length[0] = address.length;
      if (getsockname(fd, ptr(address), ptr(length)) !== 0 || familyOf(address) !== AF_UNIX) continue;
      // The client end has no name: its address is the family alone, and the bytes after it are of the fd before.
      const name = address.subarray(2, length[0]);
      const end = name.indexOf(0);
      if (Buffer.from(end === -1 ? name : name.subarray(0, end)).toString() !== path) continue;
      // The listener has the name too, and no peer.
      length[0] = address.length;
      if (getpeername(fd, ptr(address), ptr(length)) === 0) return fd;
    }
    return -1;
  }

  function kernelKeepAlive(ports: Ports) {
    const fd = fdOf(ports);
    if (fd === -1) throw new Error(`no connection from port ${ports.remotePort} to port ${ports.localPort}`);
    return {
      // Darwin answers with the flag bit, not with 1.
      keepAlive: intOption(fd, SOL_SOCKET, SO_KEEPALIVE) !== 0,
      // Seconds before the first probe.
      keepIdle: intOption(fd, IPPROTO_TCP, TCP_KEEPIDLE),
    };
  }

  // The native handle of a server socket, as node-http.test.ts finds it.
  function handleOf(socket: net.Socket) {
    const symbol = Object.getOwnPropertySymbols(socket).find(symbol => symbol.description === "handle");
    const handle = symbol && (socket as any)[symbol];
    if (typeof handle?.setKeepAlive !== "function") throw new Error("no native handle with setKeepAlive()");
    return handle as { setKeepAlive(...args: unknown[]): boolean };
  }

  const createServer = (secure: boolean, options: http.ServerOptions = {}) =>
    secure ? https.createServer({ ...tlsCert, ...options }) : http.createServer(options);

  describe("the native handle of a server socket", () => {
    test("setKeepAlive() returns true when it set the option, and false for a closed connection or another `this`", async () => {
      const result = await withSocket(http.createServer(), false, "connect", socket => {
        const handle = handleOf(socket);
        const calls: unknown[][] = [
          [true, 5000],
          [true],
          [false],
          [],
          [true, NaN],
          [true, -5000],
          [true, 999],
          [true, "0"],
        ];
        const open = calls.map(args => handle.setKeepAlive(...args));
        const otherThis = handle.setKeepAlive.call({}, true, 5000);
        let thrown: unknown;
        try {
          handle.setKeepAlive(true, Symbol("delay"));
        } catch (e) {
          thrown = (e as Error).name;
        }
        const destroys = {
          valueOf() {
            socket.destroy();
            return 5000;
          },
        };
        return { open, otherThis, thrown, closedByTheConversion: handle.setKeepAlive(true, destroys) };
      });
      assert.deepStrictEqual(result, {
        open: [true, true, true, true, true, true, true, true],
        otherThis: false,
        thrown: "TypeError",
        closedByTheConversion: false,
      });
    });
  });

  describe("SO_KEEPALIVE after socket.setKeepAlive()", { skip: isWindows }, () => {
    for (const secure of [false, true]) {
      for (const event of ["request", "connection", "connect", "upgrade"] as const) {
        test(`${secure ? "https" : "http"}: the socket of '${event}'`, async () => {
          const result = await withSocket(createServer(secure), secure, event, socket => {
            const accepted = kernelKeepAlive(socket).keepAlive;
            socket.setKeepAlive(true, 5000);
            const on = kernelKeepAlive(socket);
            socket.setKeepAlive(false);
            const off = kernelKeepAlive(socket).keepAlive;
            // Without a delay, and with a delay under one second, the kernel keeps its time: the 5 seconds from before.
            socket.setKeepAlive(true);
            const withoutDelay = kernelKeepAlive(socket);
            socket.setKeepAlive(true, 500);
            return { accepted, on, off, withoutDelay, underOneSecond: kernelKeepAlive(socket) };
          });
          assert.deepStrictEqual(result, {
            accepted: false,
            on: { keepAlive: true, keepIdle: 5 },
            off: false,
            withoutDelay: { keepAlive: true, keepIdle: 5 },
            underOneSecond: { keepAlive: true, keepIdle: 5 },
          });
        });
      }
    }

    test("skips the call that changes nothing, as net.Socket does", async () => {
      const result = await withSocket(http.createServer(), false, "request", socket => {
        socket.setKeepAlive(true, 5000);
        // A second call with the same values must not reach the kernel: it would set the 5 seconds again.
        const fd = fdOf(socket);
        symbols().setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, ptr(new Int32Array([77])), 4);
        socket.setKeepAlive(true, 5000);
        const same = kernelKeepAlive(socket);
        socket.setKeepAlive(true, 6000);
        return { same, changed: kernelKeepAlive(socket) };
      });
      assert.deepStrictEqual(result, {
        same: { keepAlive: true, keepIdle: 77 },
        changed: { keepAlive: true, keepIdle: 6 },
      });
    });

    test("acts through a Proxy of the socket", async () => {
      const result = await withSocket(http.createServer(), false, "request", socket => {
        new Proxy(socket, {}).setKeepAlive(true, 5000);
        return kernelKeepAlive(socket);
      });
      assert.deepStrictEqual(result, { keepAlive: true, keepIdle: 5 });
    });

    test("a unix socket has no keep-alive, as in Node.js", async () => {
      using dir = tempDir("sock", {});
      const path = join(String(dir), "http.sock");
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const server = http.createServer((req, res) => {
        try {
          const returned = req.socket.setKeepAlive(true, 5000) === req.socket;
          resolve({ returned, keepAlive: intOption(fdOfUnixConnection(path), SOL_SOCKET, SO_KEEPALIVE) !== 0 });
        } catch (e) {
          reject(e);
        }
        res.end();
      });
      server.listen(path);
      await once(server, "listening");
      const client = net.connect(path);
      client.on("error", reject);
      client.write(requests.request);
      try {
        assert.deepStrictEqual(await promise, { returned: true, keepAlive: false });
      } finally {
        client.destroy();
        server.closeAllConnections();
        server.close();
      }
    });

    for (const secure of [false, true]) {
      test(`${secure ? "https" : "http"}: acts on a connection that the built-in ws adopted`, async () => {
        const server = createServer(secure);
        const wss = new WebSocketServer({ noServer: true });
        const { promise, resolve, reject } = Promise.withResolvers<unknown>();
        server.on("upgrade", (req, socket, head) => {
          const { localPort, remotePort } = socket as net.Socket;
          const ports = { localPort, remotePort };
          wss.handleUpgrade(req, socket, head, ws => {
            try {
              const returned = [(socket as net.Socket).setKeepAlive(true, 5000) === socket];
              const adopted = kernelKeepAlive(ports);
              ws.terminate();
              returned.push((socket as net.Socket).setKeepAlive(false) === socket);
              resolve({ returned, adopted });
            } catch (e) {
              reject(e);
            }
          });
        });
        const upgrade =
          "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
        const client = await connect(await listen(server), secure, upgrade);
        client.on("error", reject);
        try {
          assert.deepStrictEqual(await promise, {
            returned: [true, true],
            adopted: { keepAlive: true, keepIdle: 5 },
          });
        } finally {
          client.destroy();
          wss.close();
          server.closeAllConnections();
          server.close();
        }
      });
    }

    test("the native handle takes milliseconds, and keeps the time of the kernel for a delay that it cannot use", async () => {
      const result = await withSocket(http.createServer(), false, "connect", socket => {
        const handle = handleOf(socket);
        const call = (...args: unknown[]) => [handle.setKeepAlive(...args), kernelKeepAlive(socket)];
        const on = call(true, 5000);
        const kept = [NaN, -5000, 999, "0"].map(delay => call(true, delay));
        // The first delay that is a second.
        const oneSecond = call(true, 1000);
        // More seconds than an unsigned int holds. The kernel refuses that time.
        const tooLong = [4294967301000, Infinity].map(delay => call(true, delay));
        // No arguments: off.
        const off = call();
        let afterThrow: unknown;
        try {
          handle.setKeepAlive(true, Symbol("delay"));
        } catch {
          afterThrow = kernelKeepAlive(socket).keepAlive;
        }
        return { on, kept, oneSecond, tooLong, off, afterThrow };
      });
      const five = { keepAlive: true, keepIdle: 5 };
      const one = { keepAlive: true, keepIdle: 1 };
      assert.deepStrictEqual(result, {
        on: [true, five],
        kept: [
          [true, five],
          [true, five],
          [true, five],
          [true, five],
        ],
        oneSecond: [true, one],
        tooLong: [
          [false, one],
          [false, one],
        ],
        off: [true, { keepAlive: false, keepIdle: 1 }],
        afterThrow: false,
      });
    });
  });

  describe("SO_KEEPALIVE of a connection of a server with keepAlive", { skip: isWindows }, () => {
    const options = { keepAlive: true, keepAliveInitialDelay: 30000 };
    const thirty = { keepAlive: true, keepIdle: 30 };

    // Changes the time of the kernel behind the back of the socket: a later call that reaches the kernel changes it again.
    function setKeepIdle(ports: Ports, seconds: number) {
      if (symbols().setsockopt(fdOf(ports), IPPROTO_TCP, TCP_KEEPIDLE, ptr(new Int32Array([seconds])), 4) !== 0) {
        throw new Error("setsockopt(TCP_KEEPIDLE) failed");
      }
    }

    for (const secure of [false, true]) {
      test(`${secure ? "https" : "http"}: the connection has the options when 'connection' runs`, async () => {
        const accepted = await withSocket(createServer(secure, options), secure, "connection", kernelKeepAlive);
        assert.deepStrictEqual(accepted, thirty);
      });
    }

    test("the delay is for keepAlive only, and one under a second keeps the time of the kernel", async () => {
      const accepted = (options: http.ServerOptions) =>
        withSocket(http.createServer(options), false, "connection", kernelKeepAlive);
      const [{ keepIdle }, ...withOptions] = await Promise.all([
        accepted({}),
        accepted({ keepAlive: true }),
        accepted({ keepAlive: true, keepAliveInitialDelay: 500 }),
        accepted({ keepAliveInitialDelay: 5000 }),
      ]);
      assert.deepStrictEqual(withOptions, [
        { keepAlive: true, keepIdle },
        { keepAlive: true, keepIdle },
        { keepAlive: false, keepIdle },
      ]);
    });

    test("http: setKeepAlive() starts from the options of the server", async () => {
      const off = await withSocket(createServer(false, options), false, "request", socket => {
        socket.setKeepAlive(false);
        return kernelKeepAlive(socket).keepAlive;
      });
      const on = await withSocket(createServer(false, options), false, "request", socket => {
        setKeepIdle(socket, 77);
        // The values of the options: the call must not reach the kernel.
        socket.setKeepAlive(true, 30000);
        const same = kernelKeepAlive(socket);
        socket.setKeepAlive(true, 5000);
        return { same, changed: kernelKeepAlive(socket) };
      });
      assert.deepStrictEqual(
        { off, ...on },
        { off: false, same: { keepAlive: true, keepIdle: 77 }, changed: { keepAlive: true, keepIdle: 5 } },
      );
    });

    // Node's req.socket of an https server is a TLSSocket. The server gave keep-alive to the net.Socket below it.
    test("https: setKeepAlive() starts from nothing, as Node's TLSSocket", async () => {
      const off = await withSocket(createServer(true, options), true, "request", socket => {
        // Off is what the socket already has, so the call does not reach the kernel.
        socket.setKeepAlive(false);
        return kernelKeepAlive(socket);
      });
      const on = await withSocket(createServer(true, options), true, "request", socket => {
        setKeepIdle(socket, 77);
        socket.setKeepAlive(true, 30000);
        return kernelKeepAlive(socket);
      });
      assert.deepStrictEqual({ off, on }, { off: thirty, on: thirty });
    });

    test("an assignment to the properties is for the connections after it, also after a new listen()", async () => {
      const server = http.createServer((_req, res) => res.end());
      const properties = server as unknown as KeepAliveProperties;
      const clients: net.Socket[] = [];
      // The next socket that the server accepts.
      const accept = async (port: number) => {
        const connection = once(server, "connection") as Promise<[net.Socket]>;
        clients.push(await connect(port, false, requests.request));
        return (await connection)[0];
      };
      try {
        properties.keepAlive = true;
        properties.keepAliveInitialDelay = 7;
        let port = await listen(server);
        const first = await accept(port);
        const beforeListen = kernelKeepAlive(first);

        properties.keepAliveInitialDelay = 9;
        const second = await accept(port);
        const afterListen = { second: kernelKeepAlive(second), first: kernelKeepAlive(first) };
        // The socket starts from the 9 seconds: the same values do not reach the kernel.
        setKeepIdle(second, 77);
        second.setKeepAlive(true, 9000);
        const sameAsAssigned = kernelKeepAlive(second);

        for (const client of clients) client.destroy();
        server.closeAllConnections();
        server.close();
        await once(server, "close");
        port = await listen(server);
        const afterNewListen = kernelKeepAlive(await accept(port));

        properties.keepAlive = false;
        const off = kernelKeepAlive(await accept(port)).keepAlive;

        assert.deepStrictEqual(
          { beforeListen, afterListen, sameAsAssigned, afterNewListen, off },
          {
            beforeListen: { keepAlive: true, keepIdle: 7 },
            afterListen: { second: { keepAlive: true, keepIdle: 9 }, first: { keepAlive: true, keepIdle: 7 } },
            sameAsAssigned: { keepAlive: true, keepIdle: 77 },
            afterNewListen: { keepAlive: true, keepIdle: 9 },
            off: false,
          },
        );
      } finally {
        for (const client of clients) client.destroy();
        server.closeAllConnections();
        server.close();
      }
    });

    test("a class field, and Object.defineProperty() after listen(), give the values", async () => {
      class KeepAliveServer extends http.Server {
        keepAlive = true;
        keepAliveInitialDelay = 7;
      }
      const field = await withSocket(new KeepAliveServer(), false, "connection", kernelKeepAlive);

      const server = http.createServer((_req, res) => res.end());
      const port = await listen(server);
      Object.defineProperty(server, "keepAlive", { value: true });
      Object.defineProperty(server, "keepAliveInitialDelay", { value: 8 });
      const connection = once(server, "connection") as Promise<[net.Socket]>;
      const client = await connect(port, false, requests.request);
      try {
        const defined = kernelKeepAlive((await connection)[0]);
        assert.deepStrictEqual(
          { field, defined },
          { field: { keepAlive: true, keepIdle: 7 }, defined: { keepAlive: true, keepIdle: 8 } },
        );
      } finally {
        client.destroy();
        server.closeAllConnections();
        server.close();
      }
    });

    test("an assigned keepAliveInitialDelay that is not a number keeps the time of the kernel", async () => {
      const server = http.createServer((_req, res) => res.end());
      const properties = server as unknown as KeepAliveProperties;
      properties.keepAlive = true;
      const port = await listen(server);
      const clients: net.Socket[] = [];
      // The keep-alive of the next connection, accepted with `delay` as the property.
      const accepted = async (delay: unknown) => {
        properties.keepAliveInitialDelay = delay;
        const connection = once(server, "connection") as Promise<[net.Socket]>;
        clients.push(await connect(port, false, requests.request));
        return kernelKeepAlive((await connection)[0]);
      };
      const throws = {
        valueOf() {
          throw new Error("valueOf");
        },
      };
      try {
        const { keepIdle } = await accepted(0);
        const kernel = { keepAlive: true, keepIdle };
        const results: unknown[] = [];
        for (const delay of [7, 7.9, NaN, "7", 5n, Symbol("delay"), throws, null, undefined, {}]) {
          results.push(await accepted(delay));
        }
        assert.deepStrictEqual(results, [
          { keepAlive: true, keepIdle: 7 },
          { keepAlive: true, keepIdle: 7 },
          kernel,
          kernel,
          kernel,
          kernel,
          kernel,
          kernel,
          kernel,
          kernel,
        ]);
      } finally {
        for (const client of clients) client.destroy();
        server.closeAllConnections();
        server.close();
      }
    });

    for (const secure of [false, true]) {
      test(`${secure ? "https" : "http"}: a unix listener does not set it, as in Node.js`, async () => {
        using dir = tempDir("sock", {});
        const path = join(String(dir), "http.sock");
        const server = createServer(secure, options);
        server.on("request", (_req, res) => res.end());
        server.listen(path);
        await once(server, "listening");
        const connection = once(server, "connection");
        const client = secure ? tls.connect({ path, rejectUnauthorized: false }) : net.connect(path);
        try {
          client.write(requests.request);
          await Promise.race([connection, once(client, "error").then(([error]) => Promise.reject(error))]);
          assert.strictEqual(intOption(fdOfUnixConnection(path), SOL_SOCKET, SO_KEEPALIVE) !== 0, false);
        } finally {
          client.destroy();
          server.closeAllConnections();
          server.close();
        }
      });
    }

    // Keep-alive is per listener, and off. TCP_NODELAY stays on for every connection: the `noDelay` option and
    // socket.setNoDelay(false) have no effect on a server socket.
    test("other listeners do not set it, and every connection has TCP_NODELAY on", async () => {
      const optionsOf = (ports: Ports) => {
        const fd = fdOf(ports);
        if (fd === -1) throw new Error(`no connection from port ${ports.remotePort} to port ${ports.localPort}`);
        return {
          keepAlive: intOption(fd, SOL_SOCKET, SO_KEEPALIVE) !== 0,
          noDelay: intOption(fd, IPPROTO_TCP, TCP_NODELAY) !== 0,
        };
      };
      const served = Promise.withResolvers<Ports>();
      using server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request, server) {
          served.resolve({ localPort: server.port, remotePort: server.requestIP(request)!.port });
          return new Response();
        },
      });
      const listened = Promise.withResolvers<Ports>();
      using listener = Bun.listen({
        port: 0,
        hostname: "127.0.0.1",
        socket: {
          open: socket => listened.resolve({ localPort: socket.localPort, remotePort: socket.remotePort }),
          data() {},
        },
      });
      const clients = [await connect(server.port!, false, requests.request), await connect(listener.port, false, "")];
      try {
        assert.deepStrictEqual(
          {
            "Bun.serve()": optionsOf(await served.promise),
            "Bun.listen()": optionsOf(await listened.promise),
            "http.createServer()": await withSocket(http.createServer(), false, "connection", optionsOf),
            "http.createServer({ keepAlive: true, noDelay: false })": await withSocket(
              http.createServer({ keepAlive: true, noDelay: false }),
              false,
              "request",
              socket => {
                socket.setNoDelay(false);
                return optionsOf(socket);
              },
            ),
          },
          {
            "Bun.serve()": { keepAlive: false, noDelay: true },
            "Bun.listen()": { keepAlive: false, noDelay: true },
            "http.createServer()": { keepAlive: false, noDelay: true },
            "http.createServer({ keepAlive: true, noDelay: false })": { keepAlive: true, noDelay: true },
          },
        );
      } finally {
        for (const client of clients) client.destroy();
      }
    });
  });

  describe("socket.setKeepAlive() on a connection that the server just closed", () => {
    test("returns the socket", async () => {
      const accepted = Promise.withResolvers<net.Socket>();
      const server = http.createServer((req, res) => {
        accepted.resolve(req.socket);
        res.end();
      });
      const client = await connect(await listen(server), false, requests.request);
      try {
        // The client has the response, so the connection is idle for the server.
        await once(client, "data");
        const socket = await accepted.promise;
        const closed = once(socket, "close");
        // The native connection closes now. The socket hears of it in a later task.
        server.closeIdleConnections();
        assert.deepStrictEqual(
          [socket.destroyed, socket.setKeepAlive(true, 5000) === socket, socket.setKeepAlive(false) === socket],
          [false, true, true],
        );
        await closed;
      } finally {
        client.destroy();
        server.close();
      }
    });
  });

  describe("Node.js compatibility", () => {
    const node = nodeExe();
    (node ? test : test.skip)("the tests of the first two blocks pass in Node.js", async () => {
      // A direct run, not `node --test`: the runner mode forks a second node
      // process per file. node:test still exits non-zero on any failure.
      await using proc = Bun.spawn({
        cmd: [node!, "--v8-pool-size=1", fileURLToPath(import.meta.url)],
        env: { ...bunEnv, UV_THREADPOOL_SIZE: "2" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      assert.deepStrictEqual({ exitCode, output: exitCode === 0 ? "" : stdout + stderr }, { exitCode: 0, output: "" });
    });
  });
}
