const serverless = require('serverless-http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Netlify's generated Lambda entry loads this adapter with require().
process.env.NETLIFY = 'true';

const appModuleUrl = pathToFileURL(path.resolve(__dirname, '../../server/dist/app.js')).href;
const initialization = import(appModuleUrl)
  .then(({ app }) => ({ handler: serverless(app) }))
  .catch((error) => ({ error }));

exports.handler = async (event, context) => {
  const result = await initialization;
  if ('error' in result) {
    const message = String(result.error?.message || result.error || 'Unknown startup error');
    console.error('API app initialization failed:', result.error);
    const safeMessage = [process.env.DATABASE_URL, process.env.SESSION_SECRET]
      .filter(Boolean)
      .reduce((value, secret) => value.split(secret).join('[redacted]'), message)
      .slice(0, 400);
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'API app initialization failed', detail: safeMessage }),
    };
  }

  return result.handler(event, context);
};
