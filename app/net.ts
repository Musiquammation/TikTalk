import { appendGroup, getGroup, handleMissedGroups, incMissedMsgInGroup, updateGroupStorage } from "./groups";
import { SERV_SOCK_ADDRESS } from "./servAddresses";
import { conversation, getTalkRequestStatus, setTalkRequestButton, setUsername } from "./setupHtml";


interface Global {
	socket: WebSocket;
	session: string;
}

let global: Global | null = null;

export function startConnection(data: any) {
	if (global) {
		console.warn("Closing previous socket");
		global.socket.close();
	}
	
	const session: string = data.token;
	

	// Update groups
	const socket = new WebSocket(SERV_SOCK_ADDRESS);

	// share
	global = {
		socket,
		session
	};

	console.log("Start session:", session);

	socket.addEventListener('open', e => {
		socket.send(JSON.stringify({
			action: 'login',
			session,
		}));
	});

	socket.addEventListener('message', event => {
		const msg = JSON.parse(event.data);


		switch (msg.action) {
		case 'login-ok':
			setUsername(msg.username);
			handleMissedGroups(msg.missed);
			break;

		case 'askTalk':
			console.log("Task request received");
			break;

		case 'group':
		{
			appendGroup({
				users: msg.users,
				usernames: msg.usernames,
				id: msg.groupId,
				lastMsg: Date.now(),
				pos: msg.pos,
				missed: 0,
			});
			setTalkRequestButton('talk');

			break;
		}

		case 'cancelTalk':
		{
			setTalkRequestButton('talk');
			break;
		}

		case 'missedMsg':
		{
			const missedList = msg.missed as {
				content: string;
				date: number;
				author: string;
			}[];


			const group = getGroup();
			group.missed = 0;

			
			// Add missed messages
			for (const m of missedList) {
				const a = group.users.indexOf(m.author);
				conversation.add(m.content, a, m.date*1000);
			}

			updateGroupStorage();

			break;
		}

		case 'push':
		{
			conversation.add(msg.content, msg.author, msg.date);
			break;
		}

		case 'wellSent':
		{
			conversation.markAsSent(msg.msgId, msg.date);
			break;
		}

		case 'miss':
		{
			console.log("Miss of", msg.author);
			incMissedMsgInGroup(msg.groupId, msg.date);
			break;
		}



		case 'error':
			console.error(msg.label);
			break;

		default:
			throw new Error("Invalid action");
		}
	});
}


export function toggleTalkRequest() {
	switch (getTalkRequestStatus()) {
	case "talk":
		sendTalkRequest();
		return 'cancel';
		
	case "cancel":
		cancelTalkRequest();
		return 'canceling';

	case "canceling":
		return null; // nothing to do
	}	
}

function sendTalkRequest() {
	if (!global)
		throw new Error("No socket to use");

	global.socket.send(JSON.stringify({
		action: 'askTalk',
		session: global.session,
		blacklist: []
	}));
}



export function sendMessage(content: string,
	groupId: string, author: number, msgId: number
) {
	if (!global)
		throw new Error("No socket to use");

	global.socket.send(JSON.stringify({
		action: 'message',
		session: global.session,
		content,
		groupId,
		author,
		msgId
	}));
}

export function sendGroupOpen(groupId: string) {
	if (!global)
		throw new Error("No socket to use");

	global.socket.send(JSON.stringify({
		action: 'openConv',
		session: global.session,
		groupId,
		allUsers: getGroup(groupId).users
	}));

}

function cancelTalkRequest() {
	if (!global)
		throw new Error("No socket to use");

	global.socket.send(JSON.stringify({
		action: 'cancelTalk',
		session: global.session,
	}));

}


export function stopConnection() {
	if (!global)
		return;

	
	global.socket.close();
	localStorage.removeItem('tiktalk-connection');

	global = null;
}

