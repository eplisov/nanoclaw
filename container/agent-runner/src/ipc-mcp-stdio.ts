/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'send_voice_message',
  "Send a voice message to the user. Synthesizes the given text to speech and sends it as a Telegram voice note. Use when the user asks for a spoken/voice reply. Keep the text concise — very long texts may fail or sound unnatural.",
  {
    text: z.string().describe('The text to synthesize and send as voice'),
  },
  async (args) => {
    const data = {
      type: 'voice_message',
      chatJid,
      text: args.text,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Voice message queued for synthesis and delivery.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Google Calendar tools (request/response via IPC)
// ---------------------------------------------------------------------------

const CALENDAR_RESULTS_DIR = path.join(IPC_DIR, 'calendar_results');
const TASKS_RESULTS_DIR = path.join(IPC_DIR, 'tasks_results');

function waitForCalendarResult(requestId: string, timeoutMs = 30000): Promise<{ success: boolean; data?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const resultPath = path.join(CALENDAR_RESULTS_DIR, `${requestId}.json`);
    const start = Date.now();
    const poll = () => {
      if (fs.existsSync(resultPath)) {
        try {
          const content = fs.readFileSync(resultPath, 'utf-8');
          fs.unlinkSync(resultPath);
          resolve(JSON.parse(content));
        } catch (err) {
          reject(err);
        }
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Calendar request timed out'));
        return;
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}

function calendarRequestId(): string {
  return `cal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function waitForTasksResult(requestId: string, timeoutMs = 30000): Promise<{ success: boolean; data?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const resultPath = path.join(TASKS_RESULTS_DIR, `${requestId}.json`);
    const start = Date.now();
    const poll = () => {
      if (fs.existsSync(resultPath)) {
        try {
          const content = fs.readFileSync(resultPath, 'utf-8');
          fs.unlinkSync(resultPath);
          resolve(JSON.parse(content));
        } catch (err) {
          reject(err);
        }
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Tasks request timed out'));
        return;
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}

function tasksRequestId(): string {
  return `tsk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

if (isMain) {
  server.tool(
    'calendar_list_events',
    `List upcoming events from your Google Calendar. Returns events sorted by start time.
Use this when the user asks about their schedule, upcoming meetings, or what's happening on a specific day/week.`,
    {
      time_min: z.string().optional().describe('Start of time range (ISO 8601 datetime, e.g. "2026-04-06T00:00:00+03:00"). Defaults to now.'),
      time_max: z.string().optional().describe('End of time range (ISO 8601 datetime). If omitted, returns next N events.'),
      max_results: z.number().optional().describe('Maximum number of events to return (default 10, max 50)'),
      query: z.string().optional().describe('Free-text search filter (matches summary, description, location)'),
    },
    async (args) => {
      const requestId = calendarRequestId();
      writeIpcFile(TASKS_DIR, {
        type: 'calendar_list_events',
        requestId,
        time_min: args.time_min,
        time_max: args.time_max,
        max_results: args.max_results,
        query: args.query,
        timestamp: new Date().toISOString(),
      });
      try {
        const result = await waitForCalendarResult(requestId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? { error: result.error }, null, 2) }], isError: !result.success };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Calendar error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'calendar_get_event',
    'Get full details of a specific calendar event by its ID.',
    {
      event_id: z.string().describe('The event ID (from calendar_list_events results)'),
    },
    async (args) => {
      const requestId = calendarRequestId();
      writeIpcFile(TASKS_DIR, {
        type: 'calendar_get_event',
        requestId,
        event_id: args.event_id,
        timestamp: new Date().toISOString(),
      });
      try {
        const result = await waitForCalendarResult(requestId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? { error: result.error }, null, 2) }], isError: !result.success };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Calendar error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'calendar_create_event',
    `Create a new event on Google Calendar. Always confirm event details with the user before creating.
For timed events use ISO 8601 datetime (e.g. "2026-04-07T14:00:00+03:00"). For all-day events use date only ("2026-04-07").`,
    {
      summary: z.string().describe('Event title'),
      start: z.string().describe('Start time (ISO 8601 datetime) or date (YYYY-MM-DD for all-day)'),
      end: z.string().describe('End time (ISO 8601 datetime) or date (YYYY-MM-DD for all-day)'),
      description: z.string().optional().describe('Event description'),
      location: z.string().optional().describe('Event location'),
      attendees: z.string().optional().describe('Comma-separated email addresses of attendees'),
    },
    async (args) => {
      const requestId = calendarRequestId();
      writeIpcFile(TASKS_DIR, {
        type: 'calendar_create_event',
        requestId,
        summary: args.summary,
        start: args.start,
        end: args.end,
        description: args.description,
        location: args.location,
        attendees: args.attendees,
        timestamp: new Date().toISOString(),
      });
      try {
        const result = await waitForCalendarResult(requestId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? { error: result.error }, null, 2) }], isError: !result.success };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Calendar error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'calendar_update_event',
    'Update an existing calendar event. Only provided fields are changed.',
    {
      event_id: z.string().describe('The event ID to update'),
      summary: z.string().optional().describe('New event title'),
      start: z.string().optional().describe('New start time (ISO 8601) or date (YYYY-MM-DD)'),
      end: z.string().optional().describe('New end time (ISO 8601) or date (YYYY-MM-DD)'),
      description: z.string().optional().describe('New description'),
      location: z.string().optional().describe('New location'),
    },
    async (args) => {
      const requestId = calendarRequestId();
      writeIpcFile(TASKS_DIR, {
        type: 'calendar_update_event',
        requestId,
        event_id: args.event_id,
        summary: args.summary,
        start: args.start,
        end: args.end,
        description: args.description,
        location: args.location,
        timestamp: new Date().toISOString(),
      });
      try {
        const result = await waitForCalendarResult(requestId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? { error: result.error }, null, 2) }], isError: !result.success };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Calendar error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'calendar_delete_event',
    'Delete an event from Google Calendar. Confirm with the user before deleting.',
    {
      event_id: z.string().describe('The event ID to delete'),
    },
    async (args) => {
      const requestId = calendarRequestId();
      writeIpcFile(TASKS_DIR, {
        type: 'calendar_delete_event',
        requestId,
        event_id: args.event_id,
        timestamp: new Date().toISOString(),
      });
      try {
        const result = await waitForCalendarResult(requestId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? { error: result.error }, null, 2) }], isError: !result.success };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Calendar error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'calendar_free_busy',
    'Check free/busy status for a time range. Use when the user asks about availability or free slots.',
    {
      time_min: z.string().describe('Start of time range (ISO 8601 datetime)'),
      time_max: z.string().describe('End of time range (ISO 8601 datetime)'),
    },
    async (args) => {
      const requestId = calendarRequestId();
      writeIpcFile(TASKS_DIR, {
        type: 'calendar_free_busy',
        requestId,
        time_min: args.time_min,
        time_max: args.time_max,
        timestamp: new Date().toISOString(),
      });
      try {
        const result = await waitForCalendarResult(requestId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? { error: result.error }, null, 2) }], isError: !result.success };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Calendar error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Google Tasks tools (request/response via IPC)
  // -------------------------------------------------------------------------

  server.tool(
    'tasks_list_lists',
    `List all of the user's Google Tasks task lists (e.g. "My Tasks", "Shopping").
Use this when the user mentions multiple lists or asks which lists exist. The returned id can be passed as list_id to other tasks_* tools.`,
    {},
    async () => {
      const requestId = tasksRequestId();
      writeIpcFile(TASKS_DIR, {
        type: 'tasks_list_lists',
        requestId,
        timestamp: new Date().toISOString(),
      });
      try {
        const result = await waitForTasksResult(requestId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? { error: result.error }, null, 2) }], isError: !result.success };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Tasks error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'tasks_list_tasks',
    `List tasks from a Google Tasks list. By default returns only open (non-completed) tasks from the user's default list.
Use this when the user asks "what's on my todo list", "what do I need to do", or wants to review their pending tasks.`,
    {
      list_id: z.string().optional().describe('Task list id from tasks_list_lists. Defaults to "@default" (the user\'s primary list).'),
      show_completed: z.boolean().optional().describe('Include completed tasks (default false).'),
      due_min: z.string().optional().describe('Lower bound for due date (RFC3339 timestamp). Filter tasks due on or after this date.'),
      due_max: z.string().optional().describe('Upper bound for due date (RFC3339 timestamp).'),
      max_results: z.number().optional().describe('Max items to return (default 100).'),
    },
    async (args) => {
      const requestId = tasksRequestId();
      writeIpcFile(TASKS_DIR, {
        type: 'tasks_list_tasks',
        requestId,
        list_id: args.list_id,
        show_completed: args.show_completed,
        due_min: args.due_min,
        due_max: args.due_max,
        max_results: args.max_results,
        timestamp: new Date().toISOString(),
      });
      try {
        const result = await waitForTasksResult(requestId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? { error: result.error }, null, 2) }], isError: !result.success };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Tasks error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'tasks_get_task',
    'Get full details of a single Google Task by its id.',
    {
      task_id: z.string().describe('The task id (from tasks_list_tasks results).'),
      list_id: z.string().optional().describe('Task list id. Defaults to "@default".'),
    },
    async (args) => {
      const requestId = tasksRequestId();
      writeIpcFile(TASKS_DIR, {
        type: 'tasks_get_task',
        requestId,
        task_id: args.task_id,
        list_id: args.list_id,
        timestamp: new Date().toISOString(),
      });
      try {
        const result = await waitForTasksResult(requestId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? { error: result.error }, null, 2) }], isError: !result.success };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Tasks error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'tasks_create_task',
    `Create a new task in Google Tasks. Use when the user says "remind me to ...", "add a task ...", "put X on my todo list", or similar.
Confirm the title and any details with the user before creating. Use Calendar instead for time-bound events (meetings, appointments).`,
    {
      title: z.string().describe('Task title (short, action-oriented).'),
      notes: z.string().optional().describe('Longer description / notes for the task.'),
      due: z.string().optional().describe('Due date as RFC3339 timestamp (e.g. "2026-04-15T00:00:00.000Z"). NOTE: Google Tasks ignores time-of-day — only the date portion is stored.'),
      list_id: z.string().optional().describe('Target task list id. Defaults to "@default".'),
      parent: z.string().optional().describe('Parent task id, to create a subtask.'),
    },
    async (args) => {
      const requestId = tasksRequestId();
      writeIpcFile(TASKS_DIR, {
        type: 'tasks_create_task',
        requestId,
        title: args.title,
        notes: args.notes,
        due: args.due,
        list_id: args.list_id,
        parent: args.parent,
        timestamp: new Date().toISOString(),
      });
      try {
        const result = await waitForTasksResult(requestId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? { error: result.error }, null, 2) }], isError: !result.success };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Tasks error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'tasks_update_task',
    'Update fields of an existing Google Task. Only provided fields are changed. Confirm changes with the user before applying.',
    {
      task_id: z.string().describe('The task id to update.'),
      list_id: z.string().optional().describe('Task list id. Defaults to "@default".'),
      title: z.string().optional().describe('New title.'),
      notes: z.string().optional().describe('New notes.'),
      due: z.string().optional().describe('New due date (RFC3339; time-of-day ignored).'),
      status: z.string().optional().describe('Status: "needsAction" or "completed".'),
    },
    async (args) => {
      const requestId = tasksRequestId();
      writeIpcFile(TASKS_DIR, {
        type: 'tasks_update_task',
        requestId,
        task_id: args.task_id,
        list_id: args.list_id,
        title: args.title,
        notes: args.notes,
        due: args.due,
        status: args.status,
        timestamp: new Date().toISOString(),
      });
      try {
        const result = await waitForTasksResult(requestId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? { error: result.error }, null, 2) }], isError: !result.success };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Tasks error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'tasks_complete_task',
    'Mark a Google Task as completed. Use when the user says "I did X", "mark X as done", "tick off X".',
    {
      task_id: z.string().describe('The task id to mark completed.'),
      list_id: z.string().optional().describe('Task list id. Defaults to "@default".'),
    },
    async (args) => {
      const requestId = tasksRequestId();
      writeIpcFile(TASKS_DIR, {
        type: 'tasks_complete_task',
        requestId,
        task_id: args.task_id,
        list_id: args.list_id,
        timestamp: new Date().toISOString(),
      });
      try {
        const result = await waitForTasksResult(requestId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? { error: result.error }, null, 2) }], isError: !result.success };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Tasks error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'tasks_delete_task',
    'Delete a Google Task. Confirm with the user before deleting — this is irreversible.',
    {
      task_id: z.string().describe('The task id to delete.'),
      list_id: z.string().optional().describe('Task list id. Defaults to "@default".'),
    },
    async (args) => {
      const requestId = tasksRequestId();
      writeIpcFile(TASKS_DIR, {
        type: 'tasks_delete_task',
        requestId,
        task_id: args.task_id,
        list_id: args.list_id,
        timestamp: new Date().toISOString(),
      });
      try {
        const result = await waitForTasksResult(requestId);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result.data ?? { error: result.error }, null, 2) }], isError: !result.success };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Tasks error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
