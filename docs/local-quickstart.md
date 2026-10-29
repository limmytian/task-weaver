# Local Quickstart

This disposable Compose setup lets each visitor run an isolated Task Weaver
instance on their own computer. It includes PostgreSQL with pgvector, the
latest API and Web images published after successful main-branch CI builds,
migrations, and persistent local volumes.
It does not create a shared account or send data to a Task Weaver-hosted service.

## Requirements

- Docker Desktop or Docker Engine with the Compose v2 plugin
- Node.js 16 or later to generate local credentials
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
still has the old database password. Follow the migration below before starting
the new configuration. For a disposable trial, you can instead remove its
volumes using the reset command below, then start again. The helper does not
delete or change an existing database volume.

### Preserve an earlier trial

Run these commands in the same checkout and Compose project that owns the old
trial. First prepare credentials without changing any containers, then stop
application writes and save a database backup outside the checkout:

```sh
./scripts/local-compose-up.sh --prepare-only
docker compose --env-file .task-weaver/local-trial/compose.env -f docker-compose.local.yml stop web api
umask 077
trial_backup=$(mktemp "$HOME/task-weaver-trial-backup.XXXXXX")
docker compose --env-file .task-weaver/local-trial/compose.env -f docker-compose.local.yml exec -T database \
  pg_dump -U task_weaver -d task_weaver -Fc > "$trial_backup"
printf 'Database backup: %s\n' "$trial_backup"
```

Back up the skill and attachment volumes as well if they contain data. Verify
the backups before continuing; see [deployment and recovery](deployment.md#upgrade-and-recovery).
The existing database container must still be running. Read the new database
password from the private file on a private terminal, then enter it twice at
the PostgreSQL prompt (do not paste it into a shell command):

```sh
sed -n 's/^TW_LOCAL_DATABASE_PASSWORD=//p' .task-weaver/local-trial/compose.env
docker compose --env-file .task-weaver/local-trial/compose.env -f docker-compose.local.yml exec database \
  psql -U task_weaver -d task_weaver
```

At the `psql` prompt run `\password task_weaver`, enter the generated password
twice, and exit with `\q`. The password is displayed by the first command, so
do not run it on a shared screen or retain terminal logs. Start the trial with
`./scripts/local-compose-up.sh`, sign in with your existing account and verify
your data. The regenerated authentication secret invalidates old sessions;
it does not change account passwords. If migration fails, keep the backup and
restore it with the matching old images rather than deleting the volume.

The email and password are yours to choose; there is no shared demo login.
After signing in, try this short workflow:

1. Create a project and describe its goal.
2. Add a requirement for one outcome.
3. Add a task under that requirement and open the Board.
4. Add a discussion update or a Markdown document, then inspect the task history.

The demo ports bind to `127.0.0.1`, so the Web UI and API are only reachable from
the same computer. Do not expose this Compose project to a network or use it for
real data.

## Connect the CLI

With Node.js 20 or newer, install the CLI from the public npm registry and connect
to the running local API:

```sh
npm install --global @task-weaver/cli
tw --version
tw auth login --api-url http://localhost:3001
tw auth whoami --json
tw project list --json
```

Create a scoped Key in the Web UI and enter it through the hidden login prompt.
For a remote instance, use that instance's API origin. See
[npm CLI distribution](npm-distribution.md) for one-off runs and version pinning.

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
