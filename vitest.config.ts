import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Os testes não leem as chaves do .env.local nem acessam o Supabase real.
  envDir: false,
  define: {
    'import.meta.env.VITE_INVITES_ENABLED': JSON.stringify('true'),
    'import.meta.env.VITE_TURNSTILE_SITE_KEY': JSON.stringify('chave-de-teste'),
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.tsx'],
    environmentOptions: {
      jsdom: { url: 'http://localhost:5173' },
    },
  },
})
