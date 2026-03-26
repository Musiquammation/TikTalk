import { appendGroup, collectBlacklist, getGroup, handleMissedGroups, incMissedMsgInGroup, resetMissedMsgInGroup, updateGroupStorage } from "./groups";
import { SERV_SOCK_ADDRESS } from "./servAddresses";
import { conversation, getTalkRequestStatus, getUserId, setTalkRequestButton, setUsername } from "./setupHtml";


const BLACKLIST_COULDOWN = 60 * 60000; // 60mn

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
			setUsername(msg.username, msg.userId);
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

		case 'startConv':
		{
			const missedList = msg.missed as {
				content: string;
				date: number;
				author: string;
			}[];

			console.log(missedList);

			console.log("Connected are:", msg.connected);


			const date = missedList.length>0 ?
				missedList[missedList.length-1].date :
				Date.now();

			const group = getGroup();
			resetMissedMsgInGroup(group.id, date);

			
			// Add missed messages
			for (const m of missedList) {
				let idx = group.users.indexOf(m.author);
				if (idx >= group.pos)
					idx++;

				console.log(idx);
				conversation.add(m.content, idx, m.date*1000);
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

		case 'typing':
		{
			if (msg.groupId !== getGroup().id)
				return;

			if (msg.typing) {
				conversation.addTyping(msg.author);
			} else {
				conversation.removeTyping(msg.author);
			}


			break;
		}

		case 'enterConv':
		{
			console.log(`User #${msg.author} enters`);
			break;
		}

		case 'quitConv':
		{
			console.log(`User #${msg.author} quits`);
			if (msg.groupId !== getGroup().id)
				return;

			conversation.removeTyping(msg.author);
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
		blacklist: collectBlacklist(BLACKLIST_COULDOWN)
	}));
}



export function sendMessage(content: string,
	groupId: string, msgId: number
) {
	if (!global)
		throw new Error("No socket to use");

	global.socket.send(JSON.stringify({
		action: 'message',
		session: global.session,
		content,
		groupId,
		msgId
	}));
}

export function sendTyping(groupId: string, typing: boolean) {
	if (!global)
		throw new Error("No socket to use");

	global.socket.send(JSON.stringify({
		action: typing ? 'typing-on' : 'typing-off',
		session: global.session,
		groupId,
	}));
}


export function sendGroupOpen(groupId: string) {
	if (!global)
		throw new Error("No socket to use");

	const userId = getUserId();
	if (userId === null)
		throw new TypeError("UserId is undefined");

	const group = getGroup(groupId);
	const allUsers = [
		...group.users.slice(0, group.pos),
		userId,
		...group.users.slice(group.pos)

	];

	global.socket.send(JSON.stringify({
		action: 'openConv',
		session: global.session,
		groupId,
		allUsers
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

