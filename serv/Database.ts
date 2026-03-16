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
				id TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				author_id TEXT NOT NULL,
				destination_id TEXT NOT NULL,
				group_id TEXT,
				FOREIGN KEY (author_id) REFERENCES users(id),
				FOREIGN KEY (destination_id) REFERENCES users(id)
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

	async getUser(email: string, password: string): Promise<string | null> {
		const result = await this.pool.query(
			`SELECT id FROM users WHERE email = $1 AND password = $2`,
			[email, password]
		);

		return result.rows[0]?.id ?? null;
	}

	async addMessage(
		content: string,
		author: string,
		destination: string,
		groupId: string | null
	): Promise<void> {
		const id = randomUUID();

		await this.pool.query(
			`INSERT INTO messages
			 (id, content, author_id, destination_id, group_id)
			 VALUES ($1, $2, $3, $4, $5)`,
			[id, content, author, destination, groupId]
		);
	}
}
