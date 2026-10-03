"""查 `docs/**/*.md` 里引的源码行号还准不准 —— 这条一动就坏： README 中文数仓正文里
到处是 `src/foo.ts:123` 这种引用，代码一改行号就漂，而文档本身没有任何东西会报错。

做什么：
    1. 扫 `docs/` 下所有 .md，找出形如 `<路径>.ts:<行号>`（可带 `-<行号>`）的引用；
    2. 路径存在性 / 行号是否越界；
    3. 把被引用的那一行**原样打出来**，让人（或 AI）一眼看出「引的还是不是它想说的地方」
       —— 这一条比「越界」更重要：行号没越界但指向隔壁注释，也算坏了。

用法：
    python3 scripts/check-doc-refs.py            # 查全部
    python3 scripts/check-doc-refs.py docs/code-tour/00-改前必读.md

退出码 0 = 全部命中且在文件范围内；1 = 有引用缺失或越界（adjacent 不算）。
"""
import pathlib
import re
import sys

# `src/foo/bar.ts:123` 或 `src/foo/bar.ts:123-456`；允许被引号/括号/中文标点包住。
REF = re.compile(r'((?:src|tests|scripts|docs)/[\w./-]+\.(?:ts|mjs|js|css|py|sh|yml)):(\d+)(?:-(\d+))?')


def scan(path: pathlib.Path) -> tuple[list[str], list[tuple[str, int, str]]]:
    problems: list[str] = []
    shown: list[tuple[str, int, str]] = []
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        for m in REF.finditer(line):
            ref, start, end = m.group(1), int(m.group(2)), m.group(3)
            target = pathlib.Path(ref)
            if not target.exists():
                problems.append(f'{path}:{lineno}  {ref}  文件不存在')
                continue
            lines = target.read_text().splitlines()
            last = int(end) if end else start
            if start > len(lines) or last > len(lines):
                problems.append(
                    f'{path}:{lineno}  {ref}:{start}{"-" + end if end else ""}  越界（该文件只有 {len(lines)} 行）')
                continue
            body = lines[start - 1].strip()
            shown.append((f'{ref}:{start}{"-" + end if end else ""}', lineno, body))
    return problems, shown


def main() -> int:
    targets = ([pathlib.Path(a) for a in sys.argv[1:]]
               or sorted(pathlib.Path('docs').rglob('*.md')))
    problems: list[str] = []
    for path in targets:
        problems_here, shown = scan(path)
        problems += problems_here
        if shown:
            print(f'\n=== {path} ({len(shown)} 处引用)')
            for ref, lineno, body in shown:
                print(f'  L{lineno:<4} {ref:<45} -> {body[:90]}')
    if problems:
        print('\n❌ 坏引用：')
        for p in problems:
            print('  ' + p)
        return 1
    print('\n✅ 引用全部命中且在范围内 —— 但「指向的那一句是否还是它想说的地方」要你亲眼过一遍。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
