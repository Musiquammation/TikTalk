import { focusOnAppConv, focusOnAppPanel } from "./setupHtml";

interface Message {
	content: string;
	author: number;
	date: number;
}

interface ConversationMeta {
	id: string;         // `${convId}_meta`
	totalMessages: number;
	blockCount: number;
}

interface ConversationBlock {
	id: string;         // `${convId}_${blockIndex}`
	messages: Message[];
}

interface EventHandler {
	send(content: string, msgId: number): void;
	typing(type: boolean): void;
}

export class Conversation {
	static readonly BLOCK_SIZE = 32;
	private static readonly DB_NAME = "conversations_db";
	private static readonly DB_VERSION = 1;
	private static readonly STORE_NAME = "conversations";

	private panel: HTMLDivElement;
	private db: IDBDatabase | null = null;

	private currentId: string | null = null;
	private usernames: string[] = [];
	private loadedBlocks: number = 0;
	private totalMessages: number = 0;
	private blockCount: number = 0;

	// DOM elements
	private messagesEl: HTMLDivElement | null = null;
	private loaderEl: HTMLDivElement | null = null;
	private inputEl: HTMLInputElement | null = null;
	private sendBtn: HTMLButtonElement | null = null;

	// Pending (waiting) messages: temp id → { element, content, date }
	private pendingMessages = new Map<number, { el: HTMLDivElement; content: string; date: number }>();

	private pos = -1;

	private typingAuthors = new Set<number>();
	private typingEl: HTMLDivElement | null = null;
	private typingInterval: ReturnType<typeof setInterval> | null = null;

	constructor(panel: HTMLDivElement) {
		this.panel = panel;
		this.panel.classList.add("conv-panel");
	}

	// ─── IndexedDB ────────────────────────────────────────────────────────────

	private openDB(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			if (this.db) return resolve(this.db);

			const req = indexedDB.open(Conversation.DB_NAME, Conversation.DB_VERSION);

			req.onupgradeneeded = (e) => {
				const db = (e.target as IDBOpenDBRequest).result;
				if (!db.objectStoreNames.contains(Conversation.STORE_NAME)) {
					db.createObjectStore(Conversation.STORE_NAME, { keyPath: "id" });
				}
			};

			req.onsuccess = (e) => {
				this.db = (e.target as IDBOpenDBRequest).result;
				resolve(this.db);
			};

			req.onerror = () => reject(req.error);
		});
	}

	private async dbGet<T>(id: string): Promise<T | undefined> {
		const db = await this.openDB();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(Conversation.STORE_NAME, "readonly");
			const req = tx.objectStore(Conversation.STORE_NAME).get(id);
			req.onsuccess = () => resolve(req.result as T | undefined);
			req.onerror = () => reject(req.error);
		});
	}

	private async dbPut(record: ConversationMeta | ConversationBlock): Promise<void> {
		const db = await this.openDB();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(Conversation.STORE_NAME, "readwrite");
			const req = tx.objectStore(Conversation.STORE_NAME).put(record);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
		});
	}

	// ─── Meta & block helpers ─────────────────────────────────────────────────

	private metaId(convId: string): string {
		return `${convId}_meta`;
	}

	private blockId(convId: string, blockIndex: number): string {
		return `${convId}_${blockIndex}`;
	}

	private async getMeta(convId: string): Promise<ConversationMeta | undefined> {
		return this.dbGet<ConversationMeta>(this.metaId(convId));
	}

	private async getBlock(convId: string, blockIndex: number): Promise<ConversationBlock | undefined> {
		return this.dbGet<ConversationBlock>(this.blockId(convId, blockIndex));
	}

	/**
	 * Appends a message to the last block, creating a new one if the current
	 * block is full (>= BLOCK_SIZE). Persists both the block and the meta.
	 * Returns the block the message was written into.
	 */
	private async pushMessage(convId: string, message: Message): Promise<ConversationBlock> {
		let meta = await this.getMeta(convId);

		// Bootstrap: first message ever in this conversation
		if (!meta) {
			meta = { id: this.metaId(convId), totalMessages: 0, blockCount: 0 };
		}

		let targetBlock: ConversationBlock;

		if (meta.blockCount === 0) {
			// No block yet — create the first one
			targetBlock = { id: this.blockId(convId, 0), messages: [] };
			meta.blockCount = 1;
		} else {
			const lastIndex = meta.blockCount - 1;
			const lastBlock = await this.getBlock(convId, lastIndex);

			if (!lastBlock) {
				throw new Error(`Block ${lastIndex} missing for conversation "${convId}".`);
			}

			if (lastBlock.messages.length >= Conversation.BLOCK_SIZE) {
				// Last block is full — start a new one
				targetBlock = { id: this.blockId(convId, meta.blockCount), messages: [] };
				meta.blockCount++;
			} else {
				targetBlock = lastBlock;
			}
		}

		targetBlock.messages.push(message);
		meta.totalMessages++;

		// Persist atomically (best-effort; IDB doesn't support cross-store XA)
		await this.dbPut(targetBlock);
		await this.dbPut(meta);

		// Keep cached counts in sync
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
	async open(id: string, pos: number, usernames: string[], eventHandler: EventHandler) {
		focusOnAppConv();

		this.pos = pos;
		this.currentId = id;
		this.usernames = usernames;
		this.loadedBlocks = 0;

		// Reset typing state when opening a conversation
		this.typingAuthors.clear();
		if (this.typingEl) {
			this.typingEl.remove();
			this.typingEl = null;
		}

		// Ensure meta exists in DB
		let meta = await this.getMeta(id);
		if (!meta) {
			meta = { id: this.metaId(id), totalMessages: 0, blockCount: 0 };
			await this.dbPut(meta);
		}
		this.totalMessages = meta.totalMessages;
		this.blockCount = meta.blockCount;

		// Build panel DOM
		this.panel.innerHTML = "";
		this.panel.setAttribute("data-conv-id", id);

		this.panel.appendChild(this.buildHeader(usernames));

		this.loaderEl = this.buildLoader();
		this.panel.appendChild(this.loaderEl);

		this.messagesEl = document.createElement("div");
		this.messagesEl.className = "conv-messages";
		this.panel.appendChild(this.messagesEl);

		// Create typing indicator element (hidden by default)
		this.typingEl = document.createElement("div");
		this.typingEl.className = "conv-typing";
		this.typingEl.style.display = "none";
		this.panel.appendChild(this.typingEl);

		this.panel.appendChild(this.buildInputBar(eventHandler));

		// Load first 2 blocks
		await this.loadBlock();
		await this.loadBlock();

		this.updateLoader();
		this.setupScrollLoader();
	}

	/**
	 * Appends a new message to the conversation (DB + DOM).
	 */
	async add(msg: string, author: number, date: number): Promise<void> {
		if (!this.currentId) throw new Error("No conversation open.");

		const message: Message = { content: msg, author, date };
		await this.pushMessage(this.currentId, message);

		// Only render if the message falls in an already-loaded range
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
	private async loadBlock(): Promise<void> {
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

	private setupScrollLoader(): void {
		if (!this.messagesEl) return;
		this.messagesEl.addEventListener("scroll", async () => {
			if (this.messagesEl!.scrollTop < 80) {
				const loadedCount = this.loadedBlocks * Conversation.BLOCK_SIZE;
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
	async markAsSent(id: number, date: number) {
		if (!this.currentId) throw new Error("No conversation open.");

		const pending = this.pendingMessages.get(id);
		if (!pending) throw new Error(`No pending message with id ${id}.`);

		// Remove waiting state from DOM
		pending.el.classList.remove("waiting");
		this.pendingMessages.delete(id);

		// Persist to DB
		const message: Message = {
			content: pending.content,
			author: this.pos,
			date: pending.date,
		};

		await this.pushMessage(this.currentId, message);
		this.updateLoader();
	}

	// ─── DOM builders ─────────────────────────────────────────────────────────

	private buildHeader(usernames: string[]): HTMLDivElement {
		const header = document.createElement("div");
		header.className = "conv-header";

		const menuBtn = document.createElement("button");
		menuBtn.id = "convMenuBtn";
		menuBtn.textContent = "☰";

		const title = document.createElement("span");
		title.className = "conv-title";
		title.textContent =
			usernames.length === 2
				? usernames.join(" & ")
				: `${usernames[0]} + ${usernames.length - 1} others`;

		header.append(menuBtn, title);

		menuBtn.addEventListener("click", focusOnAppPanel);

		return header;
	}

	private buildMessageEl(msg: Message): HTMLDivElement {
		const wrapper = document.createElement("div");
		const username =
			msg.author === this.pos
				? "You"
				: (this.usernames[this.getIdx(msg.author)] ?? `User ${msg.author}`);

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

	private buildWaitingMessageEl(content: string, date: number, id: number): HTMLDivElement {
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

	private buildDateSeparator(timestamp: number): HTMLDivElement {
		const sep = document.createElement("div");
		sep.className = "conv-date-separator";
		sep.dataset.date = String(this.toDateKey(timestamp));
		sep.textContent = this.formatDateSeparator(timestamp);
		return sep;
	}

	private rebuildDateSeparators(container: HTMLElement): void {
		container.querySelectorAll(".conv-date-separator").forEach((el) => el.remove());

		const messages = Array.from(container.querySelectorAll<HTMLElement>(".conv-message[data-date]"));
		let lastKey: string | null = null;

		for (const msg of messages) {
			const ts = Number(msg.dataset.date);
			const key = this.toDateKey(ts);
			if (key !== lastKey) {
				lastKey = key;
				msg.insertAdjacentElement("beforebegin", this.buildDateSeparator(ts));
			}
		}
	}

	private buildLoader(): HTMLDivElement {
		const loader = document.createElement("div");
		loader.className = "conv-loader";
		loader.textContent = "↑ scroll to load older messages";
		return loader;
	}

	private buildInputBar(eventHandler: EventHandler): HTMLDivElement {
		const bar = document.createElement("div");
		bar.className = "conv-input-bar";

		this.inputEl = document.createElement("input");
		this.inputEl.type = "text";
		this.inputEl.className = "conv-input";
		this.inputEl.placeholder = "Write a message…";

		this.sendBtn = document.createElement("button");
		this.sendBtn.type = "button";
		this.sendBtn.className = "conv-send-btn";
		this.sendBtn.textContent = "Send";

		let typingActive = false;
		let typingTimeout: ReturnType<typeof setTimeout> | null = null;

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

	private handleSend(eventHandler: EventHandler): void {
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

	private updateLoader(): void {
		if (!this.loaderEl) return;
		const allLoaded = this.loadedBlocks >= this.blockCount;
		this.loaderEl.style.display = allLoaded ? "none" : "flex";
	}

	private scrollToBottom(): void {
		if (this.messagesEl) {
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		}
	}

	private formatDate(timestamp: number): string {
		return new Intl.DateTimeFormat("en-US", {
			hour: "2-digit",
			minute: "2-digit",
		}).format(new Date(timestamp));
	}

	private toDateKey(timestamp: number): string {
		const d = new Date(timestamp);
		return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
	}

	private formatDateSeparator(timestamp: number): string {
		const now = new Date();
		const d = new Date(timestamp);
		const diffDays = Math.floor((now.setHours(0, 0, 0, 0) - d.setHours(0, 0, 0, 0)) / 86400000);

		if (diffDays === 0) return "Today";
		if (diffDays === 1) return "Yesterday";
		if (diffDays < 7) return new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(timestamp));
		return new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(timestamp));
	}

	private getIdx(idx: number): number {
		return idx < this.pos ? idx : idx - 1;
	}

	// ─── Typing management ────────────────────────────────────────────────────

	addTyping(author: number) {
		if (author === this.pos || author < 0) return;
		this.typingAuthors.add(author);
		this.updateTypingUI();
	}

	removeTyping(author: number) {
		this.typingAuthors.delete(author);
		this.updateTypingUI();
	}

	private updateTypingUI() {
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

		let text: string;
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
			this.typingEl!.textContent = text + ".".repeat(dots);
		}, 400);
	}
}