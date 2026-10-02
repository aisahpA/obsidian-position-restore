"""验一批改动里**只有注释**变了 —— 中文化每一批落盘后都要跑一次。

判定按文件类型分流，因为两种注释的形态不一样：
- 行注释（`//`，本项目里的 .ts / .mjs）：走行启发式，见 comment_only_run。
- 块注释（`.css`）：CSS 的注释续行是纯散文、什么前缀都没有，行启发式认不出，
  会把一整块判成代码改动（styles.css 中文化时报过 1295 行假 FAIL）⇒ 改用
  **文件级**的「剥掉 `/* … */` 与字符串字面量后逐字节相等」。它比行启发式更严格：
  注释以外的每一个字节（含缩进、空行、换行）都要求一模一样。
  行内注释（`padding: 0; /* 说明 */`）也归这一路 —— 剥完剩下的就是代码。

用法：python3 scripts/check-comment-only.py <路径...>   # 不给路径就查 src
退出码 0 = 通过（改动全落在注释上）；1 = 发现疑似代码的改动。

比对的是 **HEAD 与工作区**（`git diff HEAD`）：改动 stage 与否都看得见，已 commit 的
改动不属于「这一批」、不在检查范围。
"""
import os
import subprocess
import sys
from collections import Counter

COMMENT_PREFIXES = ('//', '/*', '*', '*/')

# 走「剥块注释比对」的扩展名。全仓实测：.ts/.mjs 里零多行块注释（只有 `//`），
# 所以 CSS 是唯一需要这条路的面；将来若别的语言进仓，把扩展名加到这里即可。
BLOCK_COMMENT_EXTS = {'.css'}

# 整行注释以 `#` 开头的扩展名（shell / YAML）。2026-10-02 中文化 `reload.sh` 与
# `.github/workflows/release.yml` 时引入：它们的注释全是 `#`，而 `COMMENT_PREFIXES` 只认
# `//` 与 `/* */` ⇒ `#` 注释行会被当成代码改动judged FAIL，那两个文件只能改用
# 「剥掉纯注释行后逐行比对」自证。加进判据后它们走标准路径。
# ⚠️ `.json`（tsconfig.json 那种 JSONC）不在这里：它的注释是 `//`，走默认行启发式即可。
HASH_COMMENT_EXTS = {'.sh', '.yml', '.yaml'}


def is_comment(body: str, ext: str = '') -> bool:
	if body == '' or body.endswith('*/'):
		return True
	if body.startswith(('//', '/*', '*')):
		return True
	# `#` 注释只对 shell / YAML 认，且放过 shebang —— `#!/usr/bin/env bash` 是解释器指令，
	# 不是会被中文化的散文。
	if ext in HASH_COMMENT_EXTS and body.startswith('#') and not body.startswith('#!'):
		return True
	return False


def is_trailing_comment_change(old: str, new: str) -> bool:
	"""行尾注释：`code; // 说明` 这种。两行的**代码部分**（第一个 `//` 之前、去尾空格）必须逐字相同，
	否则我们就认不出这是「只改了注释」。代码部分的相同性同时挡住了字符串里的 `//`（URL 之类）——
	那种行一旦真的改动，前缀必然不同，会被判为代码改动。"""
	if '//' not in old or '//' not in new:
		return False
	return code_part(old) == code_part(new)


def code_part(line: str, ext: str = '') -> str:
	"""行尾注释之前的代码部分。分隔符按扩展名取：`//` 通用；shell / YAML 用 `#`。

	`#` 的定位规则（三条都要）：
	- **跳过引号内的 `#`** —— `echo "a#b" # 说明` 里那个 `a#b` 不是注释；
	- 前面**不是空白**（前面是空白时整行由 `is_comment` 放行，那是独占行的注释）；
	- 它后面跟点空白或行尾（`#说明` 不是一个 `#` 注释，更像路径/片段）。
	满足任一条就不切。"""
	if ext in HASH_COMMENT_EXTS:
		quote = ''
		for i, ch in enumerate(line):
			if quote:
				if ch == quote:
					quote = ''
				continue
			if ch in ('"', "'"):
				quote = ch
				continue
			if ch != '#':
				continue
			before = line[:i]
			if before.strip() == '' or not line[i + 1:].startswith((' ', '\t')) \
					and line[i + 1:] != '':
				continue
			return before.rstrip()
		return line
	return line.split('//', 1)[0].rstrip()


def comment_only_run(olds: list[str], news: list[str], ext: str = '') -> bool:
	"""一整组连续的 `-` 行后面跟一整组连续的 `+` 行。git diff 会把相邻改动并成一组，组内两边行数
	不一定相等（注释块重排会增减行）。

	**纯注释行整条跳过**，只比代码行 —— 这一条是关键：纯注释行的 `code_part` 是空串，
	空串也会进多重集，于是「一个正在缩短的块注释」（3 行 → 2 行）会把空串记成 3 个对 2 个而误判。
	真实的场景是块注释与**紧挨其下的行尾注释**被同一个 `-U0` hunk 并进一组
	（2026-10-02 译 `recent-files-browser-dom.test.ts` 时踩到，7 行假 FAIL）。
	跳过之后，纯注释的增删行数被忽略（那是本脚本要放行的那一面），行尾注释仍按其代码部分比对。"""
	code_olds = [o for o in olds if not is_comment(o.strip(), ext)]
	code_news = [n for n in news if not is_comment(n.strip(), ext)]
	return Counter(code_part(o, ext) for o in code_olds) == Counter(code_part(n, ext) for n in code_news)


def strip_block_comments(text: str) -> str:
	"""把 `/* … */` 剥掉，剩下的**代码部分**逐字节保留。

	两种注释分开处理：
	- **独占整行的注释**（行内除空白外只有注释，含跨行块）—— 连该行自己的缩进与换行
	  一起吞掉。译文长短与折行和英文不同，若把注释内部的换行也要求守恒，任何一次翻译
	  都过不去；而独占行的注释被整行吞掉，"这一行是注释"这件事本身就不会被误判成改动。
	- **行内注释**（`padding: 0; /* 说明 */`）—— 只吞注释本身，两侧的代码与空白原样留下。

	字符串字面量原样保留（连它们也要求不变）。不处理正则字面量：CSS 里没有，而这套
	判据只喂给 BLOCK_COMMENT_EXTS 里的文件。

	边界：**新增或删除一个注释块**会连带改变它前后的空行 ⇒ 判 FAIL。这不是误报，是判据
	的界线 —— 它守的是「除注释外一个字节都没动」，而增删注释块确实动了结构。翻译不改结构。"""
	out, i, n = [], 0, len(text)
	while i < n:
		if text.startswith('/*', i):
			j = text.find('*/', i + 2)
			if j == -1:
				raise ValueError('未闭合的块注释，位置 %d' % i)
			line_start = text.rfind('\n', 0, i) + 1
			end = text.find('\n', j + 2)
			line_end = n if end == -1 else end
			if text[line_start:i].strip() == '' and text[j + 2:line_end].strip() == '':
				# 独占行：连行首缩进（已经在 out 里了，弹掉）与行尾换行一起吞
				while out and out[-1] in (' ', '\t'):
					out.pop()
				i = min(line_end + 1, n)
				continue
			i = j + 2
			continue
		c = text[i]
		if c in ('"', "'"):
			j = i + 1
			while j < n:
				if text[j] == '\\':
					j += 2
					continue
				if text[j] == c:
					break
				j += 1
			out.append(text[i:j + 1])
			i = j + 1
			continue
		out.append(c)
		i += 1
	return ''.join(out)


def blob_at_head(path: str) -> str | None:
	"""HEAD 里的那份原文；文件不在 HEAD 里（本次新增）返回 None —— 新增文件没有
	「改动前」可比，本就无从证明，只能跳过并说明。"""
	r = subprocess.run(['git', 'show', 'HEAD:' + path], capture_output=True, text=True)
	return r.stdout if r.returncode == 0 else None


def check_block_file(path: str) -> tuple[bool | None, str, list[str]]:
	old = blob_at_head(path)
	if old is None:
		return None, '%s：不在 HEAD 里（新增文件），跳过' % path, []
	new = open(path, encoding='utf-8').read()
	so, sn = strip_block_comments(old), strip_block_comments(new)
	if so == sn:
		return True, ('ok: %s 的改动全落在块注释上（块数 %d -> %d，剥注释后 %d = %d 字节）'
			% (path, old.count('/*'), new.count('/*'), len(so), len(sn))), []
	k = 0
	while k < min(len(so), len(sn)) and so[k] == sn[k]:
		k += 1
	detail = [
		'  首个差异在第 %d 个字节（剥注释后长度 %d vs %d）' % (k, len(so), len(sn)),
		'  HEAD: %r' % so[max(0, k - 60):k + 80],
		'  现在: %r' % sn[max(0, k - 60):k + 80],
	]
	return False, 'FAIL: %s 的块注释之外还有别的改动' % path, detail


def check_line_file(path: str) -> tuple[bool, str, list[str]]:
	diff = subprocess.run(
		['git', 'diff', 'HEAD', '-U0', '--', path], capture_output=True, text=True, check=True,
	).stdout
	skips = ('+++', '---', '@@', 'diff ', 'index ', 'old mode', 'new mode',
		'new file', 'deleted file', 'similarity ', 'rename ', '\\ No newline')
	ext = os.path.splitext(path)[1].lower()
	bad: list[str] = []
	lines = diff.split('\n')
	i = 0
	while i < len(lines):
		line = lines[i]
		if line.startswith(skips):
			i += 1
			continue
		# 一整组连续的 `-` 行 + 紧跟的一整组连续的 `+` 行，交给成组判定。
		# 纯新增（只有 `+` 组、前面没有 `-` 组）也走这里 —— 否则「新增一行注释」会被
		# 上面那条逐行规则误判成代码改动。olds 为空时，comment_only_run 要求 `+` 组
		# 必须全是注释行，否则多重集不等。
		if line[:1] in ('-', '+'):
			olds, j = [], i
			while j < len(lines) and lines[j][:1] == '-':
				olds.append(lines[j][1:]); j += 1
			news = []
			while j < len(lines) and lines[j][:1] == '+':
				news.append(lines[j][1:]); j += 1
			if not comment_only_run(olds, news, ext):
				bad += ['-' + o for o in olds] + ['+' + n for n in news]
			i = j
			continue
		if not is_comment(line.strip(), ext):
			bad.append(line)
		i += 1
	if bad:
		return False, 'FAIL: %s 有 %d 行不像注释改动' % (path, len(bad)), bad
	return True, 'ok: %s 的改动全落在注释行上' % path, []


def main() -> int:
	targets = sys.argv[1:] or ['src']
	r = subprocess.run(
		['git', 'diff', 'HEAD', '--name-only', '--'] + targets,
		capture_output=True, text=True, check=True,
	)
	files = [f for f in r.stdout.split('\n') if f.strip()]
	if not files:
		print('ok: %s 没有改动' % ' '.join(targets))
		return 0
	bad: list[str] = []
	for path in files:
		if os.path.splitext(path)[1].lower() in BLOCK_COMMENT_EXTS:
			ok, note, detail = check_block_file(path)
		else:
			ok, note, detail = check_line_file(path)
		print(note)
		if ok is False:
			bad += detail
	if bad:
		print('FAIL: %d 行不像注释：' % len(bad))
		for line in bad[:20]:
			print('  ' + line[:120])
		return 1
	return 0


if __name__ == '__main__':
	raise SystemExit(main())
