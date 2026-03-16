export function generateToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes)
		.map(b => b.toString(16).padStart(2, "0"))
		.join("");

}