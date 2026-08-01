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

// Map short names to full names
const USER_MAP = { AR: "Anirudh Ramakrishnan", BK: "Bodireddy Kiran" };

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

    // Never trust the client's claimed sender; use the registered identity.
    const safeMsg = { ...msg, from: socket.shortName };

    if (safeMsg.isFile) {
      if (!safeMsg.filename || !Array.isArray(safeMsg.buffer)) return;
    } else if (typeof safeMsg.text !== "string" || !safeMsg.text.trim()) {
      return;
    }

    messages.set(safeMsg.msgId, { ...safeMsg, delivered: false });

    const toSocket = users[safeMsg.to];
    if (toSocket) {
      io.to(toSocket).emit("newMessage", safeMsg);
      safeMsg.delivered = true;
      messages.set(safeMsg.msgId, safeMsg);
    }
  });

  socket.on("seenMessage", (msgId) => {
    const m = messages.get(msgId);
    if (m && !m.timeout) {
      m.timeout = setTimeout(() => {
        messages.delete(msgId);
        io.emit("deleteMessage", msgId);
      }, 7000);
      messages.set(msgId, m);
    }
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
