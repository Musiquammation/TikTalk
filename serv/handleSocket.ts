import { WebSocketServer } from "ws";
import { Handler } from "./Handler";

export function handleSocket(wss: WebSocketServer, handler: Handler) {
    wss.on("connection", ws => {
        ws.on("message", msg => {
            const content = JSON.parse(msg.toString());
            if (content.action === 'login') {
                if (handler.appendSocket(content.session, ws)) {
                    ws.send("{action: 'login-ok'}");
                } else {
                    ws.send("{action: 'login-err'}");
                }

                return;
            }



            ws.send("{action: 'error'}");
        });

        ws.send("ok");
    });

}