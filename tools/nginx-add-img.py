#!/usr/bin/env python3
"""给 /ai 的 nginx 块补一条 sub_filter：把 HTML/JS/CSS 里的 `/img/` 重写成 `/ai/img/`。

背景：hl-platform 挂在 /ai 子路径下。nginx 用 rewrite 把 /ai/X 变成 /X 转给后端，
再用 sub_filter 把响应体里的绝对路径改回去。原来的白名单只有
/api/、/js/、/app.css 三条 —— 新加的 /img/ 不在里面，
于是 <img src="/img/logo.png"> 到了浏览器变成 https://aijiangti.cn/img/logo.png（404）。
"""
import shutil
import sys
import time

P = "/etc/nginx/sites-enabled/studymate.conf"
ANCHOR = "        sub_filter '/app.css' '/ai/app.css';\n"
ADD = "        sub_filter '/img/' '/ai/img/';\n"

src = open(P).read()
if "/ai/img/" in src:
    print("已经是补过的状态，无需改动")
    sys.exit(0)
if ANCHOR not in src:
    print("找不到锚点（/app.css 那条 sub_filter），中止 —— 别瞎改 nginx")
    sys.exit(1)

bak = f"/etc/nginx/backup-studymate.conf.{int(time.time())}"
shutil.copy2(P, bak)
open(P, "w").write(src.replace(ANCHOR, ANCHOR + ADD, 1))
print("已补上 sub_filter '/img/' '/ai/img/'")
print("备份：", bak)
