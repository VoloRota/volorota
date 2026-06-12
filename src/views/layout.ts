/** Minimal server-rendered HTML helpers — no React, no client framework. */

/**
 * Favicon as an inline SVG data URI — the brand mark (roster grid with a lit
 * diagonal), zero extra requests so the no-third-party guard stays trivially true.
 */
export const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Crect width='128' height='128' rx='24' fill='%230f172a'/%3E%3Cg%3E%3Crect x='12' y='12' width='22' height='22' rx='5' fill='%231e293b'/%3E%3Crect x='41' y='12' width='22' height='22' rx='5' fill='%231e293b'/%3E%3Crect x='70' y='12' width='22' height='22' rx='5' fill='%231e293b'/%3E%3Crect x='99' y='12' width='22' height='22' rx='5' fill='%23134e4a'/%3E%3Crect x='12' y='41' width='22' height='22' rx='5' fill='%231e293b'/%3E%3Crect x='41' y='41' width='22' height='22' rx='5' fill='%231e293b'/%3E%3Crect x='70' y='41' width='22' height='22' rx='5' fill='%231e293b'/%3E%3Crect x='99' y='41' width='22' height='22' rx='5' fill='%230f766e'/%3E%3Crect x='12' y='70' width='22' height='22' rx='5' fill='%23115e59'/%3E%3Crect x='41' y='70' width='22' height='22' rx='5' fill='%231e293b'/%3E%3Crect x='70' y='70' width='22' height='22' rx='5' fill='%2314b8a6'/%3E%3Crect x='99' y='70' width='22' height='22' rx='5' fill='%231e293b'/%3E%3Crect x='12' y='99' width='22' height='22' rx='5' fill='%231e293b'/%3E%3Crect x='41' y='99' width='22' height='22' rx='5' fill='%235eead4'/%3E%3Crect x='70' y='99' width='22' height='22' rx='5' fill='%231e293b'/%3E%3Crect x='99' y='99' width='22' height='22' rx='5' fill='%231e293b'/%3E%3C/g%3E%3C/svg%3E">`;

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
  ${FAVICON_LINK}
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
