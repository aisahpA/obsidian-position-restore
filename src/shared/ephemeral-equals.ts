import { EphemeralState } from '@/types';

// Position-record comparison. Shared by two owners that must agree on what
// "the same position" means:
//  - the recorder (Sampler), for change detection against its baseline;
//  - the store (PositionStore), for deciding whether a leaf's record still
//    diverges from the file record.
// It lives in shared/ rather than in capture/ephemeral so the storage layer
// never has to import the capture layer for two pure functions.

// Cursor-only equality for callers that track cursor movement independently
// of scroll (e.g. the 100ms poll, whose baseline may carry a scroll field
// that must not participate in the comparison).
export function isCursorStatesEqual(
	state1?: EphemeralState['cursor'],
	state2?: EphemeralState['cursor']
): boolean {
	if (!!state1 !== !!state2) return false;
	if (!state1 || !state2) return true;
	return state1.from.ch === state2.from.ch && state1.from.line === state2.from.line &&
		state1.to.ch === state2.to.ch && state1.to.line === state2.to.line;
}

export function isEphemeralStatesEquals(state1: EphemeralState, state2: EphemeralState): boolean {
	const c1 = state1.cursor, c2 = state2.cursor;
	if (!isCursorStatesEqual(c1, c2)) return false;

	return state1.scroll === state2.scroll;
}
