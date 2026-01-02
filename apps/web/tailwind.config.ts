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
        // Refined dark theme - deeper blacks with subtle blue undertones
        background: '#03030a',
        surface: '#0a0a14',
        'surface-light': '#12121e',
        border: '#1a1a2e',
        
        // Accent colors - Electric cyan-green
        accent: '#00ffa3',
        'accent-dim': '#00cc82',
        'accent-light': '#33ffb5',
        
        // Status colors - More saturated
        long: '#00ffa3',     // Success green
        short: '#ff3d71',    // Error red  
        warning: '#ffb800',  // Warning amber
        
        // Text hierarchy
        'text-primary': '#f0f2f5',
        'text-secondary': '#7c8494',
        'text-muted': '#464c5c',
        
        // New accent colors for variety
        'electric-blue': '#00a3ff',
        'violet': '#8b5cf6',
        'orange': '#ff6b35',
      },
      fontFamily: {
        // Display font for headings and emphasis
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        // Sans font for body text
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        // Mono font for prices, numbers, code
        mono: ['var(--font-mono)', 'Menlo', 'monospace'],
      },
      fontSize: {
        // Custom sizing for trading numbers
        'price-lg': ['2.5rem', { lineHeight: '1', letterSpacing: '-0.02em', fontWeight: '700' }],
        'price-md': ['1.75rem', { lineHeight: '1', letterSpacing: '-0.01em', fontWeight: '700' }],
        'price-sm': ['1.25rem', { lineHeight: '1', letterSpacing: '-0.01em', fontWeight: '600' }],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'flash-green': 'flash-green 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'flash-red': 'flash-red 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in-up': 'fade-in-up 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in-scale': 'fade-in-scale 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slide-in-from-bottom 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-down': 'slide-in-from-top 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'border-pulse': 'border-pulse 1.5s ease-in-out infinite',
        'success-pop': 'success-pop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'shake': 'shake 0.4s ease-in-out',
        'shimmer': 'shimmer 1.5s infinite',
        'live-pulse': 'live-pulse 1.5s ease-in-out infinite',
        'spin-slow': 'spin 2s linear infinite',
        'float': 'float 3s ease-in-out infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
      },
      keyframes: {
        'flash-green': {
          '0%': { backgroundColor: 'rgba(0, 255, 163, 0.5)', transform: 'scale(1.02)' },
          '50%': { backgroundColor: 'rgba(0, 255, 163, 0.25)' },
          '100%': { backgroundColor: 'transparent', transform: 'scale(1)' },
        },
        'flash-red': {
          '0%': { backgroundColor: 'rgba(255, 61, 113, 0.5)', transform: 'scale(1.02)' },
          '50%': { backgroundColor: 'rgba(255, 61, 113, 0.25)' },
          '100%': { backgroundColor: 'transparent', transform: 'scale(1)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-in-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in-scale': {
          from: { opacity: '0', transform: 'scale(0.95)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'slide-in-from-bottom': {
          from: { transform: 'translateY(100%)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        'slide-in-from-top': {
          from: { transform: 'translateY(-20px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(0, 255, 163, 0.15)' },
          '50%': { boxShadow: '0 0 20px 4px rgba(0, 255, 163, 0.15)' },
        },
        'glow-pulse': {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '1' },
        },
        'border-pulse': {
          '0%, 100%': { borderColor: '#1a1a2e' },
          '50%': { borderColor: '#00ffa3' },
        },
        'success-pop': {
          '0%': { transform: 'scale(0.8)', opacity: '0' },
          '50%': { transform: 'scale(1.1)' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'shake': {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%, 60%': { transform: 'translateX(-4px)' },
          '40%, 80%': { transform: 'translateX(4px)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'live-pulse': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.5', transform: 'scale(1.2)' },
        },
        'float': {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'out-quart': 'cubic-bezier(0.25, 1, 0.5, 1)',
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      boxShadow: {
        'glow': '0 0 24px rgba(0, 255, 163, 0.15)',
        'glow-sm': '0 0 12px rgba(0, 255, 163, 0.15)',
        'glow-long': '0 0 24px rgba(0, 255, 163, 0.25)',
        'glow-short': '0 0 24px rgba(255, 61, 113, 0.25)',
        'glow-accent': '0 0 32px rgba(0, 255, 163, 0.3)',
        'inner-glow': 'inset 0 0 24px rgba(0, 255, 163, 0.1)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(ellipse at 50% 0%, rgba(0, 255, 163, 0.08) 0%, transparent 50%)',
        'gradient-radial-short': 'radial-gradient(ellipse at 50% 0%, rgba(255, 61, 113, 0.08) 0%, transparent 50%)',
        'grid-pattern': 'linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)',
        'gradient-mesh': 'radial-gradient(at 40% 20%, rgba(0, 255, 163, 0.08) 0px, transparent 50%), radial-gradient(at 80% 0%, rgba(0, 163, 255, 0.05) 0px, transparent 50%), radial-gradient(at 0% 50%, rgba(139, 92, 246, 0.05) 0px, transparent 50%)',
        'gradient-card': 'linear-gradient(135deg, rgba(255,255,255,0.02) 0%, transparent 100%)',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
    },
  },
  plugins: [],
};

export default config;
