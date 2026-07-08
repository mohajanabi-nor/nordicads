import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        cream: "var(--cream)",
        "cream-2": "var(--cream-2)",
        orange: "var(--orange)",
        amber: "var(--amber)",
        ink: "var(--ink)",
        mute: "var(--mute)",
        line: "var(--line)",
      },
    },
  },
  plugins: [],
};
export default config;
