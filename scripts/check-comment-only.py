"""验一批改动里**只有注释行**变了 —— 中文化每一批落盘后都要跑一次。

用法：python3 scripts/check-comment-only.py <路径...>   # 不给路径就查 src
退出码 0 = 通过（改动全落在注释行上）；1 = 发现疑似代码行的改动。
"""
import subprocess
import sys
from collections import Counter

COMMENT_PREFIXES = ('//', '/*', '*', '*/')


def is_comment(body: str) -> bool:
	return body.startswith(COMMENT_PREFIXES) or body == '' or body.endswith('*/')


def is_trailing_comment_change(old: str, new: str) -> bool:
	"""行尾注释：`code; // 说明` 这种。两行的**代码部分**（第一个 `//` 之前、去尾空格）必须逐字相同，
	否则我们就认不出这是「只改了注释」。代码部分的相同性同时挡住了字符串里的 `//`（URL 之类）——
	那种行一旦真的改动，前缀必然不同，会被判为代码改动。"""
	if '//' not in old or '//' not in new:
		return False
	return code_part(old) == code_part(new)


def code_part(line: str) -> str:
	return line.split('//', 1)[0].rstrip()


def comment_only_run(olds: list[str], news: list[str]) -> bool:
	"""一整组连续的 `-` 行后面跟一整组连续的 `+` 行。git diff 会把相邻改动并成一组，组内两边行数
	不一定相等（注释块重排会增减行）。
	- 两边都全是纯注释行 ⇒ 通过。
	- 否则比较两边的**代码部分多重集**：相等即证明这些改动只落在 `//` 之后。行尾注释（`code; // 说明`）
	  就在这一类里，且天然挡住真正的代码改动（改名、增删、缩进变化都会让多重集不同）。"""
	if all(is_comment(o.strip()) for o in olds) and all(is_comment(n.strip()) for n in news):
		return True
	return Counter(code_part(o) for o in olds) == Counter(code_part(n) for n in news)


def main() -> int:
	targets = sys.argv[1:] or ['src']
	diff = subprocess.run(
		['git', 'diff', '-U0', '--'] + targets,
		capture_output=True, text=True, check=True,
	).stdout
	skips = ('+++', '---', '@@', 'diff ', 'index ', 'old mode', 'new mode')
	lines = diff.split('\n')
	bad = []
	i = 0
	while i < len(lines):
		line = lines[i]
		if line.startswith(skips):
			i += 1
			continue
		# 一整组连续的 `-` 行 + 紧跟的一整组连续的 `+` 行，交给成组判定
		if line[:1] == '-':
			olds, j = [], i
			while j < len(lines) and lines[j][:1] == '-':
				olds.append(lines[j][1:]); j += 1
			news = []
			while j < len(lines) and lines[j][:1] == '+':
				news.append(lines[j][1:]); j += 1
			if not comment_only_run(olds, news):
				bad += ['-' + o for o in olds] + ['+' + n for n in news]
			i = j
			continue
		if line[:1] == '+' or not is_comment(line[1:].strip()):
			bad.append(line)
		i += 1
	if bad:
		print(f'FAIL: {len(bad)} 行不像注释：')
		for line in bad[:20]:
			print('  ' + line[:120])
		return 1
	print(f'ok: {targets} 的改动全部落在注释行上')
	return 0


if __name__ == '__main__':
	raise SystemExit(main())
