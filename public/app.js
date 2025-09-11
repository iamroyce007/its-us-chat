const socket = io();

let myUser = null;
let myKey = null;
let currentContact = null;

// Credentials
const USERS = { AR: "138", BK: "152" };
const USER_MAP = { AR: "Anirudh Ramakrishnan", BK: "Bodireddy Kiran" };

// UI
const loginScreen = document.getElementById('loginScreen');
const chatScreen = document.getElementById('chatScreen');
const loginBtn = document.getElementById('loginBtn');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const userInfo = document.getElementById('userInfo');
const contactsDiv = document.getElementById('contacts');
const messagesDiv = document.getElementById('messages');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');
const fileInput = document.getElementById('fileInput');
const logoutBtn = document.getElementById('logoutBtn');

// Login
loginBtn.onclick = () => {
  const u = usernameInput.value.trim();
  const p = passwordInput.value.trim();

  if (!USERS[u] || USERS[u] !== p) {
    alert("Invalid credentials!");
    return;
  }

  myUser = u;
  socket.emit("register", myUser);
  showChat();
};

logoutBtn.onclick = () => location.reload();

function showChat() {
  loginScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
  userInfo.innerText = USER_MAP[myUser];

  // contacts
  contactsDiv.innerHTML = "";
  for (let u in USERS) {
    if (u === myUser) continue;
    const div = document.createElement("div");
    div.className = "contact";
    div.innerText = USER_MAP[u];
    div.onclick = () => selectContact(u, div);
    contactsDiv.appendChild(div);
    if (!currentContact) selectContact(u, div);
  }
}

function selectContact(u, el) {
  currentContact = u;
  document.querySelectorAll(".contact").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  messagesDiv.innerHTML = "";
}

// Messages
sendBtn.onclick = async () => {
  if (!currentContact) return alert("Select a contact!");

  const text = textInput.value.trim();
  const file = fileInput.files[0];
  const msgId = Date.now().toString() + Math.random().toString(36).slice(2,8);

  if (file) {
    const buf = await file.arrayBuffer();
    socket.emit("sendMessage", {
      msgId, from: myUser, to: currentContact,
      isFile: true, filename: file.name, filetype: file.type, buffer: Array.from(new Uint8Array(buf))
    });
    fileInput.value = '';
  } else if (text) {
    socket.emit("sendMessage", { msgId, from: myUser, to: currentContact, isFile: false, text });
    textInput.value = '';
  }
};

// Receive messages
socket.on("newMessage", (m) => {
  if (m.to !== myUser) return;

  let content = m.isFile ? URL.createObjectURL(new Blob([new Uint8Array(m.buffer)], {type: m.filetype})) : m.text;
  addMessageBubble({ msgId: m.msgId, from: m.from, content, isFile: m.isFile, filetype: m.filetype });
  socket.emit("seenMessage", m.msgId);

  setTimeout(() => document.querySelector(`[data-msg-id="${m.msgId}"]`)?.remove(), 7000);
});

function addMessageBubble({msgId, from, content, isFile, filetype}) {
  const wrap = document.createElement("div");
  wrap.className = "msg";
  wrap.dataset.msgId = msgId;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerText = `${USER_MAP[from]} • ${new Date().toLocaleTimeString()}`;
  wrap.appendChild(meta);

  if (isFile && filetype.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = content;
    wrap.appendChild(img);
  } else if (isFile && filetype.startsWith("video/")) {
    const video = document.createElement("video");
    video.controls = true;
    video.src = content;
    wrap.appendChild(video);
  } else {
    const p = document.createElement("div");
    p.innerText = content;
    wrap.appendChild(p);
  }

  messagesDiv.appendChild(wrap);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}
