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
	)]
]);
