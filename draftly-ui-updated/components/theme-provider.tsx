"use client";

import { createContext, ReactNode, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";
type ThemeContextValue = { theme: Theme; resolvedTheme: ResolvedTheme; setTheme: (theme:Theme)=>void; toggleTheme:()=>void };
const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function applyTheme(theme:Theme):ResolvedTheme {
  const resolved=theme === "system" ? getSystemTheme() : theme;
  document.documentElement.classList.toggle("dark",resolved === "dark");
  document.documentElement.dataset.theme=resolved;
  document.documentElement.style.colorScheme=resolved;
  return resolved;
}

export function ThemeProvider({children}:{children:ReactNode}) {
  const [theme,setThemeState]=useState<Theme>("system");
  const [resolvedTheme,setResolvedTheme]=useState<ResolvedTheme>("light");
  useEffect(()=>{
    const saved=(localStorage.getItem("draftly-theme") as Theme | null) ?? "system";
    setThemeState(saved);
    setResolvedTheme(applyTheme(saved));
  },[]);
  useEffect(()=>{
    if(theme!=="system") return;
    const media=window.matchMedia("(prefers-color-scheme: dark)");
    const onChange=()=>setResolvedTheme(applyTheme("system"));
    media.addEventListener("change",onChange);
    return ()=>media.removeEventListener("change",onChange);
  },[theme]);
  const setTheme=(next:Theme)=>{
    localStorage.setItem("draftly-theme",next);
    setThemeState(next);
    setResolvedTheme(applyTheme(next));
  };
  const toggleTheme=()=>setTheme(resolvedTheme === "dark" ? "light" : "dark");
  return <ThemeContext.Provider value={{theme,resolvedTheme,setTheme,toggleTheme}}>{children}</ThemeContext.Provider>;
}

export function useTheme(){
  const ctx=useContext(ThemeContext);
  if(!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
