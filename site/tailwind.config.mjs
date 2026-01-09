/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        cyber: {
          cyan: '#00E5FF',
          magenta: '#FF00E5',
          purple: '#9B4DFF',
          dark: '#0A0A1A',
          darker: '#050510',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      boxShadow: {
        'neon-cyan': '0 0 20px rgba(0, 229, 255, 0.5)',
        'neon-magenta': '0 0 20px rgba(255, 0, 229, 0.5)',
        'neon-purple': '0 0 20px rgba(155, 77, 255, 0.5)',
      },
    },
  },
  plugins: [],
};
