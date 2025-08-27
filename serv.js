const admin = require('firebase-admin');
require('dotenv').config();


admin.initializeApp({
	credential: admin.credential.cert(
		JSON.parse(process.env.SERVICE_ACCOUNT_KEY)
	),
});


const token = "fun588SCQku1BmQFHUHCWs:APA91bFEcIcU4jLIjm_t2yUecvbLQNGTPEc4Ic0cVL7r4jF6QzkFzISf8HqOJXmh9usvuvwVUBMVLinBZL_B7kpoOUpbEeBy7EHtn5CVdbzTmsAAzAi_ho8";

(async () => {
	try {
		await admin.messaging().send({
			token,
			
			notification: { title: "title", body: "lorem ipsum" },
		
			data: Object.fromEntries(
				Object.entries({value: 42}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
			),
		
			android: {
				priority: 'high',
				notification: {
					channelId: 'default',
					icon: 'ic_stat_ic_notification' // sans extension
				}
			},
		
			apns: {
				payload: {
					aps: {
						sound: 'default'
					}
				}
			}
		});

		console.log("Sent!");

	} catch (err) {
		if (err.code === 'messaging/registration-token-not-registered') {
			console.err('messaging/registration-token-not-registered');
		} else {
			console.error('FCM error for token', token, err);
		}
	}
})();

