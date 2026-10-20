#!/bin/bash
# mutation-check.sh — 变异测试：验证 unit-orphan-reap.mjs 真的会红
#
# 为什么需要这个脚本：2026-10-21 复核查出测试套件有两代"哑巴"问题：
#   第一代：6 条「源码正则断言」是自证，切片失配时 body 为空串、无条件通过。
#   第二代（改完之后）：删掉了正则，但场景 B 写成 either-or、接线完全没有断言，
#     于是 M4/M6/M7 三个变异（把非组长分支改成什么都不杀、断掉 fingerprint 接线、
#     让 _persist 永远写 null）跑出来全绿 —— 套件以为自己在看，其实没看。
#
# 唯一能证明「这套测试有牙」的办法：把已知缺陷放进去，看它是否红。
# 下面每个变异都对应一次被推翻的修复，编号沿用复核的 M1~M7。
#
# 用法（仓库根目录，需 posix；WSL 可用）：
#   bash tests/tools/mutation-check.sh
#
# 退出码：所有变异都被抓到为 0，否则为 1。

set -u
set -o pipefail
cd "$(dirname "$0")/../.." || exit 1

TOTAL=0

DL="engine/dlcore.js"
LX="engine/platform/linux.mjs"
DW="engine/platform/darwin.mjs"
SUITE="tests/unit-orphan-reap.mjs"
BAK_DL=$(mktemp)
BAK_LX=$(mktemp)
BAK_DW=$(mktemp)

cp "$DL" "$BAK_DL"
cp "$LX" "$BAK_LX"
cp "$DW" "$BAK_DW"

cleanup() {
  cp "$BAK_DL" "$DL"
  cp "$BAK_LX" "$LX"
  cp "$BAK_DW" "$DW"
  rm -f "$BAK_DL" "$BAK_LX" "$BAK_DW"
}
trap cleanup EXIT

fail_count=0

run_suite() { node "$SUITE" 2>&1 | sed 's/\r//'; }

count_fails() { echo "$1" | grep -c "^FAIL"; }

echo "=== 基线（无变异，应当全绿）==="
BASE=$(run_suite)
BASE_SUM=$(echo "$BASE" | grep -E "passed, [0-9]+ failed")
echo "   $BASE_SUM"
case "$BASE_SUM" in
  *", 0 failed"*) echo "   基线通过" ;;
  *) echo "   ★ 基线本身就是红的，先修好再谈变异"; echo "$BASE" | grep "^FAIL" | sed 's/^/     /'; exit 1 ;;
esac
echo

# 通用：跑一个变异，判断是否被抓到
# $1=名称  $2=out
judge() {
  local name="$1" out="$2"
  local n
  TOTAL=$((TOTAL+1))
  n=$(count_fails "$out")
  echo "$out" | grep -E "^FAIL|passed, " | sed 's/^/   /'
  if [ "$n" -ge 1 ]; then
    echo "   ✓ 被抓到（$n 条 FAIL）"
  else
    echo "   ✗ 没被抓到 —— 这套件对这个变异无效"
    fail_count=$((fail_count+1))
  fi
}

# 每个变异都自带一道闸：python 失败（替换目标找不到）→ 整个脚本 exit 2。
# 2026-10-21 复核实测过：没有这道闸时，python 的 assert 失败会被后续逻辑
# 当成“这个变异没被抓到”，报告的失败原因完全是错的（说套件没牙，其实是脚本没改成功）。
# 实现方式：每个 heredoc 里都显式 sys.exit(3) 于 assert 失败路径，
# 外面用 `|| { echo ...; exit 2; }` 兜住。

# ── M1：treeKill → killTree（还原非组长谎报）──
echo "=== M1：_reapOrphanCommand 的 treeKill 换回 killTree ==="
python3 - "$DL" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
s = s.replace("const killed = platform.treeKill(n);", "const killed = platform.killTree(n);")
open(p, "w", encoding="utf-8").write(s)
PY
if [ $? -ne 0 ]; then echo "   ★ 变异没应用成功（替换目标找不到），脚本该更新了"; exit 2; fi
judge "M1" "$(run_suite)"
cp "$BAK_DL" "$DL"
echo

# ── M2：把 bash 加回 pnpm 期望集合（还原误杀风险）──
echo "=== M2：pnpm-install 的期望集合加回 sh/bash ==="
python3 - "$DL" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
s = s.replace('"pnpm-install" ? ["node", "npm", "pnpm"]',
              '"pnpm-install" ? ["node", "npm", "pnpm", "sh", "bash"]')
open(p, "w", encoding="utf-8").write(s)
PY
if [ $? -ne 0 ]; then echo "   ★ 变异没应用成功（替换目标找不到），脚本该更新了"; exit 2; fi
judge "M2" "$(run_suite)"
cp "$BAK_DL" "$DL"
echo

# ── M3：treeAlive → pidAlive（还原「探组长、杀进程组」）──
echo "=== M3：linux 的 treeAlive 换回 pidAlive ==="
python3 - "$LX" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
marker = "export function treeAlive(pid) {"
i = s.index(marker)
s = s[:i + len(marker)] + "\n  return pidAlive(pid); // MUTATION" + s[i + len(marker):]
open(p, "w", encoding="utf-8").write(s)
PY
if [ $? -ne 0 ]; then echo "   ★ 变异没应用成功（替换目标找不到），脚本该更新了"; exit 2; fi
judge "M3" "$(run_suite)"
cp "$BAK_LX" "$LX"
echo

# ── M4：非组长分支改成「永远返回 false，什么都不杀」──
# 这是上一版套件放过去的那个变异（场景 B 写成 either-or 的直接后果）。
echo "=== M4：非组长分支改成永远不杀（回归到「空转」）==="
python3 - "$LX" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
marker = "      // 不是组长：只杀自己。不发 -n，那是父亲那一组。"
i = s.index(marker)
j = s.index("      return true;", i)
end = s.index("\n", j) + 1
s = s[:i] + "      return false; // MUTATION: 什么都不杀\n" + s[end:]
open(p, "w", encoding="utf-8").write(s)
PY
if [ $? -ne 0 ]; then echo "   ★ 变异没应用成功（替换目标找不到），脚本该更新了"; exit 2; fi
judge "M4" "$(run_suite)"
cp "$BAK_LX" "$LX"
echo

# ── M5：restore 不再把 childStart 传下去（接线断掉）──
echo "=== M5：restore 不再传 m.childStart（指纹接线断掉）==="
python3 - "$DL" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
s = s.replace("this._reapOrphanCommand(m.childPid, m.cmd?.type, m.childStart);",
              "this._reapOrphanCommand(m.childPid, m.cmd?.type);")
open(p, "w", encoding="utf-8").write(s)
PY
if [ $? -ne 0 ]; then echo "   ★ 变异没应用成功（替换目标找不到），脚本该更新了"; exit 2; fi
judge "M5" "$(run_suite)"
cp "$BAK_DL" "$DL"
echo

# ── M6：_persist 永远写 childStart: null ──
echo "=== M6：_persist 永远写 childStart: null（写端失效）==="
python3 - "$DL" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
old = """childStart: (t.kind === "command" && t.state === "running" && t.child && t._childStart)
            ? t._childStart : null,"""
new = """childStart: null, // MUTATION"""
assert old in s, "M6 的替换目标没找到（代码结构变了，需要更新变异脚本）"
s = s.replace(old, new)
open(p, "w", encoding="utf-8").write(s)
PY
if [ $? -ne 0 ]; then echo "   ★ 变异没应用成功（替换目标找不到），脚本该更新了"; exit 2; fi
judge "M6" "$(run_suite)"
cp "$BAK_DL" "$DL"
echo

# ── M7：treeKill 的升级探活退回「只看进程在不在」（不比对指纹）──
# 复核用强制抢号实际打死过无关进程，这条保证它不会悄悄退回去。
echo "=== M7：treeKill 升级探活退回 process.kill(n,0)（不留指纹）==="
python3 - "$LX" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
old = "() => escalationAllowed(n, startBefore),"
new = "() => { process.kill(n, 0); return true; }, // MUTATION"
assert old in s, "M7 的替换目标没找到（代码结构变了，需要更新变异脚本）"
s = s.replace(old, new)
open(p, "w", encoding="utf-8").write(s)
PY
if [ $? -ne 0 ]; then echo "   ★ 变异没应用成功（替换目标找不到），脚本该更新了"; exit 2; fi
judge "M7" "$(run_suite)"
cp "$BAK_LX" "$LX"
echo

# ── M8：escalationAllowed 不再比对指纹（只看到进程在不在）──
# 比 M7 更细：即使 treeKill 还调 escalationAllowed，判据里丢掉指纹比对也应当被抓到。
echo "=== M8：escalationAllowed 不再比对指纹 ==="
python3 - "$LX" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
old = """export function escalationAllowed(pid, startBefore) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (!pidAlive(n)) return false;
  if (!startBefore) return false;
  return processStartOf(n) === startBefore;
}"""
new = """export function escalationAllowed(pid, startBefore) {
  return pidAlive(pid); // MUTATION: 丢掉指纹比对
}"""
assert old in s, "M8 的替换目标没找到（代码结构变了，需要更新变异脚本）"
s = s.replace(old, new)
open(p, "w", encoding="utf-8").write(s)
PY
if [ $? -ne 0 ]; then echo "   ★ 变异没应用成功（替换目标找不到），脚本该更新了"; exit 2; fi
judge "M8" "$(run_suite)"
cp "$BAK_LX" "$LX"
echo

# ── M9：没指纹时退化为“保守升级”（曾经写错过的方向）──
echo "=== M9：escalationAllowed 没指纹时退化为保守升级 ==="
python3 - "$LX" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
old = "  if (!startBefore) return false;"
new = "  if (!startBefore) return true; // MUTATION: 没指纹就升级"
assert old in s, "M9 的替换目标没找到"
s = s.replace(old, new, 1)
open(p, "w", encoding="utf-8").write(s)
PY
if [ $? -ne 0 ]; then echo "   ★ 变异没应用成功（替换目标找不到），脚本该更新了"; exit 2; fi
judge "M9" "$(run_suite)"
cp "$BAK_LX" "$LX"
echo

# ── M10：树的大小写不能变（darwin 侧 treeKill 内联掉）──
echo "=== M10：darwin 的 treeKill 内联掉 escalationAllowed ==="
python3 - "$DW" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
old = "() => escalationAllowed(n, startBefore),"
new = "() => { process.kill(n, 0); return true; }, // MUTATION"
assert old in s, "M10 的替换目标没找到"
s = s.replace(old, new)
open(p, "w", encoding="utf-8").write(s)
PY
if [ $? -ne 0 ]; then echo "   ★ 变异没应用成功（替换目标找不到），脚本该更新了"; exit 2; fi
judge "M10" "$(run_suite)"
cp "$BAK_DW" "$DW"
echo

echo "=== 还原后复核 ==="
FINAL=$(run_suite)
FINAL_SUM=$(echo "$FINAL" | grep -E "passed, [0-9]+ failed")
echo "   $FINAL_SUM"
case "$FINAL_SUM" in
  *", 0 failed"*) echo "   已还原" ;;
  *) echo "   ★ 还原失败，请手工检查 git status"; echo "$FINAL" | grep "^FAIL" | sed 's/^/     /'; fail_count=$((fail_count+1)) ;;
esac

echo
if [ "$fail_count" -eq 0 ]; then
  echo "=== 变异测试通过：$TOTAL 个变异全部被抓到 ==="
  exit 0
else
  echo "=== 变异测试失败：$fail_count 个变异没被抓到 ==="
  exit 1
fi
