# -*- coding: utf-8 -*-
"""
cschat6 客服聊天室 → 待处理 自动导入模块（零依赖，仅标准库）

流程：
  1. 用 账号+密码+TOTP 自动登录 cschat6，拿到 pai-dan.client cookie
  2. 每隔 POLL_SEC 秒轮询「藍色小精靈」群组的消息接口
  3. 对含「是否 / 请问…?」问句、且含 平台/会员 格式的新消息 → 解析成待处理
  4. 结尾问句点名具体会员 → 只抓那个；否则 → 全抓
  5. 群组按台北时间(UTC+8)自动填 早班/中班/晚班

全部通过环境变量配置，未开启(CSCHAT_ENABLE≠1)则不启动、不影响原站点。

环境变量：
  CSCHAT_ENABLE        = 1 才启动
  CSCHAT_USERNAME      = 登录账号（如 DG7766）
  CSCHAT_PASSWORD      = 登录密码
  CSCHAT_TOTP_SECRET   = 2FA 密钥种子（base32，如 JBSWY3DPEHPK3PXP）
  CSCHAT_ROOM_ID       = 群组ID（默认 藍色小精靈 6905bdf80aa3f30011f5ec9a）
  CSCHAT_POLL_SEC      = 轮询间隔秒（默认 30）
  CSCHAT_DRY_RUN       = 1 则只打印「会抓到什么」，不真正写入（首次验证用）
"""

import os
import re
import json
import time
import hmac
import base64
import struct
import hashlib
import threading
import urllib.request
import urllib.error
import http.cookiejar
from datetime import datetime, timezone, timedelta

API = "https://pd.cschat6.com/api/v1"
ORIGIN = "https://pd.cschat6.com"
TZ8 = timezone(timedelta(hours=8))          # 台北 / 北京，UTC+8
SHIFT_GROUPS = ["早班", "中班", "晚班"]
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def _log(*a):
    print("[chat-import]", *a, flush=True)


# --------------------------------------------------------- TOTP（标准 RFC6238）
def totp_now(secret_b32, digits=6, period=30, t=None):
    """由 base32 密钥算当前 6 位验证码，和验证器 App 显示的一致。"""
    s = re.sub(r"\s+", "", secret_b32 or "").upper()
    s += "=" * ((8 - len(s) % 8) % 8)         # 补齐 base32 填充
    key = base64.b32decode(s)
    counter = int((t if t is not None else time.time()) // period)
    msg = struct.pack(">Q", counter)
    h = hmac.new(key, msg, hashlib.sha1).digest()
    o = h[-1] & 0x0F
    code = (struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)


# --------------------------------------------------------- cschat6 客户端
class Cschat:
    def __init__(self, username, password, totp_secret):
        self.username = username
        self.password = password
        self.totp_secret = totp_secret
        self._new_opener()

    def _new_opener(self):
        self.cj = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cj))

    def _req(self, method, path, obj=None):
        url = path if path.startswith("http") else API + path
        data = json.dumps(obj).encode("utf-8") if obj is not None else None
        headers = {
            "Accept": "application/json",
            "User-Agent": UA,
            "Origin": ORIGIN,
            "Referer": ORIGIN + "/",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with self.opener.open(req, timeout=25) as r:
            raw = r.read().decode("utf-8", "replace")
        return json.loads(raw) if raw.strip() else {}

    def login(self):
        """账号密码 → TOTP 两步登录，成功后 cookie 存在 self.cj。"""
        self._new_opener()
        self._req("POST", "/login",
                  {"username": self.username, "password": self.password})
        code = totp_now(self.totp_secret)
        self._req("POST", "/guests/id=me/login", {"totp": code})
        _log("登录成功")

    def messages(self, room_id, limit=50):
        """拉群组消息（最新在前）。cookie 失效(401/403)自动重登一次。"""
        path = ("/chat-messages?chatRoomId=%s&order=desc&sort=createdAt&limit=%d"
                % (room_id, limit))
        try:
            res = self._req("GET", path)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                _log("cookie 失效，重新登录…")
                self.login()
                res = self._req("GET", path)
            else:
                raise
        return res.get("data") or []


# --------------------------------------------------------- 消息解析
_FIELD_RE = re.compile(r"^\s*(平台|会员|最后登入时间|最后登入|原因|备注)\s*[:：]\s*(.*)$")


def parse_entries(content):
    """把消息正文拆成一条条 {platform,account,lastLogin,reason,remark}。
    以「平台」行作为每条起点；采种/期号/请问 等无关行自动忽略。"""
    entries, cur = [], None

    def flush():
        if cur and cur.get("platform") and cur.get("account"):
            entries.append(cur)

    for line in (content or "").splitlines():
        m = _FIELD_RE.match(line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if key == "平台":
            flush()
            cur = {"platform": val}
        elif cur is not None:
            if key == "会员":
                cur["account"] = val
            elif key in ("最后登入时间", "最后登入"):
                cur["lastLogin"] = val
            elif key == "原因":
                cur["reason"] = val
            elif key == "备注":
                cur["remark"] = val
    flush()
    return entries


def is_triggered(content):
    """要抓的是「在问主管」的消息：含『是否』或『请问…?』。纯上报(无问句)忽略。"""
    c = content or ""
    if "是否" in c:
        return True
    if "请问" in c and ("?" in c or "？" in c):
        return True
    return False


def clean_account(acc):
    return re.sub(r"[^A-Za-z0-9]", "", acc or "")


def scope_entries(entries, content):
    """结尾问句点名了具体会员 → 只抓被点名的；否则(泛问/模糊) → 全抓。"""
    qlines = [ln for ln in (content or "").splitlines()
              if ("是否" in ln or "请问" in ln or "?" in ln or "？" in ln)]
    qtext = " ".join(qlines)
    named = [e for e in entries if e.get("account") and e["account"] in qtext]
    return named if named else entries


def shift_group(created_iso):
    """按消息 createdAt(UTC) 换算台北时间，落到 早班/中班/晚班。"""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})", created_iso or "")
    if m:
        dt = datetime(*[int(x) for x in m.groups()], tzinfo=timezone.utc).astimezone(TZ8)
    else:
        dt = datetime.now(TZ8)
    h = dt.hour
    if 8 <= h < 16:
        return "早班"
    if 16 <= h < 24:
        return "中班"
    return "晚班"


# --------------------------------------------------------- 主循环
class Importer:
    def __init__(self, deps, cfg):
        self.deps = deps                      # server.py 注入的数据函数
        self.cfg = cfg
        self.client = Cschat(cfg["username"], cfg["password"], cfg["totp_secret"])

    def ensure_groups(self):
        """确保设置里有 早班/中班/晚班 三个群组。"""
        try:
            cur = (self.deps["get_config"]() or {}).get("groups") or []
            merged = list(cur)
            for g in SHIFT_GROUPS:
                if g not in merged:
                    merged.append(g)
            if merged != cur:
                self.deps["set_config"]({"groups": merged})
                _log("已补齐班次群组:", merged)
        except Exception as e:
            _log("补群组失败:", e)

    def process(self, msgs):
        deps, cfg = self.deps, self.cfg
        room = cfg["room_id"]
        with deps["lock"]:
            data = deps["load"]() or {"members": [], "seq": 1000}
            ci = data.setdefault("chatImport", {})
            seen_list = ci.get("seen", [])
            seen = set(seen_list)
            new_seen, added = [], 0

            # 旧→新处理，保证生成编号顺序稳定
            for msg in sorted(msgs, key=lambda x: x.get("createdAt", "")):
                mid = msg.get("id")
                if not mid or mid in seen:
                    continue
                if (msg.get("chatRoom") or {}).get("id") != room:
                    seen.add(mid); new_seen.append(mid); continue

                # TODO(主管引用回复): 拿到「引用字段」后在此处理 冻结/不处理
                content = msg.get("content") or ""
                if not is_triggered(content):
                    seen.add(mid); new_seen.append(mid); continue
                entries = parse_entries(content)
                if not entries:
                    seen.add(mid); new_seen.append(mid); continue

                chosen = scope_entries(entries, content)
                grp = shift_group(msg.get("createdAt", ""))
                for e in chosen:
                    acc = clean_account(e.get("account"))
                    if not acc:
                        continue
                    f = {"platform": e.get("platform", ""), "account": acc,
                         "lastLogin": e.get("lastLogin", ""), "reason": e.get("reason", ""),
                         "remark": e.get("remark", ""), "group": grp}
                    if cfg["dry_run"]:
                        _log("[DRY] 会抓:", grp, f["platform"], acc,
                             "| 原因:", f["reason"][:40])
                    else:
                        m = deps["make_member"](deps["next_id"](data["members"]), f, "提交中")
                        m["srcMsgId"] = mid
                        data["members"].insert(0, m)
                    added += 1
                seen.add(mid); new_seen.append(mid)

            if cfg["dry_run"]:
                if added:
                    _log("[DRY] 本轮共会抓 %d 条（未写入）" % added)
                return

            if new_seen:
                ci["seen"] = (seen_list + new_seen)[-3000:]   # 去重表，限长
                data["chatImport"] = ci
                if added:
                    deps["enforce_cap"](data)
                deps["save"](data)
                if added:
                    _log("已导入 %d 条待处理" % added)

    def run(self):
        _log("启动，群组=%s，间隔=%ds，dry_run=%s"
             % (self.cfg["room_id"], self.cfg["poll_sec"], self.cfg["dry_run"]))
        try:
            self.client.login()
        except Exception as e:
            _log("首次登录失败（稍后重试）:", e)
        self.ensure_groups()
        while True:
            try:
                self.process(self.client.messages(self.cfg["room_id"]))
            except Exception as e:
                _log("轮询出错:", repr(e))
            time.sleep(self.cfg["poll_sec"])


# --------------------------------------------------------- 对外入口
def start(deps):
    """server.py 在 main() 里调用。未开启则直接返回。"""
    if os.environ.get("CSCHAT_ENABLE", "").strip() not in ("1", "true", "yes", "on"):
        return
    cfg = {
        "username": os.environ.get("CSCHAT_USERNAME", "").strip(),
        "password": os.environ.get("CSCHAT_PASSWORD", ""),
        "totp_secret": os.environ.get("CSCHAT_TOTP_SECRET", "").strip(),
        "room_id": os.environ.get("CSCHAT_ROOM_ID", "6905bdf80aa3f30011f5ec9a").strip(),
        "poll_sec": max(10, int(os.environ.get("CSCHAT_POLL_SEC", "30") or 30)),
        "dry_run": os.environ.get("CSCHAT_DRY_RUN", "").strip() in ("1", "true", "yes", "on"),
    }
    if not (cfg["username"] and cfg["password"] and cfg["totp_secret"]):
        _log("已启用但缺少 账号/密码/TOTP 密钥，未启动")
        return
    t = threading.Thread(target=Importer(deps, cfg).run, daemon=True)
    t.start()
    _log("后台线程已启动")
