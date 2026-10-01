// What a row's line number means TODAY (see src/recent-files/browser/now-line.ts).
//
// A line number is an ADDRESS, and a note is edited: a paragraph written above a
// spot moves every line below it, and the address that used to name the spot names
// something else. The list goes on printing the number it recorded — that is what
// the row is about — but anything that OPENS the note has to be handed the number
// the note answers to now, or none at all.
//
// The three ways this module knows, and the one way it admits it does not, are all
// answered here against hand-built facts: no workspace, no file, no vault.

import { describe, it, expect } from 'vitest';
import type { CachedMetadata } from 'obsidian';
import { nowLineFor, type NowLineFacts } from '@/recent-files/browser/now-line';
import { linesSource } from '@/position/capture/ephemeral';
import type { NavEntry } from '@/nav/entry';
import type { NavEntryDescription } from '@/recent-files/browser/model';
import type { NavEntryState } from '@/types';

// A file's parsed headings, in the shape the metadata cache hands them over.
const cache = (...at: [string, number][]): CachedMetadata =>
	({
		headings: at.map(([heading, line]) => ({
			heading, level: 2, position: { start: { line } },
		})),
	}) as CachedMetadata;

// Facts a test can answer by hand. Every one of them is "nothing to go on" by
// default, so each case below says exactly what it is a case OF.
const facts = (over: Partial<NowLineFacts> = {}): NowLineFacts => ({
	mtimeOf: () => undefined,
	cacheFor: () => null,
	linesOf: () => undefined,
	...over,
});

// A jump with a landing, as the store keeps one: the line it landed on, and the
// text that stood on that line when it did.
const jump = (st: NavEntryState, key?: string, keyLine?: number): NavEntry => ({
	kind: 'jump', path: 'a.md', leafId: 'leaf-1', t: 0, st,
	key: key ?? 'outline:## Beta',
	keyLine,
});

const at = (line: number): NavEntryDescription => ({ name: 'a', line: `L${line + 1}`, lineIndex: line });

describe('nowLineFor', () => {
	it('文件此后没被写过就沿用记下的行号', () => {
		// The record's own clock and the file's say the same thing: nothing has been
		// written since the words were taken, so the number is still the address.
		const entry = jump({ scroll: 40, anchor: '正文', mtime: 7 });
		expect(nowLineFor(entry, at(40), facts({ mtimeOf: () => 7 }))).toBe(40);
		// …and no line of the file is read to prove it: the clock answered.
		const linesOf = () => linesSource(['nothing', 'like', 'it']);
		expect(nowLineFor(entry, at(40), facts({ mtimeOf: () => 7, linesOf }))).toBe(40);
	});

	it('带 key 的跳转靠自己的 anchor 重新定位，隔多远都行', () => {
		// The heading the jump was made to has moved down by fifty lines — further than
		// a text scan would ever look — and its own line is still authoritative.
		const entry = jump({ scroll: 40, anchor: '正文' }, 'outline:## Beta', 30);
		const got = nowLineFor(entry, at(40), facts({
			mtimeOf: () => 9,
			cacheFor: () => cache(['Beta', 80]),
		}));
		expect(got).toBe(90);
	});

	it('在笔记此刻的文本里重新找到 anchor 那一行', () => {
		const lines = Array.from({ length: 60 }, (_, i) => `第 ${i} 行`);
		lines[43] = 'the line that was there';
		const entry = jump({ scroll: 40, anchor: 'the line that was there' });
		expect(nowLineFor(entry, at(40), facts({
			mtimeOf: () => 9,
			linesOf: () => linesSource(lines),
		}))).toBe(43);
	});

	it('anchor 文本没了就沉默以对', () => {
		// The note was rewritten: nothing in it is the line the record names. A number
		// this module does not have is not a number it guesses at.
		const entry = jump({ scroll: 40, anchor: 'the line that was there' });
		expect(nowLineFor(entry, at(40), facts({
			mtimeOf: () => 9,
			linesOf: () => linesSource(Array.from({ length: 60 }, (_, i) => `第 ${i} 行`)),
		}))).toBeUndefined();
	});

	it('文件被改过、又没有 anchor 可依时，什么都不说', () => {
		// An old record, a file the clock says has been touched since: there is nothing
		// here that could re-find it, and a number known to have moved is not a number
		// worth handing to anything that opens the note.
		const entry = jump({ scroll: 40, mtime: 3 });
		expect(nowLineFor(entry, at(40), facts({ mtimeOf: () => 9 }))).toBeUndefined();
	});

	it('没有任何东西能重新定位时，就保留手上那个数字', () => {
		// No anchor, and no clock that says anything has changed: the recorded number is
		// the best thing anyone knows about the spot, and it is what the row prints.
		const entry = jump({ scroll: 40 });
		expect(nowLineFor(entry, at(40), facts())).toBe(40);
	});

	it('为一次悬停可以去读文件，为一次重画绝不可以', () => {
		// `prime` is the difference between one hover waiting one await and fifty rows
		// reading fifty files (see RecentFilesReads.linesFor).
		const seen: boolean[] = [];
		const entry = jump({ scroll: 40, anchor: 'the line that was there' });
		const lines = Array.from({ length: 60 }, (_, i) => `第 ${i} 行`);
		lines[41] = 'the line that was there';
		const linesOf = (_path: string, prime: boolean) => {
			seen.push(prime);
			return prime ? linesSource(lines) : undefined;
		};
		nowLineFor(entry, at(40), facts({ mtimeOf: () => 9, linesOf }));
		nowLineFor(entry, at(40), facts({ mtimeOf: () => 9, linesOf }), false);
		expect(seen).toEqual([true, false]);
	});

	it('视图根本没有行号可言', () => {
		const entry: NavEntry = { kind: 'view', viewType: 'graph', leafId: 'leaf-1', t: 0 };
		expect(nowLineFor(entry, { name: 'graph' }, facts())).toBeUndefined();
	});
});
