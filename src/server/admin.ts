import { Config } from "../config/index.js";

/**
 * Render the self-contained local admin page. Inline CSS+JS only — no
 * external assets, no CDN (selfhosted philosophy). The token is embedded in
 * a <script> variable for the page's own fetch() calls; it never appears in
 * the public server's output.
 */
export function renderAdminPage(config: Config): string {
  const scheme = JSON.stringify(config.scheme);
  const baseUrl = JSON.stringify(config.base_url);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>uptool admin</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem; background: #16171a; color: #e4e4e7;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0 0 1rem; color: #f4f4f5; }
  h1 span { color: #71717a; font-weight: 400; }
  table { width: 100%; border-collapse: collapse; background: #1c1d21; border: 1px solid #2b2c31; border-radius: 6px; overflow: hidden; }
  th, td { padding: .55rem .75rem; text-align: left; border-bottom: 1px solid #2b2c31; }
  th { color: #a1a1aa; font-weight: 500; font-size: .75rem; text-transform: uppercase; letter-spacing: .03em; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #202127; }
  a { color: #7dd3fc; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .lock { color: #fbbf24; margin-left: .35rem; cursor: default; }
  button.del {
    background: #3a1d1f; color: #fca5a5; border: 1px solid #5c2a2d; border-radius: 4px;
    padding: .3rem .6rem; cursor: pointer; font-size: .8rem;
  }
  button.del:hover { background: #4a2226; }
  .empty { color: #71717a; padding: 1.5rem; text-align: center; }
  .status { color: #71717a; font-size: .8rem; margin-top: .75rem; }
  .muted { color: #71717a; }
</style>
</head>
<body>
  <h1>uptool <span>admin</span></h1>
  <table id="tbl">
    <thead>
      <tr>
        <th>Slug</th><th>Name</th><th>File</th><th>Created</th><th>Expires</th><th>Link</th><th></th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="status" id="status">loading…</div>

<script>
(function () {
  var token = new URLSearchParams(location.search).get("token") || "";
  // Scrub the token from the URL bar / history without reloading.
  history.replaceState({}, "", location.pathname);

  var SCHEME = ${scheme};
  var BASE_URL = ${baseUrl};

  function publicUrl(slug) {
    return SCHEME + "://" + slug + "." + BASE_URL;
  }

  function relTime(ms) {
    if (!ms) return "never";
    var diff = ms - Date.now();
    var abs = Math.abs(diff);
    var units = [
      ["d", 86400000], ["h", 3600000], ["m", 60000], ["s", 1000]
    ];
    var out = "";
    for (var i = 0; i < units.length; i++) {
      if (abs >= units[i][1]) { out = Math.floor(abs / units[i][1]) + units[i][0]; break; }
    }
    if (!out) out = "now";
    return diff >= 0 ? "in " + out : out + " ago";
  }

  function api(method, path) {
    return fetch(path, { method: method, headers: { Authorization: "Bearer " + token } })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function render(files) {
    var rows = document.getElementById("rows");
    if (!files.length) {
      rows.innerHTML = '<tr><td colspan="7" class="empty">No deployments yet.</td></tr>';
      return;
    }
    rows.innerHTML = files.map(function (f) {
      var url = publicUrl(f.slug);
      var hits = (f.hits !== undefined) ? '<span class="muted"> · ' + f.hits + ' hits</span>' : "";
      return '<tr data-slug="' + escapeHtml(f.slug) + '">' +
        '<td>' + escapeHtml(f.slug) + (f.key ? '<span class="lock" title="protected">&#128274;</span>' : '') + '</td>' +
        '<td>' + escapeHtml(f.name || "") + '</td>' +
        '<td>' + escapeHtml(f.filename) + hits + '</td>' +
        '<td>' + relTime(f.created) + '</td>' +
        '<td>' + relTime(f.expires) + '</td>' +
        '<td><a href="' + url + '" target="_blank" rel="noopener">preview</a></td>' +
        '<td><button class="del">Delete</button></td>' +
        '</tr>';
    }).join("");

    var buttons = rows.querySelectorAll("button.del");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", function (ev) {
        var tr = ev.target.closest("tr");
        var slug = tr.getAttribute("data-slug");
        if (!confirm("Delete deployment " + slug + "?")) return;
        api("DELETE", "/files/" + slug).then(function () { load(); });
      });
    }
  }

  function load() {
    api("GET", "/files").then(function (res) {
      var status = document.getElementById("status");
      if (!res.ok) { status.textContent = "error loading deployments"; return; }
      render(res.body.files || []);
      status.textContent = res.body.files.length + " deployment(s) · refreshed " + new Date().toLocaleTimeString();
    }).catch(function () {
      document.getElementById("status").textContent = "connection error";
    });
  }

  load();
  setInterval(load, 10000);
})();
</script>
</body>
</html>
`;
}
