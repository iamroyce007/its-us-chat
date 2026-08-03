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
function connect(shortName, url = URL) {
  const socket = io(url, { transports: ["websocket"] });
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

test("delivers a file larger than the transport's default payload ceiling", async () => {
  // A file crosses the wire as a JSON array of byte values, so 600 KB of file
  // is ~2.4 MB of payload - past engine.io's 1 MB default, and far under the
  // 10 MB the server says it accepts. It used to disconnect the sender
  // mid-send rather than deliver the file or reject it.
  const buffer = Array.from({ length: 600 * 1024 }, () => 200);
  let dropped = false;
  ar.on("disconnect", () => {
    dropped = true;
  });

  ar.emit("sendMessage", {
    msgId: "big",
    to: "BK",
    isFile: true,
    filename: "big.bin",
    buffer,
  });
  await wait(2500);

  assert.ok(!dropped, "the sender was disconnected mid-send");
  const got = bk.received.find((m) => m.msgId === "big");
  assert.ok(got, "the file was not delivered");
  assert.equal(got.buffer.length, buffer.length);
});

test("evicts the oldest message once the store reaches its ceiling", async () => {
  // A message nobody sees is never retired by seenMessage, so the store used
  // to grow for the life of the process. Run a server with a ceiling of two to
  // watch the third send push the first one out.
  const port = Number(PORT) + 1;
  const capped = spawn("node", [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), MAX_STORED_MESSAGES: "2" },
    stdio: "ignore",
  });
  await wait(700);

  const url = `http://127.0.0.1:${port}`;
  const sender = await connect("AR", url);
  const recipient = await connect("BK", url);
  await wait(200);

  try {
    // Nobody marks these seen; only the ceiling can retire them.
    for (const msgId of ["e1", "e2", "e3"]) {
      sender.emit("sendMessage", { msgId, to: "BK", isFile: false, text: msgId });
      await wait(150);
    }
    await wait(300);

    assert.ok(recipient.deleted.includes("e1"), "the oldest message was not evicted");
    assert.ok(!recipient.deleted.includes("e2"));
    assert.ok(!recipient.deleted.includes("e3"));
    assert.ok(sender.deleted.includes("e1"), "the sender was not told about the eviction");
  } finally {
    capped.kill();
  }
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
