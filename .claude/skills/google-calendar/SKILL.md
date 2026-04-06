# Google Calendar Integration

Adds Google Calendar as a tool for the NanoClaw agent. The agent can read, create, update, and delete calendar events via IPC-based MCP tools.

## Architecture

- **Container side** (`ipc-mcp-stdio.ts`): 6 MCP tools that write IPC requests and wait for results
- **Host side** (`host.ts`): Processes IPC tasks, calls Google Calendar API via `googleapis`, writes results back
- **Auth**: OAuth2 tokens stored locally, auto-refreshed by the host

## Setup

### 1. Create GCP Project & Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable **Google Calendar API**: APIs & Services > Library > search "Google Calendar API" > Enable
4. Create credentials: APIs & Services > Credentials > Create Credentials > OAuth client ID
   - Application type: **Desktop app**
   - Name: "NanoClaw Calendar"
5. Download the JSON file

### 2. Upload Credentials to VPS

```bash
# Copy the downloaded JSON to the VPS
scp ~/Downloads/client_secret_*.json nanoclaw:~/nanoclaw/data/google-calendar-credentials.json
```

### 3. Run OAuth Setup

On your **local machine**, set up SSH port-forward:

```bash
ssh -L 3000:localhost:3000 nanoclaw
```

On the **VPS** (in the SSH session):

```bash
cd ~/nanoclaw
npx tsx .claude/skills/google-calendar/scripts/setup-oauth.ts
```

The script will print a URL. Open it in your local browser, grant access. The page will confirm success and tokens are saved automatically.

### 4. Build & Deploy

```bash
cd ~/nanoclaw
npm install
npm run build
rm -rf data/sessions/*/agent-runner-src   # Clear agent-runner cache
bash container/build.sh                    # Rebuild container image
systemctl --user restart nanoclaw          # Restart service
```

### 5. Update Agent Instructions

Add to `groups/telegram_main/CLAUDE.md`:

```markdown
## Google Calendar

You have Google Calendar tools. Use them when the user asks about:
- Their schedule, upcoming events, what's happening today/this week
- Creating meetings, appointments, or reminders
- Checking availability or free time
- Modifying or cancelling events

Available tools:
- calendar_list_events — list events in a date range
- calendar_get_event — get event details by ID
- calendar_create_event — create new events (confirm details first!)
- calendar_update_event — modify existing events
- calendar_delete_event — remove events (confirm first!)
- calendar_free_busy — check availability

Format times clearly with date, time, and title. Use the user's timezone.
```

## Tools Reference

| Tool | Description |
|------|-------------|
| `calendar_list_events` | List events. Params: `time_min?`, `time_max?`, `max_results?`, `query?` |
| `calendar_get_event` | Get event details. Params: `event_id` |
| `calendar_create_event` | Create event. Params: `summary`, `start`, `end`, `description?`, `location?`, `attendees?` |
| `calendar_update_event` | Update event. Params: `event_id`, plus optional fields to change |
| `calendar_delete_event` | Delete event. Params: `event_id` |
| `calendar_free_busy` | Check busy slots. Params: `time_min`, `time_max` |

## Troubleshooting

**"Google Calendar not configured"**: Credentials or token file missing. Run setup-oauth again.

**"Calendar request timed out"**: Host handler didn't respond within 30s. Check `logs/nanoclaw.log` for errors.

**Token expired / invalid_grant**: Delete `data/google-calendar-token.json` and re-run setup-oauth.

**"Only available to the main group"**: Calendar tools are restricted to the main Telegram group for security.
