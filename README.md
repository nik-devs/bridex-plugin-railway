# bridex-plugin-railway

Railway for [Bridex](https://bridex.app) agents, through the official Railway CLI
(bundled and pinned — `@railway/cli` in `package.json`; its install step
downloads the binary, so the instance needs network access when the plugin is
installed).

## Setup

Settings → Plugins → Catalog → **Railway** → Install. The token goes in
Settings → **Integrations → Railway**, nowhere else:

- an **account token** (railway.com → Account Settings → Tokens, no workspace)
  reaches every workspace of the account;
- a **workspace token** (the same page with a workspace chosen) reaches that
  workspace only.

Project tokens do not work here: listing and creating projects needs an
account or a workspace. The plugin reads the token on every call, so a key
replaced in Integrations is used at once.

The token stays inside the plugin: the CLI runs with it in a private HOME
under the instance state and a minimal environment — agents never see it, and
the instance's other secrets never reach the CLI.

## Tools

| Tool | What it does |
|------|--------------|
| `railway_projects` | every project with its environments and services, or one environment of a project: each service's latest deployment, domains, replicas |
| `railway_create` | a project, a service (empty, or from a Docker image or a GitHub repo) or a database (postgres, mysql, redis, mongo) |
| `railway_deploy` | uploads a folder of the agent's workspace (`.gitignore` respected) to a service; waits up to 120 s, then follows the deployment in the background and wakes the agent in its conversation when it settles — the tail of the build or deploy log on failure |
| `railway_logs` | deploy, build or http logs, latest deployment or a given one, with Railway's filter syntax |
| `railway_variables` | list (values masked unless `reveal`), set (value through stdin, never in a process list), delete |
| `railway_service` | recent deployments, redeploy (optionally from source), restart, list domains, generate or attach a domain |

A deploy folder must be inside the calling agent's workspace (by default its
task's checkout, or its working directory). Background deploys are tracked as
plugin jobs: a server restart re-arms the watch.
