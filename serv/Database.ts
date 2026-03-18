import { Pool } from "pg";
import { randomUUID } from "crypto";

export class Database {
	private pool: Pool;

	constructor() {
		this.pool = new Pool({
			connectionString: process.env.DATABASE_URL
		});
	}

	async initializeTables(): Promise<void> {
		await this.pool.query(`
			CREATE TABLE IF NOT EXISTS users (
				id TEXT PRIMARY KEY,
				email TEXT UNIQUE NOT NULL,
				name TEXT NOT NULL,
				password TEXT NOT NULL
			)
		`);

		await this.pool.query(`
			CREATE TABLE IF NOT EXISTS messages (
				id SERIAL PRIMARY KEY,
				content TEXT NOT NULL,
				date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				author_id TEXT NOT NULL REFERENCES users(id),
				group_id TEXT
			)
		`);

		await this.pool.query(`
			CREATE TABLE IF NOT EXISTS sendMsg (
				id SERIAL PRIMARY KEY,
				msg_id INT NOT NULL REFERENCES messages(id),
				destination_id TEXT NOT NULL REFERENCES users(id)
			)
		`);
	}

	async addUser(name: string, email: string, password: string): Promise<string> {
		const id = randomUUID();

		await this.pool.query(
			`INSERT INTO users (id, email, name, password)
			 VALUES ($1, $2, $3, $4)`,
			[id, email, name, password]
		);

		return id;
	}

	async getUser(email: string, password: string) {
		const result = await this.pool.query(
			`SELECT id, name FROM users WHERE email = $1 AND password = $2`,
			[email+"", password+""]
		);

		if (!result.rows)
			return null;

		return result.rows[0] as {id: string, name: string};
	}


	async addMessage(
		content: string,
		authorId: string,
		destinationId: string,
		groupId: string | null
	) {
		const result = await this.pool.query(
			`INSERT INTO messages (content, author_id, group_id, date)
			 VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
			 RETURNING id`,
			[content, authorId, groupId]
		);

		const messageId = result.rows[0].id;

		await this.pool.query(
			`INSERT INTO sendMsg (msg_id, destination_id)
			 VALUES ($1, $2)`,
			[messageId, destinationId]
		);
	}

	async countMissedMsg(userId: string) {
		const result = await this.pool.query(`
			SELECT
				m.group_id AS group,
				COUNT(*) AS count,
				MAX(m.date) AS date 
			FROM messages m
			JOIN sendMsg s
				ON s.msg_id = m.id
			WHERE s.destination_id = $1
			GROUP BY m.group_id;
		`, [userId]);

		return result.rows.map(row => ({
			group: row.group as string,
			count: Number(row.count),
			date: Math.floor(new Date(row.date).getTime() / 1000)
		}));
	}
}
