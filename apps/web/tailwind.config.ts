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
        // Arctic Terminal Theme - Deep navy with blue undertones
        background: '#060a10',
        surface: '#0c1219',
        'surface-light': '#141d28',
        border: '#1c2a3a',
        
        // Primary accent - Electric ice blue
        accent: '#00d4ff',
        'accent-dim': '#00a8cc',
        'accent-light': '#4de8ff',
        
        // Status colors - Vibrant but balanced
        long: '#00ff88',      // Bright mint green - profit
        short: '#ff4757',     // Coral red - loss
        warning: '#ffb830',   // Warm amber
        
        // Text hierarchy - Cool whites
        'text-primary': '#f0f6fc',
        'text-secondary': '#8b9eb3',
        'text-muted': '#4a5c70',
        
        // Additional accent colors
        'electric-blue': '#3b82f6',
        'violet': '#a78bfa',
        'orange': '#ff9f43',
        'cyan': '#00d4ff',
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
        'urgent-flash': 'urgent-flash 0.5s ease-in-out infinite',
        'expiry-glow': 'expiry-glow 0.8s ease-in-out infinite',
      },
      keyframes: {
        'flash-green': {
          '0%': { backgroundColor: 'rgba(0, 255, 136, 0.5)', transform: 'scale(1.02)' },
          '50%': { backgroundColor: 'rgba(0, 255, 136, 0.25)' },
          '100%': { backgroundColor: 'transparent', transform: 'scale(1)' },
        },
        'flash-red': {
          '0%': { backgroundColor: 'rgba(255, 71, 87, 0.5)', transform: 'scale(1.02)' },
          '50%': { backgroundColor: 'rgba(255, 71, 87, 0.25)' },
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
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(0, 212, 255, 0.15)' },
          '50%': { boxShadow: '0 0 25px 6px rgba(0, 212, 255, 0.15)' },
        },
        'glow-pulse': {
          '0%, 100%': { opacity: '0.5' },
          '50%': { opacity: '1' },
        },
        'border-pulse': {
          '0%, 100%': { borderColor: '#1c2a3a' },
          '50%': { borderColor: '#00d4ff' },
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
        'urgent-flash': {
          '0%, 100%': { 
            opacity: '0.2',
            backgroundColor: 'rgba(255, 71, 87, 0.15)',
          },
          '50%': { 
            opacity: '1',
            backgroundColor: 'rgba(255, 71, 87, 0.4)',
          },
        },
        'expiry-glow': {
          '0%, 100%': { 
            boxShadow: '0 0 5px rgba(255, 71, 87, 0.5), 0 0 20px rgba(255, 71, 87, 0.3)',
          },
          '50%': { 
            boxShadow: '0 0 15px rgba(255, 71, 87, 0.8), 0 0 40px rgba(255, 71, 87, 0.5)',
          },
        },
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'out-quart': 'cubic-bezier(0.25, 1, 0.5, 1)',
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      boxShadow: {
        'glow': '0 0 30px rgba(0, 212, 255, 0.15)',
        'glow-sm': '0 0 15px rgba(0, 212, 255, 0.15)',
        'glow-long': '0 0 30px rgba(0, 255, 136, 0.25)',
        'glow-short': '0 0 30px rgba(255, 71, 87, 0.25)',
        'glow-accent': '0 0 40px rgba(0, 212, 255, 0.3)',
        'inner-glow': 'inset 0 0 30px rgba(0, 212, 255, 0.1)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(ellipse at 50% 0%, rgba(0, 255, 136, 0.06) 0%, transparent 50%)',
        'gradient-radial-short': 'radial-gradient(ellipse at 50% 0%, rgba(255, 71, 87, 0.06) 0%, transparent 50%)',
        'grid-pattern': 'linear-gradient(rgba(0, 212, 255, 0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 212, 255, 0.03) 1px, transparent 1px)',
        'gradient-mesh': 'radial-gradient(at 40% 20%, rgba(0, 212, 255, 0.08) 0px, transparent 50%), radial-gradient(at 80% 0%, rgba(59, 130, 246, 0.04) 0px, transparent 50%), radial-gradient(at 0% 50%, rgba(167, 139, 250, 0.04) 0px, transparent 50%)',
        'gradient-card': 'linear-gradient(135deg, rgba(0, 212, 255, 0.02) 0%, transparent 100%)',
        'arctic-glow': 'radial-gradient(ellipse at 50% -20%, rgba(0, 212, 255, 0.08) 0%, transparent 60%)',
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
