"use client";
import { Laptop, Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
export function ThemeSwitcher(){
 const {theme,setTheme}=useTheme();
 const choices=[{value:"light" as const,label:"Light",Icon:Sun},{value:"dark" as const,label:"Dark",Icon:Moon},{value:"system" as const,label:"System",Icon:Laptop}];
 return <div className="grid gap-2 sm:grid-cols-3">{choices.map(({value,label,Icon})=><button key={value} onClick={()=>setTheme(value)} className={`flex min-h-24 flex-col items-center justify-center gap-2 rounded-xl border p-3 text-sm font-medium transition ${theme===value?"border-brand bg-brand-soft text-brand":"border-border bg-surface hover:bg-surface-subtle"}`}><Icon className="h-5 w-5"/>{label}</button>)}</div>
}
