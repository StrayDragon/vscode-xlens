import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import * as vscode from 'vscode';
import { getDiffEntries, resolveRef, listTags, listRecentCommits, getUpstreamRef, getCommitsAheadOfUpstream } from '../gitService';
import {
    createPreset,
    loadPreset,
    listPresets,
    updatePresetRange,
    updatePresetBaseBranch,
} from '../presetService';

function runGit(cwd: string, args: string[]): string {
    const quoted = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
    return execSync(`git ${quoted}`, { cwd, encoding: 'utf-8' }).trim();
}

/**
 * Create a temp git repo:
 *   main: init (a.txt, sub/b.txt) → tag v1.0.0 → second (a.txt M, new.txt A)
 */
function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlens-test-'));
    runGit(dir, ['init', '-q', '-b', 'main']);
    runGit(dir, ['config', 'user.email', 'test@test']);
    runGit(dir, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'bee\n');
    runGit(dir, ['add', '.']);
    runGit(dir, ['commit', '-qm', 'init']);
    runGit(dir, ['tag', 'v1.0.0']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n');
    runGit(dir, ['add', '.']);
    runGit(dir, ['commit', '-qm', 'second']);
    return dir;
}

suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    test('Sample test', () => {
        assert.strictEqual(-1, [1, 2, 3].indexOf(5));
        assert.strictEqual(-1, [1, 2, 3].indexOf(0));
    });

    suite('gitService range diff', () => {
        let repo: string;

        setup(() => { repo = makeRepo(); });
        teardown(() => { fs.rmSync(repo, { recursive: true, force: true }); });

        test('range diff between tag and HEAD', async () => {
            const entries = await getDiffEntries(repo, { kind: 'range', from: 'v1.0.0', to: 'HEAD' }, '');
            const byPath = new Map(entries.map(e => [e.path, e.status]));
            assert.strictEqual(byPath.get('a.txt'), 'M');
            assert.strictEqual(byPath.get('new.txt'), 'A');
            assert.strictEqual(byPath.get('sub/b.txt'), undefined);
        });

        test('range diff between two tags is empty when identical', async () => {
            runGit(repo, ['tag', 'v1.0.0-copy', 'v1.0.0']);
            const entries = await getDiffEntries(repo, { kind: 'range', from: 'v1.0.0', to: 'v1.0.0-copy' }, '');
            assert.strictEqual(entries.length, 0);
        });

        test('range diff respects filter prefix', async () => {
            const entries = await getDiffEntries(repo, { kind: 'range', from: 'v1.0.0', to: 'HEAD' }, 'sub/');
            assert.strictEqual(entries.length, 0);
            const all = await getDiffEntries(repo, { kind: 'range', from: 'v1.0.0', to: 'HEAD' }, '');
            assert.ok(all.length >= 2);
        });

        test('range main→HEAD is empty', async () => {
            const entries = await getDiffEntries(repo, { kind: 'range', from: 'main', to: 'HEAD' }, '');
            assert.strictEqual(entries.length, 0);
        });

        test('three-dot shows only target-side changes on divergent branches (PR-style)', async () => {
            // feature forks from v1.0.0 and only touches sub/b.txt;
            // main advanced with a.txt + new.txt after v1.0.0.
            runGit(repo, ['checkout', '-qb', 'feature', 'v1.0.0']);
            fs.writeFileSync(path.join(repo, 'sub', 'b.txt'), 'bee\nfeature\n');
            runGit(repo, ['add', '.']);
            runGit(repo, ['commit', '-qm', 'feature-work']);

            const threeDot = await getDiffEntries(repo, { kind: 'range', from: 'main', to: 'feature', mode: 'three-dot' }, '');
            assert.deepStrictEqual(threeDot.map(e => e.path).sort(), ['sub/b.txt']);

            const twoDot = await getDiffEntries(repo, { kind: 'range', from: 'main', to: 'feature', mode: 'two-dot' }, '');
            assert.deepStrictEqual(twoDot.map(e => e.path).sort(), ['a.txt', 'new.txt', 'sub/b.txt']);
        });

        test('three-dot falls back to two-dot when there is no merge base', async () => {
            runGit(repo, ['checkout', '-q', '--orphan', 'orphan']);
            runGit(repo, ['rm', '-qrf', '.']);
            fs.writeFileSync(path.join(repo, 'x.txt'), 'x\n');
            runGit(repo, ['add', '.']);
            runGit(repo, ['commit', '-qm', 'orphan']);

            const entries = await getDiffEntries(repo, { kind: 'range', from: 'main', to: 'orphan', mode: 'three-dot' }, '');
            const byPath = new Map(entries.map(e => [e.path, e.status]));
            assert.strictEqual(byPath.get('x.txt'), 'A');
            assert.strictEqual(byPath.get('a.txt'), 'D');
        });

        test('numstat collects line additions/deletions', async () => {
            const entries = await getDiffEntries(repo, { kind: 'range', from: 'v1.0.0', to: 'HEAD', mode: 'two-dot' }, '');
            const a = entries.find(e => e.path === 'a.txt');
            assert.strictEqual(a?.additions, 1);
            assert.strictEqual(a?.deletions, 0);
            const n = entries.find(e => e.path === 'new.txt');
            assert.strictEqual(n?.additions, 1);
            assert.strictEqual(n?.deletions, 0);
        });

        test('base mode still works (working tree vs ref)', async () => {
            fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
            const entries = await getDiffEntries(repo, { kind: 'base', ref: 'main' }, '');
            const byPath = new Map(entries.map(e => [e.path, e.status]));
            assert.strictEqual(byPath.get('a.txt'), 'M');
        });

        test('resolveRef validates refs', async () => {
            const sha = await resolveRef(repo, 'v1.0.0');
            assert.match(sha, /^[0-9a-f]{40}$/);
            const short = await resolveRef(repo, 'HEAD');
            assert.match(short, /^[0-9a-f]{40}$/);
            await assert.rejects(() => resolveRef(repo, 'no-such-ref'));
            await assert.rejects(() => resolveRef(repo, 'a b; rm -rf /'));
        });

        test('listTags and listRecentCommits', async () => {
            const tags = await listTags(repo);
            assert.deepStrictEqual(tags, ['v1.0.0']);
            const commits = await listRecentCommits(repo, 5);
            assert.ok(commits.length >= 2);
            assert.match(commits[0].sha, /^[0-9a-f]{7,}$/);
            assert.ok(commits[0].subject.length > 0);
        });

        test('getUpstreamRef / getCommitsAheadOfUpstream without upstream', async () => {
            assert.strictEqual(await getUpstreamRef(repo), undefined);
            assert.strictEqual(await getCommitsAheadOfUpstream(repo), undefined);
        });

        test('getCommitsAheadOfUpstream reports ahead count vs remote-tracking branch', async () => {
            // Simulate a remote by cloning into a bare repo and pushing with -u.
            const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'xlens-bare-'));
            try {
                runGit(bare, ['init', '-q', '--bare', '-b', 'main']);
                runGit(repo, ['remote', 'add', 'origin', bare]);
                runGit(repo, ['push', '-qu', 'origin', 'main']);

                const synced = await getCommitsAheadOfUpstream(repo);
                assert.ok(synced);
                assert.strictEqual(synced!.upstream, 'origin/main');
                assert.strictEqual(synced!.ahead, 0);

                fs.writeFileSync(path.join(repo, 'push-me.txt'), 'local\n');
                runGit(repo, ['add', '.']);
                runGit(repo, ['commit', '-qm', 'unpushed']);

                const ahead = await getCommitsAheadOfUpstream(repo);
                assert.ok(ahead);
                assert.strictEqual(ahead!.upstream, 'origin/main');
                assert.strictEqual(ahead!.ahead, 1);

                const entries = await getDiffEntries(
                    repo,
                    { kind: 'range', from: ahead!.upstream, to: 'HEAD' },
                    '',
                );
                assert.ok(entries.some(e => e.path === 'push-me.txt' && e.status === 'A'));
            } finally {
                fs.rmSync(bare, { recursive: true, force: true });
            }
        });
    });

    suite('preset range persistence', () => {
        let repo: string;

        setup(() => { repo = makeRepo(); });
        teardown(() => { fs.rmSync(repo, { recursive: true, force: true }); });

        test('createPreset stores range and clears baseBranch', () => {
            const p = createPreset(repo, 'range-p', ['a.txt'], 'desc', undefined, { from: 'v1.0.0', to: 'main' });
            assert.deepStrictEqual(p.range, { from: 'v1.0.0', to: 'main' });
            assert.strictEqual(p.baseBranch, undefined);

            const loaded = loadPreset(repo, 'range-p');
            assert.deepStrictEqual(loaded.range, { from: 'v1.0.0', to: 'main' });

            const meta = listPresets(repo).find(m => m.name === 'range-p');
            assert.deepStrictEqual(meta?.range, { from: 'v1.0.0', to: 'main' });
        });

        test('baseBranch and range are mutually exclusive', () => {
            const p = createPreset(repo, 'p', ['a.txt'], undefined, 'main');
            assert.strictEqual(p.range, undefined);

            updatePresetRange(repo, 'p', { from: 'v1.0.0', to: 'main' });
            const after = loadPreset(repo, 'p');
            assert.deepStrictEqual(after.range, { from: 'v1.0.0', to: 'main' });
            assert.strictEqual(after.baseBranch, undefined);

            updatePresetBaseBranch(repo, 'p', 'main');
            const back = loadPreset(repo, 'p');
            assert.strictEqual(back.range, undefined);
            assert.strictEqual(back.baseBranch, 'main');
        });

        test('legacy preset without range loads fine', () => {
            const p = createPreset(repo, 'legacy', ['a.txt'], undefined, 'main');
            assert.strictEqual(p.range, undefined);
            assert.strictEqual(p.baseBranch, 'main');
            assert.deepStrictEqual(loadPreset(repo, 'legacy').paths, ['a.txt']);
        });
    });
});
