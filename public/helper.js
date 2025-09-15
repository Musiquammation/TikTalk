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



let localNotifPerm = -1;
let askLocalNotifPerm;

if (usingCapacitor) {
	const {
		FirebaseMessaging,
		PushNotifications,
		LocalNotifications,
		StatusBar,
		Device
	} = Capacitor.Plugins;

	PushNotifications.createChannel({
		id: "default",
		name: "Default",
		description: "Default notification channel",
		importance: 5, // max
		visibility: 1, // public
		sound: "default"
	});


	async function ensureToken() {
		// Demander la permission (obligatoire sur iOS)
		const perm = await PushNotifications.requestPermissions();
		if (perm.receive === "granted") {
			// Récupérer le token FCM
			const { token } = await FirebaseMessaging.getToken();
			console.log("FCM token:", token);

			try {
				await goFetch(
					"/api/registerFCM",
					{
						token,
						sessionToken: localStorage.getItem('sessionToken'),
					},
					"POST"
				);
			} catch (err) {
				console.error("Error sending token to server", err);
			}
		}
	}


	askLocalNotifPerm = function() {
		return new Promise((resolve, reject) => {
			if (localNotifPerm === 0) {
				reject();
				return;
			}
			
			if (localNotifPerm === 1) {
				resolve();
				return;
			}

			LocalNotifications.requestPermissions().then(perm => {
				if (perm.display === 'granted') {
					localNotifPerm = 1;
					resolve();
				} else {
					localNotifPerm = 1;
					reject();
				}
			});
		});
	}

	// Écoute des notifs reçues en foreground
	async function onNotificationReceived(notification) {
		try {
			await askLocalNotifPerm();
			const notif = notification.notification;

			await LocalNotifications.schedule({
				notifications: [
					{
						title: notif.title,
						body: notif.body,
						id: 1,
						extra: notif.data
					}
				],
			});

		} catch (e) {}

		console.log("Notification recue:", notification);
	}

	// Écoute quand l’utilisateur clique sur une notif
	function onNotificationActionPerformed(notification) {
		const data = notification.notification.data;
		if (data.conv) {
			localStorage.setItem("convToOpenAs_" + localStorage.getItem('currentUsername'), data.conv);
			return;
		}

		if (data.rush) {
			gotoPage('app');
			return;
		}
	}


	FirebaseMessaging.addListener("pushNotificationReceived", onNotificationReceived);
	FirebaseMessaging.addListener("notificationReceived", onNotificationReceived);
	FirebaseMessaging.addListener("pushNotificationActionPerformed", onNotificationActionPerformed);
	FirebaseMessaging.addListener("notificationActionPerformed", onNotificationActionPerformed);



	if (!window.inAppPage) {
		LocalNotifications.addListener(
			'localNotificationActionPerformed',
			notif => {
				localStorage.setItem(
					"convToOpenAs_" + localStorage.getItem('currentUsername'),
					notif.notification.extra.conv
				);

				gotoPage('app');
			}
		);
	}



	ensureToken();




} else {
	askLocalNotifPerm = function() {
		return new Promise((resolve, reject) => {
			reject();
		});
	}
}


