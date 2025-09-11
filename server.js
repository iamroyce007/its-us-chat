const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// Users and messages storage
const users = {}; // username -> socket.id
const messages = {}; // username -> [msg1, msg2, ...]

// Handle socket connections
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("register", (username) => {
    users[username] = socket.id;
    socket.username = username;
    console.log("Registered:", username);

    // Send pending messages to user
    if (messages[username]) {
      messages[username].forEach(msg => {
        io.to(socket.id).emit("newMessage", msg);
      });
    }
  });

  socket.on("sendMessage", (msg) => {
    // Store message for recipient
    if (!messages[msg.to]) messages[msg.to] = [];
    messages[msg.to].push(msg);

    // Deliver if recipient is online
    const toSocket = users[msg.to];
    if (toSocket) io.to(toSocket).emit("newMessage", msg);
  });

  socket.on("seenMessage", (msgId) => {
    // Find the message and set deletion timeout
    for (let user in messages) {
      messages[user] = messages[user].map(m => {
        if (m.msgId === msgId && !m.timeout) {
          m.timeout = setTimeout(() => {
            messages[user] = messages[user].filter(msg => msg.msgId !== msgId);
            io.emit("deleteMessage", msgId);
          }, 7000);
        }
        return m;
      });
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
server.listen(PORT, () => console.log(`🚀 Chat running at http://localhost:${PORT}`));
