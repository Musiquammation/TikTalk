import express from "express";
import { Handler } from "./Handler";

export function setupRequests(handler: Handler) {
	const app = express();



	return app;	
}