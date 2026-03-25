import { startConnection, stopConnection, toggleTalkRequest } from "./net";
import { SERV_RQST_ADDRESS } from "./servAddresses";
import { Conversation } from "./Conversation";
import { loadGroups } from "./groups";

let publicUsername: string | null = null;

let setConnectionItemResolve: ((name: string)=>void) | null = null;

export function getUsername() {
	return publicUsername;
}

export function setUsername(name: string | undefined) {
	if (name === undefined)
		throw TypeError("Username is undefined");

	publicUsername = name;
	if (setConnectionItemResolve) {
		setConnectionItemResolve(name);
	}
}

export function setupHtml() {
	// Toggle forms
	document.getElementById('showRegister')!.addEventListener('click', (e) => {
		e.preventDefault();
		document.getElementById('loginContainer')!.classList.add('hidden');
		document.getElementById('registerContainer')!.classList.remove('hidden');
	});
	
	document.getElementById('showLogin')!.addEventListener('click', (e) => {
		e.preventDefault();
		document.getElementById('registerContainer')!.classList.add('hidden');
		document.getElementById('loginContainer')!.classList.remove('hidden');
	});
	
	// --- Shared auth logic ---
	async function authenticate(
		endpoint: 'login' | 'register',
		credentials: { email: string; password: string; name?: string },
		errorDiv: HTMLElement | null
	): Promise<void> {
		try {
			const response = await fetch(`${SERV_RQST_ADDRESS}/${endpoint}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(credentials)
			});
	
			const data = await response.json();
	
			if (response.ok) {
				// Store connection data
				if (errorDiv) {
					if (credentials.name !== undefined)  {
						setUsername(credentials.name);
						localStorage.setItem('tiktalk-connection', JSON.stringify(credentials));

					} else {
						setConnectionItemResolve = (name: string) => {
							const sc = {...credentials, name};
							localStorage.setItem('tiktalk-connection', JSON.stringify(sc));
							setConnectionItemResolve = null;	
						};
					}

					errorDiv.classList.add('hidden');
				}
	
	
	
				startConnection(data);
	
			} else if (errorDiv) {
				errorDiv.textContent = data.error || `${endpoint === 'login' ? 'Login' : 'Registration'} failed`;
				errorDiv.classList.remove('hidden');
			} else {
				localStorage.removeItem('tiktalk-connection');
			}
		} catch (e) {
			if (errorDiv) {
				errorDiv.textContent = String(e);
				errorDiv.classList.remove('hidden');
			}
	
			console.error(e);
		}
	}
	
	// Login form
	document.getElementById('loginForm')!.addEventListener('submit', async (e: Event) => {
		e.preventDefault();
		const email = (document.getElementById('email') as HTMLInputElement).value;
		const password = (document.getElementById('password') as HTMLInputElement).value;
		await authenticate('login', { email, password }, document.getElementById('loginError')!);
	});
	
	// Register form
	document.getElementById('registerForm')!.addEventListener('submit', async (e: Event) => {
		e.preventDefault();
		const name = (document.getElementById('regName') as HTMLInputElement).value;
		const email = (document.getElementById('regEmail') as HTMLInputElement).value;
		const password = (document.getElementById('regPassword') as HTMLInputElement).value;
		await authenticate('register', { name, email, password }, document.getElementById('registerError')!);
	});
	
	// Autologin
	try {
		const stored = localStorage.getItem('tiktalk-connection');
		if (!stored)
			throw new Error("Cannot auto-login");
	
		const credentials = JSON.parse(stored) as 
			{ name: string; email: string; password: string };
	
		setUsername(credentials.name);
		authenticate('login', credentials, null);

		loadGroups();
	} catch (e) {
		console.error(e);
	}

	// Disconnect
	document.getElementById('disconnect')!.addEventListener('click', () => {
		stopConnection();
	});

	// Talk
	document.getElementById('talk')!.addEventListener('click', () => {
		const t = toggleTalkRequest();
		if (t) {
			setTalkRequestButton(t);
		}

	});
}


let talkRequestState: 'talk' | 'cancel' | 'canceling' = 'talk';

export function setTalkRequestButton(talk: 'talk' | 'cancel' | 'canceling') {
	talkRequestState = talk;

	const btn = document.getElementById('talk')!;

	btn.classList.remove('talk', 'cancel', 'canceling');

	switch (talk) {
	case "talk":
		btn.classList.add('talk');
		btn.textContent = "Talk";
		break;

	case "cancel":
		btn.classList.add('cancel');
		btn.textContent = "Cancel";
		break;

	case "canceling":
		btn.classList.add('Canceling');
		btn.textContent = "Canceling";
		break;

	}
	
}

export function getTalkRequestStatus() {
	return talkRequestState;
}


export const conversation = new Conversation(
	document.getElementById("conv")! as HTMLDivElement,
);

