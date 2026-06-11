# VoloRota public demo deployment

Stands up the public demo: VoloRota + Caddy (TLS), seeded with a fictional
congregation, mail in capture mode (nothing leaves the box — sends appear in
`/admin/outbox`), and an hourly reset back to seed state.

## One-time setup (Ubuntu 24.04)

```bash
# as root or with sudo
apt-get update && apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

git clone https://github.com/VoloRota/volorota.git /opt/volorota
cd /opt/volorota/deploy/demo
cp .env.example .env && nano .env       # set domain, password, three tokens

docker compose up -d --build            # builds the image, starts app + Caddy
./reset.sh                              # first seed

# hourly reset timer
cp volorota-demo-reset.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now volorota-demo-reset.timer
```

Point DNS (`demo.volorota.org` A record) at the VPS before `docker compose up`
so Caddy can obtain its certificate.

## Demo links to publish

- Admin: `https://demo.volorota.org` — publish the demo password openly
- Volunteer experience (no login at all):
  `https://demo.volorota.org/v/<DEMO_TOKEN_TOM>` etc. — the fixed tokens from
  `.env` survive resets, so published links stay valid.

## Sandbox properties

- **Mail**: no `VOLOROTA_SMTP_*` configured → capture transport; the admin
  dashboard shows a capture-mode banner and every send is viewable at
  `/admin/outbox`. No email can leave the demo.
- **Reset**: `reset.sh` wipes the data volume and reseeds; the schedule always
  starts on the upcoming Sunday so the demo never looks stale.
- **Updates**: `cd /opt/volorota && git pull && cd deploy/demo && docker compose up -d --build`
