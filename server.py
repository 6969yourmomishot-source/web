# -*- coding: utf-8 -*-
"""
会员追踪 · 前端 + 轻量后端（零依赖，仅用 Python 标准库）

- 监听 0.0.0.0 和 Railway 注入的 $PORT（本地默认 8000）
- 服务 public/ 里的静态前端
- 提供会员数据接口（数据存成 JSON 文件，所有访问者共享同一份）
- 全站 + 接口都受访问密码保护（SITE_PASSWORD 环境变量）
- 安全响应头 + CSP

数据文件位置：DATA_DIR 环境变量（默认在本文件同目录）。
  ⚠️ Railway 重新部署会重置容器文件；要永久保存，请挂 Volume 并把 DATA_DIR 指向它。

本地预览：  python server.py   然后打开 http://localhost:8000
"""

import os
import re
import json
import hmac
import time
import base64
import hashlib
import secrets
import threading
import functools
from datetime import datetime, timezone, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8000"))
BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(BASE, "public")
# 数据目录：优先用手动设的 DATA_DIR；否则用 Railway 挂卷时自动注入的
# RAILWAY_VOLUME_MOUNT_PATH；都没有则用本文件同目录（临时，重启会丢）。
DATA_DIR = (os.environ.get("DATA_DIR")
            or os.environ.get("RAILWAY_VOLUME_MOUNT_PATH")
            or BASE)
DATA_FILE = os.path.join(DATA_DIR, "members.json")
USERS_FILE = os.path.join(DATA_DIR, "users.json")
SESSION_TTL = 7 * 86400      # 登录有效期 7 天
ROLES = ("admin", "staff")   # 管理员 / 一般人员

# 访问密码：已按需求移除（站点公开，无需密码）。
# 如需恢复，改回： SITE_PASSWORD = os.environ.get("SITE_PASSWORD", "").strip()
SITE_PASSWORD = ""

# 是否灌入演示数据：默认关闭。设 SEED_DEMO=1 才会在空库时生成演示会员。
SEED_DEMO = os.environ.get("SEED_DEMO", "").strip().lower() in ("1", "true", "yes", "on")

# 时区：用 UTC+8（北京/上海），用于"今日"统计
TZ = timezone(timedelta(hours=8))
STATUSES = ["提交中", "不处理", "冻结", "线冻结", "已处理", "异常"]

_lock = threading.RLock()


# ------------------------------------------------------------ 数据存储
def now_iso():
    return datetime.now(TZ).isoformat(timespec="seconds")


def today_str():
    return datetime.now(TZ).strftime("%Y-%m-%d")


def load_data():
    with _lock:
        if os.path.exists(DATA_FILE):
            try:
                with open(DATA_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                print("读取数据失败:", e)
        return None


def save_data(data):
    with _lock:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


FIELDS = ["platform", "account", "lastLogin", "reason", "remark", "group"]


def year_letter(y):
    """2026=A, 2027=B, …, 2051=Z（超出范围则夹到 A/Z）。"""
    i = max(0, min(25, y - 2026))
    return chr(ord("A") + i)


def next_member_id(members):
    """编号 = 年字母 + 当天MMDD + 3位日内流水，如 A0717001。"""
    d = datetime.now(TZ)
    prefix = year_letter(d.year) + d.strftime("%m%d")
    mx = 0
    for m in members:
        mid = str(m.get("id", ""))
        if mid.startswith(prefix):
            tail = mid[len(prefix):]
            if tail.isdigit():
                mx = max(mx, int(tail))
    return "%s%03d" % (prefix, mx + 1)


def make_member(mid, f, status="提交中"):
    m = {"id": mid}
    for k in FIELDS:
        m[k] = (f.get(k) or "").strip()
    m["status"] = status
    m["createdAt"] = now_iso()
    m["updatedAt"] = now_iso()
    return m


def split_accounts(account):
    """会员栏可能含多个账号（空格/换行/逗号/顿号/斜线/竖线分隔），拆成列表；
    账号只保留英文+数字（剃除中文、括号、符号等），剃完为空则丢弃。"""
    out = []
    for p in re.split(r"[\s,，、/|]+", account or ""):
        p = re.sub(r"[^A-Za-z0-9]", "", p)
        if p:
            out.append(p)
    return out


def expand_members(data, items):
    """把每笔 item 按会员账号逐一分笔插入，返回新增的 member 列表。"""
    added = []
    for f in items:
        if not isinstance(f, dict):
            continue
        for acc in split_accounts((f.get("account") or "").strip()):
            g = dict(f)
            g["account"] = acc
            m = make_member(next_member_id(data["members"]), g, "提交中")
            data["members"].insert(0, m)
            added.append(m)
    return added


def seed_demo():
    """首次运行没有数据时灌入演示数据（默认关闭，SEED_DEMO=1 才用）。"""
    samples = [
        {"platform": "XO", "account": "aijd199028", "lastLogin": "2026-07-15 17:13:01",
         "reason": "与JD zjl7229 同IP*2、同彩种", "remark": "疑似刷子团队 市场指示冻结处理 抓鬼"},
        {"platform": "OL", "account": "xy19860415", "lastLogin": "2026/07/13 05:38:53",
         "reason": "与JD zjl7229 同IP*2", "remark": "疑似刷子团队 市场指示冻结处理 抓鬼"},
        {"platform": "XY", "account": "xxjs888", "lastLogin": "2026/07/15 13:47:15",
         "reason": "与JD zjl7229 同IP*2", "remark": "疑似刷子团队 市场指示冻结处理 抓鬼"},
    ]
    members = []
    for f in samples:
        members.append(make_member(next_member_id(members), f, "提交中"))
    save_data({"members": members, "seq": 1000})
    print("已生成演示数据：%d 条" % len(members))


def ensure_data():
    if load_data() is None:
        if SEED_DEMO:
            seed_demo()
        else:
            save_data({"members": [], "seq": 1000})
            print("已初始化空数据库（未灌演示数据；如需演示数据设 SEED_DEMO=1）")


# ------------------------------------------------------------ 账号 / 会话 / 设置
def load_users():
    with _lock:
        if os.path.exists(USERS_FILE):
            try:
                with open(USERS_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                print("读取用户失败:", e)
        return {"users": [], "secret": ""}


def save_users(data):
    with _lock:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(USERS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


def get_secret():
    data = load_users()
    if not data.get("secret"):
        data["secret"] = secrets.token_hex(32)
        save_users(data)
    return data["secret"]


def hash_pw(password, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 100000).hex()
    return salt, h


def verify_pw(password, salt, h):
    try:
        calc = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 100000).hex()
        return hmac.compare_digest(calc, h)
    except Exception:
        return False


def find_user(username):
    for u in load_users().get("users", []):
        if u["username"] == username:
            return u
    return None


def public_user(u):
    return {"username": u["username"], "nickname": u.get("nickname", ""), "role": u["role"]}


def make_token(username):
    payload = base64.urlsafe_b64encode(
        json.dumps({"u": username, "exp": int(time.time()) + SESSION_TTL}).encode()).decode()
    sig = hmac.new(get_secret().encode(), payload.encode(), hashlib.sha256).hexdigest()
    return payload + "." + sig


def read_token(token):
    try:
        payload, sig = token.split(".", 1)
        expect = hmac.new(get_secret().encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expect):
            return None
        data = json.loads(base64.urlsafe_b64decode(payload))
        if data.get("exp", 0) < int(time.time()):
            return None
        return data.get("u")
    except Exception:
        return None


def _pub_config(cfg):
    return {"maxMembers": int(cfg.get("maxMembers", 0) or 0),
            "groups": cfg.get("groups", [])}


def get_config():
    data = load_data() or {}
    return _pub_config(data.get("config") or {})


def set_config(patch):
    data = load_data() or {"members": [], "seq": 1000}
    cfg = data.get("config") or {}
    cfg.update(patch)
    data["config"] = cfg
    save_data(data)
    return _pub_config(cfg)


def enforce_cap(data):
    """自动删除最旧：超过上限则保留最新的 N 笔（members 为新→旧排序）。"""
    cfg = data.get("config") or {}
    cap = int(cfg.get("maxMembers", 0) or 0)
    if cap and len(data.get("members", [])) > cap:
        data["members"] = data["members"][:cap]


# ------------------------------------------------------------ HTTP 处理
class Handler(SimpleHTTPRequestHandler):
    # -------- 会话认证 --------
    def _current_user(self):
        token = None
        for part in self.headers.get("Cookie", "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "session":
                token = v.strip()
                break
        if not token:
            return None
        username = read_token(token)
        return find_user(username) if username else None

    def _make_cookie(self, token, ttl):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto", "") == "https" else ""
        return "session=%s; HttpOnly; Path=/; Max-Age=%d; SameSite=Lax%s" % (token, ttl, secure)

    def _serve_login(self):
        try:
            with open(os.path.join(ROOT, "login.html"), "rb") as f:
                body = f.read()
        except Exception:
            body = b"login page missing"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -------- JSON 辅助 --------
    def _send_json(self, obj, code=200, cookie=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _redirect_login(self):
        self.send_response(302)
        self.send_header("Location", "/login")
        self.end_headers()

    # -------- 路由 --------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/login":
            return self._serve_login()
        if path == "/login.js":          # 登录页脚本，公开
            return super().do_GET()
        if path == "/api/needs-setup":
            return self._send_json({"setup": len(load_users().get("users", [])) == 0})
        user = self._current_user()
        if path.startswith("/api/"):
            if not user:
                return self._send_json({"error": "未登录"}, 401)
            return self._api_get(user)
        if not user:
            return self._redirect_login()
        return super().do_GET()

    def do_HEAD(self):
        if not self._current_user():
            return self._redirect_login()
        return super().do_HEAD()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        body = self._read_body()
        if path == "/api/login":
            return self._login(body)
        if path == "/api/bootstrap":
            return self._bootstrap(body)
        user = self._current_user()
        if not user:
            return self._send_json({"error": "未登录"}, 401)
        if path == "/api/logout":
            return self._logout()
        # 账号管理 / 设置（仅管理员，方法内校验）
        if path == "/api/users":
            return self._create_user(user, body)
        m = re.match(r"^/api/users/([^/]+)/delete$", path)
        if m:
            return self._delete_user(user, m.group(1))
        m = re.match(r"^/api/users/([^/]+)/password$", path)
        if m:
            return self._set_user_pw(user, m.group(1), body)
        m = re.match(r"^/api/users/([^/]+)/nickname$", path)
        if m:
            return self._set_nickname(user, m.group(1), body)
        m = re.match(r"^/api/users/([^/]+)/role$", path)
        if m:
            return self._set_role(user, m.group(1), body)
        if path == "/api/config":
            return self._save_config(user, body)
        # 会员操作（任何登录用户）
        if path == "/api/members":
            return self._add_member(body)
        if path == "/api/members/bulk":
            return self._add_bulk(body)
        if path == "/api/members/status-batch":
            return self._batch_status(body)
        if path == "/api/members/delete-batch":
            return self._batch_delete(body)
        if path == "/api/members/group-batch":
            return self._batch_group(body)
        if path == "/api/announcements":
            return self._add_announcement(user, body)
        m = re.match(r"^/api/announcements/([^/]+)/delete$", path)
        if m:
            return self._delete_announcement(user, m.group(1))
        m = re.match(r"^/api/announcements/([^/]+)$", path)
        if m:
            return self._edit_announcement(user, m.group(1), body)
        m = re.match(r"^/api/members/([^/]+)/status$", path)
        if m:
            return self._set_status(m.group(1), body)
        m = re.match(r"^/api/members/([^/]+)/edit$", path)
        if m:
            return self._edit_member(m.group(1), body)
        m = re.match(r"^/api/members/([^/]+)/delete$", path)
        if m:
            return self._delete_member(m.group(1))
        return self._send_json({"error": "接口不存在"}, 404)

    # -------- 认证接口 --------
    def _login(self, body):
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        u = find_user(username)
        if not u or not verify_pw(password, u["salt"], u["hash"]):
            return self._send_json({"error": "账号或密码错误"}, 401)
        cookie = self._make_cookie(make_token(username), SESSION_TTL)
        return self._send_json({"ok": True, "user": public_user(u)}, cookie=cookie)

    def _bootstrap(self, body):
        data = load_users()
        if data.get("users"):
            return self._send_json({"error": "已初始化"}, 403)
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        if not username or len(password) < 4:
            return self._send_json({"error": "用户名不能为空，密码至少4位"}, 400)
        salt, h = hash_pw(password)
        data.setdefault("users", []).append(
            {"username": username, "salt": salt, "hash": h, "role": "admin", "createdAt": now_iso()})
        if not data.get("secret"):
            data["secret"] = secrets.token_hex(32)
        save_users(data)
        cookie = self._make_cookie(make_token(username), SESSION_TTL)
        return self._send_json({"ok": True, "user": {"username": username, "role": "admin"}}, cookie=cookie)

    def _logout(self):
        return self._send_json({"ok": True}, cookie=self._make_cookie("", 0))

    # -------- 账号管理（管理员）--------
    def _create_user(self, actor, body):
        if actor["role"] != "admin":
            return self._send_json({"error": "无权限"}, 403)
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        role = body.get("role") if body.get("role") in ROLES else "staff"
        if not username or len(password) < 4:
            return self._send_json({"error": "用户名不能为空，密码至少4位"}, 400)
        data = load_users()
        if any(u["username"] == username for u in data.get("users", [])):
            return self._send_json({"error": "用户名已存在"}, 400)
        salt, h = hash_pw(password)
        data.setdefault("users", []).append(
            {"username": username, "nickname": (body.get("nickname") or "").strip(),
             "salt": salt, "hash": h, "role": role, "createdAt": now_iso()})
        save_users(data)
        return self._send_json({"ok": True})

    def _set_role(self, actor, target, body):
        if actor["role"] != "admin":
            return self._send_json({"error": "无权限"}, 403)
        role = body.get("role")
        if role not in ROLES:
            return self._send_json({"error": "角色无效"}, 400)
        data = load_users()
        users = data.get("users", [])
        tgt = next((u for u in users if u["username"] == target), None)
        if not tgt:
            return self._send_json({"error": "账号不存在"}, 404)
        if tgt["role"] == "admin" and role != "admin" and \
                len([u for u in users if u["role"] == "admin"]) <= 1:
            return self._send_json({"error": "不能取消唯一管理员的权限"}, 400)
        tgt["role"] = role
        save_users(data)
        return self._send_json({"ok": True})

    def _set_nickname(self, actor, target, body):
        if actor["role"] != "admin" and actor["username"] != target:
            return self._send_json({"error": "无权限"}, 403)
        nickname = (body.get("nickname") or "").strip()
        data = load_users()
        for u in data.get("users", []):
            if u["username"] == target:
                u["nickname"] = nickname
                save_users(data)
                return self._send_json({"ok": True})
        return self._send_json({"error": "账号不存在"}, 404)

    def _delete_user(self, actor, target):
        if actor["role"] != "admin":
            return self._send_json({"error": "无权限"}, 403)
        if target == actor["username"]:
            return self._send_json({"error": "不能删除自己"}, 400)
        data = load_users()
        users = data.get("users", [])
        tgt = next((u for u in users if u["username"] == target), None)
        if not tgt:
            return self._send_json({"error": "账号不存在"}, 404)
        if tgt["role"] == "admin" and len([u for u in users if u["role"] == "admin"]) <= 1:
            return self._send_json({"error": "不能删除唯一的管理员"}, 400)
        data["users"] = [u for u in users if u["username"] != target]
        save_users(data)
        return self._send_json({"ok": True})

    def _set_user_pw(self, actor, target, body):
        if actor["role"] != "admin" and actor["username"] != target:
            return self._send_json({"error": "无权限"}, 403)
        password = body.get("password") or ""
        if len(password) < 4:
            return self._send_json({"error": "密码至少4位"}, 400)
        data = load_users()
        for u in data.get("users", []):
            if u["username"] == target:
                u["salt"], u["hash"] = hash_pw(password)
                save_users(data)
                return self._send_json({"ok": True})
        return self._send_json({"error": "账号不存在"}, 404)

    # -------- 设置（管理员）--------
    def _save_config(self, actor, body):
        if actor["role"] != "admin":
            return self._send_json({"error": "无权限"}, 403)
        patch = {}
        if "maxMembers" in body:
            try:
                patch["maxMembers"] = max(0, int(body["maxMembers"]))
            except Exception:
                return self._send_json({"error": "笔数无效"}, 400)
        if "groups" in body and isinstance(body["groups"], list):
            seen, groups = set(), []
            for g in body["groups"]:
                g = str(g).strip()
                if g and g not in seen:
                    seen.add(g)
                    groups.append(g)
            patch["groups"] = groups
        cfg = set_config(patch)
        data = load_data() or {"members": [], "seq": 1000}
        enforce_cap(data)
        save_data(data)
        return self._send_json({"ok": True, "config": cfg})

    # -------- 接口实现（GET）--------
    def _api_get(self, user):
        p = self.path.split("?", 1)[0]
        if p == "/api/me":
            return self._send_json({"user": public_user(user)})
        if p == "/api/members":
            data = load_data() or {"members": [], "seq": 1000}
            return self._send_json({"members": data["members"],
                                    "today": today_str(),
                                    "statuses": STATUSES,
                                    "config": get_config(),
                                    "announcements": data.get("announcements") or [],
                                    "user": public_user(user)})
        if p == "/api/users":
            if user["role"] != "admin":
                return self._send_json({"error": "无权限"}, 403)
            return self._send_json({"users": [public_user(u) for u in load_users().get("users", [])]})
        if p == "/api/config":
            return self._send_json({"config": get_config()})
        return self._send_json({"error": "接口不存在"}, 404)

    def _add_member(self, body):
        if not split_accounts((body.get("account") or "").strip()):
            return self._send_json({"error": "会员不能为空"}, 400)
        data = load_data() or {"members": [], "seq": 1000}
        added = expand_members(data, [body])
        enforce_cap(data)
        save_data(data)
        return self._send_json({"added": len(added), "members": added}, 201)

    def _add_bulk(self, body):
        items = body.get("members")
        if not isinstance(items, list) or not items:
            return self._send_json({"error": "没有可新增的会员"}, 400)
        data = load_data() or {"members": [], "seq": 1000}
        added = expand_members(data, items)
        if not added:
            return self._send_json({"error": "没有有效会员（每笔需含会员账号）"}, 400)
        enforce_cap(data)
        save_data(data)
        return self._send_json({"added": len(added), "members": added}, 201)

    def _set_status(self, mid, body):
        status = body.get("status")
        if status not in STATUSES:
            return self._send_json({"error": "状态无效"}, 400)
        data = load_data() or {"members": [], "seq": 1000}
        for m in data["members"]:
            if m["id"] == mid:
                m["status"] = status
                m["updatedAt"] = now_iso()
                save_data(data)
                return self._send_json(m)
        return self._send_json({"error": "会员不存在"}, 404)

    def _edit_member(self, mid, body):
        data = load_data() or {"members": [], "seq": 1000}
        for m in data["members"]:
            if m["id"] == mid:
                for k in ("platform", "lastLogin", "reason", "remark", "group"):
                    if k in body:
                        m[k] = (body.get(k) or "").strip()
                if "account" in body:
                    acc = re.sub(r"[^A-Za-z0-9]", "", body.get("account") or "")
                    if not acc:
                        return self._send_json({"error": "会员账号不能为空"}, 400)
                    m["account"] = acc
                m["updatedAt"] = now_iso()
                save_data(data)
                return self._send_json(m)
        return self._send_json({"error": "会员不存在"}, 404)

    def _batch_status(self, body):
        status = body.get("status")
        ids = body.get("ids")
        if status not in STATUSES:
            return self._send_json({"error": "状态无效"}, 400)
        if not isinstance(ids, list) or not ids:
            return self._send_json({"error": "未选择会员"}, 400)
        idset = set(ids)
        data = load_data() or {"members": [], "seq": 1000}
        n = 0
        for m in data["members"]:
            if m["id"] in idset:
                m["status"] = status
                m["updatedAt"] = now_iso()
                n += 1
        save_data(data)
        return self._send_json({"updated": n})

    def _batch_group(self, body):
        ids = body.get("ids")
        group = str(body.get("group") or "").strip()
        if not isinstance(ids, list) or not ids:
            return self._send_json({"error": "未选择会员"}, 400)
        idset = set(ids)
        data = load_data() or {"members": [], "seq": 1000}
        n = 0
        for m in data["members"]:
            if m["id"] in idset:
                m["group"] = group
                m["updatedAt"] = now_iso()
                n += 1
        save_data(data)
        return self._send_json({"updated": n})

    def _batch_delete(self, body):
        ids = body.get("ids")
        if not isinstance(ids, list) or not ids:
            return self._send_json({"error": "未选择会员"}, 400)
        idset = set(ids)
        data = load_data() or {"members": [], "seq": 1000}
        before = len(data["members"])
        data["members"] = [m for m in data["members"] if m["id"] not in idset]
        save_data(data)
        return self._send_json({"deleted": before - len(data["members"])})

    # -------- 公告（任何登录用户）--------
    def _add_announcement(self, user, body):
        text = (body.get("text") or "").strip()
        if not text:
            return self._send_json({"error": "内容不能为空"}, 400)
        data = load_data() or {"members": [], "seq": 1000}
        data["annSeq"] = data.get("annSeq", 0) + 1
        ann = {"id": "N%d" % data["annSeq"], "text": text,
               "createdAt": now_iso(), "author": user.get("nickname") or user["username"]}
        anns = data.get("announcements") or []
        anns.insert(0, ann)
        data["announcements"] = anns
        save_data(data)
        return self._send_json(ann, 201)

    def _edit_announcement(self, user, aid, body):
        text = (body.get("text") or "").strip()
        if not text:
            return self._send_json({"error": "内容不能为空"}, 400)
        data = load_data() or {"members": [], "seq": 1000}
        for a in data.get("announcements") or []:
            if a["id"] == aid:
                a["text"] = text
                a["updatedAt"] = now_iso()
                save_data(data)
                return self._send_json(a)
        return self._send_json({"error": "公告不存在"}, 404)

    def _delete_announcement(self, user, aid):
        data = load_data() or {"members": [], "seq": 1000}
        anns = data.get("announcements") or []
        new = [a for a in anns if a["id"] != aid]
        if len(new) == len(anns):
            return self._send_json({"error": "公告不存在"}, 404)
        data["announcements"] = new
        save_data(data)
        return self._send_json({"ok": True})

    def _delete_member(self, mid):
        data = load_data() or {"members": [], "seq": 1000}
        before = len(data["members"])
        data["members"] = [m for m in data["members"] if m["id"] != mid]
        if len(data["members"]) == before:
            return self._send_json({"error": "会员不存在"}, 404)
        save_data(data)
        return self._send_json({"ok": True})

    # -------- 安全响应头 + SPA 回退 --------
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self'; "
            "object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        )
        super().end_headers()

    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.exists(path) and "." not in os.path.basename(self.path):
            self.path = "/index.html"
        return super().send_head()


def main():
    ensure_data()
    handler = functools.partial(Handler, directory=ROOT)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), handler)
    print("=" * 48)
    print(" 会员追踪 已启动")
    print(" 目录: %s" % ROOT)
    print(" 数据: %s" % DATA_FILE)
    print(" 地址: http://0.0.0.0:%d" % PORT)
    print("=" * 48)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
