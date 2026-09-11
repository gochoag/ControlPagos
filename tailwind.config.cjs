module.exports = {
  content: [
    "./controlpagos/templates/**/*.html",
    "./controlpagos/static/js/**/*.js",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "Roboto", "system-ui", "sans-serif"],
      },
      colors: {
        gray: {
          900: "var(--theme-bg-900)",
          800: "var(--theme-bg-800)",
          700: "var(--theme-bg-700)",
          600: "var(--theme-accent)",
          500: "var(--theme-muted)",
          400: "var(--theme-text-muted)",
          300: "var(--theme-text)",
          200: "var(--theme-text)",
          100: "var(--theme-text)",
        },
        brand: {
          400: "var(--theme-accent-soft)",
          500: "var(--theme-accent)",
          600: "var(--theme-accent-hover)",
        },
      },
    },
  },
  plugins: [],
};
