import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            if (request.headers.host) proxyRequest.setHeader('x-forwarded-host', request.headers.host);
            const encrypted = (request.socket as typeof request.socket & { encrypted?: boolean }).encrypted;
            proxyRequest.setHeader('x-forwarded-proto', encrypted ? 'https' : 'http');
          });
        },
      },
    },
  },
});
