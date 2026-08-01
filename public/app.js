const socket = io();

let myUser = null;
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
  clearMessages();
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

    addMessageBubble({ msgId, from: myUser, content: URL.createObjectURL(new Blob([new Uint8Array(buf)], {type: file.type})), isFile: true, filetype: file.type });
    fileInput.value = '';
  } else if (text) {
    socket.emit("sendMessage", { msgId, from: myUser, to: currentContact, isFile: false, text });

    addMessageBubble({ msgId, from: myUser, content: text, isFile: false });
    textInput.value = '';
  }
};

// Receive messages
socket.on("newMessage", (m) => {
  if (m.to !== myUser) return;

  const content = m.isFile ? URL.createObjectURL(new Blob([new Uint8Array(m.buffer)], {type: m.filetype})) : m.text;
  addMessageBubble({ msgId: m.msgId, from: m.from, content, isFile: m.isFile, filetype: m.filetype });
  socket.emit("seenMessage", m.msgId);
});

// The server retires a message once the recipient has seen it and tells both
// participants. Without this handler that event was ignored: the bubble only
// ever went away on its own 7s timer, so a message the server had already
// deleted could still be on screen.
socket.on("deleteMessage", (msgId) => removeMessageBubble(msgId));

// Blob URLs for received files, so they can be released. Each one pins its
// blob in memory until revoked, and a session of image sharing otherwise
// holds every file it ever displayed until the tab is closed.
const objectUrls = new Map(); // msgId => object URL

function clearMessages() {
  // Emptying the pane on its own would strip the bubbles but leave their
  // blobs alive with nothing left holding a reference to revoke them.
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
  messagesDiv.innerHTML = "";
}

function removeMessageBubble(msgId) {
  const url = objectUrls.get(msgId);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrls.delete(msgId);
  }
  const wrap = messagesDiv.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
  if (wrap) wrap.remove();
}

// Add message to chat with 7s auto-remove
function addMessageBubble({msgId, from, content, isFile, filetype}) {
  const wrap = document.createElement("div");
  wrap.className = "msg";
  wrap.dataset.msgId = msgId;
  if (isFile) objectUrls.set(msgId, content);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerText = `${USER_MAP[from]} • ${new Date().toLocaleTimeString()}`;
  wrap.appendChild(meta);

  // A file picked with no recognised type has an empty string here, and a
  // sender that omitted it entirely leaves it undefined - which used to
  // throw on .startsWith and lose the whole bubble.
  const kind = typeof filetype === "string" ? filetype : "";

  if (isFile && kind.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = content;
    wrap.appendChild(img);
  } else if (isFile && kind.startsWith("video/")) {
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

  // Auto remove after 7s
  setTimeout(() => {
    removeMessageBubble(msgId);
  }, 7000);
}

// Send on Enter key
textInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendBtn.click();
  }
});
