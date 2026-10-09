"""查 `docs/**/*.md` 里引的源码行号还准不准 —— 这条一动就坏：文档里
到处是指向源码的链接（[`符号`](/src/foo.ts#L123)），代码一改行号就漂，
而文档本身没有任何东西会报错。

查三类问题：
    1. 链接目标文件不存在、`#L行号` 越界；
    2. 链接文字是符号名（`foo()` / `CONSTANT` / `class Foo`）时，
       该符号在目标文件里的定义行与链接行号对不上 —— 报「应为 #Lxxx」；
       只有**唯一定义行**才下判语：同名定义多处且无法判定时只打印不判错，
       宁可漏报不可误报；
    3. 旧写法（反引号包着的 `foo.ts:123` / `:123` / `foo:123`）一律报坏，
       逼它迁成可 cmd+click 的链接。

不管查得多严，最后都会把被引那一行**原样打出来**：行号没越界但指向隔壁
注释，机器看不出来，必须人（或 AI）亲眼过一遍。

用法：
    python3 scripts/check-doc-refs.py            # 查全部
    python3 scripts/check-doc-refs.py docs/code-tour/00-改前必读.md
    python3 scripts/check-doc-refs.py --fix      # 唯一定义行的漂移直接改文档

退出码 0 = 没有越界 / 缺失 / 旧写法 / 已坐实的漂移；1 = 有问题（--fix 改完
后请重跑一遍确认）。
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# 可点击链接：[`任意文字`](根路径或相对路径#L行号)。锚点只认 #L数字这一种。
LINK = re.compile(r'\[([^\]]*)\]\(([^)#]+)(?:#L(\d+))?\)')
# 旧写法：`path:line` | `:line` | `symbol:line`（可带范围）
LEGACY = re.compile(r'`((?:[\w./-]+\.ts|[A-Za-z_$][\w$]*)?):(\d+)(?:-\d+)?`')
# 链接文字是「文件:行号」标签（无锚点链接），这种不做符号核对
FILELABEL = re.compile(r'^[\w.-]+\.ts:\d+$')
# 链接文字里提符号：`foo()` / `class Foo` / `CONSTANT = 2000` 都收末尾标识符
IDENT_TAIL = re.compile(r'[A-Za-z_$][\w$]*$')
IDENT_HEAD = re.compile(r'^[A-Za-z_$][\w$]*')
KEYWORDS = {'class', 'interface', 'type', 'const', 'let', 'var', 'function',
            'enum', 'readonly', 'abstract', 'public', 'private', 'protected',
            'static', 'async', 'get', 'set', 'override', 'default', 'export',
            'new', 'return', 'if', 'for', 'while'}

# 围栏标记行
FENCE = re.compile(r'^\s*```')


def sample_spans(line: str) -> list[tuple[int, int]]:
    """返回「语法示例」区间：**只收双反引号及以上**的行内代码 span。

    单反引号 span 绝不能屏蔽 —— 旧写法（`foo.ts:1`）和链接 label（[`foo`](…)）
    都住在里面，它们正是检查对象。会自我举报的只有讲语法时写的整段示例
    （`` [`x`](/src/foo.ts#L1) ``），那种必须用双反引号包，落到这里被排除。
    markdown 规则：开闭引号必须是**同样数目**的反引号。
    """
    spans: list[tuple[int, int]] = []
    i = 0
    while i < len(line):
        if line[i] != '`':
            i += 1
            continue
        j = i
        while j < len(line) and line[j] == '`':
            j += 1
        n = j - i
        close = line.find('`' * n, j)
        if close == -1:
            break
        if n >= 2:
            spans.append((i, close + n))
        i = close + n
    return spans


def label_symbol(label: str) -> str | None:
    """链接文字 -> 可查定义的符号名。提不出来（纯中文 / 多词短语）就返回 None。

    `foo()`->foo；`class Foo`->Foo；`INTENT_WINDOW_MS = 2000`->INTENT_WINDOW_MS；
    `foo/bar` / `foo-bar` 这类含路径字符的不当符号。
    """
    label = label.strip().strip('`')
    if FILELABEL.match(label):
        return None
    if '/' in label or '-' in label or '#' in label:
        return None
    # 去掉调用括号与形参：`foo(a, b)` -> `foo`
    m = IDENT_HEAD.match(label)
    if m and '(' in label:
        head = m.group(0)
        return head if head not in KEYWORDS else None
    # 形如「修饰符 标识符」或「标识符 = 值」：取末尾标识符
    tokens = re.findall(r'[A-Za-z_$][\w$]*', label)
    if not tokens:
        return None
    tail = tokens[-1]
    if tail in KEYWORDS:
        return None
    # 纯单词（如 visit）才算；多词短语（read sampled state）不核对
    return tail if len(tokens) == 1 or m else None


def def_lines(path: pathlib.Path, symbol: str) -> list[int]:
    """符号在目标文件里的「定义行」候选。宽松打分，只用于唯一定论。

    认四种形态：class/function/const 等关键字声明、类方法、const/let 箭头
    函数、行首对象方法简写；对象字面量里的 `name: (...)` 是转发行不是定义
    （冒号形态不匹配）。
    """
    text = path.read_text().splitlines()
    hits: list[int] = []
    pat_call = re.compile(rf'(?<![\w$.]){re.escape(symbol)}\s*(?:<[^>]*>)?\(')
    pat_kw = re.compile(
        rf'^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?'
        rf'(?:class|function|interface|type|enum|const|let|var)\s+{re.escape(symbol)}\b')
    pat_method = re.compile(
        rf'^\s*(?:@\w+(?:\([^)]*\))?\s*)*'
        rf'(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*'
        rf'{re.escape(symbol)}\s*(?:<[^>]*>)?\(')
    pat_arrow = re.compile(
        rf'^\s*(?:export\s+)?'
        rf'(?:(?:(?:public|private|protected|static|readonly|abstract|override)\s+)+'
        rf'|const\s+|let\s+|var\s+)'
        rf'{re.escape(symbol)}\b[^=;]*=')
    pat_shorthand = re.compile(rf'^{re.escape(symbol)}\s*(?:<[^>]*>)?\(')
    for i, line in enumerate(text, 1):
        if pat_kw.match(line) or pat_arrow.match(line) or pat_method.match(line):
            hits.append(i)
            continue
        stripped = line.lstrip()
        if (pat_shorthand.match(stripped) and pat_call.search(line)
                and not re.search(rf'\.{re.escape(symbol)}\s*\(', line)):
            hits.append(i)
    return hits


def resolve_link(doc: pathlib.Path, url_path: str) -> pathlib.Path | None:
    """链接路径 -> 仓库内文件。只认工作区根路径（/src/...）或相对路径。"""
    if url_path.startswith('/'):
        target = (ROOT / url_path.lstrip('/')).resolve()
    elif url_path.startswith(('.', '..')):
        target = (doc.parent / url_path).resolve()
    else:
        return None
    # 不许借链接翻出仓库
    if not str(target).startswith(str(ROOT)):
        return None
    return target


def scan(doc: pathlib.Path):
    """返回 (problems, drifts, shown)。
    problems：越界/缺失/旧写法（硬错）；drifts：符号漂移，可 --fix；
    shown：每处引用的目标行原文，打印出来供人肉核对语义。
    """
    problems, drifts, shown = [], [], []
    in_fence = False
    for lineno, raw in enumerate(doc.read_text().splitlines(), 1):
        if FENCE.match(raw):
            in_fence = not in_fence
            continue
        # 双反引号包着的语法示例（`` [`x`](…) ``）不算引用
        samples = sample_spans(raw)
        in_sample = lambda pos: any(a <= pos < b for a, b in samples)
        # 旧写法只在围栏外报：代码块里的 foo.ts:1 是合法文本。
        if not in_fence:
            for m in LEGACY.finditer(raw):
                if in_sample(m.start()):
                    continue
                # 链接文字（紧跟 `[` 之后）不算旧写法 —— 那是 LINK 要查的对象
                if raw[max(0, m.start() - 1):m.start()] == '[':
                    continue
                problems.append(
                    f'{doc.relative_to(ROOT)}:{lineno}  旧写法 `{m.group(0).strip("`")}`，'
                    f'迁成可点击链接，形如 [`名`](/src/…#L行号)')
        # 链接不分围栏：ASCII 图里的链接也是真引用（如 04 的 registerDbFlush）
        for m in LINK.finditer(raw):
            if in_sample(m.start()):
                continue
            label, url_path, anchor = m.group(1).strip(), m.group(2).strip(), m.group(3)
            target = resolve_link(doc, url_path)
            if target is None:
                problems.append(
                    f'{doc.relative_to(ROOT)}:{lineno}  {url_path}  路径无法解析'
                    f'（只认 / 根路径或 ./ ../ 相对路径）')
                continue
            if not target.exists():
                problems.append(
                    f'{doc.relative_to(ROOT)}:{lineno}  {url_path}  文件不存在')
                continue
            if not anchor:
                continue  # 无行号锚点（普通文档互链之类），不查
            line_no = int(anchor)
            src_lines = target.read_text().splitlines()
            if line_no > len(src_lines):
                problems.append(
                    f'{doc.relative_to(ROOT)}:{lineno}  {url_path}#L{line_no}  '
                    f'越界（该文件只有 {len(src_lines)} 行）')
                continue
            body = src_lines[line_no - 1].strip()
            shown.append((lineno, url_path, line_no, body))
            sym = label_symbol(label)
            if not sym:
                continue
            cands = def_lines(target, sym)
            rel = target.relative_to(ROOT)
            if len(cands) == 1 and cands[0] != line_no:
                drifts.append((doc, lineno, m, rel, line_no, cands[0], sym, body))
            # 多候选且当前行不在其中：机器判不了，交给 printed 的人肉核对
    return problems, drifts, shown


def main() -> int:
    args = sys.argv[1:]
    fix = '--fix' in args
    args = [a for a in args if a != '--fix']
    # 命令行给的是相对路径，统一 resolve 成绝对路径，后面 relative_to(ROOT) 才成立
    targets = ([pathlib.Path(a).resolve() for a in args]
               or sorted((ROOT / 'docs').rglob('*.md')))

    problems, shown_total = [], 0
    drift_records = []
    for doc in targets:
        p, drifts, shown = scan(doc)
        problems += p
        drift_records += drifts
        shown_total += len(shown)
        if shown:
            print(f'\n=== {doc.relative_to(ROOT)} ({len(shown)} 处引用)')
            for lineno, url_path, line_no, body in shown:
                print(f'  L{lineno:<4} {url_path}#L{line_no:<4} -> {body[:90]}')

    # 符号漂移：--fix 直接改，否则当硬错报（CI 要拦行号漂移）
    if fix:
        by_doc: dict[pathlib.Path, list] = {}
        for doc, lineno, m, rel, old_line, new_line, sym, body in drift_records:
            by_doc.setdefault(doc, []).append((old_line, new_line, sym, rel))
        for doc, fixes in by_doc.items():
            text = doc.read_text()
            for old_line, new_line, sym, rel in fixes:
                # 必须带目标路径替换：两个不同文件的链接可能恰好同旧行号
                old = f'{rel}#L{old_line}'
                text = text.replace(old, f'{rel}#L{new_line}')
            doc.write_text(text)
            print(f'🔧 {doc.relative_to(ROOT)}: 修正 {len(fixes)} 处行号 '
                  f'（{", ".join(sorted({s for _, _, s, _ in fixes}))}）')
    elif drift_records:
        print('\n❌ 符号定义行已漂移（链接文字是符号名，定义在唯一一行）：')
        for doc, lineno, m, rel, old_line, new_line, sym, body in drift_records:
            print(f'  {doc.relative_to(ROOT)}:{lineno}  {sym}  '
                  f'{rel}#L{old_line} -> 应为 #L{new_line}')

    if problems:
        print('\n❌ 坏引用：')
        for p in problems:
            print('  ' + p)

    if not problems and not drift_records:
        print(f'\n✅ {shown_total} 处引用全部命中且在范围内、符号行号对得上 '
              f'—— 但「指向的那一句是否还是它想说的」仍要亲眼过一遍上面打印的原文。')
        return 0
    if fix and not problems:
        print('\n🔧 已按唯一定义行刷新行号，请重跑一遍确认。')
        return 0
    return 1


if __name__ == '__main__':
    sys.exit(main())
