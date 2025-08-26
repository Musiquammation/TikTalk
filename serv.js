const express = require('express');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const http = require('http');
const WebSocket = require('ws');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const admin = require('firebase-admin');
const cors = require('cors');
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


app.use(cors({
	origin: (origin, callback) => {
		const allowedOrigins = [
			process.env.DOMAIN,
			"capacitor://localhost",
			"https://localhost"   // dev web
    	];
    	
		if (!origin || allowedOrigins.includes(origin)) {
			callback(null, true);
		} else {
			callback(new Error("Not allowed by CORS"));
		}
	},

	credentials: true
}));



admin.initializeApp({
	credential: admin.credential.cert(
		JSON.parse(process.env.SERVICE_ACCOUNT_KEY)
	),
});


// HTML routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/forgot', (req, res) => res.sendFile(path.join(__dirname, 'public', 'forgot.html')));
app.get('/reset', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));



const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...{ ssl: { rejectUnauthorized: false } }
});

// Init SQL
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
		CREATE TABLE IF NOT EXISTS tiktalk_tokensFCM (
			username VARCHAR(255) NOT NULL,
			token VARCHAR(255) NOT NULL,
			PRIMARY KEY (username, token),
			FOREIGN KEY (username) REFERENCES tiktalk_users(username) ON DELETE CASCADE
		);
	`).catch(err => console.error(err));

	await pool.query(`
		CREATE INDEX IF NOT EXISTS tiktalk_idx_tokensFCM 
		ON tiktalk_tokensFCM(username);
	`).catch(err => console.error(err));
})();





function isAuthenticated(req, res, next) {
	if (req.session && req.session.username) {
		return next();
	}
	res.status(401).json({ authenticated: false });
}

function isAnonymousUsername(username) {
	return username.startsWith(process.env.ANONYMOUS_PREFIX);
}

function generateAnonymousUsername() {
	return process.env.ANONYMOUS_PREFIX + Array.from({length: 8}, () =>
		Math.floor(Math.random() * 16).toString(16)
	).join('');
}

async function getUserScore(username) {
	if (isAnonymousUsername(username))
		return 0;

	const result = await pool.query(
		"SELECT score FROM tiktalk_users WHERE username = $1",
		[username]
	);

	if (result.rows.length === 0)
		throw new Error("Username not found in database");

	return result.rows[0].score;
}



function generateRandomKey() {
	const buffer = crypto.randomBytes(8);
	return String.fromCharCode(...buffer);
}


function compareKeys(a, b) {
	return a === b;
}

function generateResetCode() {
	return Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
}









class SocketRef {
	constructor(ws) {
		this.ws = ws;
		this.listenFor = null;

		/** @type Map<string, {cache: DiscussionCache, position: number}> */
		this.discussions = new Map();
	}
}

class SearchingClient {
	static START_LAPS = 3;

	constructor(socketRef, username, score, blacklist) {
		this.socketRef = socketRef;
		this.username = username;
		this.score = score;
		this.lap = SearchingClient.START_LAPS;
		this.blacklist = blacklist || [];
	}
}

class SearchingClientPool {
	constructor(name, isAccessible) {
		this.name = name;
		this.isAccessible = isAccessible;
		
		/** @type SearchingClient[] */
		this.clients = [];
	}

	isInside(username) {
		return this.clients.some(client => client.username === username);
	}

	// Keep increasing order
	/// TODO: check order (normally, use < instead)
	pushClient(client) {
		let index = 0;
		while (index < this.clients.length && this.clients[index].score > client.score) {
			index++;
		}

		this.clients.splice(index, 0, client);
	}

	// Meet clients
	meetLap() {
		for (let i = this.clients.length - 1; i > 0; i--) {
			// # Check if both clients are compatible #
			const client = this.clients[i];
			if (client.lap > 0) {
				client.lap--;
				continue;
			}

			const next = this.clients[i-1];
			if (client.blacklist.includes(next.username)) {
				continue;
			}

			// # Now, we will join both clients #

			// Remove them from client list
			this.clients.splice(i-1, 2);
			i--;

			// Join clients
			joinClients([client, next]);
		}
	}

}



class Message {
	constructor(date, content, authorIndex) {
		this.date = date;
		this.content = content;
		this.authorIndex = authorIndex;
	}
}

class Discussion {
	static DISCUSSION_LIFETIME = 14 * 86400000; // 14 days

	constructor(users) {
		this.users = users;
		this.expireDate = Date.now() + Discussion.DISCUSSION_LIFETIME;

		/** @type Message[] */
		this.messages = [];

		this.firstUnreadMessage = Array(users.length).fill(null);
		this.firstUnnotifiedMessage = Array(users.length).fill(null);
	}

	markNotified(userIndex) {
		const firstUnnotifiedMsg = this.firstUnnotifiedMessage[userIndex];
		if (firstUnnotifiedMsg === null)
			return;

		const unnotifiedIndex = this.messages.indexOf(firstUnnotifiedMsg);

		if (unnotifiedIndex === -1)
			throw new Error("Unnotified message not found in message list");
		
		this.firstUnnotifiedMessage[userIndex] = null;

		return this.messages.length - unnotifiedIndex;
	}

	markRead(userIndex) {
		const firstUnreadMessage = this.firstUnreadMessage[userIndex];
		if (firstUnreadMessage === null)
			return false;

		const unreadIndex = this.messages.indexOf(firstUnreadMessage);

		if (unreadIndex === -1)
			throw new Error("Unread message not found in message list");


		this.firstUnreadMessage[userIndex] = null;
		
		while (this.messages.length > 0) {
			if (this.firstUnreadMessage.includes(this.messages[0]))
				return false;

			this.messages.shift();
		}

		return true;
	}

	getSeenMark() {
		for (let msg of this.messages)
			if (this.firstUnreadMessage.includes(msg))
				return msg.date;
		
		return -1;
	}
}


class DiscussionCache {
	constructor(users) {
		this.users = users;
		this.connectedUsers = 0;
		this.typingUsersMap = new Int8Array(users.length);
	}

	setTypingMode(index, value) {
		if (this.typingUsersMap[index] == value)
			return;

		this.typingUsersMap[index] = value;

		/// TODO: send to users
	}
}


class NotifFCM {
	static LIFETIME = 300 * 1000; // 5mn

	constructor(tokens) {
		this.tokens = tokens;
		this.timeout = -1;
	}

	updateNotifTimeout() {
		if (this.timeout >= 0) {
			clearTimeout(this.timeout);
		}

		// Clear memory
		this.timeout = setTimeout(() => {
			const index = notifsFCM.indexOf(this);
			if (index >= 0) {
				notifsFCM.splice(index, 1);
			}

		}, NotifFCM.LIFETIME);
	}
}








class SocketConnectionTicket {
	constructor(username) {
		this.username = username;
		this.key = generateRandomKey();

		// Remove ticket if date expires
		this.timeout = setTimeout(() => {
			const index = socketConnectionTickets.indexOf(this);
			if (index !== -1) socketConnectionTickets.splice(index, 1);
		}, 1800000); // 30mn
	}
}







const wss = new WebSocket.Server({ server });

/** @type Map<string, SocketRef> */
const userSockets = new Map();

/** @type SearchingClientPool[] */
const searchingClientsPools = [
	new SearchingClientPool("everyone", () => true),
	new SearchingClientPool("default", username => !isAnonymousUsername(username))
];


/** @type SocketConnectionTicket[] */
const socketConnectionTickets = [];

/** @type Map<string, Discussion> */
const discussions = new Map();

/** @type Map<string, DiscussionCache> */
const discussionCaches = new Map();

/** @type Map<string, NotifFCM> */
const notifsFCM = new Map();












/**
 * Send to users a meet
 * @param {SearchingClient[]} clients 
 */
function joinClients(clients) {
	// Create a DiscussionCache
	const usernames = clients.map(client => client.username);
	const key = generateRandomKey();
	const cache = new DiscussionCache(usernames);
	cache.connectedUsers = clients.length; // all of the users are connected
	
	for (let i = 0; i < clients.length; i++) {
		clients[i].socketRef.discussions.set(key, {cache, position: i});
	}


	// Send a message
	const sendObject = JSON.stringify({
		type: 'meet',
		usernames,
		key
	});

	for (let i of clients) {
		i.socketRef.ws.send(sendObject);
	}
}



async function getNotifFCM(username) {
	let notif = notifsFCM.get(token);
	if (notif) {
		notif.updateNotifTimeout();
		return notif;
	}

	
	// Search already existing notif
	const results = await pool.query(
		`SELECT token FROM tiktalk_tokensFCM WHERE username = $1;`,
		[username]
	);

	notif = new NotifFCM(results.rows.map(row => row.token));
	notif.updateNotifTimeout();
	notifsFCM.set(username, notif);
	return notif;	
}

function unregisterFCM(username, token) {
	// Delete from current token
	const notif = notifsFCM.get(username);
	if (notif) {
		const index = notif.tokens.indexOf(token);
		if (index > 0) {
			notif.tokens.splice(index, 1);
		}
	}


	// Delete from SQL table
	pool.query(
	  `DELETE FROM tiktalk_tokensFCM
	   WHERE username = $1 AND token = $2;`,
	  [username, token]
	);
}

async function notifyFCM(username, title, body, data) {
	const notif = await getNotifFCM(username);

	await Promise.all(notif.tokens.map(async token => {
		try {
			await admin.messaging().send({
				token,
				notification: { title, body },
				data,
				android: { priority: 'high' }
			});
		} catch (err) {
			if (err.code === 'messaging/registration-token-not-registered') {
				unregisterFCM(username, token);
			} else {
				console.error('FCM error for token', token, err);
			}
		}

	}));
}




app.post('/api/signup', async (req, res) => {
	const { username, email, password } = req.body;
	if (!username || !email || !password) {
		return res.json({ success: false, message: 'Missing fields' });
	}

	if (isAnonymousUsername(username)) {
		return res.json({ success: false, message: 'Cannot start with "anonymous"' });
	}

	try {
		const hash = await bcrypt.hash(password, 10);
		const result = await pool.query(
			'INSERT INTO tiktalk_users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
			[username, email, hash]
		);
		req.session.username = username;
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
			'SELECT password_hash FROM tiktalk_users WHERE username = $1',
			[username]
		);
		if (result.rows.length === 1 && await bcrypt.compare(password, result.rows[0].password_hash)) {
			req.session.username = username;
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


app.get('/api/connectSocket', (req, res) => {
	const username = req.session?.username;

	if (!username) {
		res.json({username: undefined});
		return;
	}

	const ticket = new SocketConnectionTicket(username);
	socketConnectionTickets.push(ticket);
	res.json({username, key: ticket.key});
});

app.get('/api/createAnonymousAccount', (req, res) => {
	const username = generateAnonymousUsername();
	const ticket = new SocketConnectionTicket(username);
	socketConnectionTickets.push(ticket);
	res.json({username, key: ticket.key});
});

app.get('/api/version', (req, res) => {
	res.json({version: process.env.TIKTALK_VERSION});
});

app.post('/api/registerFCM', isAuthenticated, async (req, res) => {
	const username = req.session?.username;
	
	if (!username) {
		res.sendStatus(403);
		return;
	}
	
	const token = req.body.token;
	const notif = await getNotifFCM(username);

	if (notif.tokens.includes(token)) {
		res.sendStatus(200);
		return;
	}

	
	// Add token to sql table
	await pool.query(
		`INSERT INTO tiktalk_tokensFCM (username, token) VALUES ($1, $2);`,
		[username, token]
	);

	notif.tokens.push(token);
});


app.get('/api/checkAuth', (req, res) => res.json({ authenticated: !!req.session?.username }));

app.get('/api/collectPoolNames', (req, res) => {
	res.json({
		poolNames: searchingClientsPools.map(pool => pool.name)
	});
});



















wss.on('connection', async ws => {
	let __username__ = null;
	const socketRef = new SocketRef(ws);

	function getUsername() {
		if (__username__)
			return __username__;

		throw new Error("User not identified");
	}

	function send(msg) {
		ws.send(JSON.stringify(msg));
	}

	const events = {
		connect(data) {
			const idx = socketConnectionTickets.findIndex(
				i => i.username === data.username && compareKeys(i.key, data.key)
			);

			
			if (idx < 0) {
				send({
					type: 'connect',
					connected: false
				});
				
				return;
			}


			// Register user
			__username__ = data.username;
			clearTimeout(socketConnectionTickets[idx].timeout);
			socketConnectionTickets.splice(idx, 1);
			userSockets.set(__username__, socketRef);
			


			// Collect missed notifications
			// Also, let's create/join discussionCaches
			let missedNotifications = [];
			for (let {users, key} of data.contacts) {
				// Create/Join a discussion cache
				{
					let cache = discussionCaches.get(key);
					if (cache) {
						position = cache.users.indexOf(__username__);
						if (position < 0) {
							throw new Error("User not present in DiscussionCache users");
						}

					} else {
						position = -1;
						const fullUsers = [];
						for (let i = 0; i < users.length; i++) {
							if (users[i] === null) {
								position = i;
								fullUsers.push(__username__);
							} else {
								fullUsers.push(users[i]);
							}
						}

						if (position < 0) {
							throw new Error("User not present in DiscussionCache users");
						}

						cache = new DiscussionCache(fullUsers);
						discussionCaches.set(key, cache);
					}
	
					cache.connectedUsers++;
					socketRef.discussions.set(key, {cache, position});
				}

				
				// Collect missed notifications
				const discussion = discussions.get(key);
				if (!discussion) {
					continue;
				}

				const userIndex = discussion.users.indexOf(__username__);
				if (userIndex < 0) {
					throw new Error("Checking notifications for uninvited discussion");
				}


				const missedCount = discussion.markNotified(userIndex);

				if (missedCount > 0) {
					missedNotifications.push({
						key,
						missedCount,
						lastNotifDate: discussion.messages[discussion.messages.length-1].date
					});
				}
			}

			// Send response
			send({
				type: 'connect',
				connected: true,
				missedNotifications
			});
		},


		async search(data) {
			const username = getUsername();

			// Check if user is already in a pool
			if (searchingClientsPools.some(s => s.isInside(username))) {
				send({type: 'search_alreadyInside'});
				return;
			}

			let poolName = isAnonymousUsername(username) ? "everyone" : data.pool;
			const pool = searchingClientsPools.find(i => i.name === poolName);
			if (!pool) {
				send({type: 'search_notFound'})
				return;
			}

			if (!pool.isAccessible(username)) {
				send({type: 'search_notAccessible'});
				return;
			}

			
			const score = await getUserScore(username);

			const client = new SearchingClient(
				socketRef,
				username,
				score,
				data.blacklist
			);

			pool.pushClient(client);
			send({type: 'search_ok'});
		},


		listenFor(data) {
			// Update listenFor
			const key = data.key;
			socketRef.listenFor = key;

			//  # Send missed messages #
			
			const discussion = discussions.get(key);
			if (!discussion) {
				// No missed messages (so all have been read)
				send({
					type: 'missedMessages',
					list: [],
					seenMark: -1
				});
				return;
			}
			
			const userIndex = discussion.users.indexOf(getUsername());
			if (userIndex < 0)
				throw new Error("Listening for uninvited discussion");


			// Collect missed messages
			const list = [];
			for (let i = 0; i < discussion.messages.length; i++) {
				const msg = discussion.messages[i];
				
				list.push({
					content: msg.content,
					by: msg.authorIndex,
					date: msg.date
				});
			}

			// Remove messages read by eveyrone
			let seenMark;
			if (discussion.markRead(userIndex)) {
				discussions.delete(key);
				seenMark = -1;
			} else {
				seenMark = discussion.getSeenMark();
			}

			// Send missed messages
			send({
				type: 'missedMessages',
				list,
				seenMark
			});

			const sendObject = JSON.stringify({
				type: 'updateSeen',
				seenMark
			});

			for (let i = 0; i < discussion.users.length; i++) {
				if (i === userIndex)
					continue;

				userSockets.get(discussion.users[i])?.ws.send(sendObject);
			}
		},


		message(data) {
			const listenFor = socketRef.listenFor;
			if (!listenFor)
				throw new Error("ListenFor required to send a message");


			const {content, msgId} = data;
			let discussion = null;
			let message = null;
			
			
			const obj = socketRef.discussions.get(listenFor);
			if (!obj)
				throw new Error("Discussion cache not found");
			
			const {cache, position} = obj;
			const users = cache.users;
			const date = Date.now();


			for (let index = 0; index < users.length; index++) {
				const user = users[index];

				if (index === position)
					continue;
				
				const ref = userSockets.get(user);

				// Client directly listening for message (then content is sent)
				if (ref && compareKeys(ref.listenFor, listenFor)) {
					// Mark as read
					if (message) {
						message.readBy.push(index);
					}

					// Send content
					ref.ws.send(JSON.stringify({
						type: 'message',
						content,
						by: position,
						date
					}));

					continue;
				}

				// Generate discussion and add a message
				if (!discussion) {
					discussion = discussions.get(listenFor);
					if (!discussion) {
						discussion = new Discussion(users);
						discussions.set(listenFor, discussion);
					}

					// Create a message mark as read by previous users in loop
					message = new Message(
						date,
						content,
						position
					);

					discussion.messages.push(message);
					discussion.expireDate = date + Discussion.DISCUSSION_LIFETIME;

					// Next users have not yet read / getting notified of the message
					for (let i = index; i < users.length; i++) {
						if (i === position)
							continue;

						/// TODO: opti can be done : unnotified => unread ?
						if (discussion.firstUnreadMessage[i] === null)
							discussion.firstUnreadMessage[i] = message;

						if (discussion.firstUnnotifiedMessage[i] === null)
							discussion.firstUnnotifiedMessage[i] = message;						

					}
				}

				// Notify connected users
				if (ref) {
					// Notify using web socket
					discussion.firstUnnotifiedMessage[index] = null;

					ref.ws.send(JSON.stringify({
						type: 'msgNotif',
						key: listenFor
					}));
				
				} else {
					// Notify using FCM
					/// TODO: notif content
					notifyFCM(
						username,
						"New message",
						"Notif body",
						{username, conv: listenFor}
					);
				}
			}

			// Send message sent
			send({
				type: 'msgReceived',
				id: msgId,
				seenAll: !discussion,
				date
			});
		}
	};


	ws.on('message', async (message) => {
		let data;
		try {
			data = JSON.parse(message);
			const fn = events[data.type];
			if (!fn) {
				throw new Error("Invalid request : " + data.type);
			}

			await fn(data);

		}  catch (error) {
			console.error(error);
			send({type: 'error', error: error.message});
		}
	});	

	ws.on('close', () => {
		// Leave/Delete discussions caches
		for (let [key, {cache, position}] of socketRef.discussions) {
			if (--cache.connectedUsers <= 0) {
				discussionCaches.delete(key);
			} else {
				cache.setTypingMode(position, false);
			}
		}

		// Delete socket
		if (!__username__)
			return;		

		userSockets.delete(__username__);


	});
});



// Creating discussions
setInterval(() => {
	for (let i of searchingClientsPools) {
		i.meetLap();
	}
}, 1000);


// Delete expired discussions (checked every hour)
setInterval(() => {
	const now = Date.now();

	for (const [id, discussion] of discussions)
		if (discussion.expireDate <= now)
			discussions.delete(id);
		
	
}, 3600000); 



const PORT = process.env.PORT;
server.listen(PORT, '0.0.0.0', () => {
	console.log(`Server running on port ${PORT}`);
});


