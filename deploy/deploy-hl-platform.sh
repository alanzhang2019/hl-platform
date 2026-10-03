#!/usr/bin/env bash
# ============================================================================
# hl-platform（/ai 后浪学习平台）部署脚本
# ============================================================================
# 由服务器上的分发器 /home/ubuntu/deploy/dispatch.sh 调用（它负责 git fetch +
# git reset --hard origin/main），调用链：
#   GitHub Actions → ssh "deploy hl-platform" → dispatch.sh → 本脚本
# 分发器本身的参考副本在 StudyMate 仓库的 deploy/dispatch.sh。
#
# 为什么必须重启容器：/home/ubuntu/hl-platform 是 bind-mount 到容器 /app，
# 但 server.js 与 server/*.js 在 Node 启动时就被 require 进内存了 ——
# 不重启的话磁盘上文件变了、跑的还是启动那一刻的版本。
# public/ 下的静态文件是每次请求读盘，不重启也会生效（浏览器强刷即可）。
# ============================================================================
set -euo pipefail

APP_DIR=/home/ubuntu/hl-platform
CONTAINER=hl-platform
PUBLIC=https://aijiangti.cn/ai

cd "$APP_DIR"
echo "[hl-platform] 开始部署  HEAD=$(git rev-parse --short HEAD)  $(git log -1 --format=%s)"

echo "[hl-platform] docker restart $CONTAINER …"
docker restart "$CONTAINER" >/dev/null

echo "[hl-platform] 等待就绪…"
VER=""
for i in $(seq 1 40); do
    VER=$(curl -s -m 3 http://127.0.0.1:3100/api/health \
          | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)
    if [ -n "$VER" ]; then echo "  第 ${i}s 就绪，version=$VER"; break; fi
    sleep 1
done

FAIL=0
chk() {
    local name="$1" url="$2" want="$3"
    local got
    got=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$url" || echo 000)
    if [ "$got" = "$want" ]; then
        printf '  ✅ %-32s %s\n' "$name" "$got"
    else
        printf '  ❌ %-32s %s（期望 %s）\n' "$name" "$got" "$want"
        FAIL=1
    fi
}

if [ -z "$VER" ]; then
    echo "  ❌ /api/health 40 秒内没有响应 —— 容器可能起不来，看 docker logs $CONTAINER"
    FAIL=1
fi

echo "[hl-platform] 健康检查："
chk "容器直连 /api/health"     http://127.0.0.1:3100/api/health  200
chk "经 nginx /ai/api/health"  "$PUBLIC/api/health"              200
chk "静态入口 /ai/"            "$PUBLIC/"                        200

# 跨应用回归：改 hl-platform 不应影响另外两个应用
chk "StudyMate 首页"           https://aijiangti.cn/             200
chk "错题本"                   https://aijiangti.cn/wrong-notebook 200

if [ "$FAIL" = "0" ]; then
    echo "[hl-platform] ✅ 部署成功（version=$VER）"
else
    echo "[hl-platform] ❌ 有检查未通过，见上"
fi
exit "$FAIL"
