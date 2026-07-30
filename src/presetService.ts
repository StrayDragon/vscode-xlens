import * as path from 'path';
import * as fs from 'fs';
import { Preset, PresetMeta, isDirPath, filePaths, dirPaths } from './types';

const PRESET_DIR = '.xlens/preset';

/**
 * Ensure the .xlens/preset/ directory exists.
 * Created lazily — only called when actually saving a preset.
 */
export function ensurePresetDir(repoRoot: string): void {
    const dir = path.join(repoRoot, PRESET_DIR);
    fs.mkdirSync(dir, { recursive: true });
}

/**
 * Sanitize a preset name for filesystem safety.
 */
export function sanitizePresetName(name: string): string {
    const sanitized = name
        .replace(/[\\/]/g, '-')      // path separators
        .replace(/\.\./g, '-')       // parent-directory reference
        .replace(/[<>:"|?*]/g, '_')  // reserved Windows filename characters
        .replace(/[\x00-\x1f\x7f]/g, '') // control characters
        .replace(/^\.+/, '')         // leading dots
        .replace(/\.+$/, '')         // trailing dots
        .trim();
    return sanitized || 'untitled';
}

/**
 * List all presets. Returns metadata only (no file lists).
 * Gracefully skips malformed JSON files.
 */
export function listPresets(repoRoot: string): PresetMeta[] {
    const dir = path.join(repoRoot, PRESET_DIR);
    const result: PresetMeta[] = [];

    if (!fs.existsSync(dir)) {
        return result;
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return result;
    }

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
            continue;
        }

        try {
            const fullPath = path.join(dir, entry.name);
            const raw = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as Record<string, unknown>;

            // Support reading legacy presets that use `files`/`dirs`; migrate on load
            const paths = normalizePaths(raw);
            const name = typeof raw.name === 'string' ? raw.name : '';
            if (!name || paths.length === 0) {
                continue; // skip invalid
            }

            result.push({
                name,
                description: typeof raw.description === 'string' ? raw.description : '',
                fileCount: filePaths(paths).length,
                dirCount: dirPaths(paths).length,
                baseBranch: typeof raw.baseBranch === 'string' ? raw.baseBranch : undefined,
                createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
                updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
            });
        } catch {
            // Skip malformed files
        }
    }

    return result;
}

/**
 * Load a full preset from disk.
 */
export function loadPreset(repoRoot: string, name: string): Preset {
    const filePath = getPresetPath(repoRoot, name);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Preset not found: ${name}`);
    }

    const rawText = fs.readFileSync(filePath, 'utf-8');
    const raw: Record<string, unknown> = JSON.parse(rawText);
    // Migrate legacy format (files/dirs) to unified paths
    const paths = normalizePaths(raw);
    const preset: Preset = {
        ...raw,
        name: String(raw.name ?? ''),
        paths,
        description: String(raw.description ?? ''),
        fileCount: filePaths(paths).length,
        dirCount: dirPaths(paths).length,
        baseBranch: typeof raw.baseBranch === 'string' ? raw.baseBranch : undefined,
        createdAt: String(raw.createdAt ?? new Date().toISOString()),
        updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
    } as Preset;

    if (!preset.name || !Array.isArray(preset.paths)) {
        throw new Error(`Invalid preset file: ${name}`);
    }

    return preset;
}

/**
 * Save a preset to disk.
 */
export function savePreset(repoRoot: string, preset: Preset): void {
    ensurePresetDir(repoRoot);

    preset.updatedAt = new Date().toISOString();
    const filePath = getPresetPath(repoRoot, preset.name);
    // derived fields are not persisted
    const { fileCount: _, dirCount: __, ...toSave } = preset;
    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), 'utf-8');
}

/**
 * Create a new preset.
 */
export function createPreset(
    repoRoot: string,
    name: string,
    paths: string[],
    description?: string,
    baseBranch?: string,
): Preset {
    const sanitized = sanitizePresetName(name);
    const now = new Date().toISOString();
    const normalised = [...new Set(paths)].map(normalizePath).sort();
    const preset: Preset = {
        name: sanitized,
        description: description ?? '',
        paths: normalised,
        baseBranch,
        fileCount: filePaths(normalised).length,
        dirCount: dirPaths(normalised).length,
        createdAt: now,
        updatedAt: now,
    };

    ensurePresetDir(repoRoot);
    const filePath = getPresetPath(repoRoot, sanitized);
    if (fs.existsSync(filePath)) {
        throw new Error(`Preset already exists: ${sanitized}`);
    }

    savePreset(repoRoot, preset);
    return preset;
}

/**
 * Delete a preset by name.
 */
export function deletePreset(repoRoot: string, name: string): void {
    const filePath = getPresetPath(repoRoot, name);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Preset not found: ${name}`);
    }
    fs.unlinkSync(filePath);
}

/**
 * Rename a preset.
 */
export function renamePreset(repoRoot: string, oldName: string, newName: string): Preset {
    const preset = loadPreset(repoRoot, oldName);
    const sanitizedNew = sanitizePresetName(newName);

    const newPath = getPresetPath(repoRoot, sanitizedNew);
    if (fs.existsSync(newPath) && sanitizedNew !== oldName) {
        throw new Error(`Preset already exists: ${sanitizedNew}`);
    }

    // Delete old file
    const oldPath = getPresetPath(repoRoot, oldName);
    fs.unlinkSync(oldPath);

    // Update and save with new name
    preset.name = sanitizedNew;
    savePreset(repoRoot, preset);
    return preset;
}

/**
 * Add paths to an existing preset (dedup).
 * File paths and directory paths are normalised and merged.
 */
export function addPathsToPreset(repoRoot: string, presetName: string, paths: string[]): Preset {
    const preset = loadPreset(repoRoot, presetName);
    const existing = new Set(preset.paths);
    let added = 0;
    for (const p of paths) {
        const n = normalizePath(p);
        if (!n) { continue; } // root directory — skip
        if (!existing.has(n)) {
            existing.add(n);
            added++;
        }
    }
    if (added === 0) {
        return preset;
    }
    preset.paths = [...existing].sort();
    preset.fileCount = filePaths(preset.paths).length;
    preset.dirCount = dirPaths(preset.paths).length;
    savePreset(repoRoot, preset);
    return preset;
}

/**
 * Remove paths from an existing preset.
 */
export function removePathsFromPreset(repoRoot: string, presetName: string, paths: string[]): Preset {
    const preset = loadPreset(repoRoot, presetName);
    const removeSet = new Set(paths.map(normalizePath));
    const before = preset.paths;
    const after = before.filter(p => !removeSet.has(p));
    if (after.length === before.length) {
        return preset; // no changes
    }
    preset.paths = after;
    preset.fileCount = filePaths(after).length;
    preset.dirCount = dirPaths(after).length;
    savePreset(repoRoot, preset);
    return preset;
}

/**
 * Normalize a single path entry.
 * File: `some/project/file.ts`.
 * Directory: `some/project/dir/` (trailing `/`).
 * Returns empty string for root (`/` or `.`).
 */
export function normalizePath(raw: string): string {
    let p = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (p === '.' || p === '/' || p === '') { return ''; }
    return p;
}

/**
 * Migrate a legacy preset object (with `files`/`dirs`) to the unified `paths` format.
 * Accepts either the raw JSON or an already-migrated object.
 */
function normalizePaths(raw: Record<string, unknown>): string[] {
    if (Array.isArray(raw.paths)) {
        return [...new Set((raw.paths as string[]).map(normalizePath).filter(Boolean))].sort();
    }
    // Legacy: merge files + dirs
    const files: string[] = Array.isArray(raw.files) ? (raw.files as string[]) : [];
    const dirs: string[] = Array.isArray(raw.dirs) ? (raw.dirs as string[]) : [];
    const merged = new Set<string>();
    for (const f of files) {
        const n = normalizePath(f);
        if (n) { merged.add(n); }
    }
    for (const d of dirs) {
        const n = normalizePath(d);
        if (n) { merged.add(n.endsWith('/') ? n : n + '/'); }
    }
    return [...merged].sort();
}

/**
 * Update the description of a preset.
 */
export function updatePresetDescription(repoRoot: string, presetName: string, description: string): Preset {
    const preset = loadPreset(repoRoot, presetName);
    preset.description = description;
    savePreset(repoRoot, preset);
    return preset;
}

/**
 * Update the base branch of a preset.
 */
export function updatePresetBaseBranch(repoRoot: string, presetName: string, baseBranch: string | undefined): Preset {
    const preset = loadPreset(repoRoot, presetName);
    preset.baseBranch = baseBranch;
    savePreset(repoRoot, preset);
    return preset;
}

/**
 * Get the filesystem path for a preset JSON file.
 */
function getPresetPath(repoRoot: string, name: string): string {
    const safe = sanitizePresetName(name);
    return path.join(repoRoot, PRESET_DIR, `${safe}.json`);
}

/**
 * Resolve preset storage directory path (for configuration display).
 */
export function getPresetRoot(repoRoot: string): string {
    return path.join(repoRoot, PRESET_DIR);
}
