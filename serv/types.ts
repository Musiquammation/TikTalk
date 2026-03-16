type token_t = string;
type id_t = string;

export const users = new Map<token_t, UserSession>();
export const talkRequests: TalkRequest[] = [];


class UserSession {
	readonly id: id_t;
	readonly token: token_t;
	private timeout;

	public static COULDOWN = 3600*1000;

	constructor(id: id_t, token: token_t) {
		this.id = id;
		this.token = token;
		this.timeout = setTimeout(() => this.remove());
	}

	remove() {
		users.delete(this.token);
		
	}

	update() {
		clearTimeout(this.timeout);
		this.timeout = setTimeout(() => this.remove());
	}

	static generateToken(): token_t {
		const bytes = crypto.getRandomValues(new Uint8Array(8));
		return Array.from(bytes)
			.map(b => b.toString(16).padStart(2, "0"))
			.join("");

	}

	static append(id: id_t) {
		const token = UserSession.generateToken();
		const session = new UserSession(id, token);

		users.set(token, session);

		return {token, session};
	}
}


class TalkRequest {
	userId: id_t;
	blacklist: id_t[];

	constructor(user: token_t, blacklist: id_t[]) {
		this.userId = user;
		this.blacklist = blacklist;
	}
}


function searchTalker(request: TalkRequest) {
	for (const r of talkRequests) {
		if (r.blacklist.includes(request.userId) || request.blacklist.includes(r.userId))
			continue;

		return r;
	}

	talkRequests.push(request);
	return null;
}