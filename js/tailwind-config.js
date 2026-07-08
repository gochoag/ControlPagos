      tailwind.config = {
        darkMode: "class",
        theme: {
          extend: {
            fontFamily: {
              sans: ["Outfit", "sans-serif"],
            },
            colors: {
              gray: {
                900: "var(--theme-bg-900)",
                800: "var(--theme-bg-800)",
                700: "var(--theme-bg-700)",
                600: "var(--theme-accent)",
                500: "var(--theme-accent)",
                400: "var(--theme-text)",
                300: "var(--theme-text)",
                200: "var(--theme-text)",
                100: "var(--theme-text)",
              },
              dark: {
                900: "var(--theme-bg-900)",
                800: "var(--theme-bg-800)",
                700: "var(--theme-bg-700)",
              },
              brand: {
                500: "var(--theme-accent)",
                600: "var(--theme-accent-hover)",
                400: "var(--theme-text)",
              },
              emerald: {
                400: "var(--theme-accent)",
                500: "var(--theme-bg-700)",
              },
              blue: {
                400: "var(--theme-text)",
              },
            },
          },
        },
      };
