interface Group {
	users: string[];
	usernames: string[] | null;
	id: string;
	pos: number;
	lastMsg: number;
	missed: number;
	name: string | null;
}


export const groups = new Array<Group>();


const html_groupList = document.getElementById("groupList")!;


function onGroupClick(e: PointerEvent) {
	const groupId = (e.currentTarget as HTMLElement).getAttribute("groupId");
	if (groupId) {
		openGroup(groupId);
	}
}

function createHTML(group: Group) {
	const div = document.createElement("div");
	let innerHTML = `<span>${group.name || group.usernames?.join(", ") || "(untitled)"}</span>`;
	if (group.missed > 0)
		innerHTML += `<span>${group.missed}</span>`;

	div.innerHTML = innerHTML;

	div.setAttribute("groupId", group.id);
	div.addEventListener('click', onGroupClick)
	return div;
}


export function openGroup(id: string) {
	console.log(id);
}


export function loadGroups() {
	const str = localStorage.getItem('tiktalk-groups');
	if (!str)
		return;

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

export function updateGroups() {
	localStorage.setItem('tiktalk-groups', JSON.stringify(groups));
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
}


export function appendGroup(group: Group) {
	updateGroup(group);
}