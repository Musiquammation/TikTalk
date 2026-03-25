import express from "express";
import cors from "cors";
import { Handler } from "./Handler.ts";

export function setupRequests(handler: Handler) {
	const app = express();

	app.use(express.json());
	app.use(cors());

	app.post('/login', async (req, res) => {
		const { email, password } = req.body;
		try {
			const u = await handler.checkUser(email, password);
			if (u) {
				res.json({ token: u.token });
			} else {
				res.status(401).json({ error: 'Invalid credentials' });
			}
		} catch (error) {
			res.status(500).json({ error: error+"" });
			console.error(error);
		}
	});

	
	app.post('/register', async (req, res) => {
		const { name, email, password } = req.body;
		try {
			const u = await handler.createUser(name, email, password);
			res.json({ token: u.token });

		} catch (error) {
			res.status(500).json({ error: error+"" });
			console.error(error);
		}
	});	


	



	return app;
}