import { WebSocketServer } from "ws";
import { Handler } from "./Handler.ts";

export function handleSocket(wss: WebSocketServer, handler: Handler) {
    wss.on("connection", ws => {
        ws.on("message", msg => {
            try {
                const content = JSON.parse(msg.toString());
                switch (content.action) {
                case 'login':
                {
                    if (handler.appendSocket(content.session, ws)) {
                        ws.send(JSON.stringify({
                            action: 'login-ok',
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
                }

                default:
                    throw new Error("Invalid action");
                }

            } catch (e) {
                ws.send(JSON.stringify({
                    action: 'error',
                    label: e+""
                }));
            }
        });
    });

}