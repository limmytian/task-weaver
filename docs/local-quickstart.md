# Local Quickstart

This disposable Compose setup lets each visitor run an isolated Task Weaver
instance on their own computer. It includes PostgreSQL with pgvector, the
latest API and Web images published after successful main-branch CI builds,
migrations, and persistent local volumes.
It does not create a shared account or send data to a Task Weaver-hosted service.

## Requirements

- Docker Desktop or Docker Engine with the Compose v2 plugin
- An available local TCP port 3000 and 3001
- Internet access to pull the images on first startup

## Start

From the repository root, run:

```sh
./scripts/local-compose-up.sh
```

Compose pulls the current `latest` images when they are not already available
locally. The helper stores generated trial credentials in the ignored
`.task-weaver/local-trial/compose.env` file with owner-only permissions and
prints the bootstrap secret needed for first setup. To refresh an existing
installation to the newest CI build, pull first:

```sh
docker compose --env-file .task-weaver/local-trial/compose.env -f docker-compose.local.yml pull
docker compose --env-file .task-weaver/local-trial/compose.env -f docker-compose.local.yml up -d --wait
```

Open [http://localhost:3000/login](http://localhost:3000/login). On first use,
choose **Set up the first administrator**, enter the one-time bootstrap secret
shown in the startup output, and create your own account with an email address
and password. The helper generates separate random database, auth, and
bootstrap secrets on first run and reuses the private local file afterward.

If you used the earlier trial configuration, its existing PostgreSQL volume
still has the old database password. Back up any data you need and migrate the
database password to the newly generated value before using that volume with
this configuration. For a disposable trial, you can instead remove its volumes
using the reset command below, then start again. The helper does not delete or
change an existing database volume.

The email and password are yours to choose; there is no shared demo login.
After signing in, try this short workflow:

1. Create a project and describe its goal.
2. Add a requirement for one outcome.
3. Add a task under that requirement and open the Board.
4. Add a discussion update or a Markdown document, then inspect the task history.

The demo ports bind to `127.0.0.1`, so the Web UI and API are only reachable from
the same computer. Do not expose this Compose project to a network or use it for
real data.

## Stop or reset

Stop the containers and keep your local data:

```sh
docker compose --env-file .task-weaver/local-trial/compose.env -f docker-compose.local.yml down
```

To discard the trial and all its database, skill, and attachment data:

```sh
docker compose --env-file .task-weaver/local-trial/compose.env -f docker-compose.local.yml down --volumes
```

The second command permanently removes this trial's Compose volumes.
