(async () => {
	const data = await goFetch(
		'/api/checkAuth',
		{sessionToken: localStorage.getItem('sessionToken')},
		"POST"
	);

	if (data.authenticated) {
		gotoPage('app');
	}
})();

document.getElementById('tryBtn').onclick = () => {
	gotoPage('app');
};

document.getElementById('loginBtn').onclick = () => {
	gotoPage('login');
};

document.getElementById('signupBtn').onclick = () => {
	gotoPage('signup');
};


if (usingCapacitor) {

} else {
	document.getElementById('downloadBtn').classList.remove('hidden');
	document.getElementById('privacyA').classList.remove('hidden');
}




/*
if ('serviceWorker' in navigator) {
	navigator.serviceWorker.register('/sw.js').then(() => {
		console.log('Service Worker registered');
	});

	navigator.serviceWorker.addEventListener('message', (event) => {
		if (event.data?.type === 'NEW_VERSION_READY' && event.data?.reload) {
			console.log('[Client] New version available. Reloading...');
			window.location.reload();
		}
	});
}
*/



/*
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
	console.log('[PWA] beforeinstallprompt fired');
	e.preventDefault();
	deferredPrompt = e;
	
	const btn = document.getElementById('installBtn');
	if (btn){ 
		btn.style.display = 'block';
	}
});

document.getElementById('installBtn').addEventListener('click', async () => {
	if (!deferredPrompt) return;

	deferredPrompt.prompt();

	const { outcome } = await deferredPrompt.userChoice;
	console.log(`[PWA] User response to install prompt: ${outcome}`);
	
	deferredPrompt = null;
	document.getElementById('install-btn').style.display = 'none';
});

*/