import "dotenv/config";
import express from "express";
import http from "http";
import https from "https";
import fs from "fs";
import { setupApp } from "./setupApp";


const app = setupApp();

const PORT = process.env.PORT || 3000;
const USE_HTTPS = !!process.env.USE_HTTPS;

const server = USE_HTTPS
	? https.createServer({
		key: fs.readFileSync(process.env.HTTPS_KEY!),
		cert: fs.readFileSync(process.env.HTTPS_CERT!)
	}, app)
	: http.createServer(app);






server.listen(PORT, () => {
	console.log(`Listening on ${PORT}`);
});