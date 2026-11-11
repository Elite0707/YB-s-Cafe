import serverless from 'serverless-http';

// Mark the Express app as running in a serverless function before loading it.
process.env.NETLIFY = 'true';

const { app } = await import('../../server/dist/app.js');

export const handler = serverless(app);
