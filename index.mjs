/**
 * railway: Railway for Bridex agents, through the official Railway CLI.
 *
 * Every call runs the CLI bundled with the plugin (node_modules/@railway/cli,
 * pinned in package.json — its install step downloads the binary) with the
 * configured account/workspace token in RAILWAY_API_TOKEN and a private HOME
 * under the instance state. Agents never see the token: their shell has no
 * RAILWAY_* at all, and the environment the CLI gets is minimal, so the
 * instance's other secrets do not reach it either.
 *
 * A deploy uploads a folder of the calling agent's workspace (.gitignore
 * respected) with `railway up --detach`, finds the deployment it created and
 * follows it: settled within the inline window → the result comes back in the
 * call; longer → a tracked job (it survives a server restart) that wakes the
 * agent in its conversation when the deployment settles, with the tail of the
 * build or deploy log on failure.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "node_modules", "@railway", "cli", "bin", process.platform === "win32" ? "railway.exe" : "railway");
const TEXT_CAP = 6000;
const POLL_MS = 5_000;
const WATCH_MS = 15_000;
const GIVE_UP_MS = 60 * 60_000;
/** Deployment states that end a deploy. SLEEPING is an app gone idle after a good start. */
const OK = new Set(["SUCCESS", "SLEEPING"]);
const BAD = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nodes = (conn) => (conn?.edges ?? []).map((e) => e.node);
const when = (iso) => String(iso ?? "").slice(0, 16).replace("T", " ");

export default async function activate(ctx) {
  const { z, log } = ctx;
  const cfg = ctx.config ?? {};
  const resolve = (v) => String(v ?? "").replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] ?? "");
  const token = resolve(cfg.api_token || "${RAILWAY_API_TOKEN}").trim();
  const defaultWorkspace = String(cfg.workspace ?? "").trim();
  const syncS = Math.min(170, Number(cfg.sync_s) > 0 ? Number(cfg.sync_s) : 120);
  if (!token) {
    ctx.needsConfig("add a Railway account or workspace token in Settings → Integrations → Railway, or in this plugin's setup");
    return;
  }
  // the binary comes from @railway/cli's install script: an install that
  // skipped scripts leaves only the JS shim
  if (!fs.existsSync(BIN)) throw new Error(`the Railway CLI binary is missing (${BIN}) — reinstall the plugin: its npm install downloads the CLI`);

  const home = path.join(ctx.paths.state, "plugins", "railway");
  fs.mkdirSync(home, { recursive: true });

  const clip = (s, n = TEXT_CAP) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
  const scrub = (s) => String(s ?? "").split(token).join("***");
  const text = (t) => ({ content: [{ type: "text", text: scrub(t) }] });
  const fail = (e) => text(`error: ${e?.message ?? e}`);

  /** Run the CLI; resolves { code, out, err } and only rejects when it cannot start. */
  function cli(args, { cwd = home, input = null, timeoutMs = 90_000 } = {}) {
    return new Promise((res, rej) => {
      const env = {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: home,
        LANG: process.env.LANG ?? "C.UTF-8",
        RAILWAY_API_TOKEN: token,
        NO_COLOR: "1",
        DO_NOT_TRACK: "1",
      };
      const child = spawn(BIN, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => {
        if (out.length < 4_000_000) out += d;
      });
      child.stderr.on("data", (d) => {
        if (err.length < 400_000) err += d;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        err += `\n(stopped after ${Math.round(timeoutMs / 1000)} s)`;
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        rej(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        res({ code: code ?? 1, out, err });
      });
      child.stdin.end(input ?? undefined);
    });
  }

  const cliError = (r) => clip(scrub((r.err || r.out || `exit ${r.code}`).trim()), 1500);

  /** A --json command's parsed output; a banner printed before the JSON is skipped. */
  async function cliJson(args, opts) {
    const r = await cli([...args, "--json"], opts);
    if (r.code !== 0) throw new Error(cliError(r));
    const at = r.out.search(/[[{]/);
    try {
      return JSON.parse(at > 0 ? r.out.slice(at) : r.out);
    } catch {
      throw new Error(`unexpected output from railway ${args[0]}: ${clip(scrub(r.out || r.err), 400)}`);
    }
  }

  // -- projects by name or ID ----------------------------------------------
  let cache = { at: 0, list: [] };
  async function projects(fresh = false) {
    if (!fresh && Date.now() - cache.at < 30_000) return cache.list;
    const list = await cliJson(["list"]);
    cache = { at: Date.now(), list: Array.isArray(list) ? list : [] };
    return cache.list;
  }
  async function projectId(p) {
    const s = String(p ?? "").trim();
    if (!s) throw new Error("name the project (its name or ID — railway_projects lists them)");
    for (const fresh of [false, true]) {
      const hits = (await projects(fresh)).filter((x) => x.id === s || x.name === s);
      if (hits.length === 1) return hits[0].id;
      if (hits.length > 1) throw new Error(`${hits.length} projects are named «${s}» — pass the ID: ${hits.map((x) => x.id).join(", ")}`);
    }
    throw new Error(`no project «${s}» visible to this token — railway_projects lists them`);
  }

  // -- deployments ---------------------------------------------------------
  async function deployments(project, env, service, limit = 10) {
    const list = await cliJson(["deployment", "list", "--project", project, "--environment", env, "--service", service, "--limit", String(limit)]);
    return Array.isArray(list) ? list : [];
  }
  async function statusOf(project, env, service, id) {
    return (await deployments(project, env, service, 20)).find((d) => d.id === id)?.status ?? null;
  }
  async function waitFor(project, env, service, id, deadline) {
    while (Date.now() < deadline) {
      const s = await statusOf(project, env, service, id).catch(() => null);
      if (s && (OK.has(s) || BAD.has(s))) return s;
      await sleep(POLL_MS);
    }
    return null;
  }

  function formatLogs(out) {
    return out
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          const j = JSON.parse(l);
          const level = j.level && j.level !== "info" ? `[${j.level}] ` : "";
          const http = j.httpStatus ? `${j.method ?? ""} ${j.path ?? ""} → ${j.httpStatus} ${j.totalDuration ?? ""}ms` : "";
          return `${String(j.timestamp ?? "").slice(11, 19)} ${level}${http || String(j.message ?? "").trimEnd()}`;
        } catch {
          return l;
        }
      })
      .join("\n");
  }
  async function logTail(project, env, service, id, kind, lines) {
    const flag = { deploy: "--deployment", build: "--build", http: "--http" }[kind];
    const r = await cli(["logs", ...(id ? [id] : []), "--project", project, "--environment", env, "--service", service, flag, "--lines", String(lines), "--json"], { timeoutMs: 60_000 });
    if (r.code !== 0) return `(logs unavailable: ${cliError(r)})`;
    return clip(formatLogs(r.out), 4000) || "(no log lines)";
  }

  /** The sentence an agent gets when a deploy settles. */
  async function outcome(project, env, service, id, status) {
    if (OK.has(status)) {
      const doms = await cliJson(["domain", "list", "--project", project, "--environment", env, "--service", service]).catch(() => null);
      const urls = (doms?.domains ?? []).map((d) => `https://${d.domain}`);
      return `deployed: ${service} is ${status} (deployment ${id}).${urls.length ? ` ${urls.join(" ")}` : " No domain yet — railway_service action=domain generates one."}`;
    }
    // CRASHED: the build was fine and the app fell over; otherwise the build is where it broke
    const kind = status === "CRASHED" ? "deploy" : "build";
    const more = kind === "build" ? "railway_logs kind=build reads more; kind=deploy is the app's own output" : "railway_logs reads more";
    return `${status}: ${service}, deployment ${id}. Last ${kind} log lines (${more}):\n${await logTail(project, env, service, id, kind, 60)}`;
  }

  // -- background deploys: tracked, survive a restart, wake the agent -------
  const watching = new Map();
  let timer = null;
  function arm() {
    if (timer) return;
    timer = setInterval(() => void tick(), WATCH_MS);
    timer.unref?.();
  }
  function settle(depId, w, status, summary) {
    watching.delete(depId);
    ctx.jobs.settle(w.trackId, OK.has(status) ? { status: "succeeded", result: { status } } : { status: "failed", error: clip(scrub(summary), 600) });
    ctx.wakeAgent({
      workspace: w.workspace,
      agent: w.agent,
      key: `railway:${depId}`,
      prompt: scrub(`Railway deploy of ${w.service} settled — ${summary}`),
      ...(w.sessionKey ? { sessionKey: w.sessionKey } : {}),
    });
  }
  async function tick() {
    for (const [depId, w] of [...watching]) {
      try {
        const s = await statusOf(w.project, w.environment, w.service, depId);
        if (s && (OK.has(s) || BAD.has(s))) settle(depId, w, s, await outcome(w.project, w.environment, w.service, depId, s));
        else if (Date.now() - w.since > GIVE_UP_MS) settle(depId, w, "FAILED", `still ${s ?? "unknown"} after an hour — look at railway_logs kind=build`);
      } catch (e) {
        log.warn(`watching ${depId}: ${e.message}`);
      }
    }
    if (!watching.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  for (const j of ctx.jobs.pending()) {
    if (j.model !== "railway") continue;
    const params = ctx.jobs.find(j.externalId)?.result?.params;
    if (!params?.project || !params?.service) {
      ctx.jobs.settle(j.id, { status: "failed", error: "lost track of the deploy across a restart" });
      continue;
    }
    watching.set(j.externalId, { trackId: j.id, workspace: j.workspace, agent: j.agent, sessionKey: j.sessionKey, project: params.project, environment: params.environment ?? "production", service: params.service, since: Date.parse(j.createdAt) || Date.now() });
  }
  if (watching.size) arm();
  ctx.onShutdown(() => timer && clearInterval(timer));

  /** The folder to upload: inside the calling agent's workspace, nowhere else. */
  function folderFor(call, p) {
    const ws = ctx.paths.workspace(call.workspace);
    const checkout = call.taskId ? path.join(ws, "work", call.taskId) : null;
    const base = checkout && fs.existsSync(checkout) ? checkout : ctx.paths.workspaceWorkdir(call.workspace);
    const abs = p ? path.resolve(base, p) : base;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`no such folder: ${abs}`);
    const real = fs.realpathSync(abs);
    const root = fs.realpathSync(ws);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`the folder must be inside your workspace (${ws})`);
    return real;
  }

  const mask = (v) => {
    const s = String(v ?? "");
    // a reference to another service's variable is wiring, not a secret
    return s.startsWith("${{") ? s : `•••• (${s.length} chars)`;
  };
  const scopeArgs = (id, a) => ["--project", id, "--environment", a.environment || "production", "--service", a.service];

  // -- tools ---------------------------------------------------------------
  ctx.registerTool({
    name: "railway_projects",
    description:
      "Railway projects this instance reaches. Without `project`: every project with its environments and services. With `project` (name or ID): one environment of it (production by default) — each service with its latest deployment (status, id, when, message), domains and replicas.",
    schema: {
      project: z.string().optional().describe("project name or ID"),
      environment: z.string().optional().describe("environment name (default production)"),
    },
    async handler(a) {
      try {
        if (!a.project) {
          const list = await projects(true);
          if (!list.length) return text("No projects visible to this token.");
          return text(
            list
              .map((p) => `${p.name} (${p.id}) — workspace ${p.workspace?.name ?? "?"}; environments: ${nodes(p.environments).map((e) => e.name).join(", ") || "—"}; services: ${nodes(p.services).map((s) => s.name).join(", ") || "—"}`)
              .join("\n"),
          );
        }
        const id = await projectId(a.project);
        const env = a.environment || "production";
        const st = await cliJson(["status", "--project", id, "--environment", env]);
        const en = nodes(st.environments).find((e) => e.name === env) ?? nodes(st.environments)[0];
        if (!en) return text(`${st.name}: no environment «${env}»`);
        const lines = nodes(en.serviceInstances).map((si) => {
          const d = si.latestDeployment;
          const doms = [...(si.domains?.customDomains ?? []), ...(si.domains?.serviceDomains ?? [])].map((x) => `https://${x.domain}`);
          const msg = d?.meta?.cliMessage || d?.meta?.commitMessage || "";
          const state = d ? `${d.status ?? d.instances?.[0]?.status ?? "?"} · deployment ${d.id} · ${when(d.createdAt)}${msg ? ` · «${clip(msg, 80)}»` : ""}` : "never deployed";
          return `- ${si.serviceName} (${si.serviceId}): ${state}${doms.length ? ` · ${doms.join(" ")}` : ""}${si.numReplicas ? ` · ${si.numReplicas} replica(s)` : ""}`;
        });
        return text(`${st.name} (${st.id}), environment ${en.name}:\n${lines.join("\n") || "(no services yet)"}`);
      } catch (e) {
        return fail(e);
      }
    },
  });

  ctx.registerTool({
    name: "railway_create",
    description:
      "Create on Railway: a project (kind=project, name), a service in a project (kind=service, name; optionally from a Docker `image` or a GitHub `repo`) or a database (kind=database: postgres, mysql, redis or mongo). A new service stays empty until railway_deploy uploads code to it, unless its image or repo builds. A database exposes its connection string as a variable (DATABASE_URL on Postgres): hand it to a service with railway_variables, value ${{Postgres.DATABASE_URL}}.",
    schema: {
      kind: z.enum(["project", "service", "database"]),
      name: z.string().optional().describe("project or service name"),
      project: z.string().optional().describe("project name or ID (for a service or a database)"),
      environment: z.string().optional().describe("default production"),
      workspace: z.string().optional().describe("Railway workspace for a new project, when the token sees several"),
      database: z.enum(["postgres", "mysql", "redis", "mongo"]).optional(),
      image: z.string().optional().describe("a service from a Docker image, e.g. nginx:latest"),
      repo: z.string().optional().describe("a service from a GitHub repo owner/name (the Railway GitHub app must reach it)"),
      branch: z.string().optional(),
    },
    async handler(a) {
      try {
        if (a.kind === "project") {
          if (!a.name) throw new Error("name the project");
          const ws = a.workspace || defaultWorkspace;
          const r = await cliJson(["init", "--name", a.name, ...(ws ? ["--workspace", ws] : [])]);
          cache.at = 0;
          return text(`project «${a.name}» created: ${clip(JSON.stringify(r), 1200)}`);
        }
        if (a.kind === "service" && !a.name) throw new Error("name the service");
        const id = await projectId(a.project);
        const env = a.environment || "production";
        // `railway add` works on a linked directory only: one per project and environment, in the plugin's HOME
        const dir = path.join(home, "links", `${id}-${env}`.replace(/[^\w.-]/g, "_"));
        fs.mkdirSync(dir, { recursive: true });
        const ln = await cli(["link", "--project", id, "--environment", env, "--json"], { cwd: dir });
        if (ln.code !== 0) throw new Error(`link: ${cliError(ln)}`);
        const args =
          a.kind === "database"
            ? ["add", "--database", a.database ?? "postgres"]
            : ["add", "--service", a.name, ...(a.image ? ["--image", a.image] : []), ...(a.repo ? ["--repo", a.repo, ...(a.branch ? ["--branch", a.branch] : [])] : [])];
        const r = await cliJson(args, { cwd: dir, timeoutMs: 180_000 });
        cache.at = 0;
        return text(`${a.kind === "database" ? `${a.database ?? "postgres"} database` : `service «${a.name}»`} created in ${id} (${env}): ${clip(JSON.stringify(r), 1200)}`);
      } catch (e) {
        return fail(e);
      }
    },
  });

  ctx.registerTool({
    name: "railway_deploy",
    description: `Deploy a folder of your workspace to a Railway service: the folder is uploaded (.gitignore respected) and built there — its Dockerfile when it has one, Railway's builder otherwise. The call waits up to ${syncS} s; a deploy still building by then goes on in the background and wakes you in this conversation when it settles — END your run then. A failure comes back with the tail of the build or deploy log. The default folder is your task's checkout, or your working directory when the task has none.`,
    schema: {
      project: z.string().describe("project name or ID"),
      service: z.string().describe("service name or ID (railway_create kind=service makes one)"),
      environment: z.string().optional().describe("default production"),
      path: z.string().optional().describe("the folder: relative to your task's checkout or working directory, or an absolute path inside your workspace"),
      message: z.string().max(200).optional().describe("what this deploy is — shown in Railway"),
    },
    async handler(a, call) {
      try {
        // the folder first: a wrong path needs no round trip to Railway
        const dir = folderFor(call, a.path);
        const id = await projectId(a.project);
        const env = a.environment || "production";
        const started = Date.now();
        const message = a.message || `@${call.agent}${call.taskId ? ` · ${call.taskId}` : ""}`;
        const up = await cli(["up", "--detach", "--project", id, "--environment", env, "--service", a.service, "--message", message], { cwd: dir, timeoutMs: 600_000 });
        if (up.code !== 0) throw new Error(`upload failed: ${cliError(up)}`);
        // the build-logs link carries the deployment id; failing that, the newest deployment since the upload
        let depId = (up.out.match(/[?&]id=([0-9a-f-]{36})/) ?? [])[1] ?? null;
        for (let i = 0; !depId && i < 6; i++) {
          depId = (await deployments(id, env, a.service, 5)).find((d) => Date.parse(d.createdAt) >= started - 10_000)?.id ?? null;
          if (!depId) await sleep(3000);
        }
        if (!depId) return text(`uploaded, but the new deployment has not shown up yet — railway_service action=deployments will list it.\n${clip(up.out.trim(), 800)}`);
        const status = await waitFor(id, env, a.service, depId, started + syncS * 1000);
        if (status) return text(await outcome(id, env, a.service, depId, status));
        const trackId = ctx.jobs.track({
          workspace: call.workspace,
          agent: call.agent,
          taskId: call.taskId,
          sessionKey: call.sessionKey,
          runId: call.runId,
          externalId: depId,
          model: "railway",
          label: `deploy ${a.service}`,
          params: { project: id, environment: env, service: a.service },
        });
        watching.set(depId, { trackId, workspace: call.workspace, agent: call.agent, sessionKey: call.sessionKey, project: id, environment: env, service: a.service, since: started });
        arm();
        return text(`Deploying ${a.service} (deployment ${depId}), still building after ${syncS} s. END your run — you will be woken in this conversation when it settles.`);
      } catch (e) {
        return fail(e);
      }
    },
  });

  ctx.registerTool({
    name: "railway_logs",
    description:
      "Logs of a Railway service: deploy (the app's own output — the default), build, or http (requests). The latest deployment unless `deployment` names one. `filter` takes Railway's query syntax: plain text, @level:error, and for http @httpStatus:>=500, @path:/api.",
    schema: {
      project: z.string().describe("project name or ID"),
      service: z.string().describe("service name or ID"),
      environment: z.string().optional().describe("default production"),
      kind: z.enum(["deploy", "build", "http"]).optional(),
      deployment: z.string().optional().describe("deployment ID (default: the latest)"),
      lines: z.number().int().min(1).max(500).optional().describe("default 100"),
      filter: z.string().optional(),
    },
    async handler(a) {
      try {
        const id = await projectId(a.project);
        const flag = { deploy: "--deployment", build: "--build", http: "--http" }[a.kind ?? "deploy"];
        const r = await cli(["logs", ...(a.deployment ? [a.deployment] : []), ...scopeArgs(id, a), flag, "--lines", String(a.lines ?? 100), ...(a.filter ? ["--filter", a.filter] : []), "--json"], { timeoutMs: 60_000 });
        if (r.code !== 0) throw new Error(cliError(r));
        return text(clip(formatLogs(r.out)) || "(no log lines)");
      } catch (e) {
        return fail(e);
      }
    },
  });

  ctx.registerTool({
    name: "railway_variables",
    description:
      "A Railway service's environment variables: list (values masked unless reveal=true — they are secrets), set (key and value; a value may reference another service, e.g. ${{Postgres.DATABASE_URL}}) or delete. Setting a variable redeploys the service unless skip_deploys=true.",
    schema: {
      project: z.string().describe("project name or ID"),
      service: z.string().describe("service name or ID"),
      environment: z.string().optional().describe("default production"),
      action: z.enum(["list", "set", "delete"]).optional(),
      key: z.string().optional(),
      value: z.string().optional(),
      reveal: z.boolean().optional().describe("list: show the raw values"),
      skip_deploys: z.boolean().optional().describe("set: do not redeploy"),
    },
    async handler(a) {
      try {
        const action = a.action ?? "list";
        if (action !== "list" && (!a.key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.key))) throw new Error("`key` must be a variable name");
        if (action === "set" && a.value === undefined) throw new Error("`value` is required to set a variable");
        const id = await projectId(a.project);
        const scope = scopeArgs(id, a);
        if (action === "list") {
          const vars = await cliJson(["variable", "list", ...scope]);
          const keys = Object.keys(vars ?? {}).sort();
          return text(keys.map((k) => `${k}=${a.reveal ? vars[k] : mask(vars[k])}`).join("\n") || "(no variables)");
        }
        if (action === "set") {
          // the value goes through stdin: never in a process list
          const r = await cli(["variable", "set", a.key, "--stdin", ...scope, ...(a.skip_deploys ? ["--skip-deploys"] : []), "--json"], { input: a.value });
          if (r.code !== 0) throw new Error(cliError(r));
          return text(`${a.key} set on ${a.service}${a.skip_deploys ? " (no redeploy)" : " — the service redeploys"}`);
        }
        const r = await cli(["variable", "delete", a.key, ...scope, "--json"]);
        if (r.code !== 0) throw new Error(cliError(r));
        return text(`${a.key} deleted from ${a.service}`);
      } catch (e) {
        return fail(e);
      }
    },
  });

  ctx.registerTool({
    name: "railway_service",
    description:
      "Operate a Railway service: deployments (the recent ones with their status), redeploy (rebuild the latest deployment; from_source=true pulls the latest commit or image), restart (restart the running deployment without a rebuild), domains (list them), domain (generate a railway.app domain, or attach your `domain` — the answer carries the DNS records to add).",
    schema: {
      project: z.string().describe("project name or ID"),
      service: z.string().describe("service name or ID"),
      environment: z.string().optional().describe("default production"),
      action: z.enum(["deployments", "redeploy", "restart", "domains", "domain"]),
      domain: z.string().optional().describe("action=domain: a custom domain (omit to generate a railway.app one)"),
      port: z.number().int().min(1).max(65535).optional().describe("action=domain: the port your app listens on"),
      from_source: z.boolean().optional().describe("action=redeploy: pull the latest commit or image"),
    },
    async handler(a) {
      try {
        const id = await projectId(a.project);
        const env = a.environment || "production";
        const scope = scopeArgs(id, a);
        if (a.action === "deployments") {
          const list = await deployments(id, env, a.service, 10);
          return text(
            list
              .map((d) => {
                const msg = d.meta?.cliMessage || d.meta?.commitMessage || "";
                return `${d.id} ${d.status} ${when(d.createdAt)}${msg ? ` «${clip(msg, 80)}»` : ""}`;
              })
              .join("\n") || "(no deployments)",
          );
        }
        if (a.action === "redeploy" || a.action === "restart") {
          const r = await cli(["service", a.action, ...scope, "--yes", ...(a.action === "redeploy" && a.from_source ? ["--from-source"] : []), "--json"]);
          if (r.code !== 0) throw new Error(cliError(r));
          return text(`${a.action} of ${a.service} started${a.action === "redeploy" ? " — railway_service action=deployments shows how it goes" : ""}.\n${clip(r.out.trim(), 600)}`);
        }
        if (a.action === "domains") {
          const d = await cliJson(["domain", "list", ...scope]);
          return text((d?.domains ?? []).map((x) => `https://${x.domain} (${x.type}${x.targetPort ? `, port ${x.targetPort}` : ""}, ${x.syncStatus ?? "?"})`).join("\n") || "(no domains)");
        }
        const d = await cliJson(["domain", ...(a.domain ? [a.domain] : []), ...(a.port ? ["--port", String(a.port)] : []), ...scope]);
        return text(clip(JSON.stringify(d, null, 1), 2500));
      } catch (e) {
        return fail(e);
      }
    },
  });

  if (typeof ctx.registerCheck === "function")
    ctx.registerCheck(async () => {
      try {
        const list = await projects(true);
        return { ok: true, message: `the token works — ${list.length} project(s) visible` };
      } catch (e) {
        return { ok: false, message: scrub(e.message) };
      }
    });

  if (typeof ctx.registerStat === "function") ctx.registerStat(() => [{ label: "Railway deploys", value: watching.size, sub: "in progress" }]);

  log.info(`railway active: CLI ${path.relative(here, BIN)}, inline deploy wait ${syncS}s${watching.size ? `, ${watching.size} deploy(s) resumed` : ""}`);
}
