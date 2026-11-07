# Container and deployment runner

Run one roleplay container on a host separate from the target and shared services. This exercises DNS, authentication, network latency, timeouts and service failures from that host. A runner on Kora Feet reaching products and shared services on Kora Hands is one deployment of this topology. There are no private infrastructure addresses or credentials in this repository.

## Image and persistent state

The image runs Node 22 as a non-root user, with no npm runtime dependencies. Compose enables a read-only root filesystem, a writable temporary directory, dropped Linux capabilities and a persistent `conversation-roleplay_runs` volume. Only the dashboard port is published, on host loopback by default. The container has no Docker socket or GitHub credentials. Shared services and targets are remote HTTP APIs; it embeds none of their databases or inference engines.

```sh
docker build --build-arg VCS_REF="$(git rev-parse HEAD)" -t conversation-roleplay:local .
docker run --rm --init -p 127.0.0.1:4318:4318 \
  -v conversation-roleplay_runs:/data/runs conversation-roleplay:local
```

That command runs the offline demo. For the shared-service configuration, create a private directory (mode `0700`), copy `config.example.json` to `config.json`, copy `.env.example` to `services.env`, and populate only real reviewed service routes and dedicated credentials. Keep `services.env` mode `0600`. The mounted JSON config may be mode `0644` inside the private directory so the container's non-root user can read it. Credentials remain in the environment file; the parent directory prevents other host users reading the config. Do not commit either runtime file.

```sh
export ROLEPLAY_CONFIG_FILE=/absolute/private/roleplay/config.json
export ROLEPLAY_ENV_FILE=/absolute/private/roleplay/services.env
export ROLEPLAY_IMAGE=conversation-roleplay:local
docker compose -f deploy/compose.yml up -d --wait
curl --fail http://127.0.0.1:4318/healthz
curl --fail http://127.0.0.1:4318/readyz
```

Compose starts with a five-minute drain lease so a deployment can verify readiness before accepting campaigns. The pull runner releases it immediately on successful verification. For a manual install, release it with `POST /api/deployment/resume`, supplying the private deployment token in `X-Roleplay-Deploy-Token`. Read the token from your secret manager or environment; do not put it in shell history. The lease also expires after five minutes.

`host.docker.internal` means the machine running Docker. When using a second machine, set the service origins to its resolvable private DNS name or address. `localhost` inside this container cannot reach another machine. Mint OIDC credentials through the configured canonical HTTPS issuer, even when the data-plane services use trusted private HTTP routes. Never disable issuer verification to make a route work.

## Hosted builds, host-side pull deployment

The workflow runs the full test suite on Node 22 and 24, then builds native `linux/arm64` and `linux/amd64` images on hosted runners. Each build starts its image with the same filesystem/capability restrictions, checks health and source revision, and uploads a Docker archive with a manifest containing the commit, workflow run, platform, image ID and archive SHA-256. Artifacts are retained for 30 days. This does not publish an npm package or require a public registry account.

The host-side runner is installed from a trusted reviewed checkout, separate from the container. It:

1. Reads the current remote `main` commit and looks for its successful, first-attempt **push** run of `.github/workflows/test.yml`. Pull-request runs and incomplete or unsuccessful builds are ineligible.
2. Downloads that run's one matching architecture artifact. Verifies its commit, run, platform and archive checksum; loads the image and independently checks its image ID and OCI source/revision labels.
3. Rechecks that `main` has not advanced. Checks the current container's ownership and campaign reservations. Active/paused campaigns, in-flight planning, unknown product outcomes and unresolved HAI requests defer deployment. It never cancels a campaign.
4. Authenticates a drain request, which atomically refuses new campaigns. Replaces only the owned Compose service, keeping the evidence volume. The new process also starts drained.
5. Checks Docker health, exact running image, source revision and required service readiness. Saves a private deployment receipt and releases the drain. If replacement fails, restores the prior image using the same volume before releasing the drain.

The checks establish provenance from a trusted repository and CI artifact, not an independent cryptographic build attestation. The deployment runner itself is **not** updated from downloaded archives. Review and update its trusted checkout separately when changing the deploy mechanism.

```sh
cp deploy/runner.example.json /absolute/private/roleplay/runner.json
# Edit paths and architecture, and configure a GH CLI account with read access.
node --env-file=/absolute/private/roleplay/services.env \
  deploy/pull-runner.mjs /absolute/private/roleplay/runner.json
```

For a per-user macOS deployment daemon:

```sh
node deploy/install-launchd.mjs /absolute/private/roleplay/runner.json
launchctl print gui/$(id -u)/ai.sekondbrain.conversation-roleplay.deploy
```

The LaunchAgent checks every five minutes and writes private logs under the configured deployment directory. It needs Docker/Compose and authenticated `gh` on its PATH. Public PR code never runs as a self-hosted Actions job on this host. On Linux, use the same one-shot command from a restricted systemd timer. Do not mount host credentials or the Docker socket in the roleplay container.

## Observation and recovery

- `/healthz`: process liveness and immutable source revision. Docker's healthcheck uses this endpoint.
- `/readyz`: required service readiness, returning HTTP 503 when unavailable. Identity and OpenAPI checks do not claim that inference, a product action or a HAI repair succeeded.
- `/api/services`: the same bounded diagnostic report, suitable for the dashboard. No credentials are included.
- `/api/deployment-state`: counts of active and uncertain reservations; no transcripts or tokens.
- `deployment.json`: exact source/image/artifact/run receipt and service readiness at cutover.

Inspect `docker compose -f deploy/compose.yml logs --tail 100` and the private runner logs when diagnosing a failure. A stale runner lock requires checking that no deploy process is alive before deleting that one lock. The run-directory lease also fails closed when it cannot establish ownership; after an ungraceful container crash, inspect the prior container and preserve evidence before clearing a stale lease. Never run two containers against the same run volume. A restart quarantines unfinished actions and does not replay them. Resolve unknown outcomes by independent target readback before deciding whether a fresh isolated campaign is appropriate.

Keep the dashboard on loopback. Use an SSH local tunnel to inspect it from another machine, or add an authenticated reverse proxy with an explicit allowed Host/Origin implementation before exposing a shared dashboard. This version has no public multi-user sign-in. Outbound requests from Feet still traverse the real network even when the dashboard is reached over a local tunnel.
