import { sendGroupOpen, sendMessage } from "./net";
import { getUsername, conversation } from "./setupHtml";

interface Group {
	users: string[];
	usernames: string[];
	id: string;
	pos: number;
	lastMsg: number;
	missed: number;
}


export const groups = new Array<Group>();
let currentGroup: Group | null = null;
let currentGroupStorage: string | null = null;

const html_groupList = document.getElementById("groupList")!;


function onGroupClick(e: PointerEvent) {
	const groupId = (e.currentTarget as HTMLElement).getAttribute("groupId");
	const username = getUsername();
	if (groupId && username) {
		openGroup(groupId, username);
	}
}

function createHTML(group: Group) {
	const div = document.createElement("div");
	let innerHTML = `<span>${group.usernames?.join(", ")}</span>`;
	if (group.missed > 0)
		innerHTML += `<span>${group.missed}</span>`;

	div.innerHTML = innerHTML;

	div.setAttribute("groupId", group.id);
	div.addEventListener('click', onGroupClick)
	return div;
}


export function openGroup(id: string, username: string) {
	const group = groups.find(i => i.id === id);
	if (!group) {
		throw new Error("Cannot find group " + id);
	}
	
	currentGroup = group;

	const usernames = [
		...group.usernames.slice(0, group.pos),
		username,
		...group.usernames.splice(group.pos)
	];

	// Open html panel
	conversation.open(id, usernames, {
		send(content, msgId) {
			sendMessage(content, id, group.pos, msgId);
		},

		typing(type) {
			console.log(type);
		},
	});


	// Send open (collects missed messages and new ones)
	sendGroupOpen(id);

}


export function loadGroups(id: string) {
	currentGroupStorage = "tiktalk-groups:" + id;
	// Empty data
	html_groupList.innerHTML = "";
	groups.length = 0;

	const str = localStorage.getItem(currentGroupStorage);
	if (!str) {
		return;
	}





	for (let g of JSON.parse(str)) {
		groups.push(g);
	}

	groups.sort((a, b) => {
		if (a.missed && !b.missed) return -1;
		if (!a.missed && b.missed) return 1;

		return a.lastMsg - b.lastMsg;
	});

	
	for (let g of groups) {
		html_groupList.appendChild(createHTML(g));
	}
}

export function updateGroupStorage() {
	if (currentGroupStorage === null)
		throw new Error("Group not specified");

	localStorage.setItem(currentGroupStorage, JSON.stringify(groups));
	console.log(groups);
}


interface Missed {
	group: string,
	count: number,
	date: number
}

export function updateGroup(group: Group) {
	// Upsert in groups array
	const existingIndex = groups.findIndex(g => g.id === group.id);
    if (existingIndex !== -1)
        groups.splice(existingIndex, 1);
    
    const insertIndex = groups.findIndex(sibling => {
        if (group.missed && !sibling.missed) return true;
        if (!group.missed && sibling.missed) return false;
        return group.lastMsg < sibling.lastMsg;
    });
	
    if (insertIndex !== -1) {
        groups.splice(insertIndex, 0, group);
    } else {
        groups.push(group);
    }

    // Find and remove the existing div
    const existingDiv = html_groupList.querySelector(`[groupId="${group.id}"]`);
    if (existingDiv) existingDiv.remove();

    // Find the correct insertion index using the same sort logic as loadGroups
    const insertBefore = Array.from(html_groupList.children).find(el => {
        const siblingId = el.getAttribute("groupId");
        const sibling = groups.find(g => g.id === siblingId);
        if (!sibling) return false;

        if (group.missed && !sibling.missed) return true;
        if (!group.missed && sibling.missed) return false;

        return group.lastMsg < sibling.lastMsg;
    });

    const newDiv = createHTML(group);

    if (insertBefore) {
        html_groupList.insertBefore(newDiv, insertBefore);
    } else {
        html_groupList.appendChild(newDiv);
    }
}


export function handleMissedGroups(missed: Missed[]) {
	for (const m of missed) {
		let group = groups.find(g => g.id === m.group);
		if (!group) {
			throw new Error("Group not found");
		}

		group.missed = m.count;
		group.lastMsg = m.date;
		updateGroup(group);
	}

	updateGroupStorage();
}


export function appendGroup(group: Group) {
	updateGroup(group);
	updateGroupStorage();
}


export function getGroup(id: string | null = null) {
	if (id === null) {
		if (!currentGroup)
			throw new Error("No current group");

		return currentGroup;
	}

	const group = groups.find(i => i.id === id);
	if (!group) {
		throw new Error("Cannot find group " + id);
	}

	return group;
}


export function closeGroups() {
	updateGroupStorage();
	currentGroupStorage = null;
}