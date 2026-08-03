const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Users and messages
const users = {};       // { shortName: socketId }
const messages = new Map(); // msgId => message object
// Pending deletions, keyed by message id. Kept beside the store rather than
// on the message itself: the message object is emitted over the wire, and a
// Timer handle has no business being serialised into it.
const deletionTimers = new Map(); // msgId => Timeout

// Message ids whose post-seen countdown has already begun. Kept apart from
// deletionTimers because every stored message now carries a timer, so the
// presence of one no longer means "the recipient has seen this".
const seenMessages = new Set();

// How long a message lingers after the recipient has seen it. Matches the
// client's own bubble timeout.
const SEEN_DELETE_MS = 7000;

// Ceilings on the message store itself. Only seenMessage ever retired a
// message, and an offline recipient never sends one - so anything undelivered
// stayed in memory for the lifetime of the process. With file payloads allowed
// up to MAX_FILE_BYTES apiece, that store is by far the largest thing this
// server holds, and it only ever grew.
const UNSEEN_EXPIRY_MS = Number(process.env.UNSEEN_EXPIRY_MS) || 24 * 60 * 60 * 1000;
// An expiry alone still lets a whole day's traffic pile up, so cap the count
// as well and evict oldest-first. Map iterates in insertion order.
const MAX_STORED_MESSAGES = Number(process.env.MAX_STORED_MESSAGES) || 500;

// Map short names to full names
const USER_MAP = { AR: "Anirudh Ramakrishnan", BK: "Bodireddy Kiran" };

// Payload ceilings. Files arrive as a plain array of byte values, one JS
// number per byte, so an unbounded upload is many times its own size in
// server memory before anything checks it.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 255;
const MAX_TEXT_LENGTH = 4000;

/** Emit to whichever of a message's two participants are connected. */
function emitToParticipants(msg, event, payload) {
  for (const shortName of new Set([msg.from, msg.to])) {
    const socketId = users[shortName];
    if (socketId) io.to(socketId).emit(event, payload);
  }
}

/** Drop a message and release everything held alongside it. */
function forgetMessage(msgId) {
  const timer = deletionTimers.get(msgId);
  if (timer) clearTimeout(timer);
  deletionTimers.delete(msgId);
  seenMessages.delete(msgId);
  messages.delete(msgId);
}

/**
 * Schedule a message's removal, replacing whatever timer it already had. Every
 * message gets one at send time; seeing it only shortens the wait.
 */
function scheduleDeletion(msg, delayMs) {
  const existing = deletionTimers.get(msg.msgId);
  if (existing) clearTimeout(existing);

  deletionTimers.set(
    msg.msgId,
    setTimeout(() => {
      forgetMessage(msg.msgId);
      emitToParticipants(msg, "deleteMessage", msg.msgId);
    }, delayMs)
  );
}

/** Evict oldest-first until the store is back under its ceiling. */
function evictOverflow() {
  while (messages.size > MAX_STORED_MESSAGES) {
    const oldest = messages.keys().next().value;
    if (oldest === undefined) return;
    const msg = messages.get(oldest);
    forgetMessage(oldest);
    if (msg) emitToParticipants(msg, "deleteMessage", oldest);
  }
}

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("register", (shortName) => {
    if (!USER_MAP[shortName]) return; // unknown user

    const existing = users[shortName];
    if (existing && existing !== socket.id && io.sockets.sockets.get(existing)) {
      return; // identity already active on another connection
    }

    users[shortName] = socket.id;
    socket.shortName = shortName;

    // Send pending messages to this user
    for (let [msgId, msg] of messages) {
      if (msg.to === shortName && !msg.delivered) {
        io.to(socket.id).emit("newMessage", msg);
        msg.delivered = true;
      }
    }

    console.log("Registered:", shortName);
  });

  socket.on("sendMessage", (msg) => {
    if (!socket.shortName) return; // must register before sending
    if (!msg || typeof msg.msgId !== "string" || !msg.msgId) return;
    if (!USER_MAP[msg.to]) return; // unknown recipient

    // Build the stored message from named fields rather than spreading what
    // the client sent. A spread also copied the server's own bookkeeping if
    // the client chose to send it: `delivered: true` made the message skip
    // the pending-delivery pass on register, and a truthy `timeout` made
    // seenMessage believe deletion was already scheduled, so the message
    // survived the auto-delete this app is built around.
    let safeMsg;
    if (msg.isFile) {
      if (typeof msg.filename !== "string" || !msg.filename) return;
      if (!Array.isArray(msg.buffer) || msg.buffer.length > MAX_FILE_BYTES) return;
      safeMsg = {
        msgId: msg.msgId,
        from: socket.shortName, // never the client's claimed sender
        to: msg.to,
        isFile: true,
        filename: msg.filename.slice(0, MAX_FILENAME_LENGTH),
        filetype: typeof msg.filetype === "string" ? msg.filetype : "",
        buffer: msg.buffer,
      };
    } else {
      if (typeof msg.text !== "string" || !msg.text.trim()) return;
      if (msg.text.length > MAX_TEXT_LENGTH) return;
      safeMsg = {
        msgId: msg.msgId,
        from: socket.shortName,
        to: msg.to,
        isFile: false,
        text: msg.text,
      };
    }

    messages.set(safeMsg.msgId, { ...safeMsg, delivered: false });
    scheduleDeletion(safeMsg, UNSEEN_EXPIRY_MS);
    evictOverflow();

    const toSocket = users[safeMsg.to];
    if (toSocket) {
      io.to(toSocket).emit("newMessage", safeMsg);
      messages.set(safeMsg.msgId, { ...safeMsg, delivered: true });
    }
  });

  socket.on("seenMessage", (msgId) => {
    if (typeof msgId !== "string") return;

    const m = messages.get(msgId);
    // Only the recipient can start the countdown. Any connected socket used
    // to be able to retire someone else's message by naming its id, and the
    // deletion was then broadcast to every client rather than to the two
    // people in the conversation.
    if (!m || m.to !== socket.shortName) return;
    if (seenMessages.has(msgId)) return; // countdown already running

    seenMessages.add(msgId);
    scheduleDeletion(m, SEEN_DELETE_MS);
  });

  socket.on("disconnect", () => {
    if (!socket.shortName) return;

    // Only clear the slot if this socket still owns it. A dropped connection
    // is not always noticed before the same user reconnects: register() sees
    // the old socket is gone and hands the identity to the new one, and the
    // late disconnect event then deleted an entry that now belongs to the
    // live connection - leaving the user registered but unroutable, with
    // every message to them queued as undelivered.
    if (users[socket.shortName] === socket.id) {
      delete users[socket.shortName];
      console.log("Disconnected:", socket.shortName);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
