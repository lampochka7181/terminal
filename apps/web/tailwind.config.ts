import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Terminal-inspired color palette
        background: '#0a0a0f',
        surface: '#12121a',
        'surface-light': '#1a1a25',
        border: '#2a2a3a',
        
        // Accent colors
        accent: '#00ff88',
        'accent-dim': '#00cc6a',
        
        // Status colors
        long: '#00ff88',    // Green for YES/Long
        short: '#ff3366',   // Red for NO/Short
        warning: '#ffaa00',
        
        // Text
        'text-primary': '#ffffff',
        'text-secondary': '#8888aa',
        'text-muted': '#555566',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'flash-green': 'flash-green 0.3s ease-out',
        'flash-red': 'flash-red 0.3s ease-out',
      },
      keyframes: {
        'flash-green': {
          '0%': { backgroundColor: 'rgba(0, 255, 136, 0.3)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'flash-red': {
          '0%': { backgroundColor: 'rgba(255, 51, 102, 0.3)' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
    },
  },
  plugins: [],
};

export default config;



