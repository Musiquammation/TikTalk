const express = require('express');
const path = require('path');
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

app.use(cors({
	origin: true,
	credentials: true,
}));


app.use(express.json());
app.use(express.urlencoded({ extended: true }));


admin.initializeApp({
	credential: admin.credential.cert(
		JSON.parse(process.env.SERVICE_ACCOUNT_KEY)
	),
});

const transporter = nodemailer.createTransport({
	service: 'gmail',
	auth: {
		user: process.env.MAILER_USER,
		pass: process.env.MAILER_PASS
	}
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/index', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
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
			money INT DEFAULT 0,
			money_toGive FLOAT DEFAULT 0,
			current_realconvs_count INT DEFAULT 0,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			ban BIGINT DEFAULT 0
		);
	`).catch(err => console.error(err));

	await pool.query(`
		DROP TABLE IF EXISTS tiktalk_tokensFCM;
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
		CREATE TABLE IF NOT EXISTS tiktalk_tokensSES (
			username VARCHAR(255) NOT NULL,
			token VARCHAR(255) UNIQUE NOT NULL,
			PRIMARY KEY (token, username),
			FOREIGN KEY (username) REFERENCES tiktalk_users(username) ON DELETE CASCADE
		);
	`).catch(err => console.error(err));

	await pool.query(`
		CREATE INDEX IF NOT EXISTS tiktalk_idx_tokensFCM 
		ON tiktalk_tokensFCM(username);
	`).catch(err => console.error(err));

	await pool.query(`
		CREATE INDEX IF NOT EXISTS tiktalk_idx_tokensSES 
		ON tiktalk_tokensSES(username);
	`).catch(err => console.error(err));

	await pool.query(`
		CREATE TABLE IF NOT EXISTS tiktalk_payments (
		id SERIAL PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES tiktalk_users(id) ON DELETE CASCADE,
		type INTEGER,
		value TEXT NOT NULL,
		expire_date BIGINT NOT NULL);
	`).catch(err => console.error(err));


	await pool.query(`
		CREATE TABLE IF NOT EXISTS tiktalk_reports (
			id SERIAL PRIMARY KEY,
			username VARCHAR(255) NOT NULL REFERENCES tiktalk_users(username) ON DELETE CASCADE,
			reporter VARCHAR(255) NOT NULL REFERENCES tiktalk_users(username) ON DELETE CASCADE,
			date BIGINT NOT NULL,
			CONSTRAINT unique_report UNIQUE (username, reporter)
		);

	`).catch(err => console.error(err));

	await pool.query(`
		CREATE INDEX IF NOT EXISTS tiktalk_idx_reports
		ON tiktalk_reports(username);
	`).catch(err => console.error(err));

	await pool.query(`
		CREATE TABLE IF NOT EXISTS tiktalk_realconvs (
			id SERIAL PRIMARY KEY,
			user0 VARCHAR(255) NOT NULL,
			user1 VARCHAR(255) NOT NULL,
			CONSTRAINT fk_user0 FOREIGN KEY (user0) REFERENCES tiktalk_users(username) ON DELETE CASCADE,
			CONSTRAINT fk_user1 FOREIGN KEY (user1) REFERENCES tiktalk_users(username) ON DELETE CASCADE,
			CONSTRAINT check_order CHECK (user0 < user1),
			CONSTRAINT unique_pair UNIQUE (user0, user1)
		);
	`).catch(err => console.error(err));

	await deleteExpiredPayments();
})();






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
	return crypto.randomBytes(8).toString('hex');
}


function compareKeys(a, b) {
	return a === b;
}

function generateResetCode() {
	return Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
}

function getRealConvMoneyRatio(n) {
	const table = [
		1,
		0.75,
		0.375,
		0.1666667,
		0.0729167,
		0.0333333,
		0.0159722,
		0.007862,
	];

	if (n > table.length)
		return 0.001;

	return table[n];
}


/**
 * Generate a 64-bit FNV-1a hash from an array of strings.
 * Returns a 16-character hex string.
 */
function hashStrings64(arr) {
	if (!Array.isArray(arr)) {
		throw new TypeError('Expected an array of strings');
	}

	const items = arr.map(s => (s == null ? '' : String(s)).trim()).sort();

	const joined = items.join('\u0000'); // null separator

	// FNV-1a 64-bit constants
	let h = BigInt(process.env.HASH_STRINGS_OFFSET); // offset basis
	const fnvPrime = BigInt(process.env.HASH_STRINGS_PRIME);

	for (let i = 0; i < joined.length; i++) {
		h ^= BigInt(joined.charCodeAt(i));
		h = (h * fnvPrime) & BigInt('0xFFFFFFFFFFFFFFFF'); // 64-bit mask
	}

	// Return as 16-character hex
	return h.toString(16).padStart(16, '0');
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

	constructor(username, score, blacklist) {
		this.username = username;
		this.score = score;
		this.lap = SearchingClient.START_LAPS;
		this.blacklist = blacklist || [];
	}
}

class SearchingClientPool {
	static PAIEMENT_DURATION = 86400000 * 3; // 3 days

	constructor(name, price, anonymousForbidden = true) {
		this.name = name;
		this.price = price;
		this.anonymousForbidden = anonymousForbidden;
		
		/** @type SearchingClient[] */
		this.clients = [];
	}

	async isAccessible(username) {
		if (!this.anonymousForbidden && isAnonymousUsername(username)) {
			return false;
		}

		if (this.name === "default")
			return true;

		// Search for payment
		return (await pool.query(`
			SELECT 1
			FROM tiktalk_payments p
			JOIN tiktalk_users u ON p.user_id = u.id
			WHERE u.username = $1
			AND p.type = $2
			AND p.value = $3
			AND p.expire_date >= $4
			LIMIT 1;
		`, [username, PaymentType.CLIENT_POOL, this.name, Date.now()])).rowCount > 0;
	}

	isInside(username) {
		return this.clients.some(client => client.username === username);
	}

	removeUser(username) {
		for (let i = this.clients.length - 1; i >= 0; i--)
			if (this.clients[i].username === username)
				this.clients.splice(i, 1);
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

	removeIfPresent(username) {
		const idx = this.clients.findIndex(x => x.username === username);
		if (idx >= 0)
			this.clients.slice(idx, 1);

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

		this.writingFlags = new Int8Array(users.length)
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
		this.lastMsgAuthor = null;
		this.alternedMessageCount = 0;
	}

	setTypingMode(index, value, silent = false) {
		if (this.typingUsersMap[index] == value)
			return;

		this.typingUsersMap[index] = value;

		if (silent)
			return;
			
		// Send typing mode to users
		const sentObject = JSON.stringify({
			type: value ? 'typingStart' : 'typingStop',
			index
		});

		for (let i = 0; i < this.users.length; i++) {
			if (i === index)
				continue;

			const socketRef = userSockets.get(this.users[i]);
			if (socketRef) {
				socketRef.ws.send(sentObject);
			}
		}
	}
}


class UserSession {
	static LIFETIME = 10 * 360000; // 10mn

	constructor(username) {
		this.username = username;
		this.timeout = -1;
	}

	update() {
		if (this.timeout >= 0) {
			clearTimeout(this.timeout);
		}

		// Clear memory
		this.timeout = setTimeout(() => {
			for (const [key, value] of userSessions) {
				if (value === this) {
					userSessions.delete(key);
				}
			}
		}, UserSession.LIFETIME);
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
			for (const [key, value] of userSessions) {
				if (value === this) {
					userSessions.delete(key);
				}
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



class PaymentType {
	static CLIENT_POOL = 1;

	constructor(getPrice, run) {
		this.getPrice = getPrice;
		this.run = run;
	}
}


class MissedSearchResult {
	static LIFETIME = 14 * 86400000; // 14 days

	constructor(username, usernames, key) {
		this.username = username;
		this.usernames = usernames;
		this.key = key;
		this.timeout = setTimeout(
			() => this.removeResult(),
			MissedSearchResult.LIFETIME
		);
	}

	removeResult() {
		const arr = missedSearchResults.get(this.username);
		if (!arr)
			return;

		const index = arr.indexOf(this);
		if (index !== -1) {
			arr.splice(index, 1);
		}

		if (arr.length === 0) {
			missedSearchResults.delete(key);
		}
	}

	static getAndRemove(username) {
		const arr = missedSearchResults.get(username);
		if (!arr)
			return null;

		for (let i of arr)
			clearTimeout(i.timeout);

		return arr;
	}
}




const wss = new WebSocket.Server({ server });

/** @type Map<string, SocketRef> */
const userSockets = new Map();

/** @type SearchingClientPool[] */
const searchingClientsPools = [
	new SearchingClientPool("everyone", -1, false),
	new SearchingClientPool("default", -1),
	new SearchingClientPool("nice", 10)
];


/** @type SocketConnectionTicket[] */
const socketConnectionTickets = [];

/** @type Map<string, Discussion> */
const discussions = new Map();

/** @type Map<string, DiscussionCache> */
const discussionCaches = new Map();

/** @type Map<string, UserSession> */
const userSessions = new Map();

/** @type Map<string, NotifFCM> */
const notifsFCM = new Map();

/** @type Map<string, { code, expires, timeout, userId }> */
const resetCodes = new Map();

const missedSearchResults = new Map();


const paymentTypes = {
	clientPool: new PaymentType(
		(username, data) => {
			const name = data.name;
			for (let pool of searchingClientsPools)
				if (pool.name === name)
					return pool.price;

			return -1;
		},

		(username, data) => ({
			type: PaymentType.CLIENT_POOL,
			value: data.name,
			duration: SearchingClientPool.PAIEMENT_DURATION
		})

		
	)
};


function generateResetCode() {
	return Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
}








/**
 * Send to users a meet
 * @param {SearchingClient[]} clients 
 */
function joinClients(clients) {
	clients.sort((a, b) => a.username <= b.username);

	// Create a DiscussionCache
	const usernames = clients.map(client => client.username);
	const key = hashStrings64(usernames);
	const cache = new DiscussionCache(usernames);
	cache.connectedUsers = clients.length; // all of the users are connected
	
	const sentObjectJSON = JSON.stringify({
		type: 'meet',
		usernames,
		key
	});

	for (let i = 0; i < clients.length; i++) {
		const username = clients[i].username;
		const ref = userSockets.get(clients[i].username);
		if (ref) {
			ref.discussions.set(key, {cache, position: i});
			ref.ws.send(sentObjectJSON);
		} else {
			let left = usernames.length - 1; // on ne compte pas `username`
			let result = "";

			for (let i = 0; i < usernames.length; i++) {
				if (usernames[i] === username) continue; // on saute son propre nom

				result += usernames[i];
				left--;

				if (left > 0) {
					result += left === 1 ? " and " : ", ";
				}
			}

			notifyFCM(
				username,
				"Research done!",
				`${result} ${usernames.length > 2 ? "are" : "is"} also bored.`,
				{}
			);

			const mso = new MissedSearchResult(username, usernames, key);

			if (missedSearchResults.has(username)) {
				missedSearchResults.get(username).push(mso);
			} else {
				missedSearchResults.set(username, [mso]);
			}
		}
	}
}



async function getNotifFCM(username) {
	let notif = notifsFCM.get(username);
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
	console.log("Notify", username, notif.tokens);

	await Promise.all(notif.tokens.map(async token => {
		try {
			await admin.messaging().send({
				token,
				
				notification: { title, body },

				data: Object.fromEntries(
					Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
				),

				android: {
					priority: 'high',
					notification: {
						channelId: 'default'
					}
				},

				apns: {
					payload: {
						aps: {
							sound: 'default'
						}
					}
				}
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





function generateUserSessionToken(username) {
	const sessionToken = generateRandomKey();
	const session = new UserSession(username);
	userSessions.set(sessionToken, session);

	pool.query(`INSERT INTO tiktalk_tokensSES (username, token) VALUES ($1, $2);`,
		[username, sessionToken]
	);

	return sessionToken;
}

function deleteUserSessionToken(sessionToken) {
	if (!sessionToken)
		return;

	const s = userSessions.get(sessionToken);
	if (!s) {
		return;
	}

	
	for (let sp of searchingClientsPools) {
		sp.removeIfPresent(s.username);
	}

	clearTimeout(s.timeout);
	userSessions.delete(sessionToken);


	pool.query(`DELETE FROM tiktalk_tokensSES WHERE token=$1;`,
		[sessionToken]
	);
}

async function getUserSession(sessionToken) {
	if (!sessionToken)
		return null;

	let session = userSessions.get(sessionToken);
	if (session) {
		session.update();
		return session;
	}
	
	// Search already existing session
	const results = await pool.query(
		`SELECT username FROM tiktalk_tokensSES WHERE token = $1;`,
		[sessionToken]
	);

	if (results.rows.length === 0) {
		return null;
	}

	session = new UserSession(results.rows[0].username);
	session.update();
	userSessions.set(sessionToken, session);
	return session;
}





async function addPayment(username, type, value, duration) {
	const now = Date.now();
	duration += now;

	await pool.query(`
		WITH deleted AS (
			DELETE FROM tiktalk_payments
			WHERE expire_date < $3
		)
		INSERT INTO tiktalk_payments (user_id, type, value, expire_date)
		SELECT id, $5, $1, $2
		FROM tiktalk_users
		WHERE username = $4;
	`, [value, duration, now, username, type]);
}



async function collectUserPayments(username) {
	const now = Date.now();
	const res = await pool.query(
		`WITH deleted AS (
			DELETE FROM tiktalk_payments
			WHERE expire_date < $1
		)
		SELECT p.*
		FROM tiktalk_payments p
		JOIN tiktalk_users u ON p.user_id = u.id
		WHERE u.username = $2
		ORDER BY p.expire_date ASC;`,
		[now, username]
	);

	return res.rows;
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
		await pool.query(
			'INSERT INTO tiktalk_users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
			[username, email, hash]
		);
		
		const sessionToken = generateUserSessionToken(username);
		res.json({ sessionToken  });

	} catch (err) {
		if (err.code === '23505') res.json({ success: false, message: 'Username or email exists.' });
		else res.json({ sessionToken: null, message: 'Signup failed.' });
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
			const sessionToken = generateUserSessionToken(username);
			res.json({ sessionToken });

		} else {
			res.json({ sessionToken: null, message: 'Invalid credentials' });
		}
	} catch (err) {
		res.json({ sessionToken: null, message: 'Login error' });
	}
});

app.post('/api/logout', (req, res) => {
	deleteUserSessionToken(req.body.sessionToken);
	res.json({ok: true});
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













app.post('/api/connectSocket', async (req, res) => {
	const userSession = await getUserSession(req.body.sessionToken);
	if (!userSession) {
		res.json({username: undefined});
		return;
	}

	
	const ticket = new SocketConnectionTicket(userSession.username);
	socketConnectionTickets.push(ticket);
	res.json({username: userSession.username, key: ticket.key});
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

app.post('/api/registerFCM', async (req, res) => {
	const userSession = await getUserSession(req.body.sessionToken);
	if (!userSession) {
		res.json({ok: false});
		return;
	}
	
	const token = req.body.token;
	const notif = await getNotifFCM(userSession.username);

	if (notif.tokens.includes(token)) {
		res.json({ok: true});
		return;
	}

	
	// Add token to sql table
	await pool.query(
		`INSERT INTO tiktalk_tokensFCM (username, token) VALUES ($1, $2);`,
		[userSession.username, token]
	);

	notif.tokens.push(token);
	res.json({ok: true});
});


app.post('/api/checkAuth', async (req, res) => {
	res.json({
		authenticated: (await getUserSession(req.body.sessionToken)) !== null
	})
});

app.get('/api/collectPoolNames', (req, res) => {
	res.json({
		poolNames: searchingClientsPools.map(pool => pool.name)
	});
});


app.post('/api/pay', async (req, res) => {
	const userSession = await getUserSession(req.body.sessionToken);
	if (!userSession) {
		res.json({error: 'notConnected'});
		return;
	}


	const paymentType = paymentTypes[req.body.type];
	if (!paymentType) {
		res.json({error: 'notFound'});
		return;
	}

	const price = paymentType.getPrice(userSession.username, req.body.data);
	if (price < 0) {
		res.json({error: 'refused'});
		return;
	}

	const result = await pool.query(
		`UPDATE tiktalk_users
    	SET money = money - $1
    	WHERE username = $2 AND money >= $1
    	RETURNING money;`,
		[price, userSession.username]
	);

	if (result.rowCount === 0) {
		// Payment failed
		res.json({error: 'money'});
		return;

	}


	// Add payment
	const payment = paymentType.run(userSession.username, req.body.data);
	await addPayment(userSession.username, payment.type, payment.value, payment.duration);


	// Payment done
	res.json({money: result.rows[0].money});
});

app.post('/api/getShopInfo', async (req, res) => {
	const userSession = await getUserSession(req.body.sessionToken);
	if (!userSession || isAnonymousUsername(userSession.username)) {
		res.json({ok: false});
		return;
	}

	const payments = await collectUserPayments(userSession.username);
	const money = await pool.query(
		`SELECT money FROM tiktalk_users WHERE username = $1`,
		[userSession.username]
	);

	const searchPools = searchingClientsPools.map(p => ({
		name: p.name,
		price: p.price,
		anonymousAllowed: p.anonymousAllowed,
		userCount: p.clients.length
	}));


	res.json({
		ok: true,
		payments,
		money: money.rows[0].money,
		searchPools
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
					connected: false,
					error: 'ticketNotFound'
				});
				
				return;
			}


			// Remove ticket
			__username__ = data.username;
			clearTimeout(socketConnectionTickets[idx].timeout);
			socketConnectionTickets.splice(idx, 1);

			// Check user is not already connected
			if (userSockets.get(__username__)) {
				send({
					type: 'connect',
					connected: false,
					error: 'alreadyConnected'
				});
				
				return;
			}

			// Register user
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

						// Check if (key, fullUsers) is a valid couple
						if (key != hashStrings64(fullUsers)) {
							throw new Error("Illegal (key, fullUsers) combinaison");
						}

						// Create discussion cache
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


			const mso = MissedSearchResult.getAndRemove(__username__);

			const missedSearchResults = mso ? 
				mso.map(m => ({key: m.key, usernames: m.usernames})) :
				null;

			// Send response
			send({
				type: 'connect',
				connected: true,
				missedNotifications,
				missedSearchResults
			});
		},


		async search(data) {
			const username = getUsername();

			// Check if user is already in a pool
			for (let i of searchingClientsPools)
				i.removeUser(username);

			let poolName = isAnonymousUsername(username) ? "everyone" : data.pool;
			const pool = searchingClientsPools.find(i => i.name === poolName);
			if (!pool) {
				send({type: 'search_notFound'})
				return;
			}

			if (!(await pool.isAccessible(username))) {
				send({type: 'search_notAccessible'});
				return;
			}

			
			const score = await getUserScore(username);

			const client = new SearchingClient(
				username,
				score,
				data.blacklist
			);

			pool.pushClient(client);
			send({type: 'search_ok'});
		},


		listenFor(data) {
			// Set typing mode of the user
			if (socketRef.listenFor) {
				const obj = socketRef.discussions.get(socketRef.listenFor);
				if (!obj)
					throw new Error("Discussion cache not found");
				
				const {cache, position} = obj;
				cache.setTypingMode(position, false);

			}


			// Update listenFor
			const key = data.key;
			
			if (key === null) {
				socketRef.listenFor = null;
				return;
			}
			
			socketRef.listenFor = key;

			//  # Send missed messages #
			const discussion = discussions.get(key);
			if (!discussion) {
				// No missed messages (so all have been read)
				send({
					type: 'missedMessages',
					list: [],
					seenMark: -1,
					writingFlags: null
				});
				return;
			}
			
			const userIndex = discussion.users.indexOf(getUsername());
			if (userIndex < 0)
				throw new Error("Listening for uninvited discussion");


			// Collect missed messages
			const list = [];
			const firstUnreadMessage = discussion.firstUnreadMessage[userIndex];
			
			if (firstUnreadMessage) {
				let i = discussion.messages.indexOf(firstUnreadMessage);

				if (i >= 0) {
					for (; i < discussion.messages.length; i++) {
						const msg = discussion.messages[i];
						
						list.push({
							content: msg.content,
							by: msg.authorIndex,
							date: msg.date
						});
					}
				}
			}


			// Remove messages read by eveyrone
			let seenMark;
			if (discussion.markRead(userIndex)) {
				discussions.delete(key);
				seenMark = -1;
			} else {
				seenMark = discussion.getSeenMark();
			}


			send({
				type: 'missedMessages',
				list,
				seenMark,
				writingFlags: discussion.writingFlags.map(v => v ? "1" : "0").join("")
			});

			const sentObject = JSON.stringify({
				type: 'updateSeen',
				seenMark
			});

			for (let i = 0; i < discussion.users.length; i++) {
				if (i === userIndex)
					continue;

				userSockets.get(discussion.users[i])?.ws.send(sentObject);
			}
		},


		async message(data) {
			const listenFor = socketRef.listenFor;
			if (!listenFor)
				throw new Error("ListenFor required to send a message");


			const {content, msgId} = data;
			let discussion = null;
			let message = null;

			const author = getUsername();
			if (!author)
				throw new Error("Username of the author required");

			const obj = socketRef.discussions.get(listenFor);
			if (!obj)
				throw new Error("Discussion cache not found");
			
			const {cache, position} = obj;
			const users = cache.users;
			const date = Date.now();

			// Set typing mode (without alerting users)
			cache.setTypingMode(position, false, true);


			// Send/Collect messages/notifs
			for (let index = 0; index < users.length; index++) {
				const username = users[index];

				if (index === position)
					continue;
				
				const ref = userSockets.get(username);

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
					notifyFCM(
						username,
						"New message",
						author + " sent you a message",
						{author, conv: listenFor}
					);
				}
			}

			// Increase cache.alternedMessageCount and maybe give money
			if (position !== cache.lastMsgAuthor) {
				cache.lastMsgAuthor = position;
				if (
					++cache.alternedMessageCount === +process.env.MONEY_GIVE_ALTERNED_COUNT
					&& cache.users.length === 2
				) {
					console.log("GIVE!");

					const res0 = await pool.query(
						'SELECT 1 FROM tiktalk_realconvs WHERE user0 = $1 AND user1 = $2',
						cache.users
					);
					
					// Give money
					if (res0.rowCount == 0) {
						// Save couple
						await pool.query(
							'INSERT INTO tiktalk_realconvs (user0, user1) VALUES ($1, $2)',
							cache.users
						);

						// Give money
						for (const user of cache.users) {
							const res = await pool.query(
								`SELECT current_realconvs_count
								FROM tiktalk_users
								WHERE username = $1 FOR UPDATE`,
								[user]
							);

							const currentCount = res.rows[0].current_realconvs_count;
							const delta = getRealConvMoneyRatio(currentCount) *
								process.env.MONEY_GIVE_ALTERNED_VALUE;


							await pool.query(`
								UPDATE tiktalk_users
								SET money_toGive = money_toGive + $2,
									current_realconvs_count = current_realconvs_count + 1
								WHERE username = $1
							`, [user, delta]);
						}
					}

				}
			}



			// Send message sent
			send({
				type: 'msgReceived',
				id: msgId,
				seenAll: !discussion,
				date
			});
		},

		typingStart() {
			const obj = socketRef.discussions.get(socketRef.listenFor);
			if (!obj)
				return;

			const {cache, position} = obj;
			cache.setTypingMode(position, true);
		},

		typingStop() {
			const obj = socketRef.discussions.get(socketRef.listenFor);
			if (!obj)
				return;

			const {cache, position} = obj;
			cache.setTypingMode(position, false);
		},

		async report() {
			// Get reported username
			let reported = null;
			if (!isAnonymousUsername(__username__) && socketRef.listenFor) {
				const cache = discussionCaches.get(socketRef.listenFor);
				if (cache) {
					if (cache.users.length === 2) {
						reported = cache.users[0] === __username__ ?
							cache.users[1] : cache.users[0];
					}
				}
			}


			if (!reported) {
				send({
					type: 'reportResult',
					ok: false
				});
				return;
			}

			const now = Date.now();
			const cutoff = now - process.env.REPORT_REFRESH_PERIOD * 86400000;


			// Remove old reports
			await pool.query(
				`DELETE FROM tiktalk_reports 
				WHERE date < $1`,
				[cutoff]
			);

			// Add report
			const insertResult = await pool.query(
				`INSERT INTO tiktalk_reports (username, reporter, date)
				VALUES ($1, $2, $3)
				ON CONFLICT (username, reporter) DO NOTHING`,
				[reported, __username__, now]
			);

			// Get user reports
			const { rows } = await pool.query(
				`SELECT COUNT(*)::int AS count
				FROM tiktalk_reports
				WHERE username = $1`,
				[reported]
			);

			
			// Ban user
			if (rows[0].count >= +process.env.REPORT_COUNT_LIMIT) {
				await pool.query(`
					UPDATE tiktalk_users
					SET ban = 1
					WHERE username = $1;
				`, [reported])
			}

			// Send report result
			send({
				type: 'reportResult',
				ok: insertResult.rowCount > 0
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




// Notify everyone daily
function scheduleRush() {
	const now = new Date();

	// Create tomorrow's date in UTC
	const tomorrowUTC = new Date(Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate() + 1,
		0, 0, 0, 0
	));

	// Random hour between 10 and 20 Paris time
	const randomHourParis = 10 + Math.random() * 10;
	const hour = Math.floor(randomHourParis);
	const minute = Math.floor((randomHourParis - hour) * 60);

	tomorrowUTC.setUTCHours(hour - 1, minute, 0, 0); // -1 because Paris is UTC+1 in standard time

	const delay = tomorrowUTC.getTime() - now.getTime();

	console.log(
		"Notif rush scheduled for Paris time:",
		tomorrowUTC.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })
	);





	setTimeout(async () => {
		scheduleRush();

		// Give money to users
		await pool.query(`UPDATE tiktalk_users
			SET money = money + CAST(money_toGive AS INT),
    		money_toGive = 0;`
		);

		
		// Send notifications
		const users = await pool.query(
			"SELECT username FROM tiktalk_users;"
		);

		for (let row of users.rows) {
			notifyFCM(
				row.username,
				"Everyone’s online",
				"Everyone got this notification! Log in now to instantly meet someone.",
				{rush: true}
			)
		}
	}, delay);
}

scheduleRush();



// Delete expired paiements
async function deleteExpiredPayments() {
	const now = Date.now();
	const res = await pool.query(
		"DELETE FROM tiktalk_payments WHERE expire_date < $1",
		[now]
	);
	
	console.log(`${res.rowCount} payments deleted.`);
}


setInterval(deleteExpiredPayments, 86400000); // daily






const PORT = process.env.PORT;
server.listen(PORT, '0.0.0.0', () => {
	console.log(`Server running on port ${PORT}`);
});


