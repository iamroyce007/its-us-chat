/**
 * Socket-level tests for the message lifecycle.
 *
 * The server's rules only exist over the wire - who may send as whom, who may
 * retire a message, who is told about it - so these drive real socket.io
 * clients against a real server on an ephemeral port rather than reaching
 * into the module.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { io } = require("socket.io-client");

const PORT = process.env.TEST_PORT || 8123;
const URL = `http://127.0.0.1:${PORT}`;
const SEEN_DELETE_MS = 7000; // must match the server's own constant

let server;
let ar; // registered as AR, the sender throughout
let bk; // registered as BK, the recipient
const sockets = [];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Connect a client and, when given a name, register it. */
function connect(shortName) {
  const socket = io(URL, { transports: ["websocket"] });
  socket.received = [];
  socket.deleted = [];
  socket.on("newMessage", (m) => socket.received.push(m));
  socket.on("deleteMessage", (id) => socket.deleted.push(id));
  sockets.push(socket);
  return new Promise((resolve) => {
    socket.on("connect", () => {
      if (shortName) socket.emit("register", shortName);
      resolve(socket);
    });
  });
}

before(async () => {
  server = spawn("node", [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  await wait(700);
  ar = await connect("AR");
  bk = await connect("BK");
  await wait(200);
});

after(() => {
  for (const socket of sockets) socket.disconnect();
  if (server) server.kill();
});

test("delivers a message and stamps the registered sender on it", async () => {
  // `from` is deliberately wrong here: the server must ignore it.
  ar.emit("sendMessage", { msgId: "m1", from: "BK", to: "BK", isFile: false, text: "hello" });
  await wait(250);

  const got = bk.received.find((m) => m.msgId === "m1");
  assert.ok(got, "message was not delivered");
  assert.equal(got.text, "hello");
  assert.equal(got.from, "AR");
});

test("ignores server bookkeeping fields sent by a client", async () => {
  ar.emit("sendMessage", {
    msgId: "m2",
    to: "BK",
    isFile: false,
    text: "hi",
    delivered: true,
    timeout: 1,
  });
  await wait(250);

  const got = bk.received.find((m) => m.msgId === "m2");
  assert.ok(got, "message was not delivered");
  assert.equal(got.delivered, undefined);
  assert.equal(got.timeout, undefined);
});

test("refuses a message from a socket that never registered", async () => {
  const stranger = await connect(null);
  stranger.emit("sendMessage", { msgId: "m3", to: "BK", isFile: false, text: "unregistered" });
  await wait(300);

  assert.ok(!bk.received.some((m) => m.msgId === "m3"));
});

test("rejects an oversized message", async () => {
  ar.emit("sendMessage", { msgId: "m4", to: "BK", isFile: false, text: "x".repeat(5000) });
  await wait(300);

  assert.ok(!bk.received.some((m) => m.msgId === "m4"));
});

test("carries a file far larger than the old array-of-bytes ceiling", async () => {
  // 1 MB. Encoded as an array of byte numbers this was roughly 4 MB of JSON,
  // which exceeded the transport's frame limit: the file never arrived and the
  // sender's socket was closed instead.
  const payload = Buffer.alloc(1024 * 1024, 7);
  let senderDropped = false;
  ar.once("disconnect", () => {
    senderDropped = true;
  });

  ar.emit("sendMessage", {
    msgId: "f1",
    to: "BK",
    isFile: true,
    filename: "big.bin",
    filetype: "application/octet-stream",
    buffer: payload,
  });
  await wait(1500);

  assert.ok(!senderDropped, "the sender's connection was closed by the payload");
  const got = bk.received.find((m) => m.msgId === "f1");
  assert.ok(got, "the file was not delivered");
  assert.equal(got.filename, "big.bin");
  assert.equal(Buffer.from(got.buffer).length, payload.length);
});

test("rejects a file payload sent as an array of byte numbers", async () => {
  ar.emit("sendMessage", {
    msgId: "f2",
    to: "BK",
    isFile: true,
    filename: "small.bin",
    filetype: "application/octet-stream",
    buffer: [1, 2, 3],
  });
  await wait(300);

  assert.ok(!bk.received.some((m) => m.msgId === "f2"));
});

test("refuses to reuse the id of a message still in flight", async () => {
  // Queue one for BK while they are away, then try to store over it.
  bk.disconnect();
  await wait(300);

  ar.emit("sendMessage", { msgId: "dup", to: "BK", isFile: false, text: "original" });
  await wait(250);
  ar.emit("sendMessage", { msgId: "dup", to: "BK", isFile: false, text: "clobbered" });
  await wait(250);

  bk = await connect("BK");
  await wait(400);

  const got = bk.received.filter((m) => m.msgId === "dup");
  assert.equal(got.length, 1);
  assert.equal(got[0].text, "original", "a queued message was overwritten");
});

test("only the recipient can retire a message, and only they are told", async () => {
  const stranger = await connect(null);

  stranger.emit("seenMessage", "m2");
  await wait(300);
  assert.deepEqual(bk.deleted, [], "a third party started the deletion");
  assert.deepEqual(ar.deleted, []);

  bk.emit("seenMessage", "m2");
  await wait(SEEN_DELETE_MS + 500);

  assert.ok(bk.deleted.includes("m2"));
  assert.ok(ar.deleted.includes("m2"));
  assert.ok(!stranger.deleted.includes("m2"), "the delete was broadcast to everyone");
});

test("a late disconnect does not evict the reconnected identity", async () => {
  bk.disconnect();
  await wait(200);
  bk = await connect("BK");
  await wait(300);

  ar.emit("sendMessage", { msgId: "m5", to: "BK", isFile: false, text: "after reconnect" });
  await wait(300);

  assert.ok(
    bk.received.some((m) => m.msgId === "m5"),
    "the reconnected socket is registered but unroutable"
  );
});
