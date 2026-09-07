"use client";
import { usePathname } from "next/navigation";
import { Tabs } from "@/components/ui";

export const sectionTabs = {
  activity: [
    {label:"All activity",href:"/activity"},
    {label:"Document changes",href:"/activity/document-changes"},
    {label:"Workflow runs",href:"/activity/workflow-runs"},
    {label:"Evaluations",href:"/activity/evaluations"},
    {label:"Support",href:"/activity/support"},
    {label:"System",href:"/activity/system"},
  ],
  reviews: [
    {label:"All reviews",href:"/reviews"},
    {label:"Pending",href:"/reviews/pending",count:12},
    {label:"Needs attention",href:"/reviews/needs-attention",count:4},
    {label:"Approved",href:"/reviews/approved"},
    {label:"Rejected",href:"/reviews/rejected"},
  ],
  evaluations: [
    {label:"Overview",href:"/evaluations"},
    {label:"Runs",href:"/evaluations/runs"},
    {label:"Test cases",href:"/evaluations/test-cases"},
    {label:"Datasets",href:"/evaluations/datasets"},
    {label:"Evaluators",href:"/evaluations/evaluators"},
    {label:"Trends",href:"/evaluations/trends"},
  ],
  documentation: [
    {label:"All documents",href:"/documentation"},
    {label:"By repository",href:"/documentation/by-repository"},
    {label:"By topic",href:"/documentation/by-topic"},
    {label:"Outdated",href:"/documentation/outdated",count:8},
    {label:"Recently updated",href:"/documentation/recently-updated"},
  ],
  workflows: [
    {label:"All workflows",href:"/workflows"},
    {label:"Active",href:"/workflows/active",count:6},
    {label:"Paused",href:"/workflows/paused"},
    {label:"Drafts",href:"/workflows/drafts"},
    {label:"Templates",href:"/workflows/templates"},
  ],
  agents: [
    {label:"All agents",href:"/agents"},
    {label:"Active",href:"/agents/active",count:8},
    {label:"Idle",href:"/agents/idle",count:2},
    {label:"Templates",href:"/agents/templates"},
  ]
} as const;

export function SectionTabs({section,className=""}:{section:keyof typeof sectionTabs,className?:string}){
 const path=usePathname();
 const items=sectionTabs[section];
 const exact=items.find(x=>x.href===path);
 const active=exact?.label ?? items[0].label;
 return <Tabs items={[...items]} active={active} className={className}/>;
}
