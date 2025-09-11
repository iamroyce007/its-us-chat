const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// Users mapping shortName -> socketId
const users = {}; 
// Message storage: msgId -> message
const messages = new Map();
// Offline message queue: username -> [messages]
const offlineQueue = {};

// Map short username to full display name
const DISPLAY_NAMES = {
  AR: "Anirudh Ramakrishnan",
  BK: "Bodireddy Kiran"
};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("register", (shortName) => {
    users[shortName] = socket.id;
    socket.shortName = shortName;
    console.log(`Registered: ${DISPLAY_NAMES[shortName] || shortName}`);

    // Send queued messages
    if (offlineQueue[shortName]) {
      offlineQueue[shortName].forEach((msg) => {
        io.to(socket.id).emit("newMessage", msg);
      });
      delete offlineQueue[shortName];
    }
  });

  socket.on("sendMessage", (msg) => {
    messages.set(msg.msgId, msg);
    const toSocket = users[msg.to];
    if (toSocket) {
      io.to(toSocket).emit("newMessage", msg);
    } else {
      // queue offline
      if (!offlineQueue[msg.to]) offlineQueue[msg.to] = [];
      offlineQueue[msg.to].push(msg);
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
    if (socket.shortName) delete users[socket.shortName];
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
