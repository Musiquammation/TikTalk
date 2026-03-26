import "dotenv/config";
import { WebSocketServer } from "ws";
import http from "http";
import https from "https";
import fs from "fs";
import { Handler } from "./Handler.ts";
import { handleSocket } from "./handleSocket.ts";
import { setupRequests } from "./setupRequests.ts";


const handler = new Handler();
const app = setupRequests(handler);

const PORT = process.env.PORT || 3000;

const server = Number(process.env.USE_HTTPS)
	? https.createServer({
		key: fs.readFileSync(process.env.HTTPS_KEY!),
		cert: fs.readFileSync(process.env.HTTPS_CERT!)
	}, app)
	: http.createServer(app);


const wss = new WebSocketServer({ server });
handleSocket(wss, handler);


server.listen(PORT, () => {
	console.log(`Listening on ${PORT}`);
});