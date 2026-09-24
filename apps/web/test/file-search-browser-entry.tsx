import { createRoot } from "react-dom/client";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";
import { GlobalChatSearch, routeForGlobalSearchSelection } from "../src/components/GlobalChatSearch";
import { api } from "../src/api";
api.getNotificationProjection=(async()=>({openActionCount:0})) as any;
api.searchGlobalChats=(async()=>({results:[],recentChats:[],truncated:false})) as any;
api.getWorkspaceDirectory=(async()=>({items:[],starredItems:[],total:0,history:{hasMore:false}})) as any;
api.searchGlobalFiles=async(query)=>({results:!query||query.includes("report")?[{project:{id:"p",label:"Workspace"},path:"docs/report.txt",name:"report.txt"}]:[],truncated:false,unavailableRoots:0});
function App(){const [route,setRoute]=useState("");const [open,setOpen]=useState(true);return <ThemeProvider theme={createTheme({palette:{mode:"dark"}})}><CssBaseline/><button onClick={()=>setOpen(true)}>Open search</button><GlobalChatSearch open={open} onClose={()=>setOpen(false)} onExited={()=>document.querySelector<HTMLButtonElement>("button")?.focus()} onSelect={selection=>setRoute(JSON.stringify(routeForGlobalSearchSelection(selection)))}/><pre id="selected-route">{route}</pre></ThemeProvider>;}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><App/></QueryClientProvider>);
