document.getElementById('forgotForm').addEventListener('submit', async function(e) {
	e.preventDefault();
	const identifier = document.getElementById('identifier').value.trim();
	const msg = document.getElementById('forgotMsg');
	msg.style.color = '#888';
	msg.textContent = 'A code will be sent to your email address.';
	const res = await fetch('/api/forgot-password', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ identifier })
	});
	const data = await res.json();
	if (data.success) {
		msg.style.color = '#2a8c2a';
		msg.textContent = 'A code has been sent to your email address.';
		setTimeout(() => window.location = 'reset?email=' + encodeURIComponent(identifier), 1500);
	} else {
		msg.style.color = '#c00';
		msg.textContent = data.message || 'Error.';
	}
});
