const ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`);

const CURRENT_USERNAME_KEY = 'currentUsername';

function send(data) {
	ws.send(JSON.stringify(data));
}

function generateRandomKey() {
	const arr = new Uint8Array(8);
	window.crypto.getRandomValues(arr);
	return String.fromCharCode(...arr);
}

function compareKeys(a, b) {
	return a === b;
}


let __username__ = null;

let currentContactId = -1;
let currentContact = null;
let currentDiscussionBlockLevel = -1;
let isAppendingPreviousDiscussionBlock = false;
let currentLastDate = null;



class UserProperties {
	constructor(anonymous) {
		this.searchPool = anonymous ? null : "default";
	}
}

class ContactDiv {
	constructor(div) {
		this.div = div;
	}

	setNotifNumber(number) {
		setNotifBadge(this.div, number);
	}

	resetNotifNumber() {
		resetNotifBadge(this.div);
	}
}

class PendingMessage {
	constructor(div, date) {
		this.div = div;
		this.date = date;
	}
}

class SearchPoolDescriptor {
	constructor(desc) {
		this.desc = desc;
	}
}



/** @type Map<string, PendingMessage>  */
const pendingMessages = new Map();

/** @type Map<string, ContactDiv> */
const contactDivs = new Map();



function setNotifBadge(div, number) {
	if (number > 9) {
		number = '+9';
	}

	let badge = div.querySelector('.missed-badge');
	if (!badge) {
		badge = document.createElement('span');
		badge.className = 'missed-badge';
		div.appendChild(badge);
	}
	
	badge.textContent = number;
	badge.title = number + "missed messages";
}

function resetNotifBadge(div) {
	const badge = div.querySelector('.missed-badge');
	if (badge) {
		badge.remove();
	}
}




class DBContact {
	constructor(users, key, title = null) {
		this.users = users;
		this.blocks = []; // stores IDs of blocks, most recent at index 0
		this.key = key;

		const now = Date.now();
		this.lastNotifDate = now;
		this.lastSeenDate = now;
		this.lastMsgDate = now;
		this.notifNumber = 0;
		this.title = title;
		this.blocked = false;
	}
}

class DBMessage {
	constructor(content, by, date) {
		this.content = content;
		this.date = date;
		this.by = by; // index in users array
	}
}

class DBBlock {
	constructor(lastMsgDateOfPreviousBlock) {
		this.messages = []; // max Database.BLOCK_SIZE messages
		this.lastMsgDateOfPreviousBlock = lastMsgDateOfPreviousBlock;
	}
}




class Database {
	static BLOCK_SIZE = 64;
	static DB_NAME_ANONYMOUS = "userDataAnonymous";
	static DB_NAME_PREFIX = "userDataAs_";

	constructor(username, anonymous) {
		this.username = username;
		this.anonymous = anonymous;
		this.dbVersion = 1;
		this.db = null;

		/** @type Map<number, DBContact> | null */
		this.contacts = null;

		/** @type UserProperties | null */
		this.userProperties = null;
	}

	async openDB() {
		if (this.db && this.contacts && this.userProperties) return this.db;

		await new Promise((resolve, reject) => {
			const databaseName = this.anonymous ?
				Database.DB_NAME_ANONYMOUS :
				Database.DB_NAME_PREFIX + this.username;

			const request = indexedDB.open(databaseName, this.dbVersion);

			request.onupgradeneeded = e => {
				this.db = e.target.result;
				if (!this.db.objectStoreNames.contains("contacts")) {
					this.db.createObjectStore("contacts", { keyPath: "id", autoIncrement: true })
						.createIndex("users", "users", { multiEntry: true });
				}
				if (!this.db.objectStoreNames.contains("blocks")) {
					this.db.createObjectStore("blocks", { keyPath: "id", autoIncrement: true });
				}
				if (!this.db.objectStoreNames.contains("userProperties")) {
					const store = this.db.createObjectStore("userProperties", { keyPath: "id" });

					// Insert default properties
					store.put({ id: "main", data: new UserProperties(this.anonymous)});
				}
			};

			request.onsuccess = e => {
				this.db = e.target.result;
				resolve();
			};

			request.onerror = e => reject(e.target.error);
		});

		if (!this.contacts) {
			const contactEntries = await this.getContactListFromDB();
			this.contacts = new Map(contactEntries);
		}

		if (!this.userProperties) {
			this.userProperties = await this._loadUserPropertiesFromDB();
		}

		return this.db;
	}

	getContactListFromDB() {
		return new Promise((resolve, reject) => {
			const tx = this.db.transaction("contacts", "readonly");
			const store = tx.objectStore("contacts");
			const contacts = [];
			const request = store.openCursor();

			request.onsuccess = e => {
				const cursor = e.target.result;
				if (cursor) {
					contacts.push([cursor.primaryKey, cursor.value]);
					cursor.continue();
				} else {
					resolve(contacts);
				}
			};

			request.onerror = e => reject(e.target.error);
		});
	}

	_loadUserPropertiesFromDB() {
		return new Promise((resolve, reject) => {
			const tx = this.db.transaction("userProperties", "readonly");
			const store = tx.objectStore("userProperties");
			const req = store.get("main");
			req.onsuccess = () => {
				if (req.result) {
					resolve(req.result.data);
				} else {
					resolve({ poolMode: "default" });
				}
			};
			req.onerror = e => reject(e.target.error);
		});
	}

	async getUserProperties() {
		await this.openDB();
		return this.userProperties;
	}

	async updateUserProperties() {
		await this.openDB();

		return new Promise((resolve, reject) => {
			const tx = this.db.transaction("userProperties", "readwrite");
			const store = tx.objectStore("userProperties");
			const req = store.put({ id: "main", data: this.userProperties });
			req.onsuccess = () => resolve(this.userProperties);
			req.onerror = e => reject(e.target.error);
		});
	}

	async getContactList() {
		if (this.contacts) return Array.from(this.contacts.values());
		await this.openDB();
		return Array.from(this.contacts.values());
	}

	async getContactMap() {
		await this.openDB();
		return this.contacts;
	}

	async createContact(users, key) {
		await this.openDB();

		const contact = new DBContact(users, key);
		const block = new DBBlock(null);

		const blockId = await new Promise((resolve, reject) => {
			const tx = this.db.transaction("blocks", "readwrite");
			const store = tx.objectStore("blocks");
			const req = store.add(block);
			req.onsuccess = () => resolve(req.result);
			req.onerror = e => reject(e.target.error);
		});

		contact.blocks.push(blockId);

		const contactId = await new Promise((resolve, reject) => {
			const tx = this.db.transaction("contacts", "readwrite");
			const store = tx.objectStore("contacts");
			const req = store.add(contact);
			req.onsuccess = () => resolve(req.result);
			req.onerror = e => reject(e.target.error);
		});

		this.contacts.set(contactId, contact);

		return { contact, id: contactId };
	}

	async pushMessageList(contactId, messages) {
		await this.openDB();

		const contact = this.contacts.get(contactId);
		if (!contact) throw new Error("Contact not found");

		const tx = this.db.transaction("blocks", "readwrite");
		const store = tx.objectStore("blocks");

		let lastBlockId = contact.blocks[0];
		let block = await new Promise((resolve, reject) => {
			const req = store.get(lastBlockId);
			req.onsuccess = () => resolve(req.result);
			req.onerror = e => reject(e.target.error);
		});

		let lastMsgDate = contact.lastMsgDate;
		for (const { content, by , date } of messages) {
			if (block.messages.length >= Database.BLOCK_SIZE) {
				const newBlock = new DBBlock(block.messages[block.messages.length - 1].date);
				lastBlockId = await new Promise((resolve, reject) => {
					const req = store.add(newBlock);
					req.onsuccess = () => resolve(req.result);
					req.onerror = e => reject(e.target.error);
				});
				contact.blocks.unshift(lastBlockId);
				block = newBlock;
			}

			const msg = new DBMessage(content, by, date);
			block.messages.push(msg);
			lastMsgDate = date;
		}

		contact.lastMsgDate = lastMsgDate;

		await new Promise((resolve, reject) => {
			const req = store.put({ ...block, id: lastBlockId });
			req.onsuccess = () => resolve();
			req.onerror = e => reject(e.target.error);
		});

		await this._updateContactInDB(contactId, contact);
	}

	async readBlock(contactId, level = 0) {
		await this.openDB();

		const contact = this.contacts.get(contactId);
		if (!contact) throw new Error("Contact not found");
		if (level >= contact.blocks.length) return null;

		const blockId = contact.blocks[level];
		const block = await new Promise((resolve, reject) => {
			const tx = this.db.transaction("blocks", "readonly");
			const store = tx.objectStore("blocks");
			const req = store.get(blockId);
			req.onsuccess = () => resolve(req.result);
			req.onerror = e => reject(e.target.error);
		});

		return block;
	}

	async getBlackList(couldown) {
		await this.openDB();
		const now = Date.now();

		const blacklist = [];
		for (const contact of this.contacts.values()) {
			if (contact.users.length === 2 && contact.lastNotifDate > now - couldown) {
				const username = contact.users.find(u => typeof u === "string");
				if (username) blacklist.push(username);
			}
		}

		return blacklist;
	}

	async updateLastNotifDate(contactId) {
		await this.openDB();
		const contact = this.contacts.get(contactId);
		if (!contact) throw new Error("Contact not found");

		contact.lastNotifDate = Date.now();
		await this._updateContactInDB(contactId, contact);
	}

	async markAsSeen(contactId) {
		await this.openDB();
		const contact = this.contacts.get(contactId);
		if (!contact) throw new Error("Contact not found");

		contact.lastSeenDate = Date.now();
		contact.notifNumber = 0;

		await this._updateContactInDB(contactId, contact);
	}

	async updateLastMsgDate(contactId, date) {
		await this.openDB();
		const contact = this.contacts.get(contactId);
		if (!contact) throw new Error("Contact not found");
		contact.lastMsgDate = date;
		await this._updateContactInDB(contactId, contact);
	}

	async increaseNotifNumber(contactKey, increase=1) {
		await this.openDB();

		for (const [contactId, contact] of this.contacts.entries()) {
			if (contact.key === contactKey) {
				if (contact.blocked)
					return 0;

				contact.notifNumber += increase;
				await this._updateContactInDB(contactId, contact);
				return contact.notifNumber;
			}
		}
		
		throw new Error("Contact not found");
	}

	async _updateContactInDB(contactId, contact) {
		return new Promise((resolve, reject) => {
			const tx = this.db.transaction("contacts", "readwrite");
			const store = tx.objectStore("contacts");
			const req = store.put({ ...contact, id: contactId });
			req.onsuccess = () => {
				this.contacts.set(contactId, contact);
				resolve();
			};
			req.onerror = e => reject(e.target.error);
		});
	}

	findContactByUsernames(usernames) {
		const n = usernames.length;

		for (const [id, contact] of this.contacts) {
			if (contact.users.length !== n) continue;

			if (n === 2) {
				const [a, b] = contact.users;
				const [u1, u2] = usernames;
				if ((a === u1 && b === u2) || (a === u2 && b === u1)) {
					return {contact, id};
				}
			} else if (n <= 4) {
				let match = true;
				for (let i = 0; i < n; i++) {
					if (!contact.users.includes(usernames[i])) {
						match = false;
						break;
					}
				}
				if (match) return {contact, id};
			} else {
				const usersSet = new Set(contact.users);
				let match = true;
				for (let i = 0; i < n; i++) {
					if (!usersSet.has(usernames[i])) {
						match = false;
						break;
					}
				}
				if (match) return {contact, id};
			}
		}

		return -1;
	}

	async changeMsgDate(contactId, oldDate, newDate) {
		await this.openDB();

		const contact = this.contacts.get(contactId);
		if (!contact) {
			throw new Error("Contact not found");
		}

		for (const blockId of contact.blocks) {
			const block = await new Promise((resolve, reject) => {
				const tx = this.db.transaction("blocks", "readwrite");
				const store = tx.objectStore("blocks");
				const req = store.get(blockId);
				req.onsuccess = () => resolve(req.result);
				req.onerror = e => reject(e.target.error);
			});

			if (!block) continue;

			const msg = block.messages.find(m => m.date === oldDate);
			if (msg) {
				msg.date = newDate;

				await new Promise((resolve, reject) => {
					const tx = this.db.transaction("blocks", "readwrite");
					const store = tx.objectStore("blocks");
					const req = store.put({ ...block, id: blockId });
					req.onsuccess = () => resolve();
					req.onerror = e => reject(e.target.error);
				});

				await this._updateContactInDB(contactId, contact);
				return;
			}
		}

		throw new Error(`Message with date ${oldDate} not found in contact ${contactId}`);
	}
}






/** @type Database | null */
let database = null;

function requireDatabase() {
	if (!database)
		throw "Database required";
}

async function startSearch(poolName, couldown = 1800000) {
	requireDatabase();

	const blacklist = await database.getBlackList(couldown);

	send({
		type: 'search',
		pool: poolName,
		blacklist
	});
}

const BODY = {
	conversations: document.getElementById('conversations'),
	messages: document.getElementById('messages'),
	messageInput: document.getElementById('messageInput'),
	sendBtn: document.getElementById('sendBtn'),
	convTitle: document.getElementById('convTitle'),
	reportBtn: document.getElementById('reportBtn'),
	blockBtn: document.getElementById('blockBtn'),
	searchBtn: document.getElementById('searchBtn'),
	disconnectBtn: document.getElementById('disconnectBtn'),
	searchingAnim: document.getElementById('searchingAnim'),
	searchDots: document.getElementById('searchDots'),
}


function appendDiscussionList(contactMap) {
	BODY.conversations.innerHTML = '';
	BODY.messages.innerHTML = '';

	// Sort contacts by lastMsgDate descending
	const sorted = Array.from(contactMap.entries()).sort((a, b) => (b[1].lastMsgDate || 0) - (a[1].lastMsgDate || 0));
	for (let [id, contact] of sorted) {
		appendDiscussion(contact, id);
	}
}

function appendDiscussion(contact, contactId) {
	const div = document.createElement("div");

	let classes = 'conversation';
	if (contactId === currentContactId) {
		classes += ' selected';
	}

	div.className = classes;

	if (contact.title) {
		div.textContent = contact.title;
	} else {
		div.textContent = contact.users.filter(item => typeof item === "string").join(", ");
	}

	// Add notif badge
	const notifNumber = contact.notifNumber;
	if (notifNumber && notifNumber > 0) {
		const notifStr = notifNumber > 9 ? "+9" : notifNumber;
		const badge = document.createElement('span');
		badge.className = 'missed-badge';
		badge.textContent = notifStr;
		badge.title = notifStr + "missed messages";
		div.appendChild(badge);
	}

	contactDivs.set(contact.key, new ContactDiv(div))

	// Handle click
	div.onclick = () => {
		showDiscussion(contact, contactId, div);
	}

	BODY.conversations.appendChild(div);

	return div;
}

async function showDiscussion(contact, contactId, discussionClickDiv) {
	// Mark as seen
	database.markAsSeen(contactId);

	if (discussionClickDiv) {
		resetNotifBadge(discussionClickDiv);
	}

	

	// Empty content
	BODY.messages.innerHTML = "";


	// Show two first message blocks
	const b0 = await database.readBlock(contactId, 0);
	const b1 = await database.readBlock(contactId, 1);

	currentDiscussionBlockLevel = 1;
	currentContactId = contactId;
	currentContact = contact;

	if (b0.messages.length === 0) {
		currentLastDate = b0.lastMsgDateOfPreviousBlock;
	} else {
		currentLastDate = b0.messages[b0.messages.length-1].date;
	}

	// Add messages
	const blocks = [b1, b0];
	for (let block of blocks) {
		if (!block) {
			currentDiscussionBlockLevel = -1;
			continue;
		}

		const container = document.createElement("div");
		appendDiscussionBlock(
			block.messages,
			block.lastMsgDateOfPreviousBlock,
			container,
			contact.users
		);
		BODY.messages.appendChild(container);
	}

	// Handle scroll
	BODY.messages.scrollTop = BODY.messages.scrollHeight;

	// Send listenFor
	send({
		type: 'listenFor',
		key: contact.key
	});

}

function appendDiscussionBlock(messages, lastDate, container, users, pending = false) {
	let generatedIds;

	if (pending) {
		generatedIds = [];
	}

	const isScrolledBottom = BODY.messages.scrollTop + BODY.messages.clientHeight >= BODY.messages.scrollHeight;

	for (let msg of messages) {
		const msgDate = new Date(msg.date);
		const dayString = msgDate.toLocaleDateString(undefined, {
			weekday: 'long',
			year: 'numeric',
			month: 'long',
			day: 'numeric',
		});

		if (!lastDate || (new Date(lastDate)).toDateString() !== msgDate.toDateString()) {
			const sep = document.createElement('div');
			sep.className = 'date-separator';
			sep.textContent = dayString;
			container.appendChild(sep);
			lastDate = msg.date;
		}

		const author = users[msg.by];

		const isMe = author === null;
		const bubble = document.createElement('div');
		let className = 'message-bubble ' + (isMe ? 'me' : 'other')
		if (pending) {
			className += ' pending';
		}

		bubble.className = className;

		if (!isMe) {
			const authorDiv = document.createElement('div');
			authorDiv.className = 'message-author';
			authorDiv.textContent = author;
			bubble.appendChild(authorDiv);
		}

		const text = document.createElement('div');
		text.textContent = msg.content;
		bubble.appendChild(text);

		const time = document.createElement('div');
		time.className = 'message-time';
		time.textContent = msgDate.toLocaleTimeString(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		});
		bubble.appendChild(time);

		// Add date
		bubble.setAttribute("data-date", msg.date);		
		

		container.appendChild(bubble);

		// Generate id
		if (pending) {
			const key = generateRandomKey();
			generatedIds.push(key);
			pendingMessages.set(key, new PendingMessage(bubble, msg.date));
		}
	}

	if (isScrolledBottom) {
		BODY.messages.scrollTop = BODY.messages.scrollHeight;
	}

	return generatedIds;
}

async function appendPreviousDiscussionBlock() {
	if (isAppendingPreviousDiscussionBlock)
		return false;

	isAppendingPreviousDiscussionBlock = true;

	if (currentDiscussionBlockLevel < 0) {
		return;
	}

	currentDiscussionBlockLevel++;
	const block = await database.readBlock(currentContactId, currentDiscussionBlockLevel);
	if (!block) {
		currentDiscussionBlockLevel = -1;
		return;
	}

	const container = document.createElement("div");
	appendDiscussionBlock(
		block.messages,
		block.lastMsgDateOfPreviousBlock,
		container,
		currentContact.users
	);
	BODY.messages.prepend(container);

	isAppendingPreviousDiscussionBlock = false;

}

async function appendMessages(messages, pending = false) {
	if (messages.length === 0)
		return;

	// Update database
	await database.pushMessageList(currentContactId, messages);

	// Update display
	const generatedIds = appendDiscussionBlock(
		messages,
		currentLastDate,
		BODY.messages.lastElementChild,
		currentContact.users,
		pending
	);

	currentLastDate = messages[messages.length-1].date;
	return generatedIds;
}


let seenBubble = null;

function giveSeenMark(bubble) {
	if (seenBubble)
		removeSeenMark();
	
	const seenDiv = document.createElement('div');
	seenDiv.className = 'seen-label';
	seenDiv.textContent = "Seen";
	bubble.appendChild(seenDiv);
	
	seenBubble = bubble;
}

function removeSeenMark() {
	seenBubble.querySelector('.seen-label').remove();
}

function updateSeenMark(mark) {
	if (mark === -1) {
		for (let ci = BODY.messages.children.length - 1; ci >= 0; ci--) {
			const container = BODY.messages.children[ci];
			for (let i = container.children.length - 1; i >= 0; i--) {
				const bubble = container.children[i];
				if (bubble.classList.contains('me')) {
					giveSeenMark(bubble);
					return true;
				}
			}
		}

		return false;
	}
	
	for (let ci = BODY.messages.children.length - 1; ci >= 0; ci--) {
		const container = BODY.messages.children[ci];
		for (let i = container.children.length - 1; i >= 0; i--) {
			const bubble = container.children[i];
			if (
				bubble.classList.contains('me') &&
				+bubble.getAttribute("data-date") <= mark
			) {
				giveSeenMark(bubble);
				return true;
			}
		}
	}

	return false;
}


async function setSearchPool(searchPool) {
	const properties = await database.getUserProperties();
	properties.searchPool = searchPool;
	await database.updateUserProperties();
}





let searchAnimInterval = 0;


function startSearchingAnim() {
	BODY.searchBtn.classList.add('hidden');
	BODY.searchingAnim.classList.remove('hidden');
	if (searchAnimInterval) clearInterval(searchAnimInterval);
	let dots = 0;
	searchAnimInterval = setInterval(() => {
		dots = (dots + 1) % 4;
		BODY.searchDots.textContent = '.'.repeat(dots);
	}, 350);
}

function stopSearchingAnim() {
	if (searchAnimInterval) clearInterval(searchAnimInterval);
	searchAnimInterval = 0;

	BODY.searchingAnim.classList.add('hidden');
	BODY.searchDots.textContent = '';
	BODY.searchBtn.classList.remove('hidden');
}






// Connect web socket
ws.onopen = async () => {
	const sessionToken = localStorage.getItem('sessionToken');

	let username;
	let key;
	let anonymous;

	if (sessionToken) {
		const object = await goFetch(
			'/api/connectSocket',
			{sessionToken},
			"POST"
		);

		username = object.username;
		if (!username) {
			alert("You are not connected");
			localStorage.removeItem('sessionToken');
			gotoPage('login');
			return;
		}

		anonymous = false;
		key = object.key;
		localStorage.setItem(CURRENT_USERNAME_KEY, username);

	} else {
		const object = await goFetch('/api/createAnonymousAccount');
		username = object.username;
		key = object.key;
		anonymous = true;
		localStorage.removeItem(CURRENT_USERNAME_KEY);
	}


	// Register username
	__username__ = username;
	document.getElementById("usernameDisplay").textContent = username;
	database = new Database(username, anonymous);
	appendDiscussionList(await database.getContactMap());

	// Ask for missed notifications
	let contacts = [];
	for (let [_, contact] of (await database.getContactMap())) {
		contacts.push({key: contact.key, users: contact.users});
	}

	send({
		type: 'connect',
		username,
		key,
		contacts
	});
};

const onmessage = {
	connect(data) {
		if (!data.connected) {
			throw new Error("Identification failed");
		}

		// Add missed notifications
		for (let {key, missedCount} of data.missedNotifications) {
			for (let [_, contact] of database.contacts) {
				if (contact.key !== key)
					continue;

				(async () => {
					contactDivs.get(key).setNotifNumber(
						await database.increaseNotifNumber(key, missedCount)
					)
				})();
			}
		}

		// Sort and move divs according to lastMsgDate
		const sorted = Array.from(database.contacts.entries()).sort((a, b) => (b[1].lastMsgDate || 0) - (a[1].lastMsgDate || 0));
		for (let [id, contact] of sorted) {
			const div = contactDivs.get(contact.key)?.div;
			if (div) {
				BODY.conversations.insertBefore(div, BODY.conversations.firstChild);
			}
		}
	},

	search_notFound(data) {
		stopSearchingAnim();
		console.error("Search pool not found");
	},
	
	search_notAccessible(data) {
		stopSearchingAnim();
		console.error("Search pool not accessible");
	},

	search_alreadyInside(data) {
		stopSearchingAnim();
		console.error("Search is already in a pool");
	},

	search_ok(data) {
		BODY.searchingAnim.classList.remove('notConfirmed');
	},

	async meet(data) {
		stopSearchingAnim();
		requireDatabase();

		if (!__username__) {
			throw new Error("Client username required");
		}

		const usernames = data.usernames;
		let usernameIndex = usernames.indexOf(__username__);
		if (usernameIndex < 0) {
			throw new Error("Client absent from username list");
		}
		
		usernames[usernameIndex] = null;
		
		{
			const {contact, id} = database.findContactByUsernames(usernames);
			if (contact > 0) {
				showDiscussion(contact, id);
				return;
			}
		}

		const {id, contact} = await database.createContact(usernames, data.key);
		showDiscussion(contact, id, appendDiscussion(contact, id));
	},

	message(data) {
		if (!currentContact || currentContact.blocked) {
			return;
		}

		appendMessages([{
			content: data.content,
			date: data.date,
			by: data.by
		}]);
	},

	async msgNotif(data) {
		const number = await database.increaseNotifNumber(data.key);
		if (number > 0) {
			const contactDiv = contactDivs.get(data.key);
			contactDiv?.setNotifNumber(number);
			
			// Move the conversation to the top
			if (contactDiv?.div) {
				BODY.conversations.insertBefore(contactDiv.div, BODY.conversations.firstChild);
			}
		}
	},

	missedMessages(data) {
		if (!currentContact || currentContact.blocked) {
			return;
		}

		if (data.list.length > 0)
			appendMessages(data.list);

		updateSeenMark(data.seenMark);
		
	},

	updateSeen(data) {
		updateSeenMark(data.seenMark);
	},

	msgReceived(data) {
		if (!currentContact || currentContact.blocked) {
			return;
		}

		const pending = pendingMessages.get(data.id);
		if (pending) {
			pending.div.classList.remove('pending');
			pendingMessages.delete(data.id);

			database.changeMsgDate(currentContactId, pending.date, data.date);
		} else {
			console.warn("Received message has been missed. Id was", data.id);
		}

		if (data.seenAll)
			updateSeenMark(-1);

		return;
	},

	

	error(data) {
		throw data.error;
	}
};

ws.onmessage = event => {
	const data = JSON.parse(event.data);
	const fn = (onmessage[data.type]);
	if (!fn) {
		console.log(data);
		throw "Type not found";
	}

	fn(data);
}






let lastSendPromise = Promise.resolve(); // initially resolved

async function sendMessage(content) {
	if (!content || currentContactId < 0 || !currentContact || currentContact.blocked) {
		return;
	}

	// Create a new promise that waits for the previous one to finish
	const sendPromise = lastSendPromise.then(async () => {
		const now = Date.now();


		const msgIds = await appendMessages([
			{ content, date: now, by: currentContact.users.indexOf(null) },
		], true);

		// Update lastMsgDate and move the conversation to the top
		database.updateLastMsgDate(currentContactId, now);
		const contactDiv = contactDivs.get(currentContact.key);
		if (contactDiv?.div) {
			BODY.conversations.insertBefore(contactDiv.div, BODY.conversations.firstChild);
		}

		send({
			type: 'message',
			content,
			msgId: msgIds[0]
		});


	}).catch(err => {
		console.error("Error sending message:", err);
	});

	// Update the last promise in the queue
	lastSendPromise = sendPromise;

	// Wait for this message to finish sending before continuing
	await sendPromise;
}



BODY.messages.onscroll = () => {
	const scrollTop = BODY.messages.scrollTop;
	const scrollThreshold = 0.2 * (BODY.messages.scrollHeight - BODY.messages.clientHeight);

	if (scrollTop <= scrollThreshold) {
		appendPreviousDiscussionBlock();
	}
};


BODY.sendBtn.onclick = () => {
	sendMessage(BODY.messageInput.value.trim());
	BODY.messageInput.value = "";
};


BODY.searchBtn.onclick = async () => {
	startSearchingAnim();
	BODY.searchingAnim.classList.add('notConfirmed');

	const properties = await database.getUserProperties();
	startSearch(properties.searchPool);
};


BODY.disconnectBtn.onclick = async () => {
	localStorage.removeItem(CURRENT_USERNAME_KEY);
	
		
	await goFetch(
		"/api/logout",
		{sessionToken: localStorage.getItem('sessionToken')},
		"POST"
	);
	
	localStorage.removeItem('sessionToken');
	gotoPage("");
};


document.getElementById("settingsBtn").onclick = () => {
	gotoPage('settings');
};







function openCurrentDB() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open("current", 1);

		request.onupgradeneeded = function(event) {
			const db = event.target.result;
			// Création d'un object store "userStore" avec clé "id"
			const store = db.createObjectStore("userStore", { keyPath: "id" });
			// Insérer l'objet par défaut
			store.add({ id: 1, currentUsername: null });
		};

		request.onsuccess = function(event) {
			resolve(event.target.result);
		};

		request.onerror = function(event) {
			reject(event.target.error);
		};
	});
}


// Try load messages before web socket
(async () => {
	const username = localStorage.getItem(CURRENT_USERNAME_KEY);
	
	if (username) {
		document.getElementById("usernameDisplay").textContent = username;
	
		const subDatabase = new Database(username, false);
		const contactMap = await subDatabase.getContactMap();
		
		// Cancel if database already loaded
		if (database)
			return;
	
		appendDiscussionList(contactMap);
		database = subDatabase;
	}
})();





// Handle notifications
window.handleNotifRegistration = async token => {
	try {
		await goFetch(
			'/api/registerFCM',
			{
				token,
				sessionToken: localStorage.getItem('sessionToken')
			},
			"POST"
		);

	} catch (err) {
		console.error('Error sending FCM token to server', err);
	}
};

