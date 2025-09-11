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
    messages.set(msg.msgId, { ...msg, delivered: false });

    const toSocket = users[msg.to];
    if (toSocket) {
      io.to(toSocket).emit("newMessage", msg);
      msg.delivered = true;
      messages.set(msg.msgId, msg);
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
    if (socket.shortName) {
      delete users[socket.shortName];
      console.log("Disconnected:", socket.shortName);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
