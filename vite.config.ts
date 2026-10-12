import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        // Electron main process entry
        entry: 'electron/main.ts',
      },
      preload: {
        // Preload script entry
        input: 'electron/preload.ts',
      },
      // Expose Electron/Node built-ins in the renderer if needed.
      // Set to `undefined` during tests to avoid startup issues.
      renderer:
        process.env.NODE_ENV === 'test'
          ? undefined
          : {},
    }),
  ],
})
