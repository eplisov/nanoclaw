# Google Calendar & Tasks Integration

Adds Google Calendar and Google Tasks as tools for the NanoClaw agent. The agent can read, create, update, and delete calendar events and todo tasks via IPC-based MCP tools. Both share a single OAuth2 client and token file.

## Architecture

- **Container side** (`ipc-mcp-stdio.ts`): 6 MCP tools that write IPC requests and wait for results
- **Host side** (`host.ts`): Processes IPC tasks, calls Google Calendar API via `googleapis`, writes results back
- **Auth**: OAuth2 tokens stored locally, auto-refreshed by the host

## Setup

### 1. Create GCP Project & Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing)
3. Enable **Google Calendar API**: APIs & Services > Library > search "Google Calendar API" > Enable
4. Enable **Google Tasks API**: APIs & Services > Library > search "Google Tasks API" > Enable
5. Create credentials: APIs & Services > Credentials > Create Credentials > OAuth client ID
   - Application type: **Desktop app**
   - Name: "NanoClaw Calendar"
6. Download the JSON file

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

> **Already had Calendar set up?** If you previously authorized only the Calendar scope, you must re-authorize for Tasks:
> ```bash
> rm data/google-calendar-token.json
> npx tsx .claude/skills/google-calendar/scripts/setup-oauth.ts
> ```
> Google will show the consent screen with both Calendar and Tasks permissions.

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

Add to your main group's `CLAUDE.md` (e.g. `groups/main/CLAUDE.md`):

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

## Google Tasks

You have Google Tasks tools for managing the user's todo list. Use them when the user asks to:
- Add a task / "remind me to ..." (without a specific time) / put something on their todo list
- See their open tasks or what's on a particular list
- Mark a task done / tick something off
- Edit or remove a task
- See which task lists exist

Available tools:
- tasks_list_lists — enumerate all task lists
- tasks_list_tasks — list tasks (default list, only open tasks unless asked)
- tasks_get_task — single task details
- tasks_create_task — add a new task (confirm title first!)
- tasks_update_task — change title/notes/due/status
- tasks_complete_task — mark a task done
- tasks_delete_task — remove a task (confirm first!)

**Calendar vs Tasks rule of thumb:** time-bound things with a start and end (meetings, calls, appointments) → Calendar. Open-ended "things to do" with at most a due date → Tasks.

**Due dates:** Google Tasks stores only the date portion of `due` — time-of-day is silently dropped. Pass `YYYY-MM-DDT00:00:00.000Z` and tell the user the deadline as a date, not a time.
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
| `tasks_list_lists` | List all task lists. No params. |
| `tasks_list_tasks` | List tasks. Params: `list_id?`, `show_completed?`, `due_min?`, `due_max?`, `max_results?` |
| `tasks_get_task` | Get task details. Params: `task_id`, `list_id?` |
| `tasks_create_task` | Create task. Params: `title`, `notes?`, `due?`, `list_id?`, `parent?` |
| `tasks_update_task` | Update task. Params: `task_id`, `list_id?`, plus optional fields |
| `tasks_complete_task` | Mark task done. Params: `task_id`, `list_id?` |
| `tasks_delete_task` | Delete task. Params: `task_id`, `list_id?` |

## Troubleshooting

**"Google Calendar not configured" / "Google Tasks not configured"**: Credentials or token file missing. Run setup-oauth again.

**"Calendar request timed out" / "Tasks request timed out"**: Host handler didn't respond within 30s. Check `logs/nanoclaw.log` for errors.

**Token expired / invalid_grant**: Delete `data/google-calendar-token.json` and re-run setup-oauth.

**"Google Tasks API has not been used in project ..." / 403 PERMISSION_DENIED**: Tasks API isn't enabled in your GCP project. Enable it at APIs & Services > Library > Google Tasks API > Enable.

**"insufficient authentication scopes" / Tasks tools return 403**: Your token was issued for Calendar only. Delete `data/google-calendar-token.json` and re-run setup-oauth — the consent screen will now request both scopes.

**"Only available to the main group"**: Calendar and Tasks tools are restricted to the main group for security.
