import "./globals.css";
import Shell from "@/components/shell";
import { ThemeProvider } from "@/components/theme-provider";
export const metadata={title:"Draftly",description:"Autonomous documentation engineering dashboard"};
const themeScript=`(function(){try{var t=localStorage.getItem('draftly-theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.dataset.theme=d?'dark':'light';document.documentElement.style.colorScheme=d?'dark':'light'}catch(e){}})()`;
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:themeScript}}/></head><body><ThemeProvider><Shell>{children}</Shell></ThemeProvider></body></html>}
