self.addEventListener('notificationclick', event => {
	event.notification.close();

	const urlToOpen = new URL(event.notification.data.url, self.location.origin).href;
	const convId = event.notification.data.convId;

	event.waitUntil(
		clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windowClients => {
			let client = windowClients.find(c => c.url === urlToOpen);
			if (client) {
				await client.focus();
			} else {
				client = await clients.openWindow(urlToOpen);
			}

			if (client) {
				client.postMessage({
					type: 'notification-click',
					data: { convId }
				});
			}
		})
	);
});
