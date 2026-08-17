import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { once } from 'node:events';
import path from 'node:path';

import { chromium } from 'playwright';

import {
  sanitizeHar,
  sanitizeWebSocketEvents,
} from './sanitize-capture.mjs';

const startUrl = process.env.EURECIA_URL;
if (!startUrl) {
  throw new Error(
    'EURECIA_URL is required. Example: EURECIA_URL="https://example.eurecia.com" pnpm eurecia:record',
  );
}

const parsedStartUrl = new URL(startUrl);
if (!['http:', 'https:'].includes(parsedStartUrl.protocol)) {
  throw new Error('EURECIA_URL must use http or https.');
}

const rootDirectory = path.join(process.cwd(), '.local', 'eurecia-recorder');
const profileDirectory = path.join(rootDirectory, 'profile');
const captureDirectory = path.join(
  rootDirectory,
  'captures',
  new Date().toISOString().replaceAll(':', '-'),
);
const harPath = path.join(captureDirectory, 'raw.har');
const webSocketPath = path.join(captureDirectory, 'raw-websockets.json');
const reportPath = path.join(captureDirectory, 'sanitized-report.json');

await mkdir(profileDirectory, { recursive: true });
await mkdir(captureDirectory, { recursive: true });

const webSocketEvents = [];
let stopRequested = false;
const stopSignal = Promise.race([
  once(process, 'SIGINT'),
  once(process, 'SIGTERM'),
  once(process, 'SIGHUP'),
]).then(() => {
  stopRequested = true;
});
const context = await chromium.launchPersistentContext(profileDirectory, {
  headless: false,
  recordHar: {
    path: harPath,
    content: 'embed',
    mode: 'full',
  },
});

let contextClosed = false;
let readline;
context.once('close', () => {
  contextClosed = true;
});

function appendFrame(type, url, payload) {
  webSocketEvents.push({
    type,
    url,
    timestamp: new Date().toISOString(),
    ...(Buffer.isBuffer(payload)
      ? { payloadBase64: payload.toString('base64') }
      : { payload }),
  });
}

function observePage(page) {
  page.on('websocket', (webSocket) => {
    const url = webSocket.url();
    webSocketEvents.push({
      type: 'open',
      url,
      timestamp: new Date().toISOString(),
    });
    webSocket.on('framesent', ({ payload }) =>
      appendFrame('frame-sent', url, payload),
    );
    webSocket.on('framereceived', ({ payload }) =>
      appendFrame('frame-received', url, payload),
    );
    webSocket.on('socketerror', (error) => {
      webSocketEvents.push({
        type: 'error',
        url,
        timestamp: new Date().toISOString(),
        payload: String(error),
      });
    });
    webSocket.on('close', () => {
      webSocketEvents.push({
        type: 'close',
        url,
        timestamp: new Date().toISOString(),
      });
    });
  });
}

try {
  if (!stopRequested) {
    for (const page of context.pages()) observePage(page);
    context.on('page', observePage);

    const page = context.pages()[0] ?? (await context.newPage());
    await Promise.race([
      page
        .goto(parsedStartUrl.toString(), { waitUntil: 'domcontentloaded' })
        .catch((error) => {
          console.warn(`Initial navigation did not complete: ${String(error)}`);
        }),
      stopSignal,
    ]);
  }

  if (!stopRequested && !contextClosed) {
    readline = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`Recording Eurecia traffic in ${captureDirectory}`);
    console.log('Recorder will not click, type, or submit anything.');

    await Promise.race([
      readline.question('Press Enter to stop recording and generate report...'),
      once(context, 'close'),
      stopSignal,
    ]);
  }
} finally {
  readline?.close();
  if (!contextClosed) await context.close();
}

await writeFile(webSocketPath, JSON.stringify(webSocketEvents, null, 2));
const har = JSON.parse(await readFile(harPath, 'utf8'));
const sanitizedReport = {
  har: sanitizeHar(har),
  webSockets: sanitizeWebSocketEvents(webSocketEvents),
};
await writeFile(reportPath, JSON.stringify(sanitizedReport, null, 2));

console.log(`Raw HAR: ${harPath}`);
console.log(`Raw WebSockets: ${webSocketPath}`);
console.log(`Sanitized report: ${reportPath}`);
