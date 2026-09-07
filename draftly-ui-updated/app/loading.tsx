import { Skeleton } from "@/components/ui";
export default function Loading(){return <div className="space-y-4"><Skeleton className="h-10 w-64"/><Skeleton className="h-4 w-[min(680px,90%)]"/><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({length:4}).map((_,i)=><Skeleton key={i} className="h-28"/>)}</div><Skeleton className="h-12"/><Skeleton className="h-[460px]"/></div>}
