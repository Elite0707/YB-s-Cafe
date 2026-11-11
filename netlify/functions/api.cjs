const serverless = require('serverless-http');

// Netlify's generated Lambda entry loads this adapter with require().
process.env.NETLIFY = 'true';

const handlerPromise = import('../../server/dist/app.js').then(({ app }) => serverless(app));

exports.handler = async (event, context) => {
  const handler = await handlerPromise;
  return handler(event, context);
};
