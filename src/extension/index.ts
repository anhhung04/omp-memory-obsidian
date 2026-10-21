/**
 * omp-memory-obsidian — Obsidian-vault long-term memory for omp.
 *
 * Mimics the native memory-backend surface without one:
 * - before_agent_start → recall relevant pages into the system prompt
 * - message_end/turn_end → buffer conversation, extract durable memories every
 *   OMP_MEMORY_RETAIN_EVERY turns via a side turn, write to the vault
 * - session.compacting → vault index as compaction context
 * - tools: when no native memory backend is active (ctx.memory absent), tools
 *   register under the native names recall / retain / memory_edit; when a
 *   native backend is configured, they register as vault_search /
 *   vault_remember / vault_edit so both stores coexist.
 * - command: /vault stats | path | reindex | sync
 *
 * Vault root resolution (first match wins):
 *   1. OMP_MEMORY_VAULT env var
 *   2. <cwd>/.omp/memory-vault when that directory already exists
 *   3. Default root — native Windows: %USERPROFILE%\Documents\
 *      omp-memory-vault; under WSL: C:\Users\<user>\Documents\
 *      omp-memory-vault via drvfs so Windows Obsidian can open it;
 *      elsewhere ~/.omp/agent/memory-vault (created on demand).
 *      Set OMP_MEMORY_WINDOWS_USER when the Linux user name differs from
 *      the Windows profile folder name.
 *
 * Vault runtimes are keyed by vault root and shared across rebound sessions;
 * tool-name registration is per binding (factories re-execute per session).
 * Auto recall/retain runs only for the main agent.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { VaultIndex } from "../vault/index";
import { defaultVaultRoot } from "../vault/platform";
import { slugify, VaultStore } from "../vault/store";
import { rebuildMasterIndex } from "../vault/wiki";
import { buildRecallBlock } from "./recall";
import { RetainLoop } from "./retain";

interface VaultRuntime {
	root: string;
	store: VaultStore;
	index: VaultIndex;
	retain: RetainLoop;
}

/** Shared across rebound subagent sessions — see extension loader semantics. */
const runtimes = new Map<string, VaultRuntime>();

// Tool execute() params are validated against the omptype schema by the host
// before dispatch; the zod shim's Static<> resolves unknown, so annotate the
// validated shapes directly.
interface SearchParams {
	query: string;
	limit?: number;
}
interface RememberParams {
	title: string;
	content: string;
	topic?: string;
	tags?: string[];
	importance?: number;
}
interface EditParams {
	path: string;
	action: string; // "update" | "forget"
	content?: string;
}

interface ToolNames {
	search: string;
	remember: string;
	edit: string;
}

const FALLBACK_NAMES: ToolNames = { search: "vault_search", remember: "vault_remember", edit: "vault_edit" };
const NATIVE_NAMES: ToolNames = { search: "recall", remember: "retain", edit: "memory_edit" };

const COMPACTION_CONTEXT_CAP = 2000;

function resolveVaultRoot(cwd: string): string {
	const env = process.env.OMP_MEMORY_VAULT?.trim();
	if (env) return resolve(env.replace(/^~(?=\/|$)/, homedir()));
	const projectVault = join(cwd, ".omp", "memory-vault");
	if (existsSync(projectVault)) return projectVault;
	return defaultVaultRoot();
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw?.trim()) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envEnabled(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase();
	if (!raw) return fallback;
	return raw !== "0" && raw !== "false" && raw !== "off";
}

export default function obsidianMemory(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.setLabel("Obsidian memory");

	/** Set on first session_start of this binding; recall guidance names the live tools. */
	let toolNames: ToolNames | undefined;

	async function getRuntime(ctx: ExtensionContext): Promise<VaultRuntime> {
		const root = resolveVaultRoot(ctx.cwd);
		const existing = runtimes.get(root);
		if (existing) return existing;
		const store = await VaultStore.open(root);
		const runtime: VaultRuntime = {
			root,
			store,
			index: new VaultIndex(store),
			retain: new RetainLoop(store, (message, context) => pi.logger.warn(message, context)),
		};
		runtimes.set(root, runtime);
		return runtime;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (toolNames) return;
		// ctx.memory exists only when a native memory backend resolved; in that
		// case keep the native recall/retain names for it and use vault_* here.
		toolNames = ctx.memory ? FALLBACK_NAMES : NATIVE_NAMES;
		registerTools(toolNames);
		pi.logger.info(`obsidian-memory: tools registered as ${Object.values(toolNames).join(", ")}`);
	});

	function registerTools(names: ToolNames): void {
		pi.registerTool({
			name: names.search,
			label: "Memory Search",
			description:
				"Search long-term memory (Obsidian vault: full-text over topic pages and daily logs). Returns ranked hits with vault-relative paths; read full pages with the read tool.",
			parameters: z.object({
				query: z.string().describe("Search query — keywords, topic names, tags"),
				limit: z.number().optional().describe("Max results, default 8"),
			}),
			async execute(_toolCallId, params: SearchParams, _signal, _onUpdate, ctx) {
				const rt = await getRuntime(ctx);
				const hits = await rt.index.search(params.query, params.limit ?? 8);
				if (!hits.length) {
					return { content: [{ type: "text", text: `No memories match "${params.query}".` }], details: { hits: 0 } };
				}
				const text = hits
					.map((h, i) => `${i + 1}. **${h.title}** — \`${join(rt.root, h.path)}\`\n   ${h.snippet}`)
					.join("\n");
				return { content: [{ type: "text", text }], details: { hits: hits.length, paths: hits.map(h => h.path) } };
			},
		});

		pi.registerTool({
			name: names.remember,
			label: "Memory Retain",
			description:
				"Store a durable fact in long-term memory (Obsidian vault). Always appends to today's daily log; with a topic slug and importance >= 3 it also creates/updates the topic page and rebuilds the wiki index.",
			parameters: z.object({
				title: z.string().describe("Short title for the memory"),
				content: z.string().describe("Self-contained fact, 1-4 sentences"),
				topic: z.string().optional().describe("Stable kebab-case topic slug; omit for marginal items"),
				tags: z.array(z.string()).optional(),
				importance: z.number().optional().describe("1-5, default 3; topic pages need >= 3"),
			}),
			async execute(_toolCallId, params: RememberParams, _signal, _onUpdate, ctx) {
				const rt = await getRuntime(ctx);
				const importance = params.importance ?? 3;
				const dailyPath = await rt.store.appendDaily(`**${params.title}** — ${params.content}`);
				let topicPath: string | undefined;
				if (params.topic && importance >= 3) {
					const result = await rt.store.upsertTopic({
						slug: slugify(params.topic),
						title: params.title,
						body: params.content,
						tags: params.tags,
						importance,
						source: "tool",
					});
					topicPath = result.path;
					await rebuildMasterIndex(rt.store);
				}
				const where = topicPath ? `daily log (${dailyPath}) and topic page (${topicPath})` : `daily log (${dailyPath})`;
				return { content: [{ type: "text", text: `Remembered in ${where}.` }], details: { dailyPath, topicPath } };
			},
		});

		pi.registerTool({
			name: names.edit,
			label: "Memory Edit",
			description:
				'Update or forget a memory page by vault-relative path (e.g. topics/omp-config.md, as returned by search). action "update" replaces the page body with content; action "forget" deletes the page.',
			parameters: z.object({
				path: z.string().describe("Vault-relative page path"),
				action: z.string().describe('"update" | "forget"'),
				content: z.string().optional().describe("New page body for update"),
			}),
			async execute(_toolCallId, params: EditParams, _signal, _onUpdate, ctx) {
				const rt = await getRuntime(ctx);
				if (params.action === "forget") {
					const deleted = await rt.store.deletePage(params.path);
					if (deleted && params.path.startsWith("topics/")) await rebuildMasterIndex(rt.store);
					const text = deleted ? `Deleted ${params.path}.` : `No page at ${params.path}.`;
					return { content: [{ type: "text", text }], details: { deleted } };
				}
				if (params.action === "update") {
					if (!params.content?.trim()) {
						return { content: [{ type: "text", text: 'action "update" requires non-empty content.' }], details: { updated: false } };
					}
					const page = await rt.store.readPage(params.path);
					if (!page) {
						return { content: [{ type: "text", text: `No page at ${params.path}.` }], details: { updated: false } };
					}
					await rt.store.writePage(params.path, { ...page.meta, updated: new Date().toISOString() }, params.content);
					if (params.path.startsWith("topics/")) await rebuildMasterIndex(rt.store);
					return { content: [{ type: "text", text: `Updated ${params.path}.` }], details: { updated: true } };
				}
				return { content: [{ type: "text", text: `Unknown action "${params.action}" — use "update" or "forget".` }], details: {} };
			},
		});
	}

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent.kind === "sub") return;
		if (!envEnabled("OMP_MEMORY_AUTO_RECALL", true)) return;
		try {
			const rt = await getRuntime(ctx);
			const names = toolNames ?? FALLBACK_NAMES;
			const block = await buildRecallBlock(rt.index, event.prompt, {
				limit: envInt("OMP_MEMORY_RECALL_LIMIT", 5),
				root: rt.root,
				searchTool: names.search,
				rememberTool: names.remember,
			});
			if (!block) return;
			return { systemPrompt: [...event.systemPrompt, block] };
		} catch (error) {
			pi.logger.warn("obsidian-memory recall failed", { error: String(error) });
			return;
		}
	});

	pi.on("session.compacting", async (_event, ctx) => {
		try {
			const rt = runtimes.get(resolveVaultRoot(ctx.cwd));
			if (!rt) return;
			const master = await rt.store.readPage("MEMORY.md");
			if (!master) return;
			const body = master.body.trim();
			if (!body) return;
			const clipped = body.length > COMPACTION_CONTEXT_CAP ? `${body.slice(0, COMPACTION_CONTEXT_CAP)}\n…` : body;
			return { context: [`Long-term memory vault index (${rt.root}) — read pages with the read tool:\n${clipped}`] };
		} catch {
			return undefined;
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (ctx.agent.kind === "sub") return;
		if (!envEnabled("OMP_MEMORY_AUTO_RETAIN", true)) return;
		try {
			const rt = await getRuntime(ctx);
			rt.retain.recordMessage(event.message);
		} catch (error) {
			pi.logger.warn("obsidian-memory buffer failed", { error: String(error) });
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (ctx.agent.kind === "sub") return;
		if (!envEnabled("OMP_MEMORY_AUTO_RETAIN", true)) return;
		try {
			const rt = await getRuntime(ctx);
			rt.retain.onTurnEnd(ctx, event.turnIndex, envInt("OMP_MEMORY_RETAIN_EVERY", 4));
		} catch (error) {
			pi.logger.warn("obsidian-memory retain scheduling failed", { error: String(error) });
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const rt = runtimes.get(resolveVaultRoot(ctx.cwd));
		if (!rt) return;
		// ~2 s shutdown budget: flush the raw excerpt only, no LLM call.
		await rt.retain.flushRaw().catch(() => {});
	});

	pi.registerCommand("vault", {
		description: "Obsidian memory vault: /vault stats | path | reindex | sync",
		handler: async (args, ctx) => {
			const rt = await getRuntime(ctx);
			const sub = args.trim().split(/\s+/)[0] || "stats";
			switch (sub) {
				case "path": {
					ctx.ui.notify(`Memory vault: ${rt.root}`, "info");
					return;
				}
				case "stats": {
					const pages = await rt.store.listPages();
					const topics = pages.filter(p => p.startsWith("topics/")).length;
					const daily = pages.filter(p => p.startsWith("daily/")).length;
					ctx.ui.notify(`Vault ${rt.root}: ${topics} topic pages, ${daily} daily logs`, "info");
					return;
				}
				case "reindex": {
					const docs = await rt.index.rebuild();
					const topics = await rebuildMasterIndex(rt.store);
					ctx.ui.notify(`Rebuilt search index (${docs} pages) and MEMORY.md (${topics} topics).`, "info");
					return;
				}
				case "sync": {
					rt.retain.scheduleExtraction(ctx);
					ctx.ui.notify("Memory extraction scheduled for buffered conversation.", "info");
					return;
				}
				default:
					ctx.ui.notify("Usage: /vault stats | path | reindex | sync", "warning");
			}
		},
	});
}
