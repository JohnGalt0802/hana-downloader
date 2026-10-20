#!/bin/bash
# 造现场：git clone 大仓 → 只杀组长 → 看孙子孤儿是否残留
# 用来验证 _reapOrphanCommand 的「探活组长 vs 杀进程组」错配是不是真问题。
set -u
ENGINE_PORT=${ENGINE_PORT:-4317}
TARGET=/root/code/orphan-test
rm -rf "$TARGET"

echo "=== 1. 发起 git-clone 任务 ==="
TID=$(curl -s -m 20 -X POST -H "Content-Type: application/json" \
  -d "{\"kind\":\"git-clone\",\"repo\":\"file:///root/bigsrc\",\"targetDir\":\"$TARGET\"}" \
  "http://127.0.0.1:$ENGINE_PORT/command" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).taskId||"")}catch{console.log("")}})')
echo "taskId=$TID"
sleep 3

echo
echo "=== 2. 找 git clone 主进程（进程组组长）==="
LEADER=$(pgrep -f "^git clone --progress file:///root/bigsrc $TARGET$" | head -1)
if [ -z "$LEADER" ]; then
  echo "没找到 git clone 主进程，放弃"
  exit 1
fi
PGID=$(ps -o pgid= -p "$LEADER" | tr -d ' ')
echo "leader pid=$LEADER  pgid=$PGID"

echo
echo "=== 3. 该进程组里的全部成员 ==="
ps -o pid,ppid,pgid,stat,args -g "$PGID" 2>/dev/null

echo
echo "=== 4. 只杀组长（kill -9 单个 pid，不动进程组）==="
kill -9 "$LEADER"
sleep 2

echo
echo "=== 5. 组长死后，组里还剩谁（这就是「孤儿」）==="
ps -o pid,ppid,pgid,stat,args -g "$PGID" 2>/dev/null || echo "整组已空"

echo
echo "=== 6. 任务在引擎里的状态 ==="
curl -s -m 10 "http://127.0.0.1:$ENGINE_PORT/list" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const t=JSON.parse(d).tasks.find(x=>x.taskId===process.env.TID);if(!t)return console.log("任务不见了");console.log(JSON.stringify({state:t.state,childPid:t.childPid,err:t.error,stage:t.stage},null,1))})' TID="$TID" 2>/dev/null

echo
echo "=== 7. 引擎落盘的 childPid ==="
node -e '
const fs=require("fs");
const p="/root/hanahome135/app-data/hana-downloader/tasks.json";
try{
  const m=JSON.parse(fs.readFileSync(p,"utf8"));
  const t=(m.tasks||[]).filter(x=>x.kind==="command").slice(-2);
  for(const x of t) console.log(x.taskId, x.state, "childPid="+x.childPid, x.cmd&&x.cmd.type, x.filePath);
}catch(e){console.log("读不到 tasks.json:",e.message)}
'
