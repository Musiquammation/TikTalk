(() => {
  // app/groups.ts
  var groups = new Array();
  var currentGroup = null;
  function generateStorageItemName() {
    const username = getUsername();
    if (username === null)
      throw new Error("Group pool not specified");
    return "tiktalk-groups:" + username;
  }
  var html_groupList = document.getElementById("groupList");
  function onGroupClick(e) {
    const groupId = e.currentTarget.getAttribute("groupId");
    const username = getUsername();
    if (groupId && username) {
      openGroup(groupId, username);
    }
  }
  function createHTML(group) {
    const div = document.createElement("div");
    let innerHTML = `<span>${group.usernames?.join(", ")}</span>`;
    if (group.missed > 0)
      innerHTML += `<span>${group.missed}</span>`;
    div.innerHTML = innerHTML;
    div.setAttribute("groupId", group.id);
    div.addEventListener("click", onGroupClick);
    return div;
  }
  function openGroup(id, username) {
    const group = groups.find((i) => i.id === id);
    if (!group) {
      throw new Error("Cannot find group " + id);
    }
    currentGroup = group;
    const usernames = [
      ...group.usernames.slice(0, group.pos),
      username,
      ...group.usernames.slice(group.pos)
    ];
    conversation.open(id, group.pos, usernames, {
      send(content, msgId) {
        sendMessage(content, id, msgId);
      },
      typing(type) {
        sendTyping(id, type);
      }
    });
    sendGroupOpen(id);
  }
  function loadGroups() {
    html_groupList.innerHTML = "";
    groups.length = 0;
    const str = localStorage.getItem(generateStorageItemName());
    if (!str) {
      return;
    }
    for (let g of JSON.parse(str)) {
      groups.push(g);
    }
    groups.sort((a, b) => {
      if (a.missed && !b.missed) return -1;
      if (!a.missed && b.missed) return 1;
      return a.lastMsg - b.lastMsg;
    });
    for (let g of groups) {
      html_groupList.appendChild(createHTML(g));
    }
  }
  function updateGroupStorage() {
    localStorage.setItem(generateStorageItemName(), JSON.stringify(groups));
  }
  function updateGroup(group) {
    const existingIndex = groups.findIndex((g) => g.id === group.id);
    if (existingIndex !== -1)
      groups.splice(existingIndex, 1);
    const insertIndex = groups.findIndex((sibling) => {
      if (group.missed && !sibling.missed) return true;
      if (!group.missed && sibling.missed) return false;
      return group.lastMsg < sibling.lastMsg;
    });
    if (insertIndex !== -1) {
      groups.splice(insertIndex, 0, group);
    } else {
      groups.push(group);
    }
    const existingDiv = html_groupList.querySelector(`[groupId="${group.id}"]`);
    if (existingDiv) existingDiv.remove();
    const insertBefore = Array.from(html_groupList.children).find((el) => {
      const siblingId = el.getAttribute("groupId");
      const sibling = groups.find((g) => g.id === siblingId);
      if (!sibling) return false;
      if (group.missed && !sibling.missed) return true;
      if (!group.missed && sibling.missed) return false;
      return group.lastMsg < sibling.lastMsg;
    });
    const newDiv = createHTML(group);
    if (insertBefore) {
      html_groupList.insertBefore(newDiv, insertBefore);
    } else {
      html_groupList.appendChild(newDiv);
    }
  }
  function handleMissedGroups(missed) {
    for (const m of missed) {
      let group = groups.find((g) => g.id === m.group);
      if (!group) {
        throw new Error("Group not found");
      }
      group.missed = m.count;
      group.lastMsg = m.date * 1e3;
      updateGroup(group);
    }
    updateGroupStorage();
  }
  function incMissedMsgInGroup(id, date, inc = 1) {
    const group = groups.find((g) => g.id === id);
    if (!group) {
      throw new Error("Cannot find group " + id);
    }
    group.missed = (group.missed ?? 0) + inc;
    if (date > group.lastMsg)
      group.lastMsg = date;
    updateGroup(group);
    updateGroupStorage();
  }
  function resetMissedMsgInGroup(id, date) {
    const group = groups.find((g) => g.id === id);
    if (!group) {
      throw new Error("Cannot find group " + id);
    }
    group.missed = 0;
    if (date > group.lastMsg)
      group.lastMsg = date;
    updateGroup(group);
    updateGroupStorage();
  }
  function appendGroup(group) {
    updateGroup(group);
    updateGroupStorage();
  }
  function getGroup(id = null) {
    if (id === null) {
      if (!currentGroup)
        throw new Error("No current group");
      return currentGroup;
    }
    const group = groups.find((i) => i.id === id);
    if (!group) {
      throw new Error("Cannot find group " + id);
    }
    return group;
  }
  function collectBlacklist(couldown) {
    if (currentGroup === null)
      return [];
    const blacklist = /* @__PURE__ */ new Set();
    const now = Date.now();
    for (const group of groups)
      if (now - group.lastMsg >= couldown)
        for (const user of group.users)
          blacklist.add(user);
    return Array.from(blacklist);
  }

  // app/servAddresses.ts
  var SERV_RQST_ADDRESS = window.SERV_RQST_ADDRESS;
  var SERV_SOCK_ADDRESS = window.SERV_SOCK_ADDRESS;

  // app/net.ts
  var BLACKLIST_COULDOWN = 60 * 6e4;
  var global = null;
  function startConnection(data) {
    if (global) {
      console.warn("Closing previous socket");
      global.socket.close();
    }
    const session = data.token;
    const socket = new WebSocket(SERV_SOCK_ADDRESS);
    global = {
      socket,
      session
    };
    console.log("Start session:", session);
    socket.addEventListener("open", (e) => {
      socket.send(JSON.stringify({
        action: "login",
        session
      }));
    });
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      switch (msg.action) {
        case "login-ok":
          setUsername(msg.username, msg.userId);
          handleMissedGroups(msg.missed);
          break;
        case "askTalk":
          console.log("Task request received");
          break;
        case "group": {
          appendGroup({
            users: msg.users,
            usernames: msg.usernames,
            id: msg.groupId,
            lastMsg: Date.now(),
            pos: msg.pos,
            missed: 0
          });
          setTalkRequestButton("talk");
          break;
        }
        case "cancelTalk": {
          setTalkRequestButton("talk");
          break;
        }
        case "startConv": {
          const missedList = msg.missed;
          console.log(missedList);
          console.log("Connected are:", msg.connected);
          const date = missedList.length > 0 ? missedList[missedList.length - 1].date : Date.now();
          const group = getGroup();
          resetMissedMsgInGroup(group.id, date);
          for (const m of missedList) {
            let idx = group.users.indexOf(m.author);
            if (idx >= group.pos)
              idx++;
            console.log(idx);
            conversation.add(m.content, idx, m.date * 1e3);
          }
          updateGroupStorage();
          break;
        }
        case "push": {
          conversation.add(msg.content, msg.author, msg.date);
          break;
        }
        case "wellSent": {
          conversation.markAsSent(msg.msgId, msg.date);
          break;
        }
        case "miss": {
          console.log("Miss of", msg.author);
          incMissedMsgInGroup(msg.groupId, msg.date);
          break;
        }
        case "typing": {
          if (msg.groupId !== getGroup().id)
            return;
          if (msg.typing) {
            conversation.addTyping(msg.author);
          } else {
            conversation.removeTyping(msg.author);
          }
          break;
        }
        case "enterConv": {
          console.log(`User #${msg.author} enters`);
          break;
        }
        case "quitConv": {
          console.log(`User #${msg.author} quits`);
          if (msg.groupId !== getGroup().id)
            return;
          conversation.removeTyping(msg.author);
          break;
        }
        case "error":
          console.error(msg.label);
          break;
        default:
          throw new Error("Invalid action");
      }
    });
  }
  function toggleTalkRequest() {
    switch (getTalkRequestStatus()) {
      case "talk":
        sendTalkRequest();
        return "cancel";
      case "cancel":
        cancelTalkRequest();
        return "canceling";
      case "canceling":
        return null;
    }
  }
  function sendTalkRequest() {
    if (!global)
      throw new Error("No socket to use");
    global.socket.send(JSON.stringify({
      action: "askTalk",
      session: global.session,
      blacklist: collectBlacklist(BLACKLIST_COULDOWN)
    }));
  }
  function sendMessage(content, groupId, msgId) {
    if (!global)
      throw new Error("No socket to use");
    global.socket.send(JSON.stringify({
      action: "message",
      session: global.session,
      content,
      groupId,
      msgId
    }));
  }
  function sendTyping(groupId, typing) {
    if (!global)
      throw new Error("No socket to use");
    global.socket.send(JSON.stringify({
      action: typing ? "typing-on" : "typing-off",
      session: global.session,
      groupId
    }));
  }
  function sendGroupOpen(groupId) {
    if (!global)
      throw new Error("No socket to use");
    const userId = getUserId();
    if (userId === null)
      throw new TypeError("UserId is undefined");
    const group = getGroup(groupId);
    const allUsers = [
      ...group.users.slice(0, group.pos),
      userId,
      ...group.users.slice(group.pos)
    ];
    global.socket.send(JSON.stringify({
      action: "openConv",
      session: global.session,
      groupId,
      allUsers
    }));
  }
  function cancelTalkRequest() {
    if (!global)
      throw new Error("No socket to use");
    global.socket.send(JSON.stringify({
      action: "cancelTalk",
      session: global.session
    }));
  }
  function stopConnection() {
    if (!global)
      return;
    global.socket.close();
    localStorage.removeItem("tiktalk-connection");
    global = null;
  }

  // app/Conversation.ts
  var Conversation = class _Conversation {
    static BLOCK_SIZE = 32;
    static DB_NAME = "conversations_db";
    static DB_VERSION = 1;
    static STORE_NAME = "conversations";
    panel;
    db = null;
    currentId = null;
    usernames = [];
    loadedBlocks = 0;
    totalMessages = 0;
    blockCount = 0;
    // DOM elements
    messagesEl = null;
    loaderEl = null;
    inputEl = null;
    sendBtn = null;
    // Pending (waiting) messages: temp id → { element, content, date }
    pendingMessages = /* @__PURE__ */ new Map();
    pos = -1;
    typingAuthors = /* @__PURE__ */ new Set();
    typingEl = null;
    typingInterval = null;
    constructor(panel2) {
      this.panel = panel2;
      this.panel.classList.add("conv-panel");
    }
    // ─── IndexedDB ────────────────────────────────────────────────────────────
    openDB() {
      return new Promise((resolve, reject) => {
        if (this.db) return resolve(this.db);
        const req = indexedDB.open(_Conversation.DB_NAME, _Conversation.DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(_Conversation.STORE_NAME)) {
            db.createObjectStore(_Conversation.STORE_NAME, { keyPath: "id" });
          }
        };
        req.onsuccess = (e) => {
          this.db = e.target.result;
          resolve(this.db);
        };
        req.onerror = () => reject(req.error);
      });
    }
    async dbGet(id) {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(_Conversation.STORE_NAME, "readonly");
        const req = tx.objectStore(_Conversation.STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    async dbPut(record) {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(_Conversation.STORE_NAME, "readwrite");
        const req = tx.objectStore(_Conversation.STORE_NAME).put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }
    // ─── Meta & block helpers ─────────────────────────────────────────────────
    metaId(convId) {
      return `${convId}_meta`;
    }
    blockId(convId, blockIndex) {
      return `${convId}_${blockIndex}`;
    }
    async getMeta(convId) {
      return this.dbGet(this.metaId(convId));
    }
    async getBlock(convId, blockIndex) {
      return this.dbGet(this.blockId(convId, blockIndex));
    }
    /**
     * Appends a message to the last block, creating a new one if the current
     * block is full (>= BLOCK_SIZE). Persists both the block and the meta.
     * Returns the block the message was written into.
     */
    async pushMessage(convId, message) {
      let meta = await this.getMeta(convId);
      if (!meta) {
        meta = { id: this.metaId(convId), totalMessages: 0, blockCount: 0 };
      }
      let targetBlock;
      if (meta.blockCount === 0) {
        targetBlock = { id: this.blockId(convId, 0), messages: [] };
        meta.blockCount = 1;
      } else {
        const lastIndex = meta.blockCount - 1;
        const lastBlock = await this.getBlock(convId, lastIndex);
        if (!lastBlock) {
          throw new Error(`Block ${lastIndex} missing for conversation "${convId}".`);
        }
        if (lastBlock.messages.length >= _Conversation.BLOCK_SIZE) {
          targetBlock = { id: this.blockId(convId, meta.blockCount), messages: [] };
          meta.blockCount++;
        } else {
          targetBlock = lastBlock;
        }
      }
      targetBlock.messages.push(message);
      meta.totalMessages++;
      await this.dbPut(targetBlock);
      await this.dbPut(meta);
      this.totalMessages = meta.totalMessages;
      this.blockCount = meta.blockCount;
      return targetBlock;
    }
    // ─── Public API ───────────────────────────────────────────────────────────
    /**
     * Opens the conversation in the panel.
     * Creates the conversation meta in the DB if it doesn't exist.
     * Loads the first 2 blocks of messages.
     */
    async open(id, pos, usernames, eventHandler) {
      focusOnAppConv();
      this.pos = pos;
      this.currentId = id;
      this.usernames = usernames;
      this.loadedBlocks = 0;
      this.typingAuthors.clear();
      if (this.typingEl) {
        this.typingEl.remove();
        this.typingEl = null;
      }
      let meta = await this.getMeta(id);
      if (!meta) {
        meta = { id: this.metaId(id), totalMessages: 0, blockCount: 0 };
        await this.dbPut(meta);
      }
      this.totalMessages = meta.totalMessages;
      this.blockCount = meta.blockCount;
      this.panel.innerHTML = "";
      this.panel.setAttribute("data-conv-id", id);
      this.panel.appendChild(this.buildHeader(usernames));
      this.loaderEl = this.buildLoader();
      this.panel.appendChild(this.loaderEl);
      this.messagesEl = document.createElement("div");
      this.messagesEl.className = "conv-messages";
      this.panel.appendChild(this.messagesEl);
      this.typingEl = document.createElement("div");
      this.typingEl.className = "conv-typing";
      this.typingEl.style.display = "none";
      this.panel.appendChild(this.typingEl);
      this.panel.appendChild(this.buildInputBar(eventHandler));
      await this.loadBlock();
      await this.loadBlock();
      this.updateLoader();
      this.setupScrollLoader();
    }
    /**
     * Appends a new message to the conversation (DB + DOM).
     */
    async add(msg, author, date) {
      if (!this.currentId) throw new Error("No conversation open.");
      const message = { content: msg, author, date };
      await this.pushMessage(this.currentId, message);
      if (this.messagesEl) {
        this.messagesEl.appendChild(this.buildMessageEl(message));
        this.scrollToBottom();
      }
      this.updateLoader();
    }
    // ─── Block loading ────────────────────────────────────────────────────────
    /**
     * Loads the next older block into the DOM.
     * Blocks are stored from index 0 (oldest) to blockCount-1 (newest).
     * We load newest-first, so the first call loads blockCount-1, then blockCount-2, etc.
     */
    async loadBlock() {
      if (!this.messagesEl || !this.currentId) return;
      const blockIndex = this.blockCount - 1 - this.loadedBlocks;
      if (blockIndex < 0) return;
      const block = await this.getBlock(this.currentId, blockIndex);
      if (!block || block.messages.length === 0) return;
      const fragment = document.createDocumentFragment();
      for (const msg of block.messages) {
        fragment.appendChild(this.buildMessageEl(msg));
      }
      if (this.loadedBlocks === 0) {
        this.messagesEl.appendChild(fragment);
        this.rebuildDateSeparators(this.messagesEl);
        this.scrollToBottom();
      } else {
        const prevScrollHeight = this.messagesEl.scrollHeight;
        this.messagesEl.prepend(fragment);
        this.rebuildDateSeparators(this.messagesEl);
        this.messagesEl.scrollTop += this.messagesEl.scrollHeight - prevScrollHeight;
      }
      this.loadedBlocks++;
    }
    setupScrollLoader() {
      if (!this.messagesEl) return;
      this.messagesEl.addEventListener("scroll", async () => {
        if (this.messagesEl.scrollTop < 80) {
          const loadedCount = this.loadedBlocks * _Conversation.BLOCK_SIZE;
          if (loadedCount < this.totalMessages) {
            await this.loadBlock();
            this.updateLoader();
          }
        }
      });
    }
    /**
     * Confirms a pending message: removes .waiting, persists it to the DB.
     */
    async markAsSent(id, date) {
      if (!this.currentId) throw new Error("No conversation open.");
      const pending = this.pendingMessages.get(id);
      if (!pending) throw new Error(`No pending message with id ${id}.`);
      pending.el.classList.remove("waiting");
      this.pendingMessages.delete(id);
      const message = {
        content: pending.content,
        author: this.pos,
        date: pending.date
      };
      await this.pushMessage(this.currentId, message);
      this.updateLoader();
    }
    // ─── DOM builders ─────────────────────────────────────────────────────────
    buildHeader(usernames) {
      const header = document.createElement("div");
      header.className = "conv-header";
      const menuBtn = document.createElement("button");
      menuBtn.id = "convMenuBtn";
      menuBtn.textContent = "\u2630";
      const title = document.createElement("span");
      title.className = "conv-title";
      title.textContent = usernames.length === 2 ? usernames.join(" & ") : `${usernames[0]} + ${usernames.length - 1} others`;
      header.append(menuBtn, title);
      menuBtn.addEventListener("click", focusOnAppPanel);
      return header;
    }
    buildMessageEl(msg) {
      const wrapper = document.createElement("div");
      const username = msg.author === this.pos ? "You" : this.usernames[this.getIdx(msg.author)] ?? `User ${msg.author}`;
      wrapper.className = `conv-message conv-message--${msg.author === this.pos ? "right" : "left"}`;
      wrapper.dataset.date = String(msg.date);
      const meta = document.createElement("div");
      meta.className = "conv-meta";
      const authorEl = document.createElement("span");
      authorEl.className = "conv-meta__author";
      authorEl.textContent = username;
      const contentEl = document.createElement("span");
      contentEl.className = "conv-meta__content";
      contentEl.textContent = msg.content;
      const timeEl = document.createElement("span");
      timeEl.className = "conv-meta__time";
      timeEl.textContent = this.formatDate(msg.date);
      meta.append(authorEl, contentEl, timeEl);
      wrapper.appendChild(meta);
      return wrapper;
    }
    buildWaitingMessageEl(content, date, id) {
      const wrapper = document.createElement("div");
      wrapper.className = "conv-message conv-message--right waiting";
      wrapper.dataset.pendingId = String(id);
      wrapper.dataset.date = String(date);
      const meta = document.createElement("div");
      meta.className = "conv-meta";
      const authorEl = document.createElement("span");
      authorEl.className = "conv-meta__author";
      authorEl.textContent = "You";
      const contentEl = document.createElement("span");
      contentEl.className = "conv-meta__content";
      contentEl.textContent = content;
      const timeEl = document.createElement("span");
      timeEl.className = "conv-meta__time";
      timeEl.textContent = this.formatDate(date);
      meta.append(authorEl, contentEl, timeEl);
      wrapper.appendChild(meta);
      return wrapper;
    }
    buildDateSeparator(timestamp) {
      const sep = document.createElement("div");
      sep.className = "conv-date-separator";
      sep.dataset.date = String(this.toDateKey(timestamp));
      sep.textContent = this.formatDateSeparator(timestamp);
      return sep;
    }
    rebuildDateSeparators(container) {
      container.querySelectorAll(".conv-date-separator").forEach((el) => el.remove());
      const messages = Array.from(container.querySelectorAll(".conv-message[data-date]"));
      let lastKey = null;
      for (const msg of messages) {
        const ts = Number(msg.dataset.date);
        const key = this.toDateKey(ts);
        if (key !== lastKey) {
          lastKey = key;
          msg.insertAdjacentElement("beforebegin", this.buildDateSeparator(ts));
        }
      }
    }
    buildLoader() {
      const loader = document.createElement("div");
      loader.className = "conv-loader";
      loader.textContent = "\u2191 scroll to load older messages";
      return loader;
    }
    buildInputBar(eventHandler) {
      const bar = document.createElement("div");
      bar.className = "conv-input-bar";
      this.inputEl = document.createElement("input");
      this.inputEl.type = "text";
      this.inputEl.className = "conv-input";
      this.inputEl.placeholder = "Write a message\u2026";
      this.sendBtn = document.createElement("button");
      this.sendBtn.type = "button";
      this.sendBtn.className = "conv-send-btn";
      this.sendBtn.textContent = "Send";
      let typingActive = false;
      let typingTimeout = null;
      this.inputEl.addEventListener("input", () => {
        if (!typingActive) {
          typingActive = true;
          eventHandler.typing(true);
        }
        if (typingTimeout !== null) clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
          typingActive = false;
          typingTimeout = null;
          eventHandler.typing(false);
        }, 1500);
      });
      this.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.handleSend(eventHandler);
      });
      this.sendBtn.addEventListener("click", () => this.handleSend(eventHandler));
      bar.append(this.inputEl, this.sendBtn);
      return bar;
    }
    handleSend(eventHandler) {
      if (!this.inputEl || !this.messagesEl) return;
      const content = this.inputEl.value.trim();
      if (!content) return;
      this.inputEl.value = "";
      const id = Math.floor(Math.random() * 2 ** 31);
      const date = Date.now();
      const el = this.buildWaitingMessageEl(content, date, id);
      this.messagesEl.appendChild(el);
      this.scrollToBottom();
      this.pendingMessages.set(id, { el, content, date });
      eventHandler.send(content, id);
    }
    // ─── Helpers ──────────────────────────────────────────────────────────────
    updateLoader() {
      if (!this.loaderEl) return;
      const allLoaded = this.loadedBlocks >= this.blockCount;
      this.loaderEl.style.display = allLoaded ? "none" : "flex";
    }
    scrollToBottom() {
      if (this.messagesEl) {
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      }
    }
    formatDate(timestamp) {
      return new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date(timestamp));
    }
    toDateKey(timestamp) {
      const d = new Date(timestamp);
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    }
    formatDateSeparator(timestamp) {
      const now = /* @__PURE__ */ new Date();
      const d = new Date(timestamp);
      const diffDays = Math.floor((now.setHours(0, 0, 0, 0) - d.setHours(0, 0, 0, 0)) / 864e5);
      if (diffDays === 0) return "Today";
      if (diffDays === 1) return "Yesterday";
      if (diffDays < 7) return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(timestamp));
      return new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(timestamp));
    }
    getIdx(idx) {
      return idx < this.pos ? idx : idx - 1;
    }
    // ─── Typing management ────────────────────────────────────────────────────
    addTyping(author) {
      if (author === this.pos || author < 0) return;
      this.typingAuthors.add(author);
      this.updateTypingUI();
    }
    removeTyping(author) {
      this.typingAuthors.delete(author);
      this.updateTypingUI();
    }
    updateTypingUI() {
      if (!this.typingEl) return;
      if (this.typingAuthors.size === 0) {
        this.typingEl.style.display = "none";
        if (this.typingInterval) {
          clearInterval(this.typingInterval);
          this.typingInterval = null;
        }
        return;
      }
      const names = Array.from(this.typingAuthors).map(
        (a) => this.usernames[this.getIdx(a)] ?? `User ${a}`
      );
      let text;
      if (names.length === 1) {
        text = `${names[0]} is typing`;
      } else if (names.length === 2) {
        text = `${names[0]} and ${names[1]} are typing`;
      } else {
        text = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are typing`;
      }
      this.typingEl.style.display = "block";
      let dots = 0;
      if (this.typingInterval) clearInterval(this.typingInterval);
      this.typingInterval = setInterval(() => {
        dots = (dots + 1) % 4;
        this.typingEl.textContent = text + ".".repeat(dots);
      }, 400);
    }
  };

  // app/setupHtml.ts
  var publicUsername = null;
  var publicId = null;
  var setConnectionItemResolve = null;
  function getUsername() {
    return publicUsername;
  }
  function getUserId() {
    return publicId;
  }
  function setUsername(name, id) {
    if (name === void 0)
      throw TypeError("Username is undefined");
    publicUsername = name;
    publicId = id;
    if (setConnectionItemResolve) {
      setConnectionItemResolve(name, id);
    }
    openHtmlPage("app");
  }
  var talkRequestState = "talk";
  function setTalkRequestButton(talk) {
    talkRequestState = talk;
    const btn = document.getElementById("talk");
    btn.classList.remove("talk", "cancel", "canceling");
    switch (talk) {
      case "talk":
        btn.classList.add("talk");
        btn.textContent = "Talk";
        break;
      case "cancel":
        btn.classList.add("cancel");
        btn.textContent = "Cancel";
        break;
      case "canceling":
        btn.classList.add("Canceling");
        btn.textContent = "Canceling";
        break;
    }
  }
  function getTalkRequestStatus() {
    return talkRequestState;
  }
  var conversation = new Conversation(
    document.getElementById("conv")
  );
  function openHtmlPage(label) {
    const list = document.querySelectorAll(".page");
    for (const i of list) {
      if (i.id === label) {
        i.classList.remove("hidden");
      } else {
        i.classList.add("hidden");
      }
    }
    switch (label) {
      case "app":
        focusOnAppPanel();
        break;
    }
  }
  var panel = document.getElementById("sidePanel");
  var overlay = document.getElementById("sidePanelOverlay");
  function focusOnAppPanel() {
    panel.classList.add("open");
    overlay.classList.add("open");
  }
  function focusOnAppConv() {
    panel.classList.remove("open");
    overlay.classList.remove("open");
  }
  function setupHtml() {
    document.getElementById("showRegister").addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById("loginContainer").classList.add("hidden");
      document.getElementById("registerContainer").classList.remove("hidden");
    });
    document.getElementById("showLogin").addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById("registerContainer").classList.add("hidden");
      document.getElementById("loginContainer").classList.remove("hidden");
    });
    async function authenticate(endpoint, credentials, errorDiv) {
      try {
        const response = await fetch(`${SERV_RQST_ADDRESS}/${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(credentials)
        });
        const data = await response.json();
        if (response.ok) {
          if (errorDiv) {
            if (credentials.name !== void 0) {
              setUsername(credentials.name, credentials.id);
              localStorage.setItem("tiktalk-connection", JSON.stringify(credentials));
            } else {
              setConnectionItemResolve = (name, id) => {
                const sc = { ...credentials, name, id };
                localStorage.setItem("tiktalk-connection", JSON.stringify(sc));
                setConnectionItemResolve = null;
                loadGroups();
              };
            }
            errorDiv.classList.add("hidden");
          }
          startConnection(data);
        } else if (errorDiv) {
          errorDiv.textContent = data.error || `${endpoint === "login" ? "Login" : "Registration"} failed`;
          errorDiv.classList.remove("hidden");
        } else {
          localStorage.removeItem("tiktalk-connection");
        }
      } catch (e) {
        if (errorDiv) {
          errorDiv.textContent = String(e);
          errorDiv.classList.remove("hidden");
        }
        console.error(e);
      }
    }
    document.getElementById("loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = document.getElementById("email").value;
      const password = document.getElementById("password").value;
      await authenticate("login", { email, password }, document.getElementById("loginError"));
    });
    document.getElementById("registerForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("regName").value;
      const email = document.getElementById("regEmail").value;
      const password = document.getElementById("regPassword").value;
      await authenticate("register", { name, email, password }, document.getElementById("registerError"));
    });
    try {
      const stored = localStorage.getItem("tiktalk-connection");
      if (!stored)
        throw new Error("Cannot auto-login");
      const credentials = JSON.parse(stored);
      setUsername(credentials.name, credentials.id);
      authenticate("login", credentials, null);
      loadGroups();
    } catch (e) {
      console.error(e);
    }
    document.getElementById("disconnect").addEventListener("click", () => {
      stopConnection();
    });
    document.getElementById("talk").addEventListener("click", () => {
      const t = toggleTalkRequest();
      if (t) {
        setTalkRequestButton(t);
      }
    });
    document.getElementById("sidePanelOverlay").addEventListener("click", focusOnAppConv);
    openHtmlPage("loginPage");
  }

  // app/index.ts
  function startApp() {
    setupHtml();
  }
  window.startApp = startApp;
  startApp();
})();
