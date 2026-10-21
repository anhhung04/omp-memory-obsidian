/**
 * Wiki maintenance: `[[wiki-link]]` extraction and the generated MEMORY.md
 * master index that makes the vault navigable from Obsidian's graph view.
 */

import type { VaultStore } from "./store";

/** Unique lowercase slugs referenced by `[[slug]]` / `[[slug|label]]` links. */
export function extractLinks(body: string): string[] {
	const out = new Set<string>();
	for (const match of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
		const slug = match[1].trim().toLowerCase();
		if (slug) out.add(slug);
	}
	return [...out];
}

/**
 * Regenerate <root>/MEMORY.md from the current topic pages, grouped by
 * first tag. Returns the number of topic pages indexed.
 */
export async function rebuildMasterIndex(store: VaultStore): Promise<number> {
	const paths = await store.listPages();
	const topics: { slug: string; title: string; updated: string; tag: string }[] = [];
	for (const path of paths) {
		if (!path.startsWith("topics/") || !path.endsWith(".md")) continue;
		const page = await store.readPage(path);
		if (!page) continue;
		topics.push({
			slug: path.slice("topics/".length, -".md".length),
			title: page.meta.title,
			updated: page.meta.updated.slice(0, 10),
			tag: page.meta.tags?.[0] ?? "untagged",
		});
	}
	topics.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));

	const byTag = new Map<string, typeof topics>();
	for (const topic of topics) {
		const group = byTag.get(topic.tag) ?? [];
		group.push(topic);
		byTag.set(topic.tag, group);
	}

	const lines = [
		"# Memory Index",
		"",
		`_Maintained by omp-memory-obsidian — ${topics.length} topic pages. Structure is regenerated; page contents are never edited here._`,
		"",
	];
	for (const tag of [...byTag.keys()].sort()) {
		lines.push(`## ${tag}`, "");
		for (const topic of byTag.get(tag) ?? []) {
			lines.push(`- [[${topic.slug}]] — ${topic.title}${topic.updated ? ` · ${topic.updated}` : ""}`);
		}
		lines.push("");
	}

	const now = new Date().toISOString();
	await store.writePage("MEMORY.md", { title: "Memory Index", created: now, updated: now, source: "wiki" }, `${lines.join("\n")}\n`);
	return topics.length;
}
