// The landing preview window: the line an entry lands on plus its neighbours, as
// plain records. The panel draws these; nothing here reads a file or touches the
// DOM.

// One line of the landing preview. num is the 1-based line number as shown.
export interface PreviewLine {
	num: number;
	text: string;
	mark: boolean;
}

// The landing line plus `radius` lines either side, clamped to the document.
// Pure: the caller supplies the file's already-split lines.
export function previewWindow(lines: string[], lineIndex: number, radius = 1): PreviewLine[] {
	if (lines.length === 0)
		return [];
	const first = Math.max(0, lineIndex - radius);
	const last = Math.min(lines.length - 1, lineIndex + radius);
	const out: PreviewLine[] = [];
	for (let i = first; i <= last; i++)
		out.push({ num: i + 1, text: lines[i], mark: i === lineIndex });
	return out;
}
