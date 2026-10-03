#!/usr/bin/env bash
# ============================================================================
# hl-platform 手动落位脚本（在**服务器上**执行）
# ============================================================================
# 什么时候用：GitHub Actions 的 DEPLOY_SSH_KEY secret 还没配好，
#   push 触发的 workflow 一直是 failure，改完代码推不上去、也就走不到
#   deploy/deploy-hl-platform.sh。这时候用本脚本把文件手工放到服务器上。
#
# 用法（本地 → 服务器）：
#   ssh ... 'rm -rf /tmp/hl-up && mkdir -p /tmp/hl-up'
#   scp server.js server/llm.js public/js/app.js ... server:/tmp/hl-up/
#   scp deploy/manual-place.sh server:/tmp/hl-up/
#   ssh ... 'cd /home/ubuntu/hl-platform && bash /tmp/hl-up/manual-place.sh \
#              server.js server/llm.js public/js/app.js'
#
# 为什么必须经过 /tmp 中转：scp 多个文件时会把它们**平铺**进目标目录，
#   不保留 server/ 这种子目录结构。所以先收到 /tmp，再按相对路径归位。
#
# ★ 落位后还要做两件事，本脚本不替你做：
#   ① 在容器里跑回归（宿主 node 是 v12，跑不了 node:sqlite）：
#        docker exec -w /app -e NO_DOTENV=1 hl-platform node test/admin-and-tts.test.js
#   ② 重启容器（server*.js 启动时就被 require 进内存，不重启等于没改）：
#        bash deploy/deploy-hl-platform.sh
#   ③ 提交推送 —— 否则下一次 dispatch.sh 的 git reset --hard 会把改动冲掉
# ============================================================================
set -euo pipefail

APP=${APP_DIR:-/home/ubuntu/hl-platform}
UP=${UP_DIR:-/tmp/hl-up}

if [ "$#" -eq 0 ]; then
    echo "用法：bash manual-place.sh <相对路径> [更多相对路径…]" >&2
    echo "例：  bash manual-place.sh server.js server/llm.js public/js/app.js" >&2
    exit 2
fi

BK="$APP/../hl-platform-bak-$(date +%Y%m%d-%H%M%S)"
echo "[manual-place] 备份目录：$BK"
mkdir -p "$BK"

for rel in "$@"; do
    base=$(basename "$rel")
    src="$UP/$base"
    if [ ! -f "$src" ]; then echo "❌ 缺文件：$src（是不是忘了 scp？）" >&2; exit 1; fi
    # 父目录必须存在 —— 这是防"相对路径写错"的检查。
    # 目标文件本身允许不存在（新增文件是正常场景），只是提示一声。
    if [ ! -d "$APP/$(dirname "$rel")" ]; then
        echo "❌ 目标目录不存在：$APP/$(dirname "$rel")（相对路径写错了？）" >&2
        exit 1
    fi
    if [ -f "$APP/$rel" ]; then
        mkdir -p "$(dirname "$BK/$rel")"
        cp -a "$APP/$rel" "$BK/$rel"
    else
        printf '  (新增文件，无需备份) %s\n' "$rel"
    fi
    cp -f "$src" "$APP/$rel"
    printf '  ✅ %-28s %s 字节\n' "$rel" "$(wc -c < "$APP/$rel")"
done

echo "[manual-place] 落位完成。别忘了：容器内跑回归 → deploy-hl-platform.sh → git push"
