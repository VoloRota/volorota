/** Minimal server-rendered HTML helpers — no React, no client framework. */

export function layout(title: string, body: string, opts?: { loggedIn?: boolean }): string {
  const showLogout = opts?.loggedIn !== false;
  const nav = `
  <nav class="top-nav">
    <a class="brand" href="/admin">VoloRota</a>
    <a href="/admin/matrix">Matrix</a>
    <a href="/admin/people">People</a>
    <a href="/admin/teams">Teams</a>
    <a href="/admin/templates">Templates</a>
    <a href="/admin/services">Services</a>
    <a href="/admin/outbox">Outbox</a>
    ${showLogout
      ? `<form method="POST" action="/admin/logout" style="margin-left:auto">
           <button type="submit" class="btn-logout">Sign out</button>
         </form>`
      : ""}
  </nav>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(title)} — VoloRota</title>
  <link rel="stylesheet" href="/static/style.css" />
</head>
<body>
  ${nav}
  <main>${body}</main>
  <footer class="site-footer">
    <span>VoloRota</span>
    <span class="footer-sep">·</span>
    <span>AGPL-3.0</span>
    <span class="footer-sep">·</span>
    <span>self-hosted</span>
  </footer>
</body>
</html>`;
}

export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function flash(msg: string | null, type: "error" | "success" = "success"): string {
  if (!msg) return "";
  return `<div class="flash flash-${escHtml(type)}">${escHtml(msg)}</div>`;
}
