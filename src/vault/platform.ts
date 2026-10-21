/**
 * WSL default vault root.
 *
 * On WSL, a vault under the Linux home is invisible to Windows-side
 * Obsidian, so the default moves to the Windows user profile via drvfs
 * (C:\Users\<user>\Documents\omp-memory-vault). Detection is lazy and
 * zero-cost on native Linux/macOS.
 *
 * Caveats of /mnt/c (drvfs/9P), accepted by design:
 *  - File-watch events don't propagate into WSL; our index relies on
 *    store.onChange invalidation (write-triggered), not watchers.
 *  - IO is slower; at personal-vault scale this is negligible.
 * An existing vault is never moved automatically — this only selects the
 * default for a fresh root.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Best-effort Windows username for the drvfs path. */
function windowsUserName(): string | undefined {
	const override = process.env.OMP_MEMORY_WINDOWS_USER?.trim();
	if (override) return override;
	const profile = process.env.USERPROFILE?.trim();
	if (profile) {
		const base = profile.split(/[\\/]/).filter(Boolean).pop();
		if (base) return base;
	}
	// Common WSL interop: the Linux user mirrors the Windows user.
	return process.env.USER?.trim() || process.env.LOGNAME?.trim() || undefined;
}

export function isWSL(): boolean {
	if (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME) return true;
	try {
		return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

/**
 * Default vault root for the current platform.
 *  - Native Windows → %USERPROFILE%\Documents\omp-memory-vault
 *  - WSL  → /mnt/c/Users/<user>/Documents/omp-memory-vault (drvfs only; no
 *    /mnt/c means fall through to the Linux home)
 *  - else → ~/.omp/agent/memory-vault
 */
export function defaultVaultRoot(): string {
	if (process.platform === "win32") {
		const base = process.env.USERPROFILE?.trim() || homedir();
		return join(base, "Documents", "omp-memory-vault");
	}
	if (isWSL()) {
		const user = windowsUserName();
		const documents = user ? `/mnt/c/Users/${user}/Documents` : undefined;
		if (documents && existsSync("/mnt/c") && existsSync(documents)) {
			return join(documents, "omp-memory-vault");
		}
	}
	return join(homedir(), ".omp", "agent", "memory-vault");
}
