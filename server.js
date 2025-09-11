const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// Store messages and users
const messages = new Map(); // msgId => msg object
const users = {};           // username => socket.id
const offlineQueue = {};    // username => [messages]

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Register user
  socket.on("register", (username) => {
    users[username] = socket.id;
    socket.username = username;
    console.log("Registered:", username);

    // Send any queued messages
    if (offlineQueue[username]) {
      offlineQueue[username].forEach((msg) => {
        io.to(socket.id).emit("newMessage", msg);
      });
      delete offlineQueue[username];
    }
  });

  // Send message
  socket.on("sendMessage", (msg) => {
    messages.set(msg.msgId, msg);
    const toSocket = users[msg.to];
    if (toSocket) {
      io.to(toSocket).emit("newMessage", msg);
    } else {
      // queue if user offline
      if (!offlineQueue[msg.to]) offlineQueue[msg.to] = [];
      offlineQueue[msg.to].push(msg);
    }
  });

  // Seen message → schedule deletion
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
    if (socket.username) {
      delete users[socket.username];
      console.log("Disconnected:", socket.username);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
