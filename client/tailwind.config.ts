import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,svelte}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)',
        fg: 'var(--color-fg)',
        muted: 'var(--color-muted)',
        accent: 'var(--color-accent)',
        'accent-fg': 'var(--color-accent-fg)',
        border: 'var(--color-border)',
        surface: 'var(--color-surface)',
        danger: 'var(--color-danger)',
        section: 'var(--color-section)',
      },
    },
  },
  plugins: [],
} satisfies Config;
