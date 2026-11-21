import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hashObject, normalizePosixPath, sha256 } from '../../domain/hash.js';
import type {
  ChangedFile,
  ChangeSet,
  CommitInfo,
  DiffHunk,
  SubmoduleChange,
} from '../../domain/types.js';

export interface GitDiffOptions {
  base?: string;
  head?: string;
  scope?: ChangeSet['scope'];
  maxFileSizeBytes?: number;
}

export class GitAdapterError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'GitAdapterError';
  }
}

export class GitAdapter {
  constructor(private readonly repoRoot: string) {}

  private runGit(args: string[], allowNonZero = false): { stdout: string; status: number } {
    try {
      const stdout = execFileSync('git', args, {
        cwd: this.repoRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { stdout, status: 0 };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
      if (allowNonZero && typeof e.status === 'number') {
        const out = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8') ?? '';
        return { stdout: out, status: e.status };
      }
      const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') ?? '';
      throw new GitAdapterError(
        `git ${args.join(' ')} failed: ${stderr.trim() || e.message || String(err)}`,
        err,
      );
    }
  }

  isGitRepository(): boolean {
    const res = this.runGit(['rev-parse', '--is-inside-work-tree'], true);
    return res.status === 0 && res.stdout.trim() === 'true';
  }

  getTopLevel(): string {
    const res = this.runGit(['rev-parse', '--show-toplevel']);
    return path.resolve(res.stdout.trim());
  }

  getRepositoryId(): string {
    const remote = this.runGit(['config', '--get', 'remote.origin.url'], true);
    if (remote.status === 0 && remote.stdout.trim()) {
      return sha256(remote.stdout.trim()).slice(0, 16);
    }
    return sha256(path.resolve(this.repoRoot)).slice(0, 16);
  }

  resolveRef(ref: string): string | undefined {
    const res = this.runGit(['rev-parse', '--verify', `${ref}^{commit}`], true);
    return res.status === 0 ? res.stdout.trim() : undefined;
  }

  getHeadRevision(): string {
    return this.resolveRef('HEAD') ?? 'UNBORN';
  }

  detectDefaultBaselineRef(configuredRef?: string): string | undefined {
    const candidates = [
      configuredRef,
      'origin/main',
      'main',
      'origin/master',
      'master',
      'HEAD',
    ].filter((v): v is string => Boolean(v));

    for (const ref of candidates) {
      if (this.resolveRef(ref)) {
        return ref;
      }
    }
    return undefined;
  }

  readFileAtRevision(rev: string, posixFilePath: string): string | undefined {
    const normalized = normalizePosixPath(posixFilePath);
    const res = this.runGit(['show', `${rev}:${normalized}`], true);
    return res.status === 0 ? res.stdout : undefined;
  }

  listTrackedFiles(): string[] {
    const res = this.runGit(['ls-files'], true);
    if (res.status !== 0) return [];
    return res.stdout
      .split(/\r?\n/)
      .map((l) => normalizePosixPath(l.trim()))
      .filter(Boolean);
  }

  getUntrackedFiles(): string[] {
    const res = this.runGit(['ls-files', '--others', '--exclude-standard'], true);
    if (res.status !== 0) return [];
    return res.stdout
      .split(/\r?\n/)
      .map((l) => normalizePosixPath(l.trim()))
      .filter((p) => Boolean(p) && !p.startsWith('.aeg/'));
  }

  isWorkingTreeDirty(): boolean {
    const res = this.runGit(['status', '--porcelain=v1'], true);
    if (res.status !== 0) return false;
    const lines = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => {
        if (!l) return false;
        const p = normalizePosixPath(l.slice(3).trim());
        return !p.startsWith('.aeg/');
      });
    return lines.length > 0;
  }

  computeRepositoryTreeHash(): { treeHash: string; workingTreeDirty: boolean; untrackedFiles: string[] } {
    const headTreeRes = this.runGit(['rev-parse', 'HEAD^{tree}'], true);
    const baseTree = headTreeRes.status === 0 ? headTreeRes.stdout.trim() : 'UNBORN_TREE';
    const untrackedFiles = this.getUntrackedFiles();

    const statusRes = this.runGit(['status', '--porcelain=v1', '-uall'], true);
    const dirtyEntries: Array<{ status: string; path: string; contentHash: string }> = [];

    if (statusRes.status === 0) {
      for (const rawLine of statusRes.stdout.split(/\r?\n/)) {
        if (!rawLine) continue;
        const statusCode = rawLine.slice(0, 2);
        let filePath = rawLine.slice(3).trim();
        if (filePath.includes(' -> ')) {
          filePath = filePath.split(' -> ').pop()!.trim();
        }
        if (filePath.startsWith('"') && filePath.endsWith('"')) {
          filePath = filePath.slice(1, -1);
        }
        const posixPath = normalizePosixPath(filePath);
        if (!posixPath || posixPath.startsWith('.aeg/')) continue;

        const absPath = path.join(this.repoRoot, posixPath);
        let contentHash = 'DELETED';
        if (fs.existsSync(absPath)) {
          try {
            const stat = fs.statSync(absPath);
            if (stat.isFile()) {
              contentHash = sha256(fs.readFileSync(absPath));
            } else if (stat.isDirectory()) {
              contentHash = 'DIR';
            }
          } catch {
            contentHash = 'UNREADABLE';
          }
        }
        dirtyEntries.push({ status: statusCode, path: posixPath, contentHash });
      }
    }

    dirtyEntries.sort((a, b) => a.path.localeCompare(b.path));
    const workingTreeDirty = dirtyEntries.length > 0;
    const treeHash = workingTreeDirty
      ? sha256(`${baseTree}:${hashObject(dirtyEntries)}`)
      : sha256(baseTree);

    return { treeHash, workingTreeDirty, untrackedFiles };
  }

  getChangeSet(options: GitDiffOptions = {}): ChangeSet {
    if (!this.isGitRepository()) {
      throw new GitAdapterError(`Not a git repository: ${this.repoRoot}`);
    }

    const warnings: string[] = [];
    const scope = options.scope ?? 'combined';
    const headRevision = options.head ? (this.resolveRef(options.head) ?? options.head) : this.getHeadRevision();

    let baseRef = options.base;
    let baseRevision = baseRef ? this.resolveRef(baseRef) : undefined;
    if (baseRef && !baseRevision) {
      warnings.push(`Requested base revision '${baseRef}' could not be resolved; falling back to HEAD.`);
      baseRevision = headRevision;
    }
    if (!baseRevision) {
      baseRevision = headRevision;
    }

    const { treeHash, workingTreeDirty, untrackedFiles } = this.computeRepositoryTreeHash();
    const fileMap = new Map<string, ChangedFile>();
    const submoduleChanges: SubmoduleChange[] = [];

    const maxFileSizeBytes = options.maxFileSizeBytes ?? 512 * 1024;

    const mergeDiffArgs = (diffArgs: string[]) => {
      const nameStatus = this.runGit(['diff', '--name-status', '-M', ...diffArgs], true);
      const numstat = this.runGit(['diff', '--numstat', '-M', ...diffArgs], true);
      const rawDiff = this.runGit(['diff', '-U0', '-M', '--no-color', ...diffArgs], true);

      const numstatMap = new Map<string, { additions: number; deletions: number; binary: boolean }>();
      for (const line of numstat.stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const addStr = parts[0]!;
        const delStr = parts[1]!;
        const filePart = parts.length > 3 ? parts[3]! : parts[2]!;
        const cleanPath = normalizePosixPath(filePart.replace(/\{[^}]*=> ([^}]*)\}/g, '$1'));
        const binary = addStr === '-' && delStr === '-';
        numstatMap.set(cleanPath, {
          additions: binary ? 0 : Number(addStr) || 0,
          deletions: binary ? 0 : Number(delStr) || 0,
          binary,
        });
      }

      const hunksByFile = parseDiffHunks(rawDiff.stdout, submoduleChanges);

      for (const line of nameStatus.stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        const code = parts[0]!;
        let filePath = '';
        let previousPath: string | undefined;
        let changeType: ChangedFile['changeType'] = 'modified';

        if (code.startsWith('R') && parts.length >= 3) {
          changeType = 'renamed';
          previousPath = normalizePosixPath(parts[1]!);
          filePath = normalizePosixPath(parts[2]!);
        } else if (code.startsWith('A')) {
          changeType = 'added';
          filePath = normalizePosixPath(parts[1]!);
        } else if (code.startsWith('D')) {
          changeType = 'deleted';
          filePath = normalizePosixPath(parts[1]!);
        } else {
          changeType = 'modified';
          filePath = normalizePosixPath(parts[1]!);
        }

        if (!filePath || filePath.startsWith('.aeg/')) continue;

        const stats = numstatMap.get(filePath) ?? { additions: 0, deletions: 0, binary: false };
        const hunks = hunksByFile.get(filePath) ?? [];
        const absPath = path.join(this.repoRoot, filePath);
        let large = false;
        if (changeType !== 'deleted' && fs.existsSync(absPath)) {
          try {
            large = fs.statSync(absPath).size > maxFileSizeBytes;
          } catch {
            // ignore
          }
        }

        const existing = fileMap.get(filePath);
        if (existing) {
          existing.additions += stats.additions;
          existing.deletions += stats.deletions;
          existing.binary = existing.binary || stats.binary;
          existing.large = existing.large || large;
          existing.hunks.push(...hunks);
        } else {
          fileMap.set(filePath, {
            path: filePath,
            previousPath,
            changeType,
            additions: stats.additions,
            deletions: stats.deletions,
            hunks,
            binary: stats.binary,
            large,
          });
        }
      }
    };

    if (headRevision !== 'UNBORN') {
      if (scope === 'revision_range') {
        if (baseRevision !== headRevision) {
          mergeDiffArgs([`${baseRevision}..${headRevision}`]);
        }
      } else if (scope === 'staged') {
        mergeDiffArgs(['--cached']);
      } else if (scope === 'working_tree') {
        mergeDiffArgs([]);
      } else {
        // combined: base..working_tree (includes committed since base + staged + unstaged)
        if (baseRevision !== headRevision) {
          mergeDiffArgs([baseRevision]);
        } else {
          mergeDiffArgs(['HEAD']);
        }
      }
    } else {
      warnings.push('Repository has no commits yet (HEAD is unborn); analyzing staged/untracked files.');
      mergeDiffArgs(['--cached']);
    }

    if (scope === 'working_tree' || scope === 'combined') {
      for (const untracked of untrackedFiles) {
        if (fileMap.has(untracked)) continue;
        const absPath = path.join(this.repoRoot, untracked);
        let additions = 0;
        let binary = false;
        let large = false;
        if (fs.existsSync(absPath)) {
          try {
            const stat = fs.statSync(absPath);
            large = stat.size > maxFileSizeBytes;
            if (!large && stat.isFile()) {
              const buf = fs.readFileSync(absPath);
              binary = buf.includes(0);
              if (!binary) {
                additions = buf.toString('utf8').split(/\r?\n/).length;
              }
            }
          } catch {
            warnings.push(`Could not inspect untracked file: ${untracked}`);
          }
        }
        fileMap.set(untracked, {
          path: untracked,
          changeType: 'added',
          additions,
          deletions: 0,
          hunks: additions > 0 ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: additions }] : [],
          binary,
          large,
        });
      }
    }

    const commits: CommitInfo[] = [];
    if (headRevision !== 'UNBORN' && baseRevision !== headRevision && (scope === 'revision_range' || scope === 'combined')) {
      const logRes = this.runGit(
        ['log', '--format=%H%x1f%s%x1f%an%x1f%aI', `${baseRevision}..${headRevision}`],
        true,
      );
      if (logRes.status === 0) {
        for (const line of logRes.stdout.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const [sha, subject, author, date] = line.split('\x1f');
          if (sha) {
            commits.push({ sha, subject: subject ?? '', author, date });
          }
        }
      }
    }

    const files = Array.from(fileMap.values()).sort((a, b) => a.path.localeCompare(b.path));

    return {
      repositoryId: this.getRepositoryId(),
      baseRevision,
      headRevision,
      scope,
      repositoryTreeHash: treeHash,
      files,
      commits,
      workingTreeDirty,
      untrackedFiles,
      submoduleChanges,
      analysisWarnings: warnings,
    };
  }
}

function parseDiffHunks(rawDiff: string, submoduleChanges: SubmoduleChange[]): Map<string, DiffHunk[]> {
  const map = new Map<string, DiffHunk[]>();
  let currentFile: string | undefined;
  let isSubmodule = false;
  let prevSubCommit: string | undefined;
  let currSubCommit: string | undefined;

  const flushSubmodule = () => {
    if (isSubmodule && currentFile) {
      submoduleChanges.push({
        path: currentFile,
        previousCommit: prevSubCommit,
        currentCommit: currSubCommit,
      });
    }
    isSubmodule = false;
    prevSubCommit = undefined;
    currSubCommit = undefined;
  };

  for (const line of rawDiff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flushSubmodule();
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (match) {
        currentFile = normalizePosixPath(match[2]!);
        if (!map.has(currentFile)) {
          map.set(currentFile, []);
        }
      }
      continue;
    }

    if (line.includes('160000')) {
      isSubmodule = true;
    }
    if (isSubmodule) {
      const subMinus = /^-Subproject commit ([0-9a-f]+)/.exec(line);
      const subPlus = /^\+Subproject commit ([0-9a-f]+)/.exec(line);
      if (subMinus) prevSubCommit = subMinus[1];
      if (subPlus) currSubCommit = subPlus[1];
    }

    if (currentFile && line.startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (match) {
        map.get(currentFile)!.push({
          oldStart: Number(match[1]),
          oldLines: match[2] !== undefined ? Number(match[2]) : 1,
          newStart: Number(match[3]),
          newLines: match[4] !== undefined ? Number(match[4]) : 1,
          header: match[5]?.trim() || undefined,
        });
      }
    }
  }
  flushSubmodule();
  return map;
}
