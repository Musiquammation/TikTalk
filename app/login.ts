import { startConnection } from "./net";
import { SERV_RQST_ADDRESS } from "./servAddresses";

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

// Login form
document.getElementById('loginForm')!.addEventListener('submit', async (e: Event) => {
	e.preventDefault();
	const email = (document.getElementById('email') as HTMLInputElement).value;
	const password = (document.getElementById('password') as HTMLInputElement).value;
	const errorDiv = document.getElementById('loginError')!;

	try {
		const response = await fetch(`${SERV_RQST_ADDRESS}/login`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ email, password })
		});

		const data = await response.json();

		if (response.ok) {
			errorDiv.classList.add('hidden');
			startConnection(data);
		} else {
			errorDiv.textContent = data.error || 'Login failed';
			errorDiv.classList.remove('hidden');
		}
	} catch (error) {
		errorDiv.textContent = 'Network error';
		errorDiv.classList.remove('hidden');
	}
});

// Register form
document.getElementById('registerForm')!.addEventListener('submit', async (e: Event) => {
	e.preventDefault();
	const name = (document.getElementById('regName') as HTMLInputElement).value;
	const email = (document.getElementById('regEmail') as HTMLInputElement).value;
	const password = (document.getElementById('regPassword') as HTMLInputElement).value;
	const errorDiv = document.getElementById('registerError')!;

	try {
		const response = await fetch(`${SERV_RQST_ADDRESS}/register`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ name, email, password })
		});

		const data = await response.json();

		if (response.ok) {
			errorDiv.classList.add('hidden');
			startConnection(data);
		} else {
			errorDiv.textContent = data.error || 'Registration failed';
			errorDiv.classList.remove('hidden');
		}
	} catch (error) {
		errorDiv.textContent = 'Network error';
		errorDiv.classList.remove('hidden');
	}
});