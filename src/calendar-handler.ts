/**
 * Host-side IPC handler for Google Calendar integration.
 * Processes calendar_* IPC tasks from the container agent,
 * calls Google Calendar API via googleapis, writes results back.
 */

import fs from 'fs';
import path from 'path';
import { google, calendar_v3, tasks_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

import { logger } from './logger.js';

const CREDENTIALS_FILENAME = 'google-calendar-credentials.json';
const TOKEN_FILENAME = 'google-calendar-token.json';

let cachedAuth: OAuth2Client | null = null;
let cachedCalendar: calendar_v3.Calendar | null = null;
let cachedTasks: tasks_v1.Tasks | null = null;

function initCalendarClient(dataDir: string): calendar_v3.Calendar | null {
  if (cachedCalendar) return cachedCalendar;

  const credPath = path.join(dataDir, CREDENTIALS_FILENAME);
  const tokenPath = path.join(dataDir, TOKEN_FILENAME);

  if (!fs.existsSync(credPath)) {
    logger.warn({ credPath }, 'Google Calendar credentials not found');
    return null;
  }
  if (!fs.existsSync(tokenPath)) {
    logger.warn(
      { tokenPath },
      'Google Calendar token not found — run setup-oauth first',
    );
    return null;
  }

  const raw = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  const creds = raw.installed || raw.web;
  if (!creds) {
    logger.error('Invalid Google Calendar credentials file');
    return null;
  }

  const tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));

  const oauth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uris?.[0],
  );
  oauth2Client.setCredentials(tokens);

  // Auto-persist refreshed tokens
  oauth2Client.on('tokens', (newTokens) => {
    const existing = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    const merged = { ...existing, ...newTokens };
    fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2));
    logger.info('Google Calendar tokens refreshed and saved');
  });

  cachedAuth = oauth2Client;
  cachedCalendar = google.calendar({ version: 'v3', auth: oauth2Client });
  logger.info('Google Calendar client initialized');
  return cachedCalendar;
}

function initTasksClient(dataDir: string): tasks_v1.Tasks | null {
  if (cachedTasks) return cachedTasks;
  // Reuse cachedAuth from the Calendar init path — one OAuth client serves
  // both Calendar and Tasks scopes, with shared token refresh.
  if (!initCalendarClient(dataDir)) return null;
  cachedTasks = google.tasks({ version: 'v1', auth: cachedAuth! });
  logger.info('Google Tasks client initialized');
  return cachedTasks;
}

function writeResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: { success: boolean; data?: unknown; error?: string },
  subdir: string = 'calendar_results',
): void {
  const resultDir = path.join(dataDir, 'ipc', sourceGroup, subdir);
  fs.mkdirSync(resultDir, { recursive: true });
  const filePath = path.join(resultDir, `${requestId}.json`);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(result, null, 2));
  fs.renameSync(tempPath, filePath);
}

export async function handleCalendarIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;
  if (!type.startsWith('calendar_')) return false;

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'Calendar IPC missing requestId');
    return true;
  }

  if (!isMain) {
    writeResult(dataDir, sourceGroup, requestId, {
      success: false,
      error: 'Calendar tools are only available to the main group.',
    });
    return true;
  }

  const calendar = initCalendarClient(dataDir);
  if (!calendar) {
    writeResult(dataDir, sourceGroup, requestId, {
      success: false,
      error:
        'Google Calendar not configured. Run the setup-oauth script first.',
    });
    return true;
  }

  try {
    switch (type) {
      case 'calendar_list_events': {
        const now = new Date().toISOString();
        const res = await calendar.events.list({
          calendarId: 'primary',
          timeMin: (data.time_min as string) || now,
          timeMax: (data.time_max as string) || undefined,
          maxResults: (data.max_results as number) || 10,
          singleEvents: true,
          orderBy: 'startTime',
          q: (data.query as string) || undefined,
        });
        const events = (res.data.items || []).map((e) => ({
          id: e.id,
          summary: e.summary,
          start: e.start?.dateTime || e.start?.date,
          end: e.end?.dateTime || e.end?.date,
          location: e.location,
          description: e.description,
          status: e.status,
          htmlLink: e.htmlLink,
          attendees: e.attendees?.map((a) => ({
            email: a.email,
            responseStatus: a.responseStatus,
          })),
        }));
        writeResult(dataDir, sourceGroup, requestId, {
          success: true,
          data: { events, count: events.length },
        });
        break;
      }

      case 'calendar_get_event': {
        const res = await calendar.events.get({
          calendarId: 'primary',
          eventId: data.event_id as string,
        });
        const e = res.data;
        writeResult(dataDir, sourceGroup, requestId, {
          success: true,
          data: {
            id: e.id,
            summary: e.summary,
            start: e.start?.dateTime || e.start?.date,
            end: e.end?.dateTime || e.end?.date,
            location: e.location,
            description: e.description,
            status: e.status,
            htmlLink: e.htmlLink,
            recurrence: e.recurrence,
            attendees: e.attendees?.map((a) => ({
              email: a.email,
              displayName: a.displayName,
              responseStatus: a.responseStatus,
            })),
            reminders: e.reminders,
            created: e.created,
            updated: e.updated,
          },
        });
        break;
      }

      case 'calendar_create_event': {
        const event: calendar_v3.Schema$Event = {
          summary: data.summary as string,
          description: (data.description as string) || undefined,
          location: (data.location as string) || undefined,
          start: {},
          end: {},
        };

        // Support all-day events (date only) and timed events (dateTime)
        const startStr = data.start as string;
        const endStr = data.end as string;
        if (startStr.length === 10) {
          event.start = { date: startStr };
          event.end = { date: endStr };
        } else {
          event.start = { dateTime: startStr };
          event.end = { dateTime: endStr };
        }

        if (data.attendees) {
          const emails = (data.attendees as string)
            .split(',')
            .map((addr: string) => ({ email: addr.trim() }));
          event.attendees = emails;
        }

        const res = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: event,
        });
        writeResult(dataDir, sourceGroup, requestId, {
          success: true,
          data: {
            id: res.data.id,
            summary: res.data.summary,
            start: res.data.start?.dateTime || res.data.start?.date,
            end: res.data.end?.dateTime || res.data.end?.date,
            htmlLink: res.data.htmlLink,
          },
        });
        break;
      }

      case 'calendar_update_event': {
        const patch: calendar_v3.Schema$Event = {};
        if (data.summary) patch.summary = data.summary as string;
        if (data.description !== undefined)
          patch.description = data.description as string;
        if (data.location !== undefined)
          patch.location = data.location as string;
        if (data.start) {
          const s = data.start as string;
          patch.start = s.length === 10 ? { date: s } : { dateTime: s };
        }
        if (data.end) {
          const e = data.end as string;
          patch.end = e.length === 10 ? { date: e } : { dateTime: e };
        }

        const res = await calendar.events.patch({
          calendarId: 'primary',
          eventId: data.event_id as string,
          requestBody: patch,
        });
        writeResult(dataDir, sourceGroup, requestId, {
          success: true,
          data: {
            id: res.data.id,
            summary: res.data.summary,
            start: res.data.start?.dateTime || res.data.start?.date,
            end: res.data.end?.dateTime || res.data.end?.date,
            htmlLink: res.data.htmlLink,
          },
        });
        break;
      }

      case 'calendar_delete_event': {
        await calendar.events.delete({
          calendarId: 'primary',
          eventId: data.event_id as string,
        });
        writeResult(dataDir, sourceGroup, requestId, {
          success: true,
          data: { deleted: true, event_id: data.event_id },
        });
        break;
      }

      case 'calendar_free_busy': {
        const freeBusyCalendar = google.calendar({
          version: 'v3',
          auth: cachedAuth!,
        });
        const res = await freeBusyCalendar.freebusy.query({
          requestBody: {
            timeMin: data.time_min as string,
            timeMax: data.time_max as string,
            items: [{ id: 'primary' }],
          },
        });
        const busy = res.data.calendars?.['primary']?.busy || [];
        writeResult(dataDir, sourceGroup, requestId, {
          success: true,
          data: { busy },
        });
        break;
      }

      default:
        writeResult(dataDir, sourceGroup, requestId, {
          success: false,
          error: `Unknown calendar operation: ${type}`,
        });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, type, requestId }, 'Google Calendar API error');
    writeResult(dataDir, sourceGroup, requestId, {
      success: false,
      error: message,
    });
  }

  return true;
}

function shapeTask(t: tasks_v1.Schema$Task) {
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    due: t.due,
    status: t.status,
    completed: t.completed,
    updated: t.updated,
    parent: t.parent,
    selfLink: t.selfLink,
  };
}

export async function handleTasksIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;
  if (!type.startsWith('tasks_')) return false;

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'Tasks IPC missing requestId');
    return true;
  }

  if (!isMain) {
    writeResult(
      dataDir,
      sourceGroup,
      requestId,
      {
        success: false,
        error: 'Tasks tools are only available to the main group.',
      },
      'tasks_results',
    );
    return true;
  }

  const tasks = initTasksClient(dataDir);
  if (!tasks) {
    writeResult(
      dataDir,
      sourceGroup,
      requestId,
      {
        success: false,
        error:
          'Google Tasks not configured. Run the setup-oauth script first (and re-authorize if you only had Calendar scope previously).',
      },
      'tasks_results',
    );
    return true;
  }

  const listId = (data.list_id as string) || '@default';

  try {
    switch (type) {
      case 'tasks_list_lists': {
        const res = await tasks.tasklists.list({ maxResults: 100 });
        const lists = (res.data.items || []).map((l) => ({
          id: l.id,
          title: l.title,
          updated: l.updated,
        }));
        writeResult(
          dataDir,
          sourceGroup,
          requestId,
          { success: true, data: { lists, count: lists.length } },
          'tasks_results',
        );
        break;
      }

      case 'tasks_list_tasks': {
        const res = await tasks.tasks.list({
          tasklist: listId,
          showCompleted: (data.show_completed as boolean) ?? false,
          showHidden: (data.show_completed as boolean) ?? false,
          dueMin: (data.due_min as string) || undefined,
          dueMax: (data.due_max as string) || undefined,
          maxResults: (data.max_results as number) || 100,
        });
        const items = (res.data.items || []).map(shapeTask);
        writeResult(
          dataDir,
          sourceGroup,
          requestId,
          { success: true, data: { tasks: items, count: items.length } },
          'tasks_results',
        );
        break;
      }

      case 'tasks_get_task': {
        const res = await tasks.tasks.get({
          tasklist: listId,
          task: data.task_id as string,
        });
        writeResult(
          dataDir,
          sourceGroup,
          requestId,
          { success: true, data: shapeTask(res.data) },
          'tasks_results',
        );
        break;
      }

      case 'tasks_create_task': {
        const body: tasks_v1.Schema$Task = {
          title: data.title as string,
          notes: (data.notes as string) || undefined,
          due: (data.due as string) || undefined,
        };
        const res = await tasks.tasks.insert({
          tasklist: listId,
          parent: (data.parent as string) || undefined,
          requestBody: body,
        });
        writeResult(
          dataDir,
          sourceGroup,
          requestId,
          { success: true, data: shapeTask(res.data) },
          'tasks_results',
        );
        break;
      }

      case 'tasks_update_task': {
        const patch: tasks_v1.Schema$Task = {};
        if (data.title !== undefined) patch.title = data.title as string;
        if (data.notes !== undefined) patch.notes = data.notes as string;
        if (data.due !== undefined) patch.due = data.due as string;
        if (data.status !== undefined) patch.status = data.status as string;
        const res = await tasks.tasks.patch({
          tasklist: listId,
          task: data.task_id as string,
          requestBody: patch,
        });
        writeResult(
          dataDir,
          sourceGroup,
          requestId,
          { success: true, data: shapeTask(res.data) },
          'tasks_results',
        );
        break;
      }

      case 'tasks_complete_task': {
        const res = await tasks.tasks.patch({
          tasklist: listId,
          task: data.task_id as string,
          requestBody: { status: 'completed' },
        });
        writeResult(
          dataDir,
          sourceGroup,
          requestId,
          { success: true, data: shapeTask(res.data) },
          'tasks_results',
        );
        break;
      }

      case 'tasks_delete_task': {
        await tasks.tasks.delete({
          tasklist: listId,
          task: data.task_id as string,
        });
        writeResult(
          dataDir,
          sourceGroup,
          requestId,
          { success: true, data: { deleted: true, task_id: data.task_id } },
          'tasks_results',
        );
        break;
      }

      default:
        writeResult(
          dataDir,
          sourceGroup,
          requestId,
          { success: false, error: `Unknown tasks operation: ${type}` },
          'tasks_results',
        );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, type, requestId }, 'Google Tasks API error');
    writeResult(
      dataDir,
      sourceGroup,
      requestId,
      { success: false, error: message },
      'tasks_results',
    );
  }

  return true;
}
