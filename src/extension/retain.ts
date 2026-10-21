/**
 * Turn-cadence retention: buffer user/assistant text, and every N turns run
 * a side-turn LLM extraction that writes durable items to the vault — daily
 * log always, topic pages for importance ≥ 3. Falls back to appending the
 * raw excerpt when no side-turn capability exists or extraction fails.
 *
 * Extraction is detached through `ctx.setTimeout` so a slow model call never
 * runs inside the 30 s event-handler budget; a throw there is contained by
 * the managed-timer isolation instead of tearing down the session.
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { slugify, type VaultStore } from "../vault/store";
import { rebuildMasterIndex } from "../vault/wiki";

const MAX_BUFFER_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 2_000;
const MIN_TOPIC_IMPORTANCE = 3;

export interface ExtractedMemory {
	title: string;
	summary: string;
	topic?: string;
	tags: string[];
	importance: number;
}

const EXTRACTION_PROMPT = `You maintain a long-term memory wiki for a software engineer, stored as an Obsidian vault. From the conversation excerpt, extract knowledge worth keeping across sessions:
- technical decisions and their rationale
- hard constraints and environment facts (paths, versions, credentials locations — never secrets themselves)
- user preferences and standing instructions
- resolved failures and debugging lessons
- recurring workflows

Skip ephemeral task state, code contents, and anything obvious from the repository itself.

Return ONLY a JSON array (return [] when nothing is durable):
[{"title": "short page title", "summary": "2-4 self-contained sentences", "topic": "kebab-case-slug", "tags": ["tag"], "importance": 3}]

- topic: stable kebab-case slug of the topic page this belongs under; omit for marginal items
- importance: 5 = cross-project lesson, 4 = project decision, 3 = useful fact, 2 = marginal`;

/** Parse the model reply; undefined means the reply was unusable (not "no memories"). */
export function parseExtraction(reply: string): ExtractedMemory[] | undefined {
	const start = reply.indexOf("[");
	const end = reply.lastIndexOf("]");
	if (start < 0 || end <= start) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(reply.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (!Array.isArray(raw)) return undefined;
	const out: ExtractedMemory[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		// Parsed JSON — fields are unknown until each is validated below.
		if (!("title" in item) || typeof item.title !== "string" || !item.title.trim()) continue;
		if (!("summary" in item) || typeof item.summary !== "string" || !item.summary.trim()) continue;
		const importanceRaw = "importance" in item ? item.importance : undefined;
		const importance =
			typeof importanceRaw === "number" && Number.isFinite(importanceRaw)
				? Math.min(5, Math.max(1, Math.round(importanceRaw)))
				: 3;
		const tagsRaw = "tags" in item ? item.tags : undefined;
		const tags = Array.isArray(tagsRaw)
			? tagsRaw.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map(t => t.trim())
			: [];
		const topicRaw = "topic" in item ? item.topic : undefined;
		const topic = typeof topicRaw === "string" && topicRaw.trim() ? slugify(topicRaw) : undefined;
		out.push({ title: item.title.trim(), summary: item.summary.trim(), topic, tags, importance });
	}
	return out;
}

export class RetainLoop {
	private readonly notes: string[] = []; // extraction notes already persisted to daily
	private buffer: string[] = [];
	private bufferedChars = 0;
	private lastTurnIndex = -1;
	private turnCount = 0;
	private running = false;

	constructor(
		private readonly store: VaultStore,
		private readonly log: (message: string, context?: Record<string, unknown>) => void,
	) {}

	recordMessage(message: AgentMessage): void {
		if (message.role !== "user" && message.role !== "assistant") return;
		const content = message.content;
		const text = (typeof content === "string" ? content : content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n")).trim();
		// Tool-call-only assistant turns produce "." or empty text — noise, not memory.
		if (text.length < 8) return;
		const clip = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
		this.buffer.push(`[${message.role}] ${clip}`);
		this.bufferedChars += clip.length;
		while (this.bufferedChars > MAX_BUFFER_CHARS && this.buffer.length > 1) {
			this.bufferedChars -= this.buffer.shift()?.length ?? 0;
		}
	}

	/** Count distinct turns; every `every`-th turn schedules an extraction. */
	onTurnEnd(ctx: ExtensionContext, turnIndex: number, every: number): void {
		if (turnIndex !== this.lastTurnIndex) {
			this.lastTurnIndex = turnIndex;
			this.turnCount++;
		}
		if (this.turnCount % Math.max(1, every) !== 0) return;
		this.scheduleExtraction(ctx);
	}

	scheduleExtraction(ctx: ExtensionContext): void {
		if (this.running) return;
		this.running = true;
		ctx.setTimeout(() => {
			void this.extract(ctx)
				.catch(error => this.log("obsidian-memory extraction failed", { error: String(error) }))
				.finally(() => {
					this.running = false;
				});
		}, 0);
	}

	private drain(): string {
		const excerpt = this.buffer.join("\n\n");
		this.buffer = [];
		this.bufferedChars = 0;
		return excerpt;
	}

	private async noteAndDaily(text: string): Promise<void> {
		this.notes.push(text);
		await this.store.appendDaily(text);
	}

	private async extract(ctx: ExtensionContext): Promise<void> {
		const excerpt = this.drain();
		if (!excerpt.trim()) return;
		if (!ctx.runEphemeralTurn) {
			await this.noteAndDaily(excerpt);
			return;
		}
		let items: ExtractedMemory[] | undefined;
		try {
			const { replyText } = await ctx.runEphemeralTurn({
				promptText: `${EXTRACTION_PROMPT}\n\n<conversation>\n${excerpt}\n</conversation>`,
				tools: false,
				maxTokens: 1024,
			});
			items = parseExtraction(replyText);
		} catch (error) {
			this.log("obsidian-memory extraction call failed; keeping raw excerpt", { error: String(error) });
		}
		if (!items) {
			await this.noteAndDaily(excerpt);
			return;
		}
		if (items.length === 0) {
			this.notes.push("no durable memories");
			return;
		}

		const bullets = items.map(i => `- **${i.title}**${i.topic ? ` [[${i.topic}]]` : ""} — ${i.summary}`).join("\n");
		await this.noteAndDaily(bullets);
		let touched = false;
		for (const item of items) {
			if (!item.topic || item.importance < MIN_TOPIC_IMPORTANCE) continue;
			await this.store.upsertTopic({
				slug: item.topic,
				title: item.title,
				body: item.summary,
				tags: item.tags,
				importance: item.importance,
				source: "retain",
			});
			touched = true;
		}
		if (touched) await rebuildMasterIndex(this.store);
	}

	/** Best-effort raw flush for session shutdown (must fit the ~2 s handler budget). */
	async flushRaw(): Promise<void> {
		const excerpt = this.drain();
		if (!excerpt.trim()) return;
		// Extraction already persisted these turns as notes; a raw copy would duplicate them.
		const alreadyNoted = this.notes.some(note => excerpt.includes(note) || note.includes(excerpt.slice(0, 200)));
		if (!alreadyNoted) await this.store.appendDaily(excerpt);
	}
}
