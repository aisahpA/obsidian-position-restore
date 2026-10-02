"""验一批改动里**只有注释行**变了 —— 中文化每一批落盘后都要跑一次。

用法：python3 scripts/check-comment-only.py <路径...>   # 不给路径就查 src
退出码 0 = 通过（改动全落在注释行上）；1 = 发现疑似代码行的改动。
"""
import subprocess
import sys

COMMENT_PREFIXES = ('//', '/*', '*', '*/')


def is_comment(body: str) -> bool:
	return body.startswith(COMMENT_PREFIXES) or body == '' or body.endswith('*/')


def is_trailing_comment_change(old: str, new: str) -> bool:
	"""行尾注释：`code; // 说明` 这种。两行的**代码部分**（第一个 `//` 之前、去尾空格）必须逐字相同，
	否则我们就认不出这是「只改了注释」。代码部分的相同性同时挡住了字符串里的 `//`（URL 之类）——
	那种行一旦真的改动，前缀必然不同，会被判为代码改动。"""
	if '//' not in old or '//' not in new:
		return False
	return old.split('//', 1)[0].rstrip() == new.split('//', 1)[0].rstrip()


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
		# 改动行成对出现（`-old` 紧跟 `+new`）时，交给行尾注释的判定
		if line[:1] == '-' and i + 1 < len(lines) and lines[i + 1][:1] == '+':
			old, new = line[1:], lines[i + 1][1:]
			if not (is_comment(old.strip()) and is_comment(new.strip())
					or is_trailing_comment_change(old, new)):
				bad += [line, lines[i + 1]]
			i += 2
			continue
		if line[:1] in ('-', '+') and not is_comment(line[1:].strip()):
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
