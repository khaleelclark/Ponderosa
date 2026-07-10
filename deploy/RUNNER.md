# GitHub Actions Runner on Pine

Ponderosa deploys after a verified push to `master`. GitHub-hosted runners run
the verification job; the deployment job is collected by a self-hosted runner on
Pine over its outbound HTTPS connection to GitHub. Pine does not need an inbound
port, webhook listener, or deploy SSH key.

The production checkout and service are:

```
/home/phoenix/khaleel/ponderosa
ponderosa.service
```

## One-time setup

Run these commands on Pine as `phoenix`. Obtain a short-lived registration token
from GitHub: **Ponderosa -> Settings -> Actions -> Runners -> New self-hosted
runner**. Never commit that token or add it as a repository secret.

```bash
mkdir -p ~/actions-runner
cd ~/actions-runner

# Check https://github.com/actions/runner/releases for the current version.
curl -fL -o actions-runner-linux-x64-2.335.1.tar.gz \
  https://github.com/actions/runner/releases/download/v2.335.1/actions-runner-linux-x64-2.335.1.tar.gz
tar xzf actions-runner-linux-x64-2.335.1.tar.gz

./config.sh \
  --url https://github.com/khaleelclark/Ponderosa \
  --token YOUR_SHORT_LIVED_REGISTRATION_TOKEN \
  --name pine \
  --labels pine \
  --work _work \
  --unattended

sudo ./svc.sh install phoenix
sudo ./svc.sh start
```

Confirm it is connected:

```bash
sudo ./svc.sh status
```

GitHub should show an online runner named `pine` with the labels
`self-hosted`, `linux`, `x64`, and `pine`.

## Least-privilege restart permission

The deployment workflow needs permission to restart only Ponderosa after a
successful build. Install this sudoers rule once:

```bash
sudo visudo -f /etc/sudoers.d/ponderosa-deploy
```

Add this exact line:

```
phoenix ALL=(root) NOPASSWD: /usr/bin/systemctl restart ponderosa.service, /usr/bin/systemctl status ponderosa.service --no-pager
```

Validate it before leaving the editor:

```bash
sudo visudo -cf /etc/sudoers.d/ponderosa-deploy
```

## What a merge does

1. Merging a pull request pushes its merge commit to `master`.
2. GitHub runs typecheck, build, and tests on a GitHub-hosted runner.
3. When verification passes, GitHub queues the deploy job for the `pine`
   self-hosted runner.
4. Pine fetches that exact merge SHA into the production checkout, installs
   dependencies, builds, restarts `ponderosa.service`, and polls
   `/api/health`.

The jobs are serialized with the `ponderosa-production` concurrency group, so
two fast merges cannot deploy at the same time. On a free private repository,
