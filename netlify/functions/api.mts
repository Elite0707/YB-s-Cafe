import serverless from 'serverless-http';

// This adapter runs the Express app in short-lived serverless function instances.
process.env.NETLIFY = 'true';
const { app } = await import('../../server/dist/app.js');
export const handler = serverless(app);
