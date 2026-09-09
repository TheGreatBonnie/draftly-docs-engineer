import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";
const token=(name:string)=>`rgb(var(--${name}) / <alpha-value>)`;
export default {
  darkMode: ["class"],
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      boxShadow: { card: "0 1px 2px rgb(var(--shadow-color) / .08), 0 8px 24px rgb(var(--shadow-color) / .08)" },
      colors: {
        background: token("background"), surface: token("surface"), "surface-elevated":token("surface-elevated"), "surface-muted":token("surface-muted"), "surface-subtle":token("surface-subtle"),
        foreground: token("foreground"), "foreground-secondary":token("foreground-secondary"), "foreground-muted":token("foreground-muted"),
        border: token("border"), "border-strong":token("border-strong"), brand: token("brand"), "brand-foreground":token("brand-foreground"), "brand-soft":token("brand-soft"),
        success: token("success"), "success-soft":token("success-soft"), warning:token("warning"), "warning-soft":token("warning-soft"), danger:token("danger"), "danger-soft":token("danger-soft"),
        violetToken:token("violet"), "violet-soft":token("violet-soft"), cyanToken:token("cyan"), "cyan-soft":token("cyan-soft"), input:token("input"), ring:token("ring"), code:token("code"), "code-foreground":token("code-foreground")
      }
    }
  },
  plugins: [typography]
} satisfies Config;
