import { WebSocketServer } from "ws";
import { Handler } from "./Handler.ts";

export function handleSocket(wss: WebSocketServer, handler: Handler) {
	wss.on("connection", ws => {
		ws.on("message", async msg => {
			try {
				const content = JSON.parse(msg.toString());
				switch (content.action) {
				case 'login':
				{
					const r = handler.appendSocket(content.session, ws);
					if (r !== null) {
						const missed = await handler.countMissedMsg(r.id);
						ws.send(JSON.stringify({
							action: 'login-ok',
							username: r.username,
							missed
						}));
					} else {
						throw new Error("Failed to login");
					}

					break;
				}

				case 'askTalk':
				{
					if (!content.blacklist)
						throw new Error("Blacklist is missing");

					const r = handler.searchTalker(
						content.session,
						content.blacklist,
					);

					ws.send(JSON.stringify({
						action: 'askTalk'
					}));

					break;
				}

				case 'cancelTalk':
				{
					handler.removeTalker(content.session);
					ws.send(JSON.stringify({
						action: 'cancelTalk'
					}));

					break;
				}

				case 'openConv':
				{
					const result = await handler.selectGroup(content.session,
						content.groupId, content.allUsers);

					if (result !== null) {
						const missed = result;
						ws.send(JSON.stringify({
							action: 'missedMsg',
							missed
						}));
					}

					break;
				}

				case 'message':
				{
					const date = Date.now();
					handler.pushMessage(content.session, content.content,
						content.groupId, content.author, date);

					ws.send(JSON.stringify({
						action: 'wellSent',
						msgId: content.msgId,
						date
					}));
					break;
				}

				case 'typing-on':
				{
					/// TODO: typing-on
					break;
				}

				case 'typing-off':
				{
					/// TODO: typing-on
					break;
				}


				default:
					throw new Error(`Invalid action: ${content.action}`);
				}

			} catch (e) {
				ws.send(JSON.stringify({
					action: 'error',
					label: String(e)
				}));
			}
		});
	});

}