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

// How long a message lingers after the recipient has seen it. Matches the
// client's own bubble timeout.
const SEEN_DELETE_MS = 7000;

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
    if (deletionTimers.has(msgId)) return;

    deletionTimers.set(
      msgId,
      setTimeout(() => {
        deletionTimers.delete(msgId);
        messages.delete(msgId);
        emitToParticipants(m, "deleteMessage", msgId);
      }, SEEN_DELETE_MS)
    );
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
