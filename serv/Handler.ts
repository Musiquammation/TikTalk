import WebSocket, { WebSocketServer } from "ws";
import { generateToken } from "./generateToken.ts";
import { Database } from "./Database.ts";

type session_t = string;
type id_t = string;
type group_t = string;

class Group {
	users: session_t[];
	allUsers: id_t[];

	constructor(users: session_t[], allUsers: id_t[]) {
		this.users = users;
		this.allUsers = allUsers;
	}

	addUser(session: session_t) {
		if (!this.users.includes(session)) {
			this.users.push(session);
		}
	}

	removeUser(session: session_t) {
		this.users = this.users.filter(u => u !== session);
	}
}

class UserSession {
	readonly id: id_t;
	readonly name: string;
	private date = Date.now();
	group: string | null = null;
	ws: WebSocket | null = null;

	public static COULDOWN = 3600 * 1000;

	constructor(id: id_t, name: string) {
		this.id = id;
		this.name = name;
	}

	update() {
		this.date = Date.now();
	}

	getDate() {
		return this.date;
	}
}


class TalkRequest {
	id: id_t;
	session: session_t;
	blacklist: id_t[];

	constructor(id: id_t, session: session_t, blacklist: id_t[]) {
		this.id = id;
		this.session = session;
		this.blacklist = blacklist;
	}
}

async function generateGroupId(ids: string[]): Promise<string> {
	const sorted = [...ids].sort();

	const input = sorted.join("|");

	const encoder = new TextEncoder();
	const data = encoder.encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);

	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}



export class Handler {
	private db = new Database();
	private users = new Map<session_t, UserSession>();
	private groups = new Map<group_t, Group>();
	private talkRequests: TalkRequest[] = [];
	private interval: any;

	static WASH_INTERVAL = 3600 * 100;
	static USER_LIFETIME = 3 * 3600 * 100;

	constructor() {
		this.db.initializeTables();
	}

	startInterval() {
		if (!this.interval)
			return;

		this.interval = setInterval(() => {
			const now = Date.now();

			for (const [token, session] of this.users) {
				if (now - session.getDate() > Handler.USER_LIFETIME) {
					this.disconnectUser(token);
				}
			}

		}, Handler.WASH_INTERVAL);
	}

	stopInterval() {
		clearInterval(this.interval);
	}



	async createUser(name: string, email: string, password: string) {
		const id = await this.db.addUser(name, email, password);
		const u = await this.connectUser(id, name);
		return { token: u.token, id };
	}

	async checkUser(email: string, password: string) {
		const c = await this.db.getUser(email, password);
		if (c === null)
			return null;

		const u = await this.connectUser(c.id, c.name);
		return { token: u.token, id: c.id };

	}

	async connectUser(id: id_t, name: string) {
		const token: session_t = generateToken();
		const session = new UserSession(id, name);

		this.users.set(token, session);
		return { token, session };
	}

	disconnectUser(session: session_t) {
		// Remove session from groups
		for (const [groupId, group] of this.groups) {
			group.removeUser(session);
			if (group.users.length === 0) {
				this.groups.delete(groupId);
			}
		}

		this.users.delete(session);
		this.talkRequests = this.talkRequests.filter(r => r.session !== session);
	}


	countMissedMsg(userId: string) {
		return this.db.countMissedMsg(userId);
	}

	appendSocket(session: session_t, ws: WebSocket) {
		const u = this.users.get(session);
		if (!u) return null;

		u.ws = ws;

		// Add session in groups
		for (const [_, group] of this.groups) {
			if (group.allUsers.includes(u.id)) {
				group.addUser(session);
			}
		}

		ws.onclose = () => {
			this.disconnectUser(session);
		};

		return { username: u.name, id: u.id };
	}

	searchTalker(session: session_t, blacklist: id_t[]) {
		const u = this.users.get(session);
		if (!u) {
			console.error("Cannot find session:", session);
			throw new Error("Cannot find session");
		}

		// Search if session has already a request
		for (const r of this.talkRequests)
			if (r.session === session)
				return null;


		// for (const r of this.talkRequests) {
		const talkRequestLength = this.talkRequests.length;
		for (let i = 0; i < talkRequestLength; i++) {
			const r = this.talkRequests[i];
			if (r.id === u.id || r.blacklist.includes(u.id) || blacklist.includes(r.id))
				continue;

			this.talkRequests.splice(i, 1); // remove current request

			this.startConv([r.session, session]);
			return r;
		}

		this.talkRequests.push(new TalkRequest(u.id, session, blacklist));
		return null;
	}

	removeTalker(session: session_t) {
		for (let i = this.talkRequests.length - 1; i >= 0; i--) {
			if (this.talkRequests[i].session === session) {
				this.talkRequests.splice(i, 1);
			}
		}
	}

	async startConv(sessions: session_t[]) {
		const list = sessions.map(s => {
			const u = this.users.get(s);
			if (!u) {
				console.error("Cannot find", s);
				throw new Error("Cannot find session");
			}

			return { id: u.id, ws: u.ws, name: u.name };
		});

		const groupId = await generateGroupId(list.map(u => u.id));

		for (let i = 0; i < list.length; i++) {
			const u = list[i];
			if (!u.ws)
				continue;

			u.ws.send(JSON.stringify({
				action: 'group',
				groupId,
				pos: i,
				users: list.map((u, idx) =>
					idx !== i ? u.id : null).filter(Boolean),
				usernames: list.map((u, idx) =>
					idx !== i ? u.name : null).filter(Boolean)
			}));
		}
	}

	collectSessions(userId: id_t) {
		const list: UserSession[] = [];

		for (const session of this.users.values()) {
			if (session.id === userId) {
				list.push(session);
			}
		}

		return list;
	}

	async selectGroup(session: session_t, groupId: string | null, allUsers: id_t[] | null) {
		const u = this.users.get(session);
		if (!u) {
			throw new Error("Cannot find session");
		}

		// Quit previous group
		u.group = null;


		// Enter new group
		if (groupId === null)
			return null;

		if (allUsers === null)
			throw new Error("Missing allUsers");

		// Check given allUsers
		allUsers.push(u.id);
		const candidateId = await generateGroupId(allUsers);
		if (candidateId !== groupId) {
			throw new Error("allUsers list does not match groupId");
		}

		// Create group
		if (!this.groups.has(groupId)) {
			const activeSessions = [...this.users.entries()]
				.filter(([_, u]) => allUsers.includes(u.id))
				.map(([s]) => s);

			this.groups.set(groupId, new Group(activeSessions, allUsers));
		}

		u.group = groupId;

		// Collect missed messages
		return await this.db.collectMissedMessages(u.id, groupId);
	}

	pushMessage(session: session_t, content: string,
		groupId: string, author: number, date: number
	) {
		const u = this.users.get(session);
		if (!u) {
			throw new Error("Cannot find session");
		}

		if (u.group !== groupId) {
			throw new Error("Invalid group");
		}

		const group = this.groups.get(groupId);
		if (!group) {
			throw new Error("Active group cannot be found");
		}

		const handledIds = new Set<id_t>();
		handledIds.add(u.id);

		// Send message to connected users
		console.log(group.users);
		for (const us of group.users) {
			if (us === session)
				continue; // same user

			const user = this.users.get(us);
			if (!user || !user.ws)
				continue;


			// Check group
			if (user.group === groupId) {
				user.ws.send(JSON.stringify({
					action: 'push',
					content,
					author,
					date
				}));

				handledIds.add(user.id);

			} else {
				user.ws.send(JSON.stringify({
					action: 'miss',
					groupId,
					author,
					date
				}));
			}
		}

		// Save missed messages
		const missersIds = [];
		for (const cid of group.allUsers)
			if (!handledIds.has(cid))
				missersIds.push(cid);


		if (missersIds) {
			this.db.addMissedMessage(content, missersIds, u.id, date, groupId);
		}
	}
}


