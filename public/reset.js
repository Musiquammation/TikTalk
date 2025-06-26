// Prefill identifier if passed in query string
const params = new URLSearchParams(window.location.search);
if (params.get('email')) {
	document.getElementById('identifier').value = params.get('email');
}

document.getElementById('resetForm').addEventListener('submit', async function(e) {
	e.preventDefault();
	const identifier = document.getElementById('identifier').value.trim();
	const code = document.getElementById('code').value.trim();
	const password = document.getElementById('password').value;
	const msg = document.getElementById('resetMsg');
	msg.textContent = '';

	// First, verify the code
	const verify = await fetch('/api/verify-reset-code', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email: identifier, code })
	});
	const verifyData = await verify.json();
	if (!verifyData.success) {
		msg.style.color = '#c00';
		msg.textContent = verifyData.message || 'Invalid or expired code.';
		return;
	}

	// Change the password
	const res = await fetch('/api/reset-password', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email: identifier, code, password })
	});
	const data = await res.json();
	if (data.success) {
		msg.style.color = '#2a8c2a';
		msg.textContent = 'Password changed! Redirecting...';
		setTimeout(() => window.location = 'login.html', 1500);
	} else {
		msg.style.color = '#c00';
		msg.textContent = data.message || 'Error.';
	}
});
