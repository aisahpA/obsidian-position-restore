// Tests for the history browser's row description (nav-history-modal.ts):
// the pure describeNavEntry — jump type from the entry key, and the landing
// line + its own text (edit → cursor line and cursorAnchor; reading →
// viewport top line and anchor; the recorded mode disambiguates a stale
// pre-preview cursor). The viewport text must never be shown for a cursor
// line it does not belong to.

import { describe, it, expect } from 'vitest';

import { describeNavEntry } from '../src/nav-history-modal';
import { t } from '../src/i18n';
import { NavHistoryEntry } from '../src/nav-history';

const hasFile = () => true;
const line = (n: number) => ({ from: { line: n, ch: 0 }, to: { line: n, ch: 0 } });

describe('describeNavEntry', () => {
	it('a file entry shows its basename and the key-derived jump type', () => {
		const d = describeNavEntry({ path: 'notes/project/a.md', leafId: 'leaf-1' } as NavHistoryEntry, hasFile);
		expect(d.file).toBe('a.md');
		expect(d.title).toBe('notes/project/a.md');
		expect(d.type).toBe(t('navTypeOpen'));
		expect(d.line).toBeUndefined();
		expect(d.missing).toBe(false);
	});

	it('an edit capture shows the cursor line and the cursor line text', () => {
		const edit = describeNavEntry({
			path: 'a.md', leafId: 'leaf-1', key: 'teleport:41',
			st: { scroll: 42, mode: 'source', cursor: line(99), anchor: 'viewport top', cursorAnchor: 'cursor line' },
		} as NavHistoryEntry, hasFile);
		expect(edit.type).toBe(t('navTypeTeleport'));
		expect(edit.line).toBe('L100');
		expect(edit.anchor).toBe('cursor line');
	});

	it('an edit capture without cursorAnchor (legacy entry, blank line) shows no text', () => {
		// The viewport-top anchor belongs to another line — showing it next
		// to the cursor line number would misdescribe the landing.
		const edit = describeNavEntry({
			path: 'a.md', leafId: 'leaf-1', key: 'teleport:41',
			st: { scroll: 42, mode: 'source', cursor: line(99), anchor: 'viewport top' },
		} as NavHistoryEntry, hasFile);
		expect(edit.line).toBe('L100');
		expect(edit.anchor).toBeUndefined();
	});

	it('a reading capture shows the viewport top line and its anchor', () => {
		// the stale pre-preview cursor is ignored
		const read = describeNavEntry({
			path: 'a.md', leafId: 'leaf-1',
			st: { scroll: 41, mode: 'preview', cursor: line(3), anchor: 'viewport top' },
		} as NavHistoryEntry, hasFile);
		expect(read.type).toBe(t('navTypeOpen'));
		expect(read.line).toBe('L42');
		expect(read.anchor).toBe('viewport top');
	});

	it('a cursorless edit capture shows the viewport line and its anchor', () => {
		const d = describeNavEntry({
			path: 'a.md', leafId: 'leaf-1',
			st: { scroll: 41, mode: 'source', anchor: 'viewport top' },
		} as NavHistoryEntry, hasFile);
		expect(d.line).toBe('L42');
		expect(d.anchor).toBe('viewport top');
	});

	it('a pre-upgrade entry (no mode) falls back to cursor-first', () => {
		const d = describeNavEntry({
			path: 'a.md', leafId: 'leaf-1', key: 'teleport:41',
			st: { scroll: 42, cursor: line(99) },
		} as NavHistoryEntry, hasFile);
		expect(d.line).toBe('L100');
		expect(d.anchor).toBeUndefined();
	});

	it('outline and anchor keys label their types; a pathless entry is the graph', () => {
		const outline = describeNavEntry({ path: 'a.md', leafId: 'leaf-1', key: 'outline:第一章' } as NavHistoryEntry, hasFile);
		expect(outline.type).toBe(t('navTypeOutline'));
		const link = describeNavEntry({ path: 'a.md', leafId: 'leaf-1', key: 'b.md#标题' } as NavHistoryEntry, hasFile);
		expect(link.type).toBe(t('navTypeLink'));
		const graph = describeNavEntry({ viewType: 'graph', leafId: 'leaf-1' } as NavHistoryEntry, hasFile);
		expect(graph.type).toBe(t('navTypeGraph'));
		expect(graph.file).toBe(t('navGraphName'));
		expect(graph.line).toBeUndefined();
	});

	it('a path that no longer resolves is marked missing', () => {
		const d = describeNavEntry({ path: 'gone.md', leafId: 'leaf-1' } as NavHistoryEntry, () => false);
		expect(d.missing).toBe(true);
	});
});
