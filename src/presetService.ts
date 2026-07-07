import * as path from 'path';
import * as fs from 'fs';
import { Preset, PresetMeta } from './types';

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
            const raw = fs.readFileSync(fullPath, 'utf-8');
            const preset: Preset = JSON.parse(raw);

            if (!preset.name || !Array.isArray(preset.files)) {
                continue; // skip invalid
            }

            result.push({
                name: preset.name,
                description: preset.description ?? '',
                fileCount: preset.files.length,
                dirCount: (preset.dirs ?? []).length,
                baseBranch: preset.baseBranch,
                createdAt: preset.createdAt ?? new Date().toISOString(),
                updatedAt: preset.updatedAt ?? new Date().toISOString(),
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

    const raw = fs.readFileSync(filePath, 'utf-8');
    const preset: Preset = JSON.parse(raw);

    if (!preset.name || !Array.isArray(preset.files)) {
        throw new Error(`Invalid preset file: ${name}`);
    }

    preset.fileCount = preset.files.length;
    return preset;
}

/**
 * Save a preset to disk.
 */
export function savePreset(repoRoot: string, preset: Preset): void {
    ensurePresetDir(repoRoot);

    preset.updatedAt = new Date().toISOString();
    const filePath = getPresetPath(repoRoot, preset.name);
    // fileCount is derived from files.length and does not need to be persisted.
    const { fileCount: _, ...toSave } = preset;
    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), 'utf-8');
}

/**
 * Create a new preset.
 */
export function createPreset(
    repoRoot: string,
    name: string,
    files: string[],
    description?: string,
    baseBranch?: string,
    dirs?: string[],
): Preset {
    const sanitized = sanitizePresetName(name);
    const now = new Date().toISOString();
    const preset: Preset = {
        name: sanitized,
        description: description ?? '',
        files: [...new Set(files)].sort(), // dedup + sort
        dirs: [...new Set((dirs ?? []).map(normalizeDir))].sort(),
        baseBranch,
        fileCount: 0,
        createdAt: now,
        updatedAt: now,
    };
    preset.fileCount = preset.files.length;

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
 * Add files to an existing preset (dedup).
 */
export function addFilesToPreset(repoRoot: string, presetName: string, files: string[]): Preset {
    const preset = loadPreset(repoRoot, presetName);
    const existing = new Set(preset.files);
    let added = 0;
    for (const f of files) {
        if (!existing.has(f)) {
            existing.add(f);
            added++;
        }
    }
    if (added === 0) {
        return preset; // no changes
    }
    preset.files = [...existing].sort();
    preset.fileCount = preset.files.length;
    savePreset(repoRoot, preset);
    return preset;
}

/** Normalize a tracked directory path: repo-relative, no leading './', no trailing '/'. */
export function normalizeDir(dir: string): string {
    let d = dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (d === '.' || d === '') { return ''; }
    return d;
}

/** Add tracked directories to an existing preset (dedup). */
export function addDirsToPreset(repoRoot: string, presetName: string, dirs: string[]): Preset {
    const preset = loadPreset(repoRoot, presetName);
    const existing = new Set(preset.dirs ?? []);
    let added = 0;
    for (const raw of dirs) {
        const d = normalizeDir(raw);
        if (!d) { continue; } // root directory would track the whole repo; skip
        if (!existing.has(d)) {
            existing.add(d);
            added++;
        }
    }
    if (added === 0) {
        return preset;
    }
    preset.dirs = [...existing].sort();
    savePreset(repoRoot, preset);
    return preset;
}

/** Remove tracked directories from an existing preset. */
export function removeDirsFromPreset(repoRoot: string, presetName: string, dirs: string[]): Preset {
    const preset = loadPreset(repoRoot, presetName);
    const removeSet = new Set(dirs.map(normalizeDir));
    const before = preset.dirs ?? [];
    const after = before.filter(d => !removeSet.has(d));
    if (after.length === before.length) {
        return preset; // no changes
    }
    preset.dirs = after;
    savePreset(repoRoot, preset);
    return preset;
}

/**
 * Remove files from an existing preset.
 */
export function removeFilesFromPreset(repoRoot: string, presetName: string, files: string[]): Preset {
    const preset = loadPreset(repoRoot, presetName);
    const removeSet = new Set(files);
    preset.files = preset.files.filter(f => !removeSet.has(f));
    preset.fileCount = preset.files.length;
    savePreset(repoRoot, preset);
    return preset;
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
