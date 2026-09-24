import re, sys

path = sys.argv[1]
text = open(path, encoding="utf-8").read()

pat = re.compile(r"<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", re.S)

VER = re.compile(r'\s*"version"\s*:\s*"[^"]*",?\s*$')

def only_ver(s):
    lines = [l for l in s.split("\n") if l.strip() != ""]
    return bool(lines) and all(VER.match(l) for l in lines)

unresolvable = []

def repl(m):
    ours, theirs = m.group(1), m.group(2)
    if only_ver(ours) and only_ver(theirs):
        return theirs  # replayed commit's own bump
    unresolvable.append(m.group(0))
    return m.group(0)

new = pat.sub(repl, text)
if unresolvable:
    sys.stderr.write("UNRESOLVABLE %d hunk(s) in %s\n" % (len(unresolvable), path))
    for h in unresolvable:
        sys.stderr.write(h + "\n----\n")
    sys.exit(3)
open(path, "w", encoding="utf-8").write(new)
print("resolved version hunks:", path)
