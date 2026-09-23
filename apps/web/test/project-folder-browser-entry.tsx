import { createRoot } from "react-dom/client";
import { useState } from "react";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import type { ProjectDto, ProjectFolderDto } from "@ponderosa/core";
import { ProjectFolderRail } from "../src/components/ProjectFolderRail";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useProjectRailDirectory } from "../src/hooks/useWorkspaceDirectory";
import { api } from "../src/api";
import { queryKeys } from "../src/queryKeys";
const initialProjects = ["Alpha", "Beta", "Gamma", "Delta"].map(label => ({ id: label, label, hostPath: `/tmp/${label}`, createdAt: "2026-01-01" })) as ProjectDto[];
function App() {
  const [projects,setProjects] = useState(initialProjects);
  const [folders, setFolders] = useState<ProjectFolderDto[]>([]);
  const [action, setAction] = useState("");
  return <ThemeProvider theme={createTheme()}><CssBaseline /><div style={{ width: 70, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
    <ProjectFolderRail projects={projects} folders={folders} onChange={setFolders} unread={new Map()} running={new Map([["Alpha", 1]])}
      onOpen={p => setAction(`open:${p.id}`)} onReorder={(a,b,c) => {
        setAction(`reorder:${a}:${b}:${c}`);
        setProjects(current => { const next=current.filter(p=>p.id!==a); next.splice(next.findIndex(p=>p.id===b)+(c==="after"?1:0),0,current.find(p=>p.id===a)!);return next; });
      }}
      onRename={p => setAction(`rename:${p.id}`)} onSettings={p => setAction(`settings:${p.id}`)} onDelete={p => setAction(`delete:${p.id}`)} />
  </div><pre id="folders">{JSON.stringify(folders)}</pre><div id="order">{projects.map(p=>p.id).join(",")}</div><div id="action">{action}</div></ThemeProvider>;
}
const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
let working = true;
const manyProjects = Array.from({length:26},(_,i)=>({...initialProjects[0]!,id:`project-${i+1}`,label:`Project ${i+1}`}));
api.getWorkspaceDirectory = (async (_kind: string, options: {cursor?:string}) => ({
  kind:"project", starredItems:[], total:26,
  items:(options.cursor?manyProjects.slice(25):manyProjects.slice(0,25)).map(project=>({kind:"project",project,runningAgentCount:project.id==="project-26"&&working?1:0})),
  history:{hasMore:!options.cursor,...(!options.cursor?{cursor:"page-2"}:{})},
})) as typeof api.getWorkspaceDirectory;
function PaginationFixture() {
  const query=useProjectRailDirectory();
  const counts=new Map(query.data?.pages.flatMap(page=>page.items.map(item=>[item.project.id,item.runningAgentCount] as const))??[]);
  const [folders,setFolders]=useState<ProjectFolderDto[]>([{id:"later",name:"Later",expanded:true,projectIds:["project-26"]}]);
  return <><div id="loaded">{counts.size}</div><button onClick={()=>{working=false;void client.invalidateQueries({queryKey:queryKeys.workspaceDirectory.all});}}>Complete work</button>
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",width:70}}><ProjectFolderRail projects={manyProjects} folders={folders} onChange={setFolders}
      unread={new Map()} running={counts} onOpen={()=>{}} onReorder={()=>{}} onRename={()=>{}} onSettings={()=>{}} onDelete={()=>{}} /></div></>;
}
createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).has("pagination")
  ? <QueryClientProvider client={client}><PaginationFixture /></QueryClientProvider> : <App />);
