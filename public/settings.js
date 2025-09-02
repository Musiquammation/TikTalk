class SearchPoolDescriptor {
	constructor(desc) {
		this.desc = desc;
	}
}

const searchPoolDescriptors = new Map([
	["default", new SearchPoolDescriptor(
`Basic. You only meet users with account`
	)],
	["everyone", new SearchPoolDescriptor(
`Accessible to every user, including users without an account.
Could be less safe, but useful when user search is too long for you.`
	)],
	["nice", new SearchPoolDescriptor(
`A basic and safe group. The cheaper, but still payant,
so new account can't enter!`
	)]
]);





function isAnonymousUsername(username) {
	if (!username)
		return true;

	return username.startsWith("anonymous_");
}


async function loadSettings() {
	const sessionToken = localStorage.getItem('sessionToken');
	if (!sessionToken) {
		alert("No session token found. Please log in.");
		return;
	}

	const shopInfo = await goFetch(
		'/api/getShopInfo',
		{ sessionToken },
		"POST"
	);

	if (!shopInfo.ok) {
		alert("Cannot get shop data");
		return;
	}

	// Afficher l'argent
	const moneyDiv = document.getElementById("moneyContent");
	moneyDiv.textContent = `${shopInfo.money} coins`;

	// Afficher les pools
	const poolDiv = document.getElementById("poolContent");
	poolDiv.innerHTML = ""; // vider le contenu avant d'ajouter

	shopInfo.searchPools.forEach(pool => {
		const poolEl = document.createElement("div");

		const title = document.createElement("h3");
		const priceText = pool.price === -1 ? "" : ` - ${pool.price} coins`;
		title.textContent = `${pool.name} (${pool.userCount} users)${priceText}`;
		poolEl.appendChild(title);

		const desc = document.createElement("p");
		desc.textContent = searchPoolDescriptors.get(pool.name)?.desc || "";
		poolEl.appendChild(desc);

		
		const poolName = pool.name;
		
		let isAccessible = poolName === 'default' || poolName === 'everyone';
		if (!isAccessible) {
			isAccessible = shopInfo.payments.some(x => x.type == 1 && x.value == poolName);
		}
		
		
		const button = document.createElement("button");
		if (isAccessible) {
			let localPool = localStorage.getItem('searchPool');
			if (!localPool) {
				localPool = isAnonymousUsername(localStorage.getItem('currentUsername')) ?
					'everyone' : 'default';
			}

			button.textContent = poolName === localPool ? "Current pool" : "Join pool";
			button.onclick = () => changePool(poolName);
		} else {
			button.textContent = "Buy";
			button.onclick = async () => {
				const res = await goFetch(
					'api/pay',
					{sessionToken, type: 'clientPool', data: {name: poolName}},
					"POST"
				);


				switch (res.error) {
				case 'notFound':
					alert("Pool not found");
					return;
				
				case 'refused':
					alert("Payment refused");
					return;

				case 'money':
					alert("You don't have enough coins");
					return;
				}

				changePool(poolName);
			};
		}
		poolEl.appendChild(button);
		

		poolDiv.appendChild(poolEl);
	});


}

// Fonction pour rejoindre/quitter une pool
async function changePool(poolName) {
	localStorage.setItem('searchPool', poolName);

	// Reload settings pour refléter le changement
	loadSettings();
}

// Chargement initial
loadSettings();
