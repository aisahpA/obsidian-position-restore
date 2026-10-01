"""验一批改动里**只有注释行**变了 —— 中文化每一批落盘后都要跑一次。

用法：python3 scripts/check-comment-only.py <路径...>   # 不给路径就查 src
退出码 0 = 通过（改动全落在注释行上）；1 = 发现疑似代码行的改动。
"""
import subprocess
import sys

COMMENT_PREFIXES = ('//', '/*', '*', '*/')


def is_comment(body: str) -> bool:
	return body.startswith(COMMENT_PREFIXES) or body == '' or body.endswith('*/')


def main() -> int:
	targets = sys.argv[1:] or ['src']
	diff = subprocess.run(
		['git', 'diff', '-U0', '--'] + targets,
		capture_output=True, text=True, check=True,
	).stdout
	bad = []
	for line in diff.split('\n'):
		if line.startswith(('+++', '---', '@@', 'diff ', 'index ', 'old mode', 'new mode')):
			continue
		if line[:1] in ('-', '+'):
			body = line[1:].strip()
			if not is_comment(body):
				bad.append(line)
	if bad:
		print(f'FAIL: {len(bad)} 行不像注释：')
		for line in bad[:20]:
			print('  ' + line[:120])
		return 1
	print(f'ok: {targets} 的改动全部落在注释行上')
	return 0


if __name__ == '__main__':
	raise SystemExit(main())
