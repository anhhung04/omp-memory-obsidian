/**
 * In-memory full-text search over the vault. Rebuilt lazily on first search
 * and invalidated wholesale on any store write — at personal-vault scale
 * (hundreds of small pages) a full rescan is milliseconds and always correct.
 */

import type { VaultStore } from "./store";
import { extractLinks } from "./wiki";

export interface SearchHit {
	path: string;
	title: string;
	snippet: string;
	score: number;
	/** Slugs the hit page links to, for "see also" expansion. */
	related: string[];
}

const STOPWORDS: Record<string, true> = {
	the: true, and: true, for: true, with: true, that: true, this: true,
	from: true, into: true, are: true, was: true, were: true, has: true,
	have: true, had: true, not: true, but: true, you: true, your: true,
	how: true, what: true, when: true, why: true, which: true, use: true,
	used: true, using: true, can: true, could: true, should: true, would: true,
	// Query-side noise typical in prompts.
	please: true, tell: true, show: true, explain: true, about: true,
};

export function tokenize(text: string): string[] {
	const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
	return tokens.filter(t => t.length > 1 && !STOPWORDS[t]);
}

interface Doc {
	path: string;
	title: string;
	body: string;
	/** Term frequency over the body. */
	tf: Record<string, number>;
	titleTokens: Record<string, true>;
	tagTokens: Record<string, true>;
	links: string[];
}

const TITLE_BOOST = 3;
const TAG_BOOST = 2;
const SNIPPET_CHARS = 240;

export class VaultIndex {
	private docs: Doc[] | undefined; // undefined = dirty

	constructor(private readonly store: VaultStore) {
		store.onChange(() => {
			this.docs = undefined;
		});
	}

	async rebuild(): Promise<number> {
		const docs: Doc[] = [];
		for (const path of await this.store.listPages()) {
			if (path === "MEMORY.md") continue;
			const page = await this.store.readPage(path);
			if (!page) continue;
			const tf: Record<string, number> = {};
			for (const token of tokenize(`${page.meta.title}\n${page.body}`)) {
				tf[token] = (tf[token] ?? 0) + 1;
			}
			const titleTokens: Record<string, true> = {};
			for (const token of tokenize(page.meta.title)) titleTokens[token] = true;
			const tagTokens: Record<string, true> = {};
			for (const token of tokenize((page.meta.tags ?? []).join(" "))) tagTokens[token] = true;
			docs.push({ path, title: page.meta.title, body: page.body, tf, titleTokens, tagTokens, links: extractLinks(page.body) });
		}
		this.docs = docs;
		return docs.length;
	}

	async search(query: string, limit = 8): Promise<SearchHit[]> {
		const docs = this.docs ?? (await this.rebuild(), this.docs ?? []);
		const queryTokens = [...new Set(tokenize(query))];
		if (!queryTokens.length) return [];

		const hits: SearchHit[] = [];
		for (const doc of docs) {
			let score = 0;
			for (const token of queryTokens) {
				score += doc.tf[token] ?? 0;
				if (doc.titleTokens[token]) score += TITLE_BOOST;
				if (doc.tagTokens[token]) score += TAG_BOOST;
			}
			if (score <= 0) continue;
			hits.push({ path: doc.path, title: doc.title, snippet: snippetFor(doc.body, queryTokens), score, related: doc.links });
		}
		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, limit);
	}
}

function snippetFor(body: string, queryTokens: string[]): string {
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue;
		const lower = trimmed.toLowerCase();
		if (queryTokens.some(token => lower.includes(token))) {
			return trimmed.length > SNIPPET_CHARS ? `${trimmed.slice(0, SNIPPET_CHARS)}…` : trimmed;
		}
	}
	const first = body.split("\n").find(line => line.trim() && !line.trim().startsWith("#"))?.trim() ?? "";
	return first.length > SNIPPET_CHARS ? `${first.slice(0, SNIPPET_CHARS)}…` : first;
}
