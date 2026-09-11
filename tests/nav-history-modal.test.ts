// Tests for the history browser's row description (nav-history-modal.ts):
// the pure describeNavEntry — jump type from the entry key, and the landing
// line + its own text (edit → cursor line and cursorAnchor; reading →
// viewport top line and anchor; the recorded mode disambiguates a stale
// pre-preview cursor). The viewport text must never be shown for a cursor
// line it does not belong to.

import { describe, it, expect } from 'vitest';

import { describeNavEntry } from '../src/nav-history-modal';
import { t } from '../src/i18n';
import { NavHistoryEntry } from '../src/nav-entry';

const hasFile = () => true;
const line = (n: number) => ({ from: { line: n, ch: 0 }, to: { line: n, ch: 0 } });

describe('describeNavEntry', () => {
	it('a file entry shows its basename and the key-derived jump type', () => {
		const d = describeNavEntry({ kind: 'visit', path: 'notes/project/a.md', leafId: 'leaf-1' } as NavHistoryEntry, hasFile);
		expect(d.file).toBe('a.md');
		expect(d.title).toBe('notes/project/a.md');
		expect(d.type).toBe(t('navHistory.type.open'));
		expect(d.line).toBeUndefined();
		expect(d.missing).toBe(false);
	});

	it('a tab-switch visit (via: switch) gets its own badge', () => {
		const d = describeNavEntry({ kind: 'visit', path: 'a.md', leafId: 'leaf-1', via: 'switch' } as NavHistoryEntry, hasFile);
		expect(d.type).toBe(t('navHistory.type.switch'));
	});

	it('an edit capture shows the cursor line and the cursor line text', () => {
		const edit = describeNavEntry({
			kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 41,
			st: { scroll: 42, mode: 'source', cursor: line(99), anchor: 'viewport top', cursorAnchor: 'cursor line' },
		} as NavHistoryEntry, hasFile);
		expect(edit.type).toBe(t('navHistory.type.teleport'));
		expect(edit.line).toBe('L100');
		expect(edit.anchor).toBe('cursor line');
		expect(edit.soft).toBe(true);
	});

	it('an edit capture without cursorAnchor (legacy entry, blank line) shows no text', () => {
		// The viewport-top anchor belongs to another line — showing it next
		// to the cursor line number would misdescribe the landing.
		const edit = describeNavEntry({
			kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 41,
			st: { scroll: 42, mode: 'source', cursor: line(99), anchor: 'viewport top' },
		} as NavHistoryEntry, hasFile);
		expect(edit.line).toBe('L100');
		expect(edit.anchor).toBeUndefined();
	});

	it('a teleport whose landing never settled falls back to the recorded target line', () => {
		const d = describeNavEntry({
			kind: 'teleport', path: 'a.md', leafId: 'leaf-1', line: 41,
		} as NavHistoryEntry, hasFile);
		expect(d.type).toBe(t('navHistory.type.teleport'));
		expect(d.line).toBe('L42');
	});

	it('a reading capture shows the viewport top line and its anchor', () => {
		// the stale pre-preview cursor is ignored
		const read = describeNavEntry({
			kind: 'visit', path: 'a.md', leafId: 'leaf-1',
			st: { scroll: 41, mode: 'preview', cursor: line(3), anchor: 'viewport top' },
		} as NavHistoryEntry, hasFile);
		expect(read.type).toBe(t('navHistory.type.open'));
		expect(read.line).toBe('L42');
		expect(read.anchor).toBe('viewport top');
	});

	it('a cursorless edit capture shows the viewport line and its anchor', () => {
		const d = describeNavEntry({
			kind: 'visit', path: 'a.md', leafId: 'leaf-1',
			st: { scroll: 41, mode: 'source', anchor: 'viewport top' },
		} as NavHistoryEntry, hasFile);
		expect(d.line).toBe('L42');
		expect(d.anchor).toBe('viewport top');
	});

	it('a pre-upgrade entry (no mode) falls back to cursor-first', () => {
		const d = describeNavEntry({
			kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'b.md#标题',
			st: { scroll: 42, cursor: line(99) },
		} as NavHistoryEntry, hasFile);
		expect(d.line).toBe('L100');
		expect(d.anchor).toBeUndefined();
	});

	it('an off-screen cursor capture falls back to the viewport line and anchor', () => {
		// Source-mode scrolling left the cursor behind (cursorOffscreen): the
		// restore lands on the viewport, so the row describes the viewport,
		// never the invisible cursor line.
		const d = describeNavEntry({
			kind: 'visit', path: 'a.md', leafId: 'leaf-1',
			st: { scroll: 499, mode: 'source', cursor: line(100), anchor: 'viewport top', cursorAnchor: 'cursor line', cursorOffscreen: true },
		} as NavHistoryEntry, hasFile);
		expect(d.line).toBe('L500');
		expect(d.anchor).toBe('viewport top');
	});

	it('outline and anchor keys label their types; a pathless entry is the graph', () => {
		const outline = describeNavEntry({ kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'outline:第一章' } as NavHistoryEntry, hasFile);
		expect(outline.type).toBe(t('navHistory.type.outline'));
		const link = describeNavEntry({ kind: 'jump', path: 'a.md', leafId: 'leaf-1', key: 'b.md#标题' } as NavHistoryEntry, hasFile);
		expect(link.type).toBe(t('navHistory.type.link'));
		const graph = describeNavEntry({ kind: 'view', viewType: 'graph', leafId: 'leaf-1' } as NavHistoryEntry, hasFile);
		expect(graph.type).toBe(t('navHistory.type.graph'));
		expect(graph.file).toBe(t('navHistory.graphView'));
		expect(graph.line).toBeUndefined();
	});

	it('a path that no longer resolves is marked missing', () => {
		const d = describeNavEntry({ kind: 'visit', path: 'gone.md', leafId: 'leaf-1' } as NavHistoryEntry, () => false);
		expect(d.missing).toBe(true);
	});
});
