const usingCapacitor = !!window.Capacitor;

const DOMAIN = "https://tiktalk-production.up.railway.app";

function gotoPage(page) {
	if (usingCapacitor) {
		window.location.href = "/" + page + ".html";
	} else {
		window.location.href = "/" + page;
	}
}

async function goFetch(url, data, method="GET") {
	const options = {
		method,
		headers: {
	  		"Content-Type": "application/json"
		},
		credentials: "include"
	};

	if (data && (method === "POST" || method === "PUT")) {
		options.body = JSON.stringify(data);
	}

	const fetchUrl = usingCapacitor ? `${DOMAIN}${url}` : url;

	try {
		console.log(fetchUrl);
		const res = await fetch(fetchUrl, options);
		if (!res.ok) {
			throw new Error(`HTTP error! status: ${res.status}`);
		}
		return await res.json(); // retourne le JSON du serveur
	
	} catch (err) {
		console.error("Fetch error:", err);
		return null;
	}
}




if (usingCapacitor) {
	const { PushNotifications } = Capacitor.Plugins;
	

	PushNotifications.addListener('registration', async token => {
		// localStorage.setItem('tokenFCM', token.value);		
		if (window.handleNotifRegistration) {
			window.handleNotifRegistration(token.value);
		}	
	});
			
	/*
	async function ensureToken() {
		if (!localStorage.getItem('tokenFCM')) {
			const perm = await PushNotifications.requestPermissions();
			if (perm.receive === 'granted') {
				await PushNotifications.register();
			}
		}
	}*/
	
	
	
	async function ensureToken() {
		const perm = await PushNotifications.requestPermissions();
		if (perm.receive === 'granted') {
			await PushNotifications.register();
		}
	}
	
	ensureToken();
}

