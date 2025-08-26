const usingCapacitor = !!window.Capacitor;

const DOMAIN_SECURE = true;
const DOMAIN = "tiktalk-production.up.railway.app";

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

	const fetchUrl = usingCapacitor
		? `${DOMAIN_SECURE ? 'https' : 'http'}://${DOMAIN}${url}`
		: url;

	try {
		console.log(fetchUrl);
		const res = await fetch(fetchUrl, options);
		if (!res.ok) {
			throw new Error(`HTTP error! status: ${res.status}`);
		}
		
		const data = await res.json(); // retourne le JSON du serveur

		if (data.invalidSessionError) {
			alert("You are not connected");
			gotoPage('login');
		}

		return data;
	
	} catch (err) {
		console.error("Fetch error:", err);
		return null;
	}
}




if (usingCapacitor) {
	const { PushNotifications } = Capacitor.Plugins;
	
	PushNotifications.addListener('registration', async token => {
		try {
			await goFetch(
				'/api/registerFCM',
				{
					token: token.value,
					sessionToken: localStorage.getItem('sessionToken')
				},
				"POST"
			);

		} catch (err) {
			console.error('Error sending FCM token to server', err);
		}
	});	
	
	
	async function ensureToken() {
		const perm = await PushNotifications.requestPermissions();
		if (perm.receive === 'granted') {
			await PushNotifications.register();
		}
	}
	
	ensureToken();
}

