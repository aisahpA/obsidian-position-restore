import { EphemeralState } from '@/types';

// 位置记录怎么比「同一个位置」，有两个主人必须口径一致：记录者（Sampler，判位置变没变）
// 与存储层（PositionStore，判某个标签页的记录是不是还在分叉）。放在 shared/ 是为了让存储层
// 不必为两个纯函数去依赖采集层。

// 给需要把光标位移与滚动分开跟踪的调用方用：100ms 轮询的基准值可能带着一个
// 不该参与比较的 scroll 字段。
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
