import { appendGroup, handleMissedGroups } from "./groups";
import { SERV_SOCK_ADDRESS } from "./servAddresses";

export function startConnection(data: any) {
	const session: string = data.token;
	

	handleMissedGroups(data.missed);
	

	// Update groups

	

	const socket = new WebSocket(SERV_SOCK_ADDRESS);
	

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
			console.log("Login ok");
			break;

		case 'askTalk':
			console.log("Ask talk ok");
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
				name: null
			});
			break;
		}


		case 'error':
			console.error("Serv error:", msg.label);
			break;

		default:
			throw new Error("Invalid action");
		}
	})
}


export function sendTalkRequest() {
	const requestId = Date.now();

	let alive = true;


	return {
		async promise() {

		},


		cancel() {
			alive = false;
		}
	}
}
