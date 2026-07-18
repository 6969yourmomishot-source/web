// dc-both-check
const $ = (s) => document.querySelector(s);
let setupMode = false;

async function init() {
  try {
    const r = await fetch("/api/needs-setup").then((r) => r.json());
    setupMode = !!r.setup;
  } catch (e) {}
  if (setupMode) {
    $("#title").textContent = "首次设置";
    $("#hint").textContent = "第一次使用，请创建管理员账号";
    $("#submit").textContent = "创建管理员";
  }
}

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("#username").value.trim();
  const password = $("#password").value;
  const err = $("#err");
  err.textContent = "";
  if (!username || !password) { err.textContent = "请输入账号和密码"; return; }
  $("#submit").disabled = true;
  try {
    const res = await fetch(setupMode ? "/api/bootstrap" : "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { err.textContent = data.error || "失败"; $("#submit").disabled = false; return; }
    location.href = "/";
  } catch (e) {
    err.textContent = "网络错误，请重试";
    $("#submit").disabled = false;
  }
});

init();
