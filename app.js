const socket = io();
let myUser = null;
let myKey = null;
let currentContact = null;

// Short credentials mapping
const LOGIN = {
  "AR": {pass:"138", fullName:"Anirudh Ramakrishnan"},
  "BK": {pass:"152", fullName:"Bodireddy Kiran"}
};

// Crypto functions
async function deriveKey(password, saltText) {
  const enc = new TextEncoder();
  const passKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {name:'PBKDF2', salt: enc.encode(saltText), iterations: 120000, hash:'SHA-256'},
    passKey,
    {name:'AES-GCM', length:256},
    false,
    ['encrypt','decrypt']
  );
}

function toBase64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function fromBase64(b64) { return new Uint8Array(atob(b64).split("").map(c=>c.charCodeAt(0))).buffer; }
async function encryptData(key, plainBuf) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, plainBuf);
  return {iv: toBase64(iv), ciphertext: toBase64(ct)};
}
async function decryptData(key, ivB64, ctB64) {
  const iv = new Uint8Array(fromBase64(ivB64));
  const ct = fromBase64(ctB64);
  return crypto.subtle.decrypt({name:'AES-GCM', iv}, key, ct);
}

// UI Elements
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
loginBtn.onclick = async () => {
  const shortUser = usernameInput.value.trim();
  const pass = passwordInput.value.trim();
  if (!LOGIN[shortUser] || LOGIN[shortUser].pass !== pass) {
    alert("Invalid credentials!");
    return;
  }

  myUser = LOGIN[shortUser].fullName;
  myKey = await deriveKey(pass, "its-us-chat");
  socket.emit('register', myUser);
  showChat();
};

logoutBtn.onclick = () => location.reload();

function showChat() {
  loginScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
  userInfo.innerText = myUser;

  contactsDiv.innerHTML = '';
  Object.values(LOGIN).forEach(u => {
    if (u.fullName === myUser) return;
    const div = document.createElement('div');
    div.className = 'contact';
    div.innerText = u.fullName;
    div.onclick = () => selectContact(u.fullName, div);
    contactsDiv.appendChild(div);
    if (!currentContact) selectContact(u.fullName, div);
  });
}

function selectContact(u, el) {
  currentContact = u;
  document.querySelectorAll('.contact').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  messagesDiv.innerHTML = '';
}

// Send messages
sendBtn.onclick = async () => {
  if (!currentContact) return alert("Select a contact first!");
  const text = textInput.value.trim();
  const file = fileInput.files[0];
  const msgId = Date.now().toString() + Math.random().toString(36).slice(2,8);

  if (file) {
    const buf = await file.arrayBuffer();
    const {iv, ciphertext} = await encryptData(myKey, buf);
    socket.emit("sendMessage", {msgId, from: myUser, to: currentContact, ciphertext, iv, isFile:true, filename:file.name, filetype:file.type});
    addMessage({msgId, from: myUser, content: URL.createObjectURL(file), isFile:true, filetype:file.type});
    fileInput.value = '';
  } else if (text) {
    const enc = new TextEncoder().encode(text);
    const {iv, ciphertext} = await encryptData(myKey, enc.buffer);
    socket.emit("sendMessage", {msgId, from: myUser, to: currentContact, ciphertext, iv, isFile:false});
    addMessage({msgId, from: myUser, content: text, isFile:false});
    textInput.value = '';
  }
};

// Receive messages
socket.on("newMessage", async (m) => {
  if (m.to !== myUser) return;

  try {
    const plainBuf = await decryptData(myKey, m.iv, m.ciphertext);
    let displayContent = m.isFile ? URL.createObjectURL(new Blob([plainBuf], {type:m.filetype})) : new TextDecoder().decode(plainBuf);
    addMessage({msgId: m.msgId, from: m.from, content: displayContent, isFile: m.isFile, filetype:m.filetype});
    socket.emit("seenMessage", m.msgId);

    setTimeout(()=>{document.querySelector(`[data-msg-id="${m.msgId}"]`)?.remove();}, 7000);
  } catch(e){ console.error("Decryption failed:", e);}
});

// Add message bubble
function addMessage({msgId, from, content, isFile, filetype}) {
  const wrap = document.createElement("div");
  wrap.className = "msg";
  wrap.dataset.msgId = msgId;

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerText = `${from} • ${new Date().toLocaleTimeString()}`;
  wrap.appendChild(meta);

  if (isFile) {
    if (filetype.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = content;
      wrap.appendChild(img);
    } else if (filetype.startsWith("video/")) {
      const video = document.createElement("video");
      video.src = content;
      video.controls = true;
      wrap.appendChild(video);
    } else {
      const p = document.createElement("div");
      p.innerText = content;
      wrap.appendChild(p);
    }
  } else {
    const p = document.createElement("div");
    p.innerText = content;
    wrap.appendChild(p);
  }

  messagesDiv.appendChild(wrap);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Blur screen on hide
document.addEvent
