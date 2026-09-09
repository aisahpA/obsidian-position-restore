import { App, Modal, TFile } from 'obsidian';
import { NavHistory, NavHistoryEntry } from './nav-history';
import { t } from './i18n';

// One row's display pieces, derived from the entry. Pure (the vault lookup
// comes in as a predicate) so the history browser's labels are testable
// without a DOM.
export interface NavEntryDescription {
	file: string;
	title: string;
	type: string;
	line?: string;
	anchor?: string;
	missing: boolean;
}

// The row shows the line the restore lands on plus THAT line's text: a
// reading capture lands on the viewport top line (its remap anchor), an edit
// capture lands on the cursor line (its cursorAnchor — never the viewport
// top text, a different line; missing for blank cursor lines and legacy
// entries). An edit capture whose cursor sat OUTSIDE the viewport
// (cursorOffscreen — source-mode scrolling leaves the cursor behind) falls
// back to the viewport top line + anchor: the restore lands on the viewport,
// so that is where the user actually was. Line number semantics by capture
// mode (see NavEntryState.mode): a reading capture carries the editor's
// stale pre-preview cursor, so only the recorded mode disambiguates —
// pre-upgrade entries (no mode) fall back to the cursor-first heuristic.
export function describeNavEntry(
	entry: NavHistoryEntry,
	hasFile: (path: string) => boolean,
): NavEntryDescription {
	if (!entry.path) {
		return {
			file: t('navGraphName'),
			title: entry.viewType ?? '',
			type: t('navTypeGraph'),
			missing: false,
		};
	}
	let type = t('navTypeOpen');
	if (entry.key?.startsWith('teleport:'))
		type = t('navTypeTeleport');
	else if (entry.key?.startsWith('outline:'))
		type = t('navTypeOutline');
	else if (entry.key)
		type = t('navTypeLink');
	const st = entry.st;
	let n: number | undefined;
	let anchor: string | undefined;
	if (st) {
		if (st.mode === 'preview') {
			n = st.scroll;
			anchor = st.anchor;
		} else if (st.cursor && !st.cursorOffscreen) {
			n = st.cursor.from.line;
			anchor = st.cursorAnchor;
		} else {
			n = st.scroll;
			anchor = st.anchor;
		}
	}
	return {
		file: entry.path.split('/').pop() ?? entry.path,
		title: entry.path,
		type,
		line: n !== undefined ? `L${n + 1}` : undefined,
		anchor,
		missing: !hasFile(entry.path),
	};
}

// "Browse navigation history" modal: the stack newest-first, the current
// entry highlighted, click a row to time-travel to it (NavHistory.jumpTo —
// the jump branches from the current entry: the row is re-pushed on top, so
// back returns to where you were).
export class NavHistoryModal extends Modal {
	private rows: HTMLElement[] = [];
	private selected = -1;

	constructor(app: App, private nav: NavHistory) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('position-restore-nav-modal');
		this.titleEl.setText(t('navHistoryName'));
		this.contentEl.empty();
		if (this.nav.entries.length === 0) {
			this.contentEl.createDiv({
				text: t('navHistoryEmpty'),
				cls: 'setting-item-description',
			});
			return;
		}
		this.header();
		this.rows = [];
		for (let i = this.nav.entries.length - 1; i >= 0; i--)
			this.rows[i] = this.row(i);
		this.select(this.nav.index);
		// Arrows move the selection, Enter jumps. The modal scope is only
		// live while open; not returning false lets Obsidian preventDefault
		// so the list doesn't scroll under the keys. Rows render newest-
		// first (high stack index on top), so visual down = stack index -1.
		this.scope.register([], 'ArrowDown', () => this.move(-1));
		this.scope.register([], 'ArrowUp', () => this.move(1));
		this.scope.register([], 'Enter', () => {
			if (this.selected >= 0) this.jump(this.selected);
		});
	}

	// Column labels above the list; shares the row grid so tracks align.
	private header(): void {
		const head = this.contentEl.createDiv({ cls: 'position-restore-nav-head' });
		head.createSpan({ text: t('navColFile') });
		head.createSpan({ text: t('navColPos') });
		head.createSpan({ text: t('navColType'), cls: 'nav-row-badge' });
	}

	private move(d: number): void {
		const n = this.nav.entries.length;
		this.select((this.selected + d + n) % n);
	}

	private select(i: number): void {
		this.rows[this.selected]?.removeClass('is-selected');
		this.selected = i;
		this.rows[i]?.addClass('is-selected');
		this.rows[i]?.scrollIntoView({ block: 'nearest' });
	}

	private jump(i: number): void {
		this.close();
		void this.nav.jumpTo(i)
			.catch(e => console.error('Position Restore: history jump failed:', e));
	}

	private row(i: number): HTMLElement {
		const entry = this.nav.entries[i];
		const d = describeNavEntry(entry,
			(p) => this.app.vault.getAbstractFileByPath(p) instanceof TFile);
		const isCurrent = i === this.nav.index;

		const row = this.contentEl.createDiv({ cls: 'position-restore-nav-row' });
		if (isCurrent)
			row.addClass('is-current');
		row.addEventListener('click', () => this.jump(i));

		// One fixed 3-track grid per row; every cell is emitted (empty when
		// unused) so the columns align across rows. Missing replaces the
		// jump-type badge (the file is gone either way). The current row is
		// marked by an inset accent bar (CSS) — no arrow, no marker column.
		row.createSpan({
			text: d.file,
			cls: 'nav-row-file',
			attr: { title: d.title },
		});
		const pos = row.createDiv({ cls: 'nav-row-pos' });
		if (d.line)
			pos.createSpan({ text: d.line, cls: 'nav-row-line' });
		if (d.anchor)
			pos.createSpan({
				text: `“${d.anchor}”`,
				cls: 'nav-row-anchor',
				attr: { title: `${t('navAnchorTip')}\n${d.anchor}` },
			});
		row.createSpan({
			text: d.missing ? t('navMissing') : d.type,
			cls: `nav-row-badge${d.missing ? ' nav-row-missing' : ''}`,
		});
		return row;
	}
}
