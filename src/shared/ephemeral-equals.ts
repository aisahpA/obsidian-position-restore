import { EphemeralState } from '@/types';

// Position-record comparison, shared by two owners that must agree on what
// "the same position" means: the recorder (Sampler, change detection) and the
// store (PositionStore, whether a leaf's record still diverges). It lives in
// shared/ so the storage layer never imports the capture layer for two pure
// functions.

// For callers tracking cursor movement independently of scroll (the 100ms
// poll's baseline may carry a scroll field that must not participate).
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
