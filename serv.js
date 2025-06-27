const express = require('express');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const http = require('http');
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));



const sessionParser = session({
	secret: process.env.SESSION_SECRET,
	resave: false,
	saveUninitialized: false,
	cookie: { secure: false }
});
app.use(sessionParser);
app.use(express.json());

function isAuthenticated(req, res, next) {
	if (req.session && req.session.username) {
		return next();
	}
	res.status(401).json({ authenticated: false });
}


app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/api/check-auth', (req, res) => res.json({ authenticated: !!req.session?.username }));
app.get('/login', (req, res) => req.session?.username ? res.redirect('/app') : res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (req, res) => req.session?.username ? res.redirect('/app') : res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/forgot', (req, res) => res.sendFile(path.join(__dirname, 'public', 'forgot.html')));
app.get('/reset', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset.html')));

const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl: { rejectUnauthorized: false }
});


(async () => {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS tiktalk_users (
			id SERIAL PRIMARY KEY,
			username VARCHAR(255) UNIQUE NOT NULL,
			email VARCHAR(255) UNIQUE NOT NULL,
			password_hash VARCHAR(255) NOT NULL,
			score FLOAT DEFAULT 3,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			ban BIGINT DEFAULT 0
		);
	`).catch(err => console.error(err));

	await pool.query(`
		CREATE TABLE IF NOT EXISTS tiktalk_conv (
			id VARCHAR(255) PRIMARY KEY,
			users TEXT[] NOT NULL,
			blockedBy TEXT[] DEFAULT '{}',
			votable BOOLEAN
		);
	`).catch(err => console.error(err));

	try {
		const res = await pool.query('SELECT id, users, blockedBy FROM tiktalk_conv');
		for (const row of res.rows) {
			discussions.push(new Discussion(row.id, row.users, false, row.blockedby));
		}
	} catch (err) {
		console.error(err);
	}
})();






app.post('/api/signup', async (req, res) => {
	const { username, email, password } = req.body;
	if (!username || !email || !password) return res.json({ success: false, message: 'Missing fields' });

	try {
		const hash = await bcrypt.hash(password, 10);
		const result = await pool.query(
			'INSERT INTO tiktalk_users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
			[username, email, hash]
		);
		req.session.username = result.rows[0].id;
		res.json({ success: true });
	} catch (err) {
		if (err.code === '23505') res.json({ success: false, message: 'Username or email exists.' });
		else res.json({ success: false, message: 'Signup failed.' });
	}
});

app.post('/api/login', async (req, res) => {
	const { username, password } = req.body;
	if (!username || !password) return res.json({ success: false, message: 'Missing credentials' });

	try {
		const result = await pool.query(
			'SELECT id, password_hash FROM tiktalk_users WHERE username = $1',
			[username]
		);
		if (result.rows.length === 1 && await bcrypt.compare(password, result.rows[0].password_hash)) {
			req.session.username = result.rows[0].id;
			res.json({ success: true });
		} else {
			res.json({ success: false, message: 'Invalid credentials' });
		}
	} catch (err) {
		res.json({ success: false, message: 'Login error' });
	}
});

app.post('/api/logout', (req, res) => {
	req.session.destroy(err => {
		if (err) {
			return res.status(500).json({ success: false, message: 'Logout failed' });
		}
		res.clearCookie('connect.sid');
		res.json({ success: true });
	});
});



// Returns username and hash for the authenticated user
app.get('/api/getUsernameHash', isAuthenticated, async (req, res) => {
	try {
		const username = req.session.username;
		const result = await pool.query('SELECT username, password_hash FROM tiktalk_users WHERE id = $1', [username]);
		if (result.rows.length === 1) {
			res.json({ username: result.rows[0].username, hash: result.rows[0].password_hash });
		} else {
			res.status(404).json({ error: 'User not found' });
		}
	} catch (err) {
		res.status(500).json({ error: 'Server error' });
	}
});

// Function to verify if username and hash are valid
async function isUsernameHashValid(username, hash) {
	const result = await pool.query('SELECT password_hash FROM tiktalk_users WHERE username = $1', [username]);
	if (result.rows.length === 1) {
		return result.rows[0].password_hash === hash;
	}
	return false;
}

const wss = new WebSocket.Server({ server });

class SocketRef {
	constructor(socket) {
		this.socket = socket;
		this.listenFor = null;
	}
}

// Map : username -> SocketRef
const userSockets = new Map();

class SearchingClient {
	static DEFAULT_TOLERANCE = .1;
	static INCREASE_TOLERANCE = .4;
	static SEARCH_COULDOWN = 1000;

	constructor(ws, username, score, emptyCurrentSearchingClient, blacklist) {
		this.ws = ws;
		this.username = username;
		this.score = score;
		this.tolerance = SearchingClient.DEFAULT_TOLERANCE;
		this.emptyCurrentSearchingClient = emptyCurrentSearchingClient;
		this.blacklist = blacklist || [];
	}
}

class Message {
	constructor(content, author, readBy = []) {
		this.date = Date.now();
		this.content = content;
		this.author = author;
		this.readBy = readBy;
	}
}

class Discussion {
	static VOTE_EXCHANGES = 8;

	constructor(id, users, votable, blockedBy) {
		/** @type Message[] */
		this.recentMessages = [];
		this.users = users;
		this.typingUsers = [];
		this.id = id;
		this.exchangeLeft = votable ? Discussion.VOTE_EXCHANGES : -1;
		this.lastMessageDate = Date.now();
		this.blockedBy = blockedBy;
		// Add lastSeenBy: array of timestamps, one per user
		this.lastSeenBy = users.map(() => Date.now());
	}
}

class Votable {
	constructor(voter, nominee) {
		this.voter = voter;
		this.nominee = nominee;
	}
}

/** @type SearchingClient[] */
const searchingClients = [];

/** @type Discussion[] */
const discussions = [];

/** @type Votable[] */
const votables = [];


const TRUST_BADREPORT_FACTOR = .85; // high since moderation API is'nt strong enough
const BAD_REPORT_BAN_DAYS = 7;

function getScoreCoeff(x) {
	return 2/(1+Math.exp(-x));
}


function getScoreFromNote(x) {
	if (x <= 1) return -1;
	if (x <= 2) return -2 + (x - 1) * ( -0.7 + 2);
	if (x <= 3) return -0.7 + (x - 2) * (0.1 + 0.7);
	if (x <= 4) return 0.1 + (x - 3) * (0.4 - 0.1);
	if (x <= 5) return 0.4 + (x - 4) * (1 - 0.4);
	return 1;
}












wss.on('connection', async ws => {
	let currentSearchingClient = null;
	let __username__ = null;

	function send(msg) {
		ws.send(JSON.stringify(msg));
	}

	function emptyCurrentSearchingClient() {
		currentSearchingClient = null;
	}

	function getUsername() {
		if (__username__) {
			return __username__;
		}
		throw new Error("Username not given");
	}

	async function on_search() {
		if (currentSearchingClient) {
			throw new Error("Client already searching");
		}

		currentSearchingClient = true; // temporary, to avoid lock

		const username = getUsername();
		const result = await pool.query('SELECT score FROM tiktalk_users WHERE username = $1', [username]);
		if (result.rows.length !== 1) return;
		const score = result.rows[0].score;

		const convRes = await pool.query('SELECT users FROM tiktalk_conv WHERE $1 = ANY(users)', [username]);
		let blacklist = new Set();
		for (const row of convRes.rows)
			for (const u of row.users)
				if (u !== username)
					blacklist.add(u)
		
		blacklist = Array.from(blacklist);
		blacklist.sort();

		const client = new SearchingClient(
			ws,
			username,
			score,
			emptyCurrentSearchingClient,
			blacklist
		);
		
		let i = 0;
		while (i < searchingClients.length && searchingClients[i].score > client.score) {
			i++;
		}
		searchingClients.splice(i, 0, client);
		currentSearchingClient = client;
	}

	function on_stopSearch() {
		if (!currentSearchingClient) {
			throw new Error("Client not searching");
		}

		const index = searchingClients.indexOf(currentSearchingClient);
		if (index < 0) {
			currentSearchingClient = null;
			throw new Error("Current searching client not found");
		}

		searchingClients.splice(index, 1);
	}

	// Collect username
	async function on_collectUsername(data) {
		const userdata = data.userdata;
		if (!userdata) return;

		if (!(await isUsernameHashValid(userdata.username, userdata.hash))) return;

		// Check user ban
		const res = await pool.query(
			"SELECT ban FROM tiktalk_users WHERE username = $1",
			[userdata.username]
		);

		const ban = +res.rows[0].ban;
		
		if (ban === -1 || ban >= Date.now()) {
			// User is banned
			send({type: 'ban', ban});
			ws.close();
			return;
		}


		__username__ = userdata.username;
		userSockets.set(__username__, new SocketRef(ws));

		send({type: 'userReady'});
	}

	function on_getConvList() {
		const username = getUsername();
		const userConvs = discussions.filter(d => d.users.includes(username));
		send({
			type: 'convList',
			conversations: userConvs.map(d => {
				let votable = (d.users.length == 2);
				if (votable) {
					const nominee = d.users[0] === username ? d.users[1] : d.users[0];
					votable = votables.some(
						v => v.voter == username && v.nominee == nominee
					);
				}
				
				
				let lastMessageDate;
				let missedMessages = 0;
				
				if (d.blockedBy && d.blockedBy.includes(username)) {
					lastMessageDate = -1;
					
				} else {
					for (let msg of d.recentMessages) 
						if (!msg.readBy.includes(username))
							missedMessages++;
						
					lastMessageDate = d.lastMessageDate;
				}

				return {
					id: d.id,
					title: d.users.filter(u => u !== username).join(', '),
					votable,
					missedMessages,
					lastMessageDate
				}
			})
		});
	}

	// Update lastSeenBy when listenFor changes
	function setListenFor(username, newConvId) {
		const ref = userSockets.get(username);
		if (!ref) return;

		const oldConvId = ref.listenFor;
		if (oldConvId && oldConvId !== newConvId) {
			const discussion = discussions.find(d => d.id === oldConvId && d.users.includes(username));
			if (discussion) {
				updateLastSeen(discussion, username);

				for (const u of discussion.users) {
					if (u === username) continue;

					const ref2 = userSockets.get(u);
					if (ref2 && ref2.listenFor === oldConvId && ref2.socket.readyState === WebSocket.OPEN) {
						ref2.socket.send(JSON.stringify({
							type: 'convOut',
							user: username,
							convId: oldConvId
						}));
					}
				}
			}
		}

		ref.listenFor = newConvId;
	}


	// Update on_getLatestMessages to use setListenFor
	function on_getLatestMessages(data) {
		const { convId } = data;
		const username = getUsername();
		setListenFor(username, convId);
		const discussion = discussions.find(d => d.id === convId && d.users.includes(username));
		if (!discussion) return;
		const unreadMessages = discussion.recentMessages.filter(m => !m.readBy.includes(username));
		const usersInConv = discussion.users.filter(u => {
			const ref = userSockets.get(u);
			return ref && ref.listenFor === convId;
		});
		send({
			type: 'missedMessages',
			convId,
			messages: unreadMessages.map(m => ({
				author: m.author,
				text: m.content,
				date: m.date
			})),
			lastSeenBy: discussion.lastSeenBy,
			usersInConv
		});
		for (const m of discussion.recentMessages) {
			if (!m.readBy.includes(username)) {
				m.readBy.push(username);
			}
		}
		discussion.users.forEach(u => {
			if (u !== username) {
				const ref = userSockets.get(u);
				if (ref && ref.listenFor === convId && ref.socket.readyState === WebSocket.OPEN) {
					ref.socket.send(JSON.stringify({
						type: 'convIn',
						user: username,
						convId
					}));
				}
			}
		});
	}

	function on_sendMessage(data) {
		const { convId, text } = data;
		const username = getUsername();
		const discussion = discussions.find(d => d.id === convId && d.users.includes(username));
		if (!discussion) return;
		
		// A blocking user can't write messages
		if (discussion.blockedBy && discussion.blockedBy.includes(username)) return;

		// Update exchange left
		if (
			discussion.exchangeLeft > 0 &&
			discussion.recentMessages.length > 0 &&
			discussion.recentMessages[discussion.recentMessages.length-1].author !== username
		) {
			discussion.exchangeLeft--;

			if (discussion.users.length === 2 && discussion.exchangeLeft <= 0) {
				// Create votables
				votables.push(
					new Votable(discussion.users[0], discussion.users[1]),
					new Votable(discussion.users[1], discussion.users[0]),
				);

				for (const uname of discussion.users) {
					const ref = userSockets.get(uname);
					if (ref && ref.socket.readyState === WebSocket.OPEN) {
						ref.socket.send(JSON.stringify({
							type: 'suggestVote',
							convId,
						}));
					}
				}
			}
		}

		// Add msg
		const msg = new Message(text, username, [username, ...discussion.blockedBy]);
		discussion.recentMessages.push(msg);
		discussion.lastMessageDate = Date.now();
		const now = msg.date;
		
		discussion.recentMessages = discussion.recentMessages.filter(m => {
			const allRead = discussion.users.every(u => m.readBy.includes(u));
			const old = (now - m.date) > 2 * 60 * 60 * 1000;
			return !(allRead && old);
		});

		// Send message
		for (const uname of discussion.users) {
			if (discussion.blockedBy.includes(uname)) continue;
			const ref = userSockets.get(uname);
			if (!ref || ref.socket.readyState !== WebSocket.OPEN)
				continue;

			if (ref.listenFor === convId) {
				if (!msg.readBy.includes(uname)) {
					msg.readBy.push(uname);
				}
	
				ref.socket.send(JSON.stringify({
					type: 'newMessage',
					convId,
					message: { author: username, text, date: msg.date }
				}));
			
			} else {
				ref.socket.send(JSON.stringify({
					type: 'notifyMessage',
					convId,
				}));

			}

		}
	}

	function on_getReportableMessages(data) {
		const { convId } = data;
		const username = getUsername();
		const discussion = discussions.find(d => d.id === convId && d.users.includes(username));
		if (!discussion) return;
		const timestamps = discussion.recentMessages.map(m => m.date);
		send({ type: 'reportableMessages', timestamps });
	}

	async function on_report(data) {
		const { convId, timestamp, content } = data;
		const username = getUsername();
		const discussion = discussions.find(d => d.id === convId && d.users.includes(username));
		if (!discussion) throw new Error("Discussion not found");

		const msg = discussion.recentMessages.find(m => m.date === timestamp && m.content === content);
		if (!msg) throw new Error("Message not found");;

		const isEvil = await isTextEvil(content);
		console.log(`[REPORT] Author: ${msg.author}, Result: ${['!err', 'safe', 'evil'][isEvil+1]}, Content: "${msg.content.replace(/\n/g, "\\n")}"`);

		send({
			type: 'reportResult',
			isEvil,
			content: msg.content,
			author: msg.author
		});

		switch (isEvil) {
		// Safe msg
		case 0:
		{
			const res = await pool.query(
				"UPDATE tiktalk_users SET score = score * $1 WHERE username = $2 RETURNING score",
				[TRUST_BADREPORT_FACTOR, username]
			);
			
			if (res.rows[0].score < 1) {
				banUser(username, -1);
				ws.close();
			}


			return;
		}

		// Evil msg
		case 1:
		{
			banUser(msg.author, BAD_REPORT_BAN_DAYS * 86400000);
			
			// Close socket
			const ref = userSockets.get(msg.author);
			if (ref && ref.socket.readyState === WebSocket.OPEN)
				ref.socket.close();

			return;
		}
		
		// Error
		case -1:
		{			
			send({ type: 'error', why: "Moderation service is out"});
			return;
		}
		}
	}

	async function on_vote(data) {
		// Check value
		const note = +data.note;
		if (isNaN(note) || note < 1 || note > 5)
			throw new Error("Invalid note");

		const voter = getUsername();

		// Search vote object
		const convId = data.convId;
		const d = discussions.find(d => d.id === convId);
		if (!d)
			throw new Error("Discussion not found");

		if (d.users.length != 2)
			throw new Error("Discussion has too many users");

		const nominee = d.users[0] === voter ? d.users[1] : d.users[0];
		const votableIndex = votables.findIndex(v => v.voter == voter && v.nominee == nominee)
		if (votableIndex < 0)
			throw new Error("Discussion is not votable");
		
		
		// Here, vote is valid
		const res = await pool.query(
			"SELECT username, score FROM tiktalk_users WHERE username = $1 OR username = $2",
			[voter, nominee]
		)


		if (res.rows.length != 2)
			throw new Error("Invalid SQL output");

		let coeff;
		let score;
		if (res.rows[0].username == voter) {
			score = res.rows[1].score;
			coeff = score - res.rows[0].score;
		} else {
			score = res.rows[0].score;
			coeff = score - res.rows[1].score;
		}

		const given = getScoreFromNote(note) * getScoreCoeff(coeff);
		score += given;
		await pool.query(
			"UPDATE tiktalk_users SET score = $1 WHERE username = $2",
			[score, nominee]
		);

		console.log(
			`[SCORE] '${nominee}' receives ${given} points. New score: ${score}`
		);

		// Remove votable object
		votables.splice(votableIndex, 1);
		
	}

	function on_typing(data) {
		const username = getUsername();
		const convId = data.convId;
		const discussion = discussions.find(d => d.id === convId && d.users.includes(username));
		if (!discussion) return;

		console.log("in", discussion.typingUsers);
		if (discussion.typingUsers.includes(username))
			return;
		
		discussion.typingUsers.push(username);

		console.log("IN", discussion);

		// Notify other users
		for (let u of discussion.users) {
			if (u === username)
				continue;


			const ref = userSockets.get(u);
			if (ref && ref.listenFor === convId && ref.socket.readyState === WebSocket.OPEN) {
				ref.socket.send(JSON.stringify({
					type: 'typing',
					convId,
					users: [...discussion.typingUsers]
				}));
			}
		}
	}

	function on_stopTyping(data) {
		const username = getUsername();
		const convId = data.convId;
		const discussion = discussions.find(d => d.id === convId && d.users.includes(username));
		if (!discussion)
			return;

		const index = discussion.typingUsers.indexOf(username);
		if (index === -1)
			return;
		
		
		console.log("ot", discussion.typingUsers);

		discussion.typingUsers.splice(index, 1);

		console.log("OT", discussion);

		for (let u of discussion.users) {
			if (u === username) continue;

			const ref = userSockets.get(u);
			if (ref && ref.listenFor === convId && ref.socket.readyState === WebSocket.OPEN) {
				ref.socket.send(JSON.stringify({
					type: 'typing',
					convId,
					users: [...discussion.typingUsers]
				}));
			}
		}
	}



	async function on_block(data) {
		const { convId } = data;
		const username = getUsername();
		const discussion = discussions.find(d => d.id === convId && d.users.includes(username));
		if (!discussion) return;
		if (!discussion.blockedBy.includes(username)) {
			discussion.blockedBy.push(username);
			// Update SQL
			await pool.query(
				'UPDATE tiktalk_conv SET blockedBy = array_append(blockedBy, $1) WHERE id = $2',
				[username, convId]
			);
		}
	}

	async function on_unblock(data) {
		const { convId } = data;
		const username = getUsername();
		const discussion = discussions.find(d => d.id === convId && d.users.includes(username));
		if (!discussion) return;
		if (discussion.blockedBy && discussion.blockedBy.includes(username)) {
			discussion.blockedBy = discussion.blockedBy.filter(u => u !== username);
			// Update SQL
			await pool.query(
				'UPDATE tiktalk_conv SET blockedBy = array_remove(blockedBy, $1) WHERE id = $2',
				[username, convId]
			);
		}
	}

	function updateLastSeen(discussion, username) {
		const idx = discussion.users.indexOf(username);
		if (idx !== -1) {
			discussion.lastSeenBy[idx] = discussion.lastMessageDate;
		}
	}

	ws.on('message', async (message) => {
		try {
			const data = JSON.parse(message);

			switch (data.type) {
			case 'search':
				await on_search();
				break;

			case 'stopSearch':
				on_stopSearch();
				break;
			
			case 'collectUsername':
				await on_collectUsername(data);
				break;

			case 'getConvList':
				on_getConvList();
				break;
			

			case 'getLatestMessages':
				on_getLatestMessages(data);
				break;

			case 'sendMessage':
				on_sendMessage(data);
				break;
			
			case 'getReportableMessages':
				on_getReportableMessages(data);
				break;
			
			case 'report':
				await on_report(data);
				break;
			
			case 'vote':
				on_vote(data);
				break;
			
			case 'typing':
				on_typing(data);
				break;

			case 'stopTyping':
				on_stopTyping(data);
				break;
			
			case 'block':
				on_block(data);
				break;

			case 'unblock':
				on_unblock(data);
				break;
			
			default:
				throw new Error("Invalid type: " + data.type);
			}

		} catch (error) {
			console.error(error);
			send({error: error.message});
		}
	});

	ws.on('close', () => {
		if (__username__)
			userSockets.delete(__username__);

		if (currentSearchingClient)
			on_stopSearch();

		// Remove user from typing lists
		for (const discussion of discussions) {
			if (!discussion.users.includes(__username__)) continue;

			const ref = userSockets.get(__username__);
			if (ref && ref.listenFor === discussion.id) {
				updateLastSeen(discussion, __username__);

				for (const u of discussion.users) {
					if (u === __username__) continue;

					const ref2 = userSockets.get(u);
					if (ref2 && ref2.listenFor === discussion.id && ref2.socket.readyState === WebSocket.OPEN) {
						ref2.socket.send(JSON.stringify({
							type: 'convOut',
							user: __username__,
							convId: discussion.id
						}));
					}
				}
			}

			on_stopTyping({ convId: discussion.id });
		}

	});
});




/**
 * Checks if the given text contains harmful content using Aspose moderation API.
 * @param {string} text - The text to check.
 * @returns {Promise<0|1|-1>} - 0 = safe, 1 = harmful, -1 = error
 */
async function isTextEvil(text) {
	const token = process.env.MODERATION_TOKEN;
	const url = process.env.MOERATION_ADDRESS;

	if (!token || !url) {
		console.error("Missing MODERATION_TOKEN or MOERATION_ADDRESS in .env");
		return -1;
	}

	const params = new URLSearchParams();
	params.append('InputText', text);
	params.append('__RequestVerificationToken', token);

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: params.toString()
		});

		const data = await response.json();

		console.log(data);

		if (!data.success) return -1;

		return data.hateSpeechDetected ? 1 : 0;
	} catch (error) {
		console.error('Moderation error:', error);
		return -1;
	}
}





function binarySearch(arr, val) {
	let left = 0, right = arr.length - 1;
	while (left <= right) {
		const mid = (left + right) >> 1;
		if (arr[mid] === val) return true;
		if (arr[mid] < val) left = mid + 1;
		else right = mid - 1;
	}
	return false;
}

// Search tolerances
setInterval(() => {
	for (let i = 0; i < searchingClients.length-1;) {
		const self = searchingClients[i];
		let next = null;
		let found = false;
		for (let j = i+1; j < searchingClients.length; j++) {
			next = searchingClients[j];
			const already = binarySearch(self.blacklist, next.username) || binarySearch(next.blacklist, self.username);
			if (!already) {
				found = true;
				break;
			}
		}
		if (!found) {
			i++;
			continue;
		}
		const diff = next.score - self.score;
		if (diff > self.tolerance || diff > next.tolerance) {
			self.tolerance += SearchingClient.INCREASE_TOLERANCE;
			i++;
			continue;
		}
		const list = [self, next];
		const id = Math.random().toString(36).slice(2);
		const users = list.map(u => u.username);
		const discussion = new Discussion(id, users, true, []);
		discussions.push(discussion);
		pool.query(
			'INSERT INTO tiktalk_conv (id, users, votable) VALUES ($1, $2, $3)',
			[id, users, users.length == 2]
		).catch(console.error);

		const dataToSend = {
			type: 'startConv',
			id,
			users
		};
		for (let u of list) u.emptyCurrentSearchingClient();
		searchingClients.splice(i, 2);
		for (let u of list) u.ws.send(JSON.stringify(dataToSend));
	}
}, SearchingClient.SEARCH_COULDOWN);


// Remove old unread message
setInterval(() => {
	const now = Date.now();
	const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
	for (const discussion of discussions) {
		discussion.recentMessages = discussion.recentMessages.filter(
			m => (now - m.date) <= SEVEN_DAYS
		);
	}
}, 6 * 60 * 60 * 1000); // every 6 hours





function banUser(username, banDuration) {
	const banDate = banDuration < 0 ? -1 : Date.now() + banDuration;

	pool.query(
		'UPDATE tiktalk_users SET ban = $1 WHERE username = $2',
		[banDate, username]
	);

	const ref = userSockets.get(username);
	if (ref && ref.socket.readyState === WebSocket.OPEN) {
		ref.socket.send(JSON.stringify({
			type: 'ban',
			ban: banDate
		}));		
	}
}

// Nodemailer transporter
const transporter = nodemailer.createTransport({
	service: 'gmail',
	auth: {
		user: 'villagerstudioautomailer@gmail.com',
		pass: 'gwst qjbi nbfg hqeo'
	}
});

// Temporary storage for reset codes
const resetCodes = new Map(); // email/username -> { code, expires, timeout, userId }

function generateResetCode() {
	return Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
}

// Route to request password reset
app.post('/api/forgot-password', async (req, res) => {
	const { identifier } = req.body; // email or username
	if (!identifier) return res.json({ success: false, message: 'Field required' });

	try {
		const result = await pool.query(
			'SELECT id, email, username FROM tiktalk_users WHERE email = $1 OR username = $1',
			[identifier]
		);
		if (result.rows.length !== 1) return res.json({ success: false, message: 'User not found' });
		const user = result.rows[0];
		const code = generateResetCode();
		const expires = Date.now() + 60 * 60 * 1000; // 1h
		if (resetCodes.has(user.email)) {
			clearTimeout(resetCodes.get(user.email).timeout);
		}
		const timeout = setTimeout(() => resetCodes.delete(user.email), 60 * 60 * 1000);
		resetCodes.set(user.email, { code, expires, timeout, userId: user.id, username: user.username, email: user.email });

		await transporter.sendMail({
			from: 'villagerstudioautomailer@gmail.com',
			to: user.email,
			subject: 'TikTalk password reset',
			html: `<div style=\"font-family:sans-serif;padding:2em;background:#f9f9f9;border-radius:8px;max-width:400px;margin:auto;\">
				<h2 style=\"color:#4a90e2;\">Password reset</h2>
				<p>Hello <b>${user.username}</b>,</p>
				<p>Here is your reset code, valid for 1 hour:</p>
				<div style=\"font-size:2em;font-weight:bold;letter-spacing:4px;color:#333;background:#e6f0fa;padding:1em 0;border-radius:6px;text-align:center;\">${code}</div>
				<p>If you did not request this, just ignore this email.</p>
				<p style=\"font-size:0.9em;color:#888;\">TikTalk</p>
			</div>`
		});
		res.json({ success: true, message: 'Email sent' });
	} catch (err) {
		console.error(err);
		res.json({ success: false, message: 'Server error' });
	}
});

// Code verification (accepts email or username)
app.post('/api/verify-reset-code', async (req, res) => {
	const { email: identifier, code } = req.body;
	let entry = resetCodes.get(identifier);
	let email = identifier;
	if (!entry) {
		// Try to find by username in resetCodes
		for (const [key, value] of resetCodes.entries()) {
			if (value.username === identifier) {
				entry = value;
				email = value.email;
				break;
			}
		}
	}
	if (!entry) {
		// Try to get email from DB if identifier is a username
		try {
			const result = await pool.query('SELECT email FROM tiktalk_users WHERE username = $1', [identifier]);
			if (result.rows.length === 1) {
				email = result.rows[0].email;
				entry = resetCodes.get(email);
			}
		} catch (err) {
			return res.json({ success: false, message: 'Server error' });
		}
	}
	if (!entry || entry.code !== code || entry.expires < Date.now()) {
		return res.json({ success: false, message: 'Invalid or expired code' });
	}
	res.json({ success: true });
});

// Password change (accepts email or username)
app.post('/api/reset-password', async (req, res) => {
	const { email: identifier, code, password } = req.body;
	let entry = resetCodes.get(identifier);
	let email = identifier;
	if (!entry) {
		// Try to find by username in resetCodes
		for (const [key, value] of resetCodes.entries()) {
			if (value.username === identifier) {
				entry = value;
				email = value.email;
				break;
			}
		}
	}
	if (!entry) {
		// Try to get email from DB if identifier is a username
		try {
			const result = await pool.query('SELECT email FROM tiktalk_users WHERE username = $1', [identifier]);
			if (result.rows.length === 1) {
				email = result.rows[0].email;
				entry = resetCodes.get(email);
			}
		} catch (err) {
			return res.json({ success: false, message: 'Server error' });
		}
	}
	if (!entry || entry.code !== code || entry.expires < Date.now()) {
		return res.json({ success: false, message: 'Invalid or expired code' });
	}
	try {
		const hash = await bcrypt.hash(password, 10);
		await pool.query('UPDATE tiktalk_users SET password_hash = $1 WHERE id = $2', [hash, entry.userId]);
		clearTimeout(entry.timeout);
		resetCodes.delete(entry.email);
		res.json({ success: true });
	} catch (err) {
		console.error(err);
		res.json({ success: false, message: 'Server error' });
	}
});

















const PORT = process.env.PORT;
server.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
});




