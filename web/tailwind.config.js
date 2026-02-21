/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Clinical color palette - "Sterile Trust"
        clinical: {
          // Backgrounds
          bg: '#F4F6F8',        // Light gray-blue, easy on eyes
          card: '#FFFFFF',       // Pure white for panels
          border: '#E0E0E0',     // Subtle borders
          
          // Dark mode backgrounds (Radiology style)
          'dark-bg': '#121212',
          'dark-card': '#1E1E1E',
          'dark-border': '#2E2E2E',
          
          // Text
          'text-primary': '#1F2937',
          'text-secondary': '#6B7280',
          'text-dark': '#E0E0E0',
          'text-dark-secondary': '#9CA3AF',
          
          // Brand - NHS Blue
          blue: '#005EB8',
          'blue-hover': '#004B93',
          'blue-light': '#E6F0FA',
          
          // Status colors (matte, desaturated)
          record: '#D92D20',
          'record-hover': '#B91C1C',
          ready: '#039855',
          'ready-hover': '#027A48',
          warning: '#DC6803',
          
          // Neutral actions
          neutral: '#4B5563',
          'neutral-hover': '#374151',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Roboto Mono', 'monospace'],
      },
      fontSize: {
        // Slightly larger for medical context (viewing distance)
        'base': ['15px', '1.6'],
        'sm': ['13px', '1.5'],
        'xs': ['11px', '1.4'],
        'lg': ['17px', '1.6'],
      },
      borderRadius: {
        // More precise, engineered feel
        'DEFAULT': '6px',
        'sm': '4px',
        'md': '6px',
        'lg': '8px',
      },
      keyframes: {
        shimmer: {
          '0%':   { transform: 'translateX(-150%)' },
          '100%': { transform: 'translateX(500%)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}