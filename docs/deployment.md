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

## Hosted builds and verified deployment

The workflow runs the full test suite on Node 22 and 24, then builds native `linux/arm64` and `linux/amd64` images on hosted runners. Each build starts its image with the same filesystem/capability restrictions, checks health and source revision, and uploads a Docker archive with a manifest containing the commit, workflow run, platform, build image ID, portable configuration digest and archive SHA-256. Artifacts are retained for 30 days. This does not publish an npm package or require a public registry account.

The host-side deployer is installed from a trusted reviewed checkout, separate from the container. Its legacy polling mode follows `main`; tagged SDDMini mode follows `SDDMiniFeet` and independently verifies the annotated release. It:

1. Reads the current remote `main` commit and looks for its successful, first-attempt **push** run of `.github/workflows/test.yml`. Pull-request runs and incomplete or unsuccessful builds are ineligible.
2. Downloads that run's one matching architecture artifact. Verifies its commit, run, platform, archive checksum and single expected image tag; loads the image and independently checks its platform and OCI source/revision labels. It exports the imported image again and checks that the portable configuration digest, including its root filesystem layer identities, still matches the build. This works across classic Docker and containerd stores, which may report different engine-specific image IDs for the same configuration.
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

The LaunchAgent checks every five minutes and writes private logs under the configured deployment directory. It needs Docker/Compose and authenticated `gh` on its PATH. This legacy polling path does not require a self-hosted Actions runner. Disable its LaunchAgent before enabling the SDDMini release path below so only one mechanism owns deployment. On Linux, use the same one-shot command from a restricted systemd timer. Do not mount host credentials or the Docker socket in the roleplay container.

## SDDMini releases on Kora Feet

The release workflow `.github/workflows/sddmini-release.yml` deploys only new annotated `SDDMini-KF/vX.Y.Z` tags. The tag must resolve directly to the current `SDDMiniFeet` branch commit, whose first-attempt `test.yml` **push** build must have completed successfully. Tests and native ARM64/AMD64 image builds continue on GitHub-hosted runners. The self-hosted job consumes that exact ARM64 artifact and records the tag, release workflow run, build run, archive checksum and portable image identity in its receipt. `main` pushes alone do not deploy this mode.

Keep a dedicated repository-scoped macOS ARM64 runner, labelled `kora-feet` and `conversation-roleplay-sddmini`. Do not use this runner for PRs, tests, arbitrary scripts, or other repositories. The job does not check out the repository or run a repository action: its only step calls the pinned host deployment wrapper. The `SDDMini` environment accepts only `SDDMini-KF/v*` tags. Release concurrency never cancels an existing deployment.

A mandatory **job-started hook** rejects other repositories, PR/branch/manual events, different workflows/jobs, reruns, lightweight/moved tags, branch drift and any workflow bytes not matching the host-reviewed SHA-256. The hook checks GitHub-provided context and independently reads the run, annotated tag, branch and workflow through the API. The wrapper repeats authorization and pins the revision before staging. This is a guard for a trusted deployment host, not an isolation boundary for arbitrary untrusted code. Keep external contributor approval enabled; do not add checkout or action steps to this workflow without reviewing and updating the host policy.

Install the latest supported official Actions runner for macOS ARM64 using GitHub's repository runner setup instructions. Verify the download's published SHA-256. Use a private directory under the service user's home so the LaunchAgent does not depend on macOS protected-volume permissions. Give the runner only this repository's registration token, not an organization-wide registration. Do not put registration tokens in files or command history. The runner can use `ACTIONS_RUNNER_INPUT_TOKEN` during unattended configuration; remove it from the environment afterwards.

After reviewing the deploy code and completing checks, run from its **clean committed checkout**:

```sh
node deploy/install-sddmini.mjs /absolute/private/roleplay/runner.json
```

This pins a trusted copy by commit and writes private `policy.json`, deployment config, `guard.sh` and `run-release.mjs` under `$HOME/.local/share/conversation-roleplay/sddmini`. Configure `ACTIONS_RUNNER_HOOK_JOB_STARTED` to that absolute `guard.sh` path in the runner's service environment **before starting the service**. The host needs Node 22+, Docker Compose and `gh`. The release step supplies its short-lived GitHub job token with only `contents: read` and `actions: read`; this authenticates artifact downloads without relying on the service user's interactive keychain. The pre-job hook reads public provenance independently; manual/legacy polling still requires authenticated `gh`. Never supply those host credentials or the Docker socket to the roleplay container. Install the official runner as a per-user LaunchAgent so it reconnects after login. Check it is online with the expected labels before pushing a release.

The normal delivery sequence is a reviewed PR and successful checks, a merge into the desired release branch, successful exact-commit branch push CI, then a **new unused annotated tag** at its unchanged head:

```sh
git fetch origin SDDMiniFeet
git tag -a SDDMini-KF/v0.1.0 origin/SDDMiniFeet -m 'SDDMini Feet 0.1.0'
git push origin refs/tags/SDDMini-KF/v0.1.0
```

The example version is not an instruction to reuse an existing tag. Check local and remote refs first and choose the next unused version. Monitor that one workflow; never retag or rerun an unchanged release. A failed/deferred run has not established deployment. Inspect the reservation/readiness cause, make any necessary tested repair, and issue a fresh tag. Updating a workflow intentionally requires separately reviewing and reinstalling the trusted host copy/hash. The Actions job cannot update its own trust policy.

## Observation and recovery

- `/healthz`: process liveness and immutable source revision. Docker's healthcheck uses this endpoint.
- `/readyz`: required service readiness, returning HTTP 503 when unavailable. Identity and OpenAPI checks do not claim that inference, a product action or a HAI repair succeeded.
- `/api/services`: the same bounded diagnostic report, suitable for the dashboard. No credentials are included.
- `/api/deployment-state`: counts of active and uncertain reservations; no transcripts or tokens.
- `deployment.json`: exact source/artifact/run receipt, build image ID, host image ID, portable configuration digest and service readiness at cutover.

Inspect `docker compose -f deploy/compose.yml logs --tail 100` and the private runner logs when diagnosing a failure. A stale runner lock requires checking that no deploy process is alive before deleting that one lock. The run-directory lease also fails closed when it cannot establish ownership; after an ungraceful container crash, inspect the prior container and preserve evidence before clearing a stale lease. Never run two containers against the same run volume. A restart quarantines unfinished actions and does not replay them. Resolve unknown outcomes by independent target readback before deciding whether a fresh isolated campaign is appropriate.

Keep the dashboard on loopback. Use an SSH local tunnel to inspect it from another machine, or add an authenticated reverse proxy with an explicit allowed Host/Origin implementation before exposing a shared dashboard. This version has no public multi-user sign-in. Outbound requests from Feet still traverse the real network even when the dashboard is reached over a local tunnel.
