# CatalogForge on AWS Lightsail (Sydney)

Single-host deployment used for the one-month private demo:

| Piece | Choice | Cost |
|---|---|---|
| Compute | Lightsail `small_3_2` — 2 vCPU burst, 2 GB RAM, 60 GB SSD | **$12/mo** |
| Static IP | Lightsail static IP, attached | $0 while attached |
| TLS | Caddy + Let's Encrypt | $0 |
| Data | Postgres 16 + Redis 7 in Docker volumes | $0 |
| AI | OpenCode Go (`OPENCODE_API_KEY`) | existing key |

Region is **`ap-southeast-2` (Sydney)**. The new AWS experience assigns India-based projects to Sydney; Mumbai is not available without upgrading the account. Sydney latency from India is ~100–150 ms, acceptable for a private demo.

The Lightsail account is on the Free plan with $100 credits. At $12/mo the demo fits comfortably; **delete the instance and static IP when the month ends** to stop all charges.

## Layout

```
deploy/aws/
  compose.yml     app + Postgres + Redis + Caddy, memory-capped for 2 GB
  Caddyfile       HTTPS, basic auth, reverse proxy to app:3000
  .env.example    copy to .env and fill in
```

The app image is built locally and copied to the server. The server only runs the containers; it does not build Next.js (2 GB is too tight for a reliable build).

## 1. Server prep

Already done on this host:

- `ubuntu_24_04` blueprint, 2 GB swap at `/swapfile`, `vm.swappiness=20`
- Docker Engine 29 + Compose plugin
- Lightsail firewall: `22/tcp` only from the admin IP, `80/tcp`, `443/tcp`, `443/udp` from anywhere

If repeating from scratch:

```bash
# on the instance
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo sysctl vm.swappiness=20
echo 'vm.swappiness=20' | sudo tee /etc/sysctl.d/99-catalogforge.conf

# Docker (Ubuntu)
sudo apt-get update && sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker ubuntu
```

Create the instance and static IP:

```bash
aws lightsail create-instances --profile catalogforge --region ap-southeast-2 \
  --instance-names catalogforge --availability-zone ap-southeast-2a \
  --blueprint-id ubuntu_24_04 --bundle-id small_3_2 --key-pair-name catalogforge-syd

aws lightsail allocate-static-ip --profile catalogforge --region ap-southeast-2 --static-ip-name catalogforge-ip
aws lightsail attach-static-ip --profile catalogforge --region ap-southeast-2 \
  --static-ip-name catalogforge-ip --instance-name catalogforge
```

`sslip.io` turns `15.135.152.250` into `15-135-152-250.sslip.io`. No DNS setup needed.

## 2. Build and copy the image

On the developer machine (Docker + this repo):

```bash
cd /path/to/CatalogForge
docker build -t catalogforge:latest .
docker save catalogforge:latest | gzip -1 | ssh -i ~/.ssh/catalogforge-syd.pem ubuntu@15.135.152.250 \
  'gunzip | sudo docker load'
```

The image is linux/amd64 and runs unchanged on Lightsail.

## 3. Configure

```bash
ssh -i ~/.ssh/catalogforge-syd.pem ubuntu@15.135.152.250
sudo mkdir -p /opt/catalogforge && sudo chown ubuntu:ubuntu /opt/catalogforge
```

Copy `compose.yml`, `Caddyfile` and `.env` into `/opt/catalogforge`, then:

```bash
# generate the basic-auth hash locally (Caddy 2.11 expects it base64-encoded)
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'the-password' | base64 -w0
```

`.env`:

```dotenv
APP_URL=https://15-135-152-250.sslip.io
CADDY_DOMAIN=15-135-152-250.sslip.io
POSTGRES_PASSWORD=<32-char-random>
BASIC_AUTH_USER=catalogforge
BASIC_AUTH_HASH='<base64-encoded-bcrypt-hash>'
OPENCODE_API_KEY=<opencode-go-key>
AI_PROVIDER=opencode
WORKER_BUILD_CONCURRENCY=8
WORKER_TRANSLATE_CONCURRENCY=4
BUILD_BATCH_SIZE=1
TRANSLATE_BATCH_ITEMS=15
DB_POOL_WORKER=8
```

## 4. Start

```bash
cd /opt/catalogforge
sudo docker compose up -d
sudo docker compose ps
```

First boot applies migrations, then starts the worker and the web app. `SEED_DEMO=false`, so the demo login is not created automatically — run the idempotent seed once to create the demo store and user:

```bash
docker compose exec app bun packages/db/src/seed.ts   # demo@catalogforge.dev / demo1234
```

Set `DEMO_EMAIL` / `DEMO_PASSWORD` to override those defaults, and `DEMO_API_KEY` if you want the seed to create an API key (otherwise create one in **Settings → API keys**).

`/api/v1/*` and `/api/exports` are exempt from basic auth on purpose: a request cannot carry Basic and Bearer credentials in the same `Authorization` header. Those paths still require an API key or a session inside the app; everything else (dashboard, storefront) stays behind the shared password.

## 5. Verify

```bash
# from anywhere
curl -u catalogforge:<password> https://15-135-152-250.sslip.io/api/health
# {"ok":true,"checks":{"postgres":"ok","redis":"ok"}}

# on the server
sudo docker compose logs -f app
sudo docker compose logs -f caddy
```

Caddy issues the certificate on first request. Give it a few seconds after `docker compose up`.

## 6. Update / restart

```bash
# rebuild locally, re-run the transfer command, then
cd /opt/catalogforge && sudo docker compose up -d
```

The app restarts, migrations run again, and the worker's reconciler rebuilds unfinished queue work from Postgres. Progress survives restarts by design.

## 7. Teardown (stop the $12/mo)

```bash
aws lightsail detach-static-ip --profile catalogforge --region ap-southeast-2 --static-ip-name catalogforge-ip
aws lightsail release-static-ip --profile catalogforge --region ap-southeast-2 --static-ip-name catalogforge-ip
aws lightsail delete-instance --profile catalogforge --region ap-southeast-2 --instance-name catalogforge
```

Deleting the instance deletes its attached volumes, so the database and uploads go with it. The $12/mo stops immediately; unused Free-plan credits simply expire.

## Memory notes

The 2 GB host runs the app, Postgres, Redis and Caddy with 2 GB swap:

- app capped at 1.2 GB (Next.js + worker), Postgres 512 MB, Redis 320 MB, Caddy 128 MB
- Postgres is tuned for a small box (`shared_buffers=128MB`, `max_connections=60`)
- worker AI concurrency is reduced from the image defaults (8 build / 4 translate) to keep peaks inside the cap
- `vm.swappiness=20` keeps swap as a safety valve, not the normal working set

If the app gets slow during large imports, raise `WORKER_BUILD_CONCURRENCY` only if swap stays quiet; otherwise keep it at 8.
