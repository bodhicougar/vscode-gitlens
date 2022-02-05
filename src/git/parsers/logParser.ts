import { Range } from 'vscode';
import type { Container } from '../../container';
import { Arrays, debug } from '../../system';
import { normalizePath, relative } from '../../system/path';
import { getLines } from '../../system/string';
import {
	GitCommit,
	GitCommitIdentity,
	GitCommitLine,
	GitFile,
	GitFileChange,
	GitFileChangeStats,
	GitFileIndexStatus,
	GitLog,
	GitRevision,
	GitUser,
	isUserMatch,
} from '../models';

const diffRegex = /diff --git a\/(.*) b\/(.*)/;
const diffRangeRegex = /^@@ -(\d+?),(\d+?) \+(\d+?),(\d+?) @@/;

export const fileStatusRegex = /(\S)\S*\t([^\t\n]+)(?:\t(.+))?/;
const fileStatusAndSummaryRegex = /^(\d+?|-)\s+?(\d+?|-)\s+?(.*)(?:\n\s(delete|rename|copy|create))?/;
const fileStatusAndSummaryRenamedFileRegex = /(.+)\s=>\s(.+)/;
const fileStatusAndSummaryRenamedFilePathRegex = /(.*?){(.+?)\s=>\s(.*?)}(.*)/;

const logFileSimpleRegex = /^<r> (.*)\s*(?:(?:diff --git a\/(.*) b\/(.*))|(?:(\S)\S*\t([^\t\n]+)(?:\t(.+))?))/gm;
const logFileSimpleRenamedRegex = /^<r> (\S+)\s*(.*)$/s;
const logFileSimpleRenamedFilesRegex = /^(\S)\S*\t([^\t\n]+)(?:\t(.+)?)?$/gm;

// Using %x00 codes because some shells seem to try to expand things if not
const lb = '%x3c'; // `%x${'<'.charCodeAt(0).toString(16)}`;
const rb = '%x3e'; // `%x${'>'.charCodeAt(0).toString(16)}`;
const sl = '%x2f'; // `%x${'/'.charCodeAt(0).toString(16)}`;
const sp = '%x20'; // `%x${' '.charCodeAt(0).toString(16)}`;

export const enum LogType {
	Log = 0,
	LogFile = 1,
}

interface LogEntry {
	sha?: string;

	author?: string;
	authorDate?: string;
	authorEmail?: string;

	committer?: string;
	committedDate?: string;
	committerEmail?: string;

	parentShas?: string[];

	/** @deprecated */
	path?: string;
	/** @deprecated */
	originalPath?: string;

	file?: GitFile;
	files?: GitFile[];

	status?: GitFileIndexStatus;
	fileStats?: GitFileChangeStats;

	summary?: string;

	line?: GitCommitLine;
}

export type Parser<T> = {
	arguments: string[];
	parse: (data: string) => Generator<T>;
};

type ParsedEntryFile = { status: string; path: string; originalPath?: string };
type ParsedEntryWithFiles<T> = { [K in keyof T]: string } & { files: ParsedEntryFile[] };
type ParserWithFiles<T> = {
	arguments: string[];
	parse: (data: string) => Generator<ParsedEntryWithFiles<T>>;
};

export class GitLogParser {
	static readonly shortstatRegex =
		/(?<files>\d+) files? changed(?:, (?<additions>\d+) insertions?\(\+\))?(?:, (?<deletions>\d+) deletions?\(-\))?/;

	private static _defaultParser: ParserWithFiles<{
		sha: string;
		author: string;
		authorEmail: string;
		authorDate: string;
		committer: string;
		committerEmail: string;
		committerDate: string;
		message: string;
		parents: string[];
	}>;
	static get defaultParser() {
		if (this._defaultParser == null) {
			this._defaultParser = GitLogParser.createWithFiles({
				sha: '%H',
				author: '%aN',
				authorEmail: '%aE',
				authorDate: '%at',
				committer: '%cN',
				committerEmail: '%cE',
				committerDate: '%ct',
				message: '%B',
				parents: '%P',
			});
		}
		return this._defaultParser;
	}

	static defaultFormat = [
		`${lb}${sl}f${rb}`,
		`${lb}r${rb}${sp}%H`, // ref
		`${lb}a${rb}${sp}%aN`, // author
		`${lb}e${rb}${sp}%aE`, // author email
		`${lb}d${rb}${sp}%at`, // author date
		`${lb}n${rb}${sp}%cN`, // committer
		`${lb}m${rb}${sp}%cE`, // committer email
		`${lb}c${rb}${sp}%ct`, // committer date
		`${lb}p${rb}${sp}%P`, // parents
		`${lb}s${rb}`,
		'%B', // summary
		`${lb}${sl}s${rb}`,
		`${lb}f${rb}`,
	].join('%n');

	static simpleRefs = `${lb}r${rb}${sp}%H`;
	static simpleFormat = `${lb}r${rb}${sp}%H`;

	static shortlog = '%H%x00%aN%x00%aE%x00%at';

	static create<T extends Record<string, unknown>>(
		fieldMapping: ExtractAll<T, string>,
		options?: {
			additionalArgs?: string[];
			parseEntry?: (fields: IterableIterator<string>, entry: T) => void;
			prefix?: string;
			fieldPrefix?: string;
			fieldSuffix?: string;
			separator?: string;
			skip?: number;
		},
	): Parser<T> {
		let format = options?.prefix ?? '';
		const keys: (keyof ExtractAll<T, string>)[] = [];
		for (const key in fieldMapping) {
			keys.push(key);
			format += `${options?.fieldPrefix ?? ''}${fieldMapping[key]}${
				options?.fieldSuffix ?? (options?.fieldPrefix == null ? '%x00' : '')
			}`;
		}

		const args = ['-z', `--format=${format}`];
		if (options?.additionalArgs != null && options.additionalArgs.length > 0) {
			args.push(...options.additionalArgs);
		}

		function* parse(data: string): Generator<T> {
			let entry: T = {} as any;
			let fieldCount = 0;
			let field;

			const fields = getLines(data, options?.separator ?? '\0');
			if (options?.skip) {
				for (let i = 0; i < options.skip; i++) {
					field = fields.next();
				}
			}

			while (true) {
				field = fields.next();
				if (field.done) break;

				entry[keys[fieldCount++]] = field.value as T[keyof T];

				if (fieldCount === keys.length) {
					fieldCount = 0;
					field = fields.next();

					options?.parseEntry?.(fields, entry);
					yield entry;

					entry = {} as any;
				}
			}
		}

		return { arguments: args, parse: parse };
	}

	static createSingle(field: string): Parser<string> {
		const format = field;
		const args = ['-z', `--format=${format}`];

		function* parse(data: string): Generator<string> {
			let field;

			const fields = getLines(data, '\0');
			while (true) {
				field = fields.next();
				if (field.done) break;

				yield field.value;
			}
		}

		return { arguments: args, parse: parse };
	}

	static createWithFiles<T extends Record<string, string>>(fieldMapping: T): ParserWithFiles<T> {
		let format = '%x00%x00';
		const keys: (keyof T)[] = [];
		for (const key in fieldMapping) {
			keys.push(key);
			format += `%x00${fieldMapping[key]}`;
		}

		const args = ['-z', `--format=${format}`, '--name-status'];

		function* parse(data: string): Generator<ParsedEntryWithFiles<T>> {
			const records = getLines(data, '\0\0\0\0');

			let entry: ParsedEntryWithFiles<T>;
			let files: ParsedEntryFile[];
			let fields: IterableIterator<string>;

			let first = true;
			for (let record of records) {
				if (first) {
					first = false;
					// Fix the first record (since it only has 3 nulls)
					record = record.slice(3);
				}

				entry = {} as any;
				files = [];
				fields = getLines(record, '\0');

				let fieldCount = 0;
				let field;
				while (true) {
					field = fields.next();
					if (field.done) break;

					if (fieldCount < keys.length) {
						entry[keys[fieldCount++]] = field.value as ParsedEntryWithFiles<T>[keyof T];
					} else {
						const file: ParsedEntryFile = { status: field.value.trim(), path: undefined! };
						field = fields.next();
						file.path = field.value;

						if (file.status[0] === 'R' || file.status[0] === 'C') {
							field = fields.next();
							file.originalPath = field.value;
						}
					}
				}

				entry.files = files;
				yield entry;
			}
		}

		return { arguments: args, parse: parse };
	}

	@debug({ args: false })
	static parse(
		container: Container,
		data: string,
		type: LogType,
		repoPath: string | undefined,
		fileName: string | undefined,
		sha: string | undefined,
		currentUser: GitUser | undefined,
		limit: number | undefined,
		reverse: boolean,
		range: Range | undefined,
	): GitLog | undefined {
		if (!data) return undefined;

		let relativeFileName: string;

		let entry: LogEntry = {};
		let line: string | undefined = undefined;
		let token: number;

		let i = 0;
		let first = true;

		const lines = getLines(`${data}</f>`);
		// Skip the first line since it will always be </f>
		let next = lines.next();
		if (next.done) return undefined;

		if (repoPath !== undefined) {
			repoPath = normalizePath(repoPath);
		}

		const commits = new Map<string, GitCommit>();
		let truncationCount = limit;

		let match;
		let renamedFileName;
		let renamedMatch;

		loop: while (true) {
			next = lines.next();
			if (next.done) break;

			line = next.value;

			// Since log --reverse doesn't properly honor a max count -- enforce it here
			if (reverse && limit && i >= limit) break;

			// <1-char token> data
			// e.g. <r> bd1452a2dc
			token = line.charCodeAt(1);

			switch (token) {
				case 114: // 'r': // ref
					entry = {
						sha: line.substring(4),
					};
					break;

				case 97: // 'a': // author
					if (GitRevision.uncommitted === entry.sha) {
						entry.author = 'You';
					} else {
						entry.author = line.substring(4);
					}
					break;

				case 101: // 'e': // author-mail
					entry.authorEmail = line.substring(4);
					break;

				case 100: // 'd': // author-date
					entry.authorDate = line.substring(4);
					break;

				case 110: // 'n': // committer
					entry.committer = line.substring(4);
					break;

				case 109: // 'm': // committer-mail
					entry.committedDate = line.substring(4);
					break;

				case 99: // 'c': // committer-date
					entry.committedDate = line.substring(4);
					break;

				case 112: // 'p': // parents
					entry.parentShas = line.substring(4).split(' ');
					break;

				case 115: // 's': // summary
					while (true) {
						next = lines.next();
						if (next.done) break;

						line = next.value;
						if (line === '</s>') break;

						if (entry.summary === undefined) {
							entry.summary = line;
						} else {
							entry.summary += `\n${line}`;
						}
					}

					// Remove the trailing newline
					if (entry.summary != null && entry.summary.charCodeAt(entry.summary.length - 1) === 10) {
						entry.summary = entry.summary.slice(0, -1);
					}
					break;

				case 102: {
					// 'f': // files
					// Skip the blank line git adds before the files
					next = lines.next();

					let hasFiles = true;
					if (next.done || next.value === '</f>') {
						// If this is a merge commit and there are no files returned, skip the commit and reduce our truncationCount to ensure accurate truncation detection
						if ((entry.parentShas?.length ?? 0) > 1) {
							if (truncationCount) {
								truncationCount--;
							}

							break;
						}

						hasFiles = false;
					}

					// eslint-disable-next-line no-unmodified-loop-condition
					while (hasFiles) {
						next = lines.next();
						if (next.done) break;

						line = next.value;
						if (line === '</f>') break;

						if (line.startsWith('warning:')) continue;

						if (type === LogType.Log) {
							match = fileStatusRegex.exec(line);
							if (match != null) {
								if (entry.files === undefined) {
									entry.files = [];
								}

								renamedFileName = match[3];
								if (renamedFileName !== undefined) {
									entry.files.push({
										status: match[1] as GitFileIndexStatus,
										path: renamedFileName,
										originalPath: match[2],
									});
								} else {
									entry.files.push({
										status: match[1] as GitFileIndexStatus,
										path: match[2],
									});
								}
							}
						} else {
							match = diffRegex.exec(line);
							if (match != null) {
								[, entry.originalPath, entry.path] = match;
								if (entry.path === entry.originalPath) {
									entry.originalPath = undefined;
									entry.status = GitFileIndexStatus.Modified;
								} else {
									entry.status = GitFileIndexStatus.Renamed;
								}

								void lines.next();
								void lines.next();
								next = lines.next();

								match = diffRangeRegex.exec(next.value);
								if (match !== null) {
									entry.line = {
										sha: entry.sha!,
										originalLine: parseInt(match[1], 10),
										// count: parseInt(match[2], 10),
										line: parseInt(match[3], 10),
										// count: parseInt(match[4], 10),
									};
								}

								while (true) {
									next = lines.next();
									if (next.done || next.value === '</f>') break;
								}
								break;
							} else {
								next = lines.next();
								match = fileStatusAndSummaryRegex.exec(`${line}\n${next.value}`);
								if (match != null) {
									entry.fileStats = {
										additions: Number(match[1]) || 0,
										deletions: Number(match[2]) || 0,
										changes: 0,
									};

									switch (match[4]) {
										case undefined:
											entry.status = 'M' as GitFileIndexStatus;
											entry.path = match[3];
											break;
										case 'copy':
										case 'rename':
											entry.status = (match[4] === 'copy' ? 'C' : 'R') as GitFileIndexStatus;

											renamedFileName = match[3];
											renamedMatch =
												fileStatusAndSummaryRenamedFilePathRegex.exec(renamedFileName);
											if (renamedMatch != null) {
												// If there is no new path, the path part was removed so ensure we don't end up with //
												entry.path =
													renamedMatch[3] === ''
														? `${renamedMatch[1]}${renamedMatch[4]}`.replace('//', '/')
														: `${renamedMatch[1]}${renamedMatch[3]}${renamedMatch[4]}`;
												entry.originalPath = `${renamedMatch[1]}${renamedMatch[2]}${renamedMatch[4]}`;
											} else {
												renamedMatch =
													fileStatusAndSummaryRenamedFileRegex.exec(renamedFileName);
												if (renamedMatch != null) {
													entry.path = renamedMatch[2];
													entry.originalPath = renamedMatch[1];
												} else {
													entry.path = renamedFileName;
												}
											}

											break;
										case 'create':
											entry.status = 'A' as GitFileIndexStatus;
											entry.path = match[3];
											break;
										case 'delete':
											entry.status = 'D' as GitFileIndexStatus;
											entry.path = match[3];
											break;
										default:
											entry.status = 'M' as GitFileIndexStatus;
											entry.path = match[3];
											break;
									}
								}

								if (next.done || next.value === '</f>') break;
							}
						}
					}

					if (entry.files !== undefined) {
						entry.path = Arrays.filterMap(entry.files, f => (f.path ? f.path : undefined)).join(', ');
					}

					if (first && repoPath === undefined && type === LogType.LogFile && fileName !== undefined) {
						// Try to get the repoPath from the most recent commit
						repoPath = normalizePath(
							fileName.replace(fileName.startsWith('/') ? `/${entry.path}` : entry.path!, ''),
						);
						relativeFileName = normalizePath(relative(repoPath, fileName));
					} else {
						relativeFileName = entry.path!;
					}
					first = false;

					const commit = commits.get(entry.sha!);
					if (commit === undefined) {
						i++;
						if (limit && i > limit) break loop;
					} else if (truncationCount) {
						// Since this matches an existing commit it will be skipped, so reduce our truncationCount to ensure accurate truncation detection
						truncationCount--;
					}

					GitLogParser.parseEntry(
						container,
						entry,
						commit,
						type,
						repoPath,
						relativeFileName,
						commits,
						currentUser,
					);

					break;
				}
			}
		}

		const log: GitLog = {
			repoPath: repoPath!,
			commits: commits,
			sha: sha,
			count: i,
			limit: limit,
			range: range,
			hasMore: Boolean(truncationCount && i > truncationCount && truncationCount !== 1),
		};
		return log;
	}

	private static parseEntry(
		container: Container,
		entry: LogEntry,
		commit: GitCommit | undefined,
		type: LogType,
		repoPath: string | undefined,
		relativeFileName: string,
		commits: Map<string, GitCommit>,
		currentUser: GitUser | undefined,
	): void {
		if (commit == null) {
			if (entry.author != null) {
				if (isUserMatch(currentUser, entry.author, entry.authorEmail)) {
					entry.author = 'You';
				}
			}

			if (entry.committer != null) {
				if (isUserMatch(currentUser, entry.committer, entry.committerEmail)) {
					entry.committer = 'You';
				}
			}

			const originalFileName = entry.originalPath ?? (relativeFileName !== entry.path ? entry.path : undefined);

			const files: { file?: GitFileChange; files?: GitFileChange[] } = {
				files: entry.files?.map(f => new GitFileChange(repoPath!, f.path, f.status, f.originalPath)),
			};
			if (type === LogType.LogFile) {
				files.file = new GitFileChange(
					repoPath!,
					relativeFileName,
					entry.status!,
					originalFileName,
					undefined,
					entry.fileStats,
				);
			}

			commit = new GitCommit(
				container,
				repoPath!,
				entry.sha!,
				new GitCommitIdentity(entry.author!, entry.authorEmail, new Date((entry.authorDate! as any) * 1000)),
				new GitCommitIdentity(
					entry.committer!,
					entry.committerEmail,
					new Date((entry.committedDate! as any) * 1000),
				),
				entry.summary?.split('\n', 1)[0] ?? '',
				entry.parentShas ?? [],
				entry.summary ?? '',
				files,
				undefined,
				entry.line != null ? [entry.line] : [],
			);

			commits.set(entry.sha!, commit);
		}
	}

	@debug({ args: false })
	static parseSimple(
		data: string,
		skip: number,
		skipRef?: string,
	): [string | undefined, string | undefined, GitFileIndexStatus | undefined] {
		let ref;
		let diffFile;
		let diffRenamed;
		let status;
		let file;
		let renamed;

		let match;
		do {
			match = logFileSimpleRegex.exec(data);
			if (match == null) break;

			if (match[1] === skipRef) continue;
			if (skip-- > 0) continue;

			[, ref, diffFile, diffRenamed, status, file, renamed] = match;

			// Stops excessive memory usage -- https://bugs.chromium.org/p/v8/issues/detail?id=2869
			file = ` ${diffRenamed || diffFile || renamed || file}`.substr(1);
			// Stops excessive memory usage -- https://bugs.chromium.org/p/v8/issues/detail?id=2869
			status = status == null || status.length === 0 ? undefined : ` ${status}`.substr(1);
		} while (skip >= 0);

		// Ensure the regex state is reset
		logFileSimpleRegex.lastIndex = 0;

		// Stops excessive memory usage -- https://bugs.chromium.org/p/v8/issues/detail?id=2869
		return [
			ref == null || ref.length === 0 ? undefined : ` ${ref}`.substr(1),
			file,
			status as GitFileIndexStatus | undefined,
		];
	}

	@debug({ args: false })
	static parseSimpleRenamed(
		data: string,
		originalFileName: string,
	): [string | undefined, string | undefined, GitFileIndexStatus | undefined] {
		let match = logFileSimpleRenamedRegex.exec(data);
		if (match == null) return [undefined, undefined, undefined];

		const [, ref, files] = match;

		let status;
		let file;
		let renamed;

		do {
			match = logFileSimpleRenamedFilesRegex.exec(files);
			if (match == null) break;

			[, status, file, renamed] = match;

			if (originalFileName !== file) {
				status = undefined;
				file = undefined;
				renamed = undefined;
				continue;
			}

			// Stops excessive memory usage -- https://bugs.chromium.org/p/v8/issues/detail?id=2869
			file = ` ${renamed || file}`.substr(1);
			// Stops excessive memory usage -- https://bugs.chromium.org/p/v8/issues/detail?id=2869
			status = status == null || status.length === 0 ? undefined : ` ${status}`.substr(1);

			break;
		} while (true);

		// Ensure the regex state is reset
		logFileSimpleRenamedFilesRegex.lastIndex = 0;

		return [
			// Stops excessive memory usage -- https://bugs.chromium.org/p/v8/issues/detail?id=2869
			ref == null || ref.length === 0 || file == null ? undefined : ` ${ref}`.substr(1),
			file,
			status as GitFileIndexStatus | undefined,
		];
	}
}
