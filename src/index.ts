import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { getDb } from "./db/schema.js";
import { peopleRouter } from "./routes/people.js";
import { teamsRouter } from "./routes/teams.js";
import { templatesRouter } from "./routes/templates.js";
import { servicesRouter } from "./routes/services.js";
import { layout } from "./views/layout.js";

// Initialize DB on startup
getDb();

const app = new Hono();

// Static files
app.use("/static/*", serveStatic({ root: "./public", rewriteRequestPath: (p) => p.replace(/^\/static/, "") }));

// Admin redirect
app.get("/", (c) => c.redirect("/admin"));
app.get("/admin", (c) => {
  const body = `
    <h1>VoloRota Admin</h1>
    <p>Welcome to the VoloRota church volunteer scheduler.</p>
    <ul>
      <li><a href="/admin/people">People</a> — manage your volunteer roster</li>
      <li><a href="/admin/teams">Teams</a> — define teams, roles, and crew assignments</li>
      <li><a href="/admin/templates">Templates</a> — configure recurring service schedules</li>
      <li><a href="/admin/services">Services</a> — generate and manage service instances</li>
    </ul>`;
  return c.html(layout("Dashboard", body));
});

// Mount routers
app.route("/admin/people", peopleRouter);
app.route("/admin/teams", teamsRouter);
app.route("/admin/templates", templatesRouter);
app.route("/admin/services", servicesRouter);

const port = Number(process.env.PORT ?? 3000);

export default {
  port,
  fetch: app.fetch,
};
