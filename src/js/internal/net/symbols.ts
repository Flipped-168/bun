export default {
  kArmHandshakeTimeout: Symbol("kArmHandshakeTimeout"),
  // Set while a socket must receive nothing (an idle socket in an http.Agent
  // pool): the read path destroys the socket instead of delivering the bytes.
  kDestroyOnRead: Symbol("kDestroyOnRead"),
  kPreHandshakeWrite: Symbol("kPreHandshakeWrite"),
  // Internal handshake-settled signal: server-side sockets emit no user
  // 'secureConnect' (node parity), so internal deferrals park on this instead.
  kSecureConnectDone: Symbol("kSecureConnectDone"),
  // Getter of a net.Socket subclass that has no `_handle` (a node:http server socket): the native handle that
  // setKeepAlive() acts on, or undefined for none.
  kSocketOptionHandle: Symbol("kSocketOptionHandle"),
  kVerifyError: Symbol("kVerifyError"),
  // net.Socket.prototype method behind the client-side `new tls.TLSSocket(socket)`.
  kUpgradeClientTLS: Symbol("kUpgradeClientTLS"),
  // True on a client-side `new tls.TLSSocket(socket)`. The TLSSocket constructor sets it.
  kStandaloneWrap: Symbol("kStandaloneWrap"),
};
