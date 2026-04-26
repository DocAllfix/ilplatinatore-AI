import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'node:path'

const BACKEND_URL = process.env.VITE_API_BACKEND_URL || 'http://localhost:3000'

// https://vite.dev/config/
export default defineConfig({
  logLevel: 'error',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: BACKEND_URL,
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
