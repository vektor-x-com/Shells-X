# Shells-X → PCF importer

A drop-in plugin for [Pentest Collaboration Framework](https://gitlab.com/invuls/pentest-projects/pcf) that imports Shells-X webshell exports into a PCF project in one click.

## What it imports

Reads the `shells-x-*.json` (and optionally `shells-x-*-credentials.csv`) the webshell emits via its **↑ Faraday export** button, and lands the contents into the active PCF project:

- **Hosts** — IP, OS, full multi-line posture block (kernel, capabilities, privesc surface, mounts, routing, framework details, …) into `host.comment`
- **Hostnames** — each entry in the JSON's `hostnames[]` array
- **Services** — open ports with banner, TLS info (CN/issuer/SANs/validity), version → port `description`
- **Credentials** — every parsed credential from `.env` / `wp-config.php` / `.my.cnf` / `.pgpass` / framework configs, linked to the originating service when the endpoint string contains a port hint

Dedup at every level:
- Host by `(project, ip)` — re-import **appends** the new posture block under a `--- Re-import <ts> ---` divider, so analyst notes survive
- Port by `(host, port, proto)`
- Credential by `(login, hash, cleartext, description, source, project, hash_type)`

## Install

```bash
# Clone PCF if you haven't:
git clone https://gitlab.com/invuls/pentest-projects/pcf.git ~/pcf

# Drop the plugin into PCF's import_plugins tree:
cp -r shellsx ~/pcf/routes/ui/tools_addons/import_plugins/

# Restart PCF so the loader picks it up:
cd ~/pcf && python3 app.py
```

That's it. The plugin auto-registers (PCF scans `routes/ui/tools_addons/import_plugins/*/plugin.py` at startup).

## Use

1. Generate a recon export from your Shells-X deployment — click the sidebar **↑ Faraday export** button in the shell UI. A `shells-x-*.json` (and `shells-x-*-credentials.csv` when credentials are present) lands in Downloads.
2. In PCF: open the target project → **Tools** → click the **Shells-X** tile.
3. Drop the JSON into the **`json_files`** input. If you only have the CSV (e.g. shared without the JSON), drop it into **`csv_files`** instead — when both are present, the CSV is treated as fallback and won't double-insert credentials that the JSON already carried.
4. Click submit. A summary line appears with new/duplicate counts:
   ```
   Shells-X import: hosts +1/=0, ports +3/=0, hostnames +1, credentials +6/=0
   ```

## Compatibility

- **PCF**: tested against `gitlab.com/invuls/pentest-projects/pcf` head (May 2026, commit `614af96`+). The plugin uses only documented `Database` methods (`insert_host`, `insert_host_port`, `insert_hostname`, `update_host_description`, `select_ip_from_project`, `find_ip_hostname`, `select_ip_port`, `insert_new_cred`, `select_creds_dublicates`) so it's resilient to most PCF UI/route changes.
- **Shells-X**: works with any v1.4.0+ Faraday export (JSON structure matches `shellsx/builder.py` output).
- **Python**: 3.9+ (matches PCF's own requirement).

## Why we ship this

[Faraday VM](https://github.com/infobyte/faraday) was the first target for Shells-X exports, but Faraday's `faraday_json` plugin and `bulk_create` server endpoint both silently drop credential arrays. Operators have to upload two files and use a separate UI endpoint for credentials.

PCF's plugin API has no such gap — `db.insert_new_cred()` is reachable from a plugin, so a single drop of the JSON imports everything in one step. We keep the Faraday integration for teams already on it; the PCF plugin is the cleaner option for new pipelines.

## Upstream

The plan is to submit this as a Merge Request to PCF's `import_plugins/` directory so all PCF users get it for free. Until that lands, this repo is the source of truth — fixes flow Shells-X repo → PCF MR, not the other way.
