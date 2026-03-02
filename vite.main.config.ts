import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig(({ command }) => ({
  define: {
    'process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL': command === 'serve'
      ? JSON.stringify(process.env.MAIN_WINDOW_VITE_DEV_SERVER_URL || 'http://localhost:5173')
      : 'undefined',
  },
  build: {
    minify: false,
    rollupOptions: {
      external: [
        'electron',
        'original-fs',
        'better-sqlite3',
        '@modelcontextprotocol/sdk',
        '@libsql/client',
        /^@libsql\/.*/,
        'bufferutil',
        'utf-8-validate',
        'winston',
        /^winston\/.*/,
        'winston-daily-rotate-file',
      ]
    }
  },
  resolve: {
    browserField: false,
    conditions: ['node'],
    mainFields: ['module', 'jsnext:main', 'jsnext']
  }
}));
