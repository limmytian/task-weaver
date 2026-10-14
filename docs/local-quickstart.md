# Local Quickstart

This disposable Compose setup lets each visitor run an isolated Task Weaver
instance on their own computer. It includes PostgreSQL with pgvector, the
released 0.3.7 API and Web images, migrations, and persistent local volumes.
It does not create a shared account or send data to a Task Weaver-hosted service.

## Requirements

- Docker Desktop or Docker Engine with the Compose v2 plugin
- An available local TCP port 3000 and 3001
- Internet access to pull the images on first startup

## Start

From the repository root, run:

```sh
docker compose -f docker-compose.local.yml up -d --wait
```

Open [http://localhost:3000/login](http://localhost:3000/login). On first use,
choose **Set up the first administrator**, enter this local bootstrap secret,
and create your own account with an email address and password:

```text
task-weaver-local-first-admin-bootstrap-secret-2026
```

The email and password are yours to choose; there is no shared demo login.
After signing in, try this short workflow:

1. Create a project and describe its goal.
2. Add a requirement for one outcome.
3. Add a task under that requirement and open the Board.
4. Add a discussion update or a Markdown document, then inspect the task history.

The demo ports bind to `127.0.0.1`, so the Web UI and API are only reachable from
the same computer. The bootstrap and database passwords in this file are
intentionally fixed for this disposable, loopback-only trial. Do not expose this
Compose project to a network, reuse its credentials, or use it for real data.

## Stop or reset

Stop the containers and keep your local data:

```sh
docker compose -f docker-compose.local.yml down
```

To discard the trial and all its database, skill, and attachment data:

```sh
docker compose -f docker-compose.local.yml down --volumes
```

The second command permanently removes this trial's Compose volumes.
