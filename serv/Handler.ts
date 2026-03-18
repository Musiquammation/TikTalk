import WebSocket, { WebSocketServer } from "ws";
import { generateToken } from "./generateToken.ts";
import { Database } from "./Database.ts";

type session_t = string;
type id_t = string;


class UserSession {
	readonly id: id_t;
	readonly name: string;
	private date = Date.now();
	ws: WebSocket | null = null;

	public static COULDOWN = 3600*1000;

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



export class Handler {
	private db = new Database();
	private users = new Map<session_t, UserSession>();
	private talkRequests: TalkRequest[] = [];
	private interval: any;

	static WASH_INTERVAL = 3600*100;
	static USER_LIFETIME = 3*3600*100;

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
					this.users.delete(token);
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
		return {token: u.token, id};
	}

	async checkUser(email: string, password: string) {
		const c = await this.db.getUser(email, password);
		if (c === null)
			return null;

		const u = await this.connectUser(c.id, c.name);
		return {token: u.token, id: c.id};

	}

	async connectUser(id: id_t, name: string) {
		const token: session_t = generateToken();
		const session = new UserSession(id, name);

		this.users.set(token, session);
		return {token, session};
	}

	disconnectUser(session: session_t) {
		this.users.delete(session);
		this.talkRequests = this.talkRequests.filter(r => r.session !== session);
	}

	countMissedMsg(userId: string) {
		return this.db.countMissedMsg(userId);
	}

	appendSocket(session: session_t, ws: WebSocket) {
		const u = this.users.get(session);
		if (!u)
			return false;

		u.ws = ws;
		return true;
	}

	searchTalker(session: session_t, blacklist: id_t[]) {
		const u = this.users.get(session);
		if (!u) {
			throw new Error("Cannot find session");
		}

		for (const r of this.talkRequests) {
			if (r.blacklist.includes(u.id) || blacklist.includes(r.id))
				continue;
	
			this.startConv([r.session, session]);
			return r;
		}
	
		this.talkRequests.push(new TalkRequest(u.id, session, blacklist));
		return null;
	}

	startConv(sessions: session_t[]) {
		const groupId = generateToken();

		const list = sessions.map(s => {
			const u = this.users.get(s);
			if (!u) {
				throw new Error("Cannot find session");
			}

			return {id: u.id, ws: u.ws, name: u.name};
		});

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
}


