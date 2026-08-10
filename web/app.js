import * as demo from "./demo-data.js";

/* ------------------------------------------------------------------ */
/* branding                                                            */
/* ------------------------------------------------------------------ */

let brand = {};

async function loadBranding() {
  try {
    brand = await (await fetch("branding.json")).json();
  } catch {
    brand = {};
  }
  const c = brand.colors ?? {};
  for (const [key, value] of Object.entries(c)) {
    if (key.startsWith("_")) continue;
    const cssName = "--" + key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
    document.documentElement.style.setProperty(cssName, value);
  }
  const name = brand.organizationName ?? "Forest Platform";
  document.title = name;
  $("#brand-name").textContent = name;
  $("#footer-org").textContent = name;
  $("#footer-contact").textContent = brand.contact?.email ?? "";

  const mark = $("#brand-mark");
  if (brand.logo?.imageUrl) {
    const img = document.createElement("img");
    img.src = brand.logo.imageUrl;
    img.alt = name;
    img.className = "mark";
    mark.replaceWith(img);
  } else {
    mark.textContent = brand.logo?.emoji ?? "🌿";
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]);
const money = (n) =>
  (brand.donation?.currencySymbol ?? "$") + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

const DEMO = '<span class="badge demo">Demo</span>';
const LIVE = '<span class="badge live">Live</span>';
const BLOCKED = '<span class="badge blocked">No contract</span>';

const uuid = () =>
  ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16),
  );

/** Identity sent with real API calls (the development header shim). */
const identity = {
  actorId: uuid(),
  instanceId: "00000000-0000-7000-8000-000000000001",
  organizationId: uuid(),
  permissions: "project.create",
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-actor-id": identity.actorId,
      "x-instance-id": identity.instanceId,
      "x-organization-id": identity.organizationId,
      "x-permissions": identity.permissions,
      ...(options.headers ?? {}),
    },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* empty body */
  }
  return { status: response.status, ok: response.ok, body };
}

function showResponse(target, result, successMessage) {
  const el = $(target);
  if (!el) return;
  const ok = result.ok;
  el.className = "response " + (ok ? "ok" : "err");
  el.innerHTML =
    `<strong>${ok ? successMessage : "Refused"} — HTTP ${result.status}</strong>` +
    `<pre>${esc(JSON.stringify(result.body, null, 2))}</pre>`;
}

/* projects created during this browser session (see note in the staff view) */
const sessionProjects = [];

/* ------------------------------------------------------------------ */
/* views                                                               */
/* ------------------------------------------------------------------ */

function donorView() {
  const amounts = brand.donation?.suggestedAmounts ?? [25, 75, 200, 500];
  const stats = brand.impactHeadlines ?? [];

  return `
    <div class="stack">
      <section class="hero">
        <h1>${esc(brand.tagline ?? "Keep the forest standing.")}</h1>
        <p class="lede">${esc(brand.mission ?? "")}</p>
        <div class="cta-row">
          <button class="btn accent" data-scroll="#give">Become a supporter</button>
          <button class="btn ghost" data-view-link="field">I work in the field</button>
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Our impact</h2> ${DEMO}</div>
        <p class="section-note">
          Illustrative figures from <code class="mono">web/branding.json</code>. Real numbers will come
          from the platform once the tree and payment contracts exist.
        </p>
        <div class="grid cols-4">
          ${stats
            .map(
              (s) => `<div class="card stat">
                <div class="value">${esc(s.value)}</div>
                <div class="label">${esc(s.label)}</div>
              </div>`,
            )
            .join("")}
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Where your support goes</h2> ${DEMO}</div>
        <div class="grid cols-3">
          ${demo.showcaseProjects
            .map(
              (p) => `<article class="card">
                <h3>${esc(p.name)}</h3>
                <p class="section-note">${esc(p.region)} · ${p.hectares.toLocaleString()} ha · ${p.farmers} farmers</p>
                <p>${esc(p.blurb)}</p>
              </article>`,
            )
            .join("")}
        </div>
      </section>

      <section id="give">
        <div class="section-head"><h2>Give</h2> ${BLOCKED}</div>
        <p class="section-note">
          This form is not connected to anything. Taking money needs a payments contract, and the
          specification has none — no ledger accounts, no payment records, no receipts. FIN-001
          approves an append-only double-entry ledger, but the tables for it do not exist yet.
        </p>
        <div class="card pad-lg" style="max-width:560px">
          <div class="field">
            <label>Amount</label>
            <div class="pill-row" id="amounts">
              ${amounts
                .map(
                  (a, i) =>
                    `<button class="amount-btn" aria-pressed="${i === 1}" data-amount="${a}">${money(a)}</button>`,
                )
                .join("")}
            </div>
            <p class="hint">
              About ${money(brand.donation?.perTreeCost ?? 4.5)} protects one registered tree for a year.
            </p>
          </div>
          <div class="field">
            <label for="d-name">Your name</label>
            <input id="d-name" placeholder="Jane Whitcombe" />
          </div>
          <div class="field">
            <label for="d-email">Email</label>
            <input id="d-email" type="email" placeholder="jane@example.org" />
          </div>
          <div class="field">
            <button class="btn accent" id="give-btn">Give ${money(amounts[1] ?? 75)}</button>
          </div>
          <div id="give-response"></div>
        </div>
      </section>
    </div>`;
}

function staffView() {
  return `
    <div class="stack">
      <section>
        <div class="section-head"><h2>Create a forest project</h2> ${LIVE}</div>
        <p class="section-note">
          This is the one operation the specification fully defines. Submitting writes a real row to
          <code class="mono">forests.projects</code> and emits a <code class="mono">ForestProjectCreated</code>
          event into the outbox, in a single transaction.
        </p>
        <div class="grid cols-2">
          <div class="card">
            <div class="field">
              <label for="p-public-id">Project reference</label>
              <input id="p-public-id" placeholder="rio-negro-2026" />
              <p class="hint">Must be unique. Reusing one returns a 409.</p>
            </div>
            <div class="field">
              <label for="p-org">Lead organization ID</label>
              <input id="p-org" value="" />
              <p class="hint">A UUID. Prefilled with a random one for convenience.</p>
            </div>
            <div class="field">
              <label for="p-region">Region <span style="font-weight:400;color:var(--muted)">(stored as metadata)</span></label>
              <input id="p-region" placeholder="Amazonas" />
            </div>
            <div class="field">
              <button class="btn" id="create-project">Create project</button>
            </div>
            <div id="project-response"></div>
          </div>

          <div class="card">
            <h3>Acting as</h3>
            <p class="section-note">
              There is no login. Release 0 defines no authentication contract, so the backend uses a
              development header shim and refuses to run this way in production.
            </p>
            <div class="field">
              <label for="i-instance">Tenant (x-instance-id)</label>
              <input id="i-instance" value="${esc(identity.instanceId)}" />
              <p class="hint">Must match a seeded instance, or you will get 404.</p>
            </div>
            <div class="field">
              <label for="i-perms">Permissions (x-permissions)</label>
              <input id="i-perms" value="${esc(identity.permissions)}" />
              <p class="hint">Clear this to see a 403 from the permission registry.</p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Projects created here</h2> ${BLOCKED}</div>
        <p class="section-note">
          Only what you created in this browser session. The specification defines no
          <code class="mono">GET /projects</code>, so there is no way to ask the platform what
          projects exist — a listing screen cannot be built until that operation is specified.
        </p>
        <div class="card">
          <div class="table-wrap"><table>
            <thead><tr><th>Reference</th><th>ID</th><th>Created</th></tr></thead>
            <tbody id="session-projects"></tbody>
          </table></div>
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Farmer recruitment pipeline</h2> ${DEMO}</div>
        <div class="grid cols-4">
          ${demo.pipeline
            .map(
              (s) => `<div class="card stat">
                <div class="value">${s.count}</div><div class="label">${esc(s.stage)}</div>
              </div>`,
            )
            .join("")}
        </div>
        <div class="card" style="margin-top:1rem">
          <div class="table-wrap"><table>
            <thead><tr><th>Farmer</th><th>Community</th><th>Hectares</th><th>Parcels</th><th>Trees</th><th>Status</th></tr></thead>
            <tbody>
              ${demo.farmers
                .map(
                  (f) => `<tr>
                    <td>${esc(f.name)}</td><td>${esc(f.community)}</td>
                    <td>${f.hectares}</td><td>${f.parcels}</td><td>${f.trees.toLocaleString()}</td>
                    <td>${esc(f.status)}</td>
                  </tr>`,
                )
                .join("")}
            </tbody>
          </table></div>
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Recent field activity</h2> ${DEMO}</div>
        <div class="card">
          <div class="table-wrap"><table>
            <thead><tr><th>When</th><th>Who</th><th>Activity</th><th>Synced</th></tr></thead>
            <tbody>
              ${demo.fieldActivity
                .map(
                  (a) => `<tr>
                    <td>${esc(a.when)}</td><td>${esc(a.who)}</td><td>${esc(a.what)}</td>
                    <td>${a.synced ? "Yes" : "<em>Pending</em>"}</td>
                  </tr>`,
                )
                .join("")}
            </tbody>
          </table></div>
        </div>
      </section>
    </div>`;
}

function fieldView() {
  return `
    <div class="stack">
      <section>
        <div class="section-head"><h2>Enroll a farmer</h2> ${DEMO}</div>
        <p class="section-note">
          Designed for a phone in the field. Nothing is saved — there is no farmer table and no
          enrollment operation in the specification.
        </p>
        <div class="card pad-lg" style="max-width:560px">
          <div class="field"><label for="f-name">Farmer name</label><input id="f-name" placeholder="Ana Ribeiro" /></div>
          <div class="field"><label for="f-community">Community</label><input id="f-community" placeholder="São Gabriel" /></div>
          <div class="field"><label for="f-hectares">Hectares</label><input id="f-hectares" type="number" min="0" placeholder="42" /></div>
          <div class="field">
            <label for="f-consent">Consent given for</label>
            <select id="f-consent">
              <option>Conservation payments only</option>
              <option>Payments and public reporting</option>
              <option>Payments, reporting and research</option>
            </select>
            <p class="hint">
              CONSENT-001 requires record-level permitted uses. The wording here is a placeholder —
              the consent contract does not exist yet.
            </p>
          </div>
          <div class="field"><button class="btn" id="enroll-btn">Save enrollment</button></div>
          <div id="enroll-response"></div>
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Submit a parcel boundary</h2> ${LIVE}</div>
        <p class="section-note">
          This button calls the real endpoint. Watch what comes back — the platform enforces
          everything it can (permission, tenant, idempotency key) and then refuses, listing exactly
          which contracts are missing. This is the honest state of the system, not a bug.
        </p>
        <div class="card" style="max-width:560px">
          <div class="field"><button class="btn" id="boundary-btn">Submit boundary for a parcel</button></div>
          <div id="boundary-response"></div>
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Offline queue</h2> ${DEMO}</div>
        <p class="section-note">
          ADR-028 calls for offline-first field work, but no sync or conflict-resolution contract
          exists, so this queue is a mock-up of the idea rather than a working feature.
        </p>
        <div class="card">
          <div class="table-wrap"><table>
            <thead><tr><th>Captured</th><th>Activity</th><th>State</th></tr></thead>
            <tbody>
              ${demo.fieldActivity
                .map(
                  (a) =>
                    `<tr><td>${esc(a.when)}</td><td>${esc(a.what)}</td><td>${a.synced ? "Uploaded" : "<em>Waiting for signal</em>"}</td></tr>`,
                )
                .join("")}
            </tbody>
          </table></div>
        </div>
      </section>
    </div>`;
}

async function statusView() {
  const [health, spec, gaps] = await Promise.all([
    api("/health"),
    api("/internal/specification"),
    api("/internal/contract-gaps"),
  ]);

  const s = spec.body ?? {};
  const gapList = gaps.body?.gaps ?? [];

  return `
    <div class="stack">
      <section>
        <div class="section-head"><h2>Platform status</h2> ${LIVE}</div>
        <div class="grid cols-4">
          <div class="card stat"><div class="value">${health.ok ? "Healthy" : "Down"}</div><div class="label">API</div></div>
          <div class="card stat"><div class="value">${s.specVersion ?? "—"}</div><div class="label">Spec version</div></div>
          <div class="card stat"><div class="value">${(s.requirements ?? []).length}</div><div class="label">Requirements</div></div>
          <div class="card stat"><div class="value">${gapList.length}</div><div class="label">Open contract gaps</div></div>
        </div>
      </section>

      <section>
        <div class="section-head"><h2>What is missing before this is a real product</h2></div>
        <p class="section-note">
          Each entry is a document somebody has to write and approve. Until then the platform
          refuses the operation rather than guessing at it.
        </p>
        <div class="grid cols-2">
          ${gapList
            .map(
              (g) => `<article class="card">
                <h3>${esc(g.operation)}</h3>
                <p class="section-note">Blocks: ${(g.blockedRequirementIds ?? []).map(esc).join(", ") || "—"}</p>
                <ul>${(g.missingArtifacts ?? []).map((a) => `<li><code class="mono">${esc(a)}</code></li>`).join("")}</ul>
                ${g.notes ? `<p class="hint">${esc(g.notes)}</p>` : ""}
              </article>`,
            )
            .join("")}
        </div>
      </section>

      <section>
        <div class="section-head"><h2>Approved permissions</h2> ${LIVE}</div>
        <div class="card"><div class="table-wrap"><table>
          <thead><tr><th>Code</th><th>Risk</th><th>Step-up</th><th>Approval policy</th></tr></thead>
          <tbody>
            ${(s.permissions ?? [])
              .map(
                (p) => `<tr>
                  <td><code class="mono">${esc(p.code)}</code></td><td>${esc(p.riskLevel)}</td>
                  <td>${esc(p.stepUpAuthentication ?? "—")}</td><td>${esc(p.approvalPolicy ?? "—")}</td>
                </tr>`,
              )
              .join("")}
          </tbody>
        </table></div></div>
      </section>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

function renderSessionProjects() {
  const body = $("#session-projects");
  if (!body) return;
  body.innerHTML = sessionProjects.length
    ? sessionProjects
        .map(
          (p) =>
            `<tr><td>${esc(p.publicId)}</td><td><code class="mono">${esc(p.id)}</code></td><td>${esc(
              new Date(p.createdAt).toLocaleString(),
            )}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="empty">Nothing yet — create a project above.</td></tr>`;
}

function bind(view) {
  if (view === "donor") {
    let chosen = brand.donation?.suggestedAmounts?.[1] ?? 75;
    document.querySelectorAll("#amounts .amount-btn").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll("#amounts .amount-btn").forEach((x) => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        chosen = Number(b.dataset.amount);
        $("#give-btn").textContent = `Give ${money(chosen)}`;
      }),
    );
    $("#give-btn")?.addEventListener("click", () => {
      const el = $("#give-response");
      el.className = "response err";
      el.innerHTML =
        `<strong>Not connected</strong><p style="margin:.5rem 0 0">` +
        `A ${money(chosen)} gift cannot be taken yet. Accepting money needs a payments and ledger ` +
        `contract; FIN-001 approves the ledger but no tables, accounts or receipt records are defined. ` +
        `Nothing was charged and nothing was stored.</p>`;
    });
  }

  if (view === "staff") {
    $("#p-org").value = uuid();
    renderSessionProjects();

    $("#i-instance")?.addEventListener("input", (e) => (identity.instanceId = e.target.value.trim()));
    $("#i-perms")?.addEventListener("input", (e) => (identity.permissions = e.target.value.trim()));

    $("#create-project")?.addEventListener("click", async () => {
      const publicId = $("#p-public-id").value.trim();
      const leadOrganizationId = $("#p-org").value.trim();
      const region = $("#p-region").value.trim();
      if (!publicId) {
        $("#p-public-id").focus();
        return;
      }
      const payload = { publicId, leadOrganizationId };
      if (region) payload.metadata = { region };

      const result = await api("/api/v1/projects", { method: "POST", body: JSON.stringify(payload) });
      showResponse("#project-response", result, "Project created");
      if (result.ok) {
        sessionProjects.unshift(result.body);
        renderSessionProjects();
        $("#p-public-id").value = "";
        $("#p-org").value = uuid();
      }
    });
  }

  if (view === "field") {
    $("#enroll-btn")?.addEventListener("click", () => {
      const el = $("#enroll-response");
      const name = $("#f-name").value.trim() || "this farmer";
      el.className = "response err";
      el.innerHTML =
        `<strong>Not saved</strong><p style="margin:.5rem 0 0">` +
        `There is nowhere to put ${esc(name)}. The specification defines no farmer record, no ` +
        `enrollment operation, and no consent record — CONSENT-001 is approved but its schema was ` +
        `never written. This screen shows what the flow would look like.</p>`;
    });

    $("#boundary-btn")?.addEventListener("click", async () => {
      const result = await api(`/api/v1/parcels/${uuid()}/boundaries`, {
        method: "POST",
        headers: { "idempotency-key": uuid(), "x-permissions": "parcel.submit_boundary" },
        body: JSON.stringify({}),
      });
      showResponse("#boundary-response", result, "Accepted");
    });
  }

  document.querySelectorAll("[data-scroll]").forEach((b) =>
    b.addEventListener("click", () => $(b.dataset.scroll)?.scrollIntoView({ behavior: "smooth" })),
  );
  document.querySelectorAll("[data-view-link]").forEach((b) =>
    b.addEventListener("click", () => show(b.dataset.viewLink)),
  );
}

async function show(view) {
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.setAttribute("aria-current", String(b.dataset.view === view)),
  );
  const target = $("#view");
  target.innerHTML = `<p class="empty">Loading…</p>`;
  const html =
    view === "donor" ? donorView() : view === "staff" ? staffView() : view === "field" ? fieldView() : await statusView();
  target.innerHTML = html;
  window.scrollTo({ top: 0 });
  bind(view);
}

await loadBranding();
document.querySelectorAll("#tabs button").forEach((b) =>
  b.addEventListener("click", () => show(b.dataset.view)),
);
await show("donor");
