/**
 * One-time Google Calendar OAuth setup for headless VPS.
 *
 * Usage:
 *   1. Download OAuth client credentials JSON from GCP Console (Desktop app type)
 *   2. Place at data/google-calendar-credentials.json
 *   3. SSH port-forward: ssh -L 3000:localhost:3000 nanoclaw
 *   4. Run: npx tsx .claude/skills/google-calendar/scripts/setup-oauth.ts
 *   5. Open the printed URL in your browser, grant consent
 *   6. Tokens saved to data/google-calendar-token.json
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { URL } from 'url';
import { google } from 'googleapis';

const PROJECT_ROOT = path.resolve(
  import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
  '../../../..',
);
const CREDENTIALS_PATH = path.join(
  PROJECT_ROOT,
  'data',
  'google-calendar-credentials.json',
);
const TOKEN_PATH = path.join(
  PROJECT_ROOT,
  'data',
  'google-calendar-token.json',
);
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

async function main() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(
      `\nCredentials file not found: ${CREDENTIALS_PATH}\n` +
        `\nSteps:\n` +
        `  1. Go to https://console.cloud.google.com/apis/credentials\n` +
        `  2. Create OAuth 2.0 Client ID (type: Desktop app)\n` +
        `  3. Download the JSON file\n` +
        `  4. Save it as: ${CREDENTIALS_PATH}\n`,
    );
    process.exit(1);
  }

  if (fs.existsSync(TOKEN_PATH)) {
    console.log(`\nToken already exists: ${TOKEN_PATH}`);
    console.log('Delete it first if you want to re-authorize.\n');
    process.exit(0);
  }

  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const creds = raw.installed || raw.web;
  if (!creds) {
    console.error('Invalid credentials file — expected "installed" or "web" key.');
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    REDIRECT_URI,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log(`\n${'='.repeat(60)}`);
  console.log('Google Calendar OAuth Setup');
  console.log('='.repeat(60));
  console.log(`\n1. Make sure you have SSH port-forward active:`);
  console.log(`   ssh -L ${PORT}:localhost:${PORT} nanoclaw\n`);
  console.log(`2. Open this URL in your browser:\n`);
  console.log(`   ${authUrl}\n`);
  console.log(`3. Grant access — the page will redirect and this script will capture the token.\n`);
  console.log('Waiting for callback...\n');

  const code = await waitForAuthCode();

  console.log('Received authorization code. Exchanging for tokens...');

  const { tokens } = await oauth2Client.getToken(code);

  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  fs.chmodSync(TOKEN_PATH, 0o600);

  console.log(`\nTokens saved to: ${TOKEN_PATH}`);
  console.log('Google Calendar integration is ready!\n');
}

function waitForAuthCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${PORT}`);

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (code) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>',
          );
          server.close();
          resolve(code);
          return;
        }
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(PORT, '127.0.0.1', () => {
      // server ready
    });

    server.on('error', (err) => {
      reject(new Error(`Failed to start callback server on port ${PORT}: ${err.message}`));
    });

    setTimeout(() => {
      server.close();
      reject(new Error('Timeout: no callback received within 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

main().catch((err) => {
  console.error('Setup failed:', err.message || err);
  process.exit(1);
});
