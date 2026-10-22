import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
    // The local speech engine lives in tools/ (a binary and ~170MB of voice
    // models). Watching it is pointless and, while a download is in flight,
    // fatal: the watcher hit EBUSY on the half-written zip and took the whole
    // dev server down with it.
    // .env too: the bridge's settings live there, and every edit to it made
    // Vite restart and throw the open interface — and its agent session —
    // away. The two VITE_ keys in it are read at start; change those and
    // restart by hand.
    watch: { ignored: ['**/tools/**', '**/.env'] },
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
})
