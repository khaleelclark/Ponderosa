import { createRoot } from "react-dom/client";
import { ThemeProvider, createTheme, CssBaseline } from "@mui/material";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewChatComposer } from "../src/components/NewChatComposer";
import { api } from "../src/api";
const calls: unknown[] = [];
Object.assign(window,{calls});
api.createChat = (async(body,key)=>{
  calls.push({kind:"chat",body,key});
  return {id:"chat",projectId:"storage",title:"New Chat",defaultEngine:"codex"};
}) as typeof api.createChat;
api.createAgent = (async(project,chat,options)=>{
  calls.push({kind:"agent",project,chat,options});
  if(calls.filter((v:any)=>v.kind==="agent").length===1) throw new Error("Simulated lost response; retry safely");
  return {};
}) as typeof api.createAgent;
api.browseProjectFolders = (async(path)=>{
  const current = path ?? "/home/phoenix";
  return {
    path: current,
    root: "/",
    ...(current === "/" ? {} : { parentPath: "/" }),
    folders: current === "/home/phoenix"
      ? [{ name: "repo", hostPath: "/home/phoenix/repo" }]
      : [],
  };
}) as typeof api.browseProjectFolders;
const engine:any={id:"codex",displayName:"Codex",authentication:"authenticated",intakeReady:true,enabled:true,models:[],efforts:[]};
createRoot(document.getElementById("root")!).render(<ThemeProvider theme={createTheme()}><CssBaseline/><QueryClientProvider client={new QueryClient()}>
  <NewChatComposer engines={[engine]} preferences={{} as any} onCreated={()=>{document.body.dataset.created="true";}}/>
</QueryClientProvider></ThemeProvider>);
