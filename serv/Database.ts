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
				group_id TEXT,
				owners INT
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

	async collectMissedMessages(userId: string, groupId: string) {
		const client = await this.pool.connect();

		try {
			await client.query('BEGIN');

			/**
			 * Remove sendMsg, and apply m.owners--.
			 * If m.owners <= 0, then destroy the message
			 */
			const result = await client.query(`
				WITH target AS (
					SELECT m.id, m.content, m.date, m.author_id
					FROM messages m
					JOIN sendMsg s ON s.msg_id = m.id
					WHERE s.destination_id = $1
					AND m.group_id = $2
				),
				deleted_send AS (
					DELETE FROM sendMsg s
					USING messages m
					WHERE s.msg_id = m.id
					AND s.destination_id = $1
					AND m.group_id = $2
					RETURNING s.msg_id
				),
				updated_messages AS (
					UPDATE messages m
					SET owners = m.owners - 1
					FROM deleted_send ds
					WHERE m.id = ds.msg_id
					RETURNING m.id, m.owners
				),
				deleted_messages AS (
					DELETE FROM messages m
					USING updated_messages um
					WHERE m.id = um.id
					AND um.owners <= 0
				)
				SELECT
					t.content,
					t.date,
					t.author_id AS author
				FROM target t;
			`, [userId, groupId]);

			await client.query('COMMIT');

			return result.rows.map(row => ({
				content: row.content as string,
				date: Math.floor(new Date(row.date).getTime() / 1000),
				author: row.author as string
			}));


		} catch (err) {
			await client.query('ROLLBACK');
			throw err;
		} finally {
			client.release();
		}
	}

	async addMissedMessage(content: string, destIds: string[],
		authorId: string, date: number, groupId: string
	) {
		const client = await this.pool.connect();

		try {
			await client.query('BEGIN');

			// Insert message
			const res = await client.query(
				`INSERT INTO messages (content, date, author_id, group_id, owners)
				VALUES ($1, $2, $3, $4, $5)
				RETURNING id;`,
				[content, new Date(date), authorId, groupId, destIds.length]
			);

			const msgId = res.rows[0].id as number;

			// Insert sendMsg
			const values: any[] = [];
			const placeholders: string[] = [];

			for (let i = 0; i < destIds.length; i++) {
				const baseIndex = i * 2;
				placeholders.push(`($${baseIndex + 1}, $${baseIndex + 2})`);
				values.push(msgId, destIds[i]);
			}

			if (placeholders.length > 0) {
				await client.query(
					`INSERT INTO sendMsg (msg_id, destination_id)
					VALUES ${placeholders.join(', ')};`,
					values
				);
			}

			await client.query('COMMIT');

			return msgId;

		} catch (err) {
			await client.query('ROLLBACK');
			throw err;
		} finally {
			client.release();
		}
	}
}
