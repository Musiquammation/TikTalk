const ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`);

let __userdata__ = null;

let reportTimestamps = null;

function openDB() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open("chatDB", 1);
		request.onupgradeneeded = (event) => {
			const db = event.target.result;
			if (!db.objectStoreNames.contains("conversations")) {
				db.createObjectStore("conversations", { keyPath: "id" });
			}
		};
		request.onerror = () => reject(request.error);
		request.onsuccess = () => resolve(request.result);
	});
}



function getUserdata() {
	if (!__userdata__)
		throw new Error("User data not available");

	return __userdata__;
}

let conversations = [];
let selectedConvId = null;
let messages = new Map();
let typingState = {};

const conversationsDiv = document.getElementById('conversations');
const messagesDiv = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const convTitle = document.getElementById('convTitle');
const reportBtn = document.getElementById('reportBtn');
const blockBtn = document.getElementById('blockBtn');
const cancelReportBtn = document.createElement('button');
cancelReportBtn.id = 'cancelReportBtn';
cancelReportBtn.textContent = 'Cancel';
cancelReportBtn.classList.add('hidden');
document.getElementById('convActions').appendChild(cancelReportBtn);

// Username display in sidebar
function updateUsernameDisplay() {
	try {
		const user = getUserdata();
		document.getElementById('usernameDisplay').textContent = user.username || '';
	} catch {}
}

// Search animation logic
const searchBtn = document.getElementById('searchBtn');
const searchingAnim = document.getElementById('searchingAnim');
const searchDots = document.getElementById('searchDots');
let searchAnimInterval = null;

searchBtn.addEventListener('click', () => {
	ws.send(JSON.stringify({ type: 'search' }));
	searchBtn.classList.add('hidden');
	searchingAnim.classList.remove('hidden');

	let dots = 0;
	if (searchAnimInterval) clearInterval(searchAnimInterval);
	searchAnimInterval = setInterval(() => {
		dots = (dots + 1) % 4;
		searchDots.textContent = '.'.repeat(dots);
	}, 350);
});

// Stop search animation when search is done (example: after receiving convList)
ws.addEventListener('message', (event) => {
	const data = JSON.parse(event.data);
	if (data.type === 'convList') {
		if (searchAnimInterval) clearInterval(searchAnimInterval);
		searchingAnim.classList.add('hidden');
		searchBtn.classList.remove('hidden');
		searchDots.textContent = '';
	}
});

let reportMode = false;

function setReportMode(active, resetMessages = true) {
	reportMode = active;
	reportBtn.classList.toggle('hidden', active);
	blockBtn.classList.toggle('hidden', active);
	cancelReportBtn.classList.toggle('hidden', !active);
	if (resetMessages && !active) {
		Array.from(messagesDiv.children).forEach(div => div.classList.remove('not-reportable'));
	}
}

function renderConversations() {
	conversationsDiv.innerHTML = '';
	conversations.forEach(conv => {
		const div = document.createElement('div');
		let classes = 'conversation';
		if (conv.id === selectedConvId) classes += ' selected';
		if (conv.lastMessageDate === -1) classes += ' blocked'; // conversation bloquée
		div.className = classes;
		div.textContent = conv.title || conv.id;

		// Add badge
		let missedMessages = conv.missedMessages;
		if (missedMessages && missedMessages > 0) {
			if (missedMessages > 9)
				missedMessages = "+9";

			const badge = document.createElement('span');
			badge.className = 'missed-badge';
			badge.textContent = missedMessages;
			badge.title = missedMessages + "missed messages";
			div.appendChild(badge);
		}

		div.onclick = () => {
			conv.missedMessages = 0;
			selectConversation(conv.id);
		};
		conversationsDiv.appendChild(div);
	});
}

function renderMessages() {
	messagesDiv.innerHTML = '';
	if (!selectedConvId || !messages.has(selectedConvId)) return;
	const msgs = messages.get(selectedConvId);
	if (!msgs || msgs.length === 0) return;
	const currentUser = getUserdata().username;
	let lastDate = null;

	msgs.forEach((msg) => {
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
			messagesDiv.appendChild(sep);
			lastDate = msg.date;
		}

		const isMe = msg.author === currentUser;
		const bubble = document.createElement('div');
		bubble.className = 'message-bubble ' + (isMe ? 'me' : 'other');

		// Add reportable / not-reportable class
		if (reportTimestamps) {
			if (!isMe && reportTimestamps.includes(msg.date)) {
				bubble.classList.add('reportable');
				bubble.onclick = () => {
					if (!confirm("Report this message ?")) {
						cancelReportBtn.click();
						return;
					}

					ws.send(JSON.stringify({
						type: 'report',
						timestamp: msg.date,
						content: msg.text,
						convId: selectedConvId
					}));

					setTimeout(() => {
						cancelReportBtn.click();
					});
				};

			} else {
				bubble.classList.add('not-reportable');
			}
		}

		if (!isMe) {
			const author = document.createElement('div');
			author.className = 'message-author';
			author.textContent = msg.author;
			bubble.appendChild(author);
		}

		const text = document.createElement('div');
		text.textContent = msg.text;
		bubble.appendChild(text);

		const time = document.createElement('div');
		time.className = 'message-time';
		time.textContent = msgDate.toLocaleTimeString(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		});
		bubble.appendChild(time);

		messagesDiv.appendChild(bubble);
	});

	messagesDiv.scrollTop = messagesDiv.scrollHeight;
}


function renderConvHeader() {
	if (!selectedConvId) {
		convTitle.textContent = '';
		return;
	}
	const conv = conversations.find(c => c.id === selectedConvId);
	convTitle.textContent = conv ? conv.title : selectedConvId;
}

function selectConversation(convId) {
	reportTimestamps = null;
	setReportMode(false, true);

	selectedConvId = convId;
	renderConversations();
	renderConvHeader();
	renderMessages();
	updateVoteBtn();
	typingState[convId] = [];
	renderTypingUsers();
	isTyping = false;
	if (typeof typingTimeout !== 'undefined' && typingTimeout)
		clearTimeout(typingTimeout);

	// Affichage des boutons block/unblock selon l'état
	const conv = conversations.find(c => c.id === selectedConvId);
	if (conv && conv.lastMessageDate === -1) {
		blockBtn.classList.add('hidden');
		unblockBtn.classList.remove('hidden');
		// Désactive l'input et le bouton d'envoi
		messageInput.disabled = true;
		sendBtn.disabled = true;
	} else {
		blockBtn.classList.remove('hidden');
		unblockBtn.classList.add('hidden');
		messageInput.disabled = false;
		sendBtn.disabled = false;
	}

	const userdata = getUserdata();
	ws.send(JSON.stringify({
		type: 'getLatestMessages',
		convId,
		userdata
	}));
	updateBackBtn();
}

sendBtn.onclick = () => {
	const text = messageInput.value.trim();
	if (!text || !selectedConvId) return;
	const userdata = getUserdata();

	ws.send(JSON.stringify({
		type: 'sendMessage',
		convId: selectedConvId,
		text,
		userdata
	}));
	messageInput.value = '';
};

messageInput.addEventListener('keydown', e => {
	if (e.key === 'Enter') sendBtn.onclick();
});

reportBtn.addEventListener('click', () => {
	setReportMode(true);
	const userdata = getUserdata();
	ws.send(JSON.stringify({
		type: 'getReportableMessages',
		convId: selectedConvId,
		userdata
	}));
});

cancelReportBtn.addEventListener('click', () => {
	reportTimestamps = null;
	setReportMode(false, true);
});

blockBtn.addEventListener('click', () => {
	ws.send(JSON.stringify({
		type: 'block',
		convId: selectedConvId,
	}));
	blockBtn.classList.add('hidden');
	unblockBtn.classList.remove('hidden');
});

// Gestion du bouton unblock
const unblockBtn = document.getElementById('unblockBtn');
unblockBtn.addEventListener('click', () => {
	ws.send(JSON.stringify({
		type: 'unblock',
		convId: selectedConvId,
	}));
	unblockBtn.classList.add('hidden');
	blockBtn.classList.remove('hidden');
	// On recharge la liste des conversations après un unblock
	setTimeout(getConvList, 300);
});






async function saveConversationMessages(convId, newMessages) {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction("conversations", "readwrite");
		const store = tx.objectStore("conversations");
		const getRequest = store.get(`conv_${convId}`);

		getRequest.onsuccess = () => {
			let existing = getRequest.result ? getRequest.result.messages : [];
			existing = existing.concat(newMessages);
			store.put({ id: `conv_${convId}`, messages: existing });
		};

		getRequest.onerror = () => reject(getRequest.error);

		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => reject(tx.error);
	});
}


async function loadRecentMessages(convId, limit = 16) {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction("conversations", "readonly");
		const store = tx.objectStore("conversations");
		const request = store.get(`conv_${convId}`);

		request.onsuccess = () => {
			const result = request.result;
			db.close();
			if (!result || !result.messages) return resolve([]);
			const msgs = result.messages;
			// Renvoie les `limit` derniers messages
			resolve(msgs.slice(-limit));
		};
		request.onerror = () => reject(request.error);
	});
}



async function fillMissedMessages(data) {
	const convId = data.convId;

	let oldMessages = await loadRecentMessages(convId);
	const mergedMessages = [...oldMessages, ...data.messages];
	messages.set(convId, mergedMessages);
	
	await saveConversationMessages(convId, data.messages);

	renderMessages();

}



async function addMessage(data) {
	const convId = data.convId;

	if (!messages.has(convId)) {
		const recentMsgs = await loadRecentMessages(convId);
		messages.set(convId, recentMsgs);
	}

	messages.get(convId).push(data.message);
	if (convId === selectedConvId) renderMessages();

	await saveConversationMessages(convId, [data.message]);
}

function startConv(data) {
	const otherUsers = data.users.filter(u => u !== getUserdata().username);
	const conv = {
		id: data.id,
		title: otherUsers.join(', '),
		votable: false
	};
	conversations.push(conv);
	renderConvHeader();
	renderMessages();
	selectConversation(data.id);
}

function markReportableMessages(timestamps) {
	reportTimestamps = timestamps;
	renderMessages();
}

function suggestVote(id) {
	const conv = conversations.find(x => x.id === id);
	if (!conv)
		return;
	conv.votable = true;
	if (conv.id === selectedConvId) {
		voteBtn.classList.remove('hidden');
	}
}

// Show/hide voteBtn based on selected conversation
function updateVoteBtn() {
	const conv = conversations.find(c => c.id === selectedConvId);
	if (conv && conv.votable) {
		voteBtn.classList.remove('hidden');
	} else {
		voteBtn.classList.add('hidden');
	}
}

// Add voteBtn click handler
const voteBtn = document.getElementById('voteBtn');
voteBtn.addEventListener('click', () => {
	const note = +prompt("Is this user trustable (from 1 to 5) ?");
	if (note >= 1 && note <= 5) {
		ws.send(JSON.stringify({
			type: 'vote',
			convId: selectedConvId,
			note
		}));

		voteBtn.classList.add("hidden");

	} else {
		alert("Incorrect value (number beetween 1 and 5 required)")
	}

});

function getConvList() {
	ws.send(JSON.stringify({
		type: 'getConvList'
	}));
	updateBackBtn();
}





let typingDots = 0;
let typingAnimInterval = null;

function renderTypingUsers() {
	const typingDiv = document.getElementById('typingUsers');
	if (!selectedConvId || !typingState[selectedConvId] || typingState[selectedConvId].length === 0) {
		typingDiv.textContent = '';
		if (typingAnimInterval) {
			clearInterval(typingAnimInterval);
			typingAnimInterval = null;
		}
		return;
	}
	const users = typingState[selectedConvId].filter(u => u !== getUserdata().username);
	if (users.length === 0) {
		typingDiv.textContent = '';
		if (typingAnimInterval) {
			clearInterval(typingAnimInterval);
			typingAnimInterval = null;
		}
		return;
	}
	if (!typingAnimInterval) {
		typingDots = 0;
		typingAnimInterval = setInterval(() => {
			typingDots = (typingDots + 1) % 4;
			renderTypingUsers();
		}, 350);
	}
	const names = users.join(', ');
	const verb = users.length > 1 ? 'are' : 'is';
	const dots = '.'.repeat(typingDots);
	typingDiv.textContent = `${names} ${verb} typing${dots}`;
}

// Ajout d'un div pour afficher qui écrit
if (!document.getElementById('typingUsers')) {
	const typingDiv = document.createElement('div');
	typingDiv.id = 'typingUsers';
	typingDiv.style.fontStyle = 'italic';
	typingDiv.style.color = '#888';
	messagesDiv.parentNode.insertBefore(typingDiv, messagesDiv.nextSibling);
}

// Gestion typing local
let isTyping = false;
let typingTimeout = null;

function sendTyping() {
	if (!isTyping && selectedConvId && messageInput.value.length > 0) {
		ws.send(JSON.stringify({
			type: 'typing',
			convId: selectedConvId,
			userdata: getUserdata()
		}));
		isTyping = true;
	}
}

function sendStopTyping() {
	if (isTyping && selectedConvId) {
		ws.send(JSON.stringify({
			type: 'stopTyping',
			convId: selectedConvId,
			userdata: getUserdata()
		}));
		isTyping = false;
	}
}

messageInput.addEventListener('input', () => {
	if (!selectedConvId) return;
	if (messageInput.value.length === 0) {
		sendStopTyping();
		if (typingTimeout) clearTimeout(typingTimeout);
		return;
	}
	// Si on n'est pas déjà typing, on envoie typing
	sendTyping();
	// Reset le timeout
	if (typingTimeout) clearTimeout(typingTimeout);
	typingTimeout = setTimeout(() => {
		sendStopTyping();
	}, 3000);
});

messageInput.addEventListener('focus', () => {
	if (!selectedConvId) return;
	if (messageInput.value.length > 0) {
		sendTyping();
	}
});

messageInput.addEventListener('blur', () => {
	sendStopTyping();
	if (typingTimeout) clearTimeout(typingTimeout);
});

// Quand on envoie un message, on arrête le typing
sendBtn.onclick = () => {
	const text = messageInput.value.trim();
	if (!text || !selectedConvId) return;
	const userdata = getUserdata();

	ws.send(JSON.stringify({
		type: 'sendMessage',
		convId: selectedConvId,
		text,
		userdata
	}));
	messageInput.value = '';
	sendStopTyping();
	if (typingTimeout) clearTimeout(typingTimeout);
};

function reportResult(data) {
	let prefix;
	switch (data.isEvil) {
	case 0:
		alert(`Report rejected. (Warning: getting rejecting too much may ban you account for 7 days)`);
		break;
	
	case 1:
		alert(`Report successed! ${data.author} has been definitively banned.`);
		break;
	
	case -1:
		alert(`Sorry, an error occured`);
		break;
	}
}


ws.onmessage = (event) => {
	const data = JSON.parse(event.data);
	console.log(data);
	switch (data.type) {
		case 'convList':
			conversations = data.conversations;
			conversations.sort((a, b) => b.lastMessageDate - a.lastMessageDate);
			renderConversations();
			break;

		case 'missedMessages':
			fillMissedMessages(data);
			break;

		case 'newMessage':
			addMessage(data);
			break;

		case 'startConv':
			// Arrêter l'animation de recherche et réafficher le bouton search
			if (searchAnimInterval) clearInterval(searchAnimInterval);
			searchingAnim.classList.add('hidden');
			searchBtn.classList.remove('hidden');
			searchDots.textContent = '';
			startConv(data);
			break;

		case 'reportableMessages':
			markReportableMessages(data.timestamps);
			break;

		case 'error':
			console.error(data.why);
			alert(data.why);
			break;

		case 'suggestVote':
			suggestVote(data.convId);
			break;

		case 'userReady':
			getConvList();
			break;

		case 'ban':
			if (data.ban === -1) {
				alert("You are permanantely banned");
			} else {
				alert("You are banned until " + new Date(data.ban).toLocaleString());
			}
			break;

		case 'typing':
			if (!typingState[data.convId]) typingState[data.convId] = [];
			typingState[data.convId] = data.users;
			renderTypingUsers();
			break;
		
		case 'reportResult':
			reportResult(data);
			break;

		default:
			throw new Error(`Unknown type: ${data.type}`);
	}
};

ws.onopen = async () => {
	const response = await fetch('/api/getUsernameHash');
	if (!response.ok) throw new Error('Not authenticated');
	const userdata = await response.json();

	ws.send(JSON.stringify({
		type: 'collectUsername',
		userdata
	}));

	__userdata__ = userdata;
	updateBackBtn();
	updateUsernameDisplay();
};


// Gestion du scroll vers le haut pour charger de plus vieux messages
messagesDiv.addEventListener('scroll', async () => {
	if (messagesDiv.scrollTop === 0 && selectedConvId) {
		const convMsgs = messages.get(selectedConvId) || [];
		const oldest = convMsgs.length > 0 ? convMsgs[0] : null;
		const before = oldest ? oldest.date : null;

		const db = await openDB();
		const tx = db.transaction("conversations", "readonly");
		const store = tx.objectStore("conversations");
		const request = store.get(`conv_${selectedConvId}`);
		request.onsuccess = () => {
			const result = request.result;
			if (!result || !result.messages) return;
			const allMsgs = result.messages;
			let idx = allMsgs.findIndex(m => before && m.date === before);
			if (idx === -1) idx = allMsgs.length;
			const older = allMsgs.slice(Math.max(0, idx-16), idx);
			if (older.length > 0) {
				messages.set(selectedConvId, [...older, ...convMsgs]);
				renderMessages();

				if (messagesDiv.children.length > older.length) {
					const anchor = messagesDiv.children[older.length];
					if (anchor) anchor.scrollIntoView();
				}
			}
		};
		request.onerror = () => {};
	}
});

// --- Responsive sidebar mobile logic ---
const backBtn = document.getElementById('backBtn');

function isMobile() {
	return window.innerWidth <= 700;
}

function showSidebarMobile(show) {
	const sidebar = document.getElementById('sidebar');
	if (show) {
		sidebar.classList.add('mobile-visible');
	} else {
		sidebar.classList.remove('mobile-visible');
	}
}

function updateBackBtn() {
	if (isMobile() && selectedConvId) {
		backBtn.classList.remove('hidden');
		showSidebarMobile(false);
	} else {
		backBtn.classList.add('hidden');
		if (isMobile()) showSidebarMobile(true);
	}
}

backBtn.addEventListener('click', event => {
	showSidebarMobile(true);
	event.stopPropagation(); // avoid #main calls showSidebarMobile(false);
});

window.addEventListener('resize', updateBackBtn);





document.getElementById('main').onclick = () => {
	if (!isMobile())
		return;

	const sidebar = document.getElementById('sidebar');
	if (!sidebar.classList.contains("mobile-visible"))
		return;

	sidebar.classList.remove("mobile-visible");
}



// --- Initial state on load ---
document.addEventListener('DOMContentLoaded', () => {
	updateBackBtn();
	updateUsernameDisplay();
});

// Disconnect user
const disconnectBtn = document.getElementById('disconnectBtn');
disconnectBtn.addEventListener('click', async () => {
	try {
		await fetch('/api/logout', { method: 'POST', credentials: 'include' });
	} catch (e) {}
	window.location.href = '/';
});


// Keyboard for mobile users
function adjustMainHeight() {
	const main = document.getElementById("main");
	if (window.visualViewport) {
		const height = window.visualViewport.height;
		main.style.height = `${height}px`;
		main.style.maxHeight = `${height}px`;
	}
}

window.visualViewport?.addEventListener("resize", adjustMainHeight);
window.addEventListener("load", adjustMainHeight);
