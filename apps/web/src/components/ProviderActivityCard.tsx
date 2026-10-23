import {Alert,Box,FormControl,InputLabel,LinearProgress,MenuItem,Paper,Select,Stack,Typography} from "@mui/material";
import type {TokenUsageScope} from "@ponderosa/core";
import {useQuery} from "@tanstack/react-query";
import {useEffect,useState} from "react";
import {api} from "../api";
import {queryKeys} from "../queryKeys";
import {TokenUsageDetails} from "./TokenUsageButton";

export interface ProviderActivityScopeOption {
  scope: TokenUsageScope;
  id?: string;
  label: string;
}

export function ProviderActivityCard({scopes,initialScopeKey,title="Provider Activity"}:{scopes:ProviderActivityScopeOption[];initialScopeKey?:string;title?:string}):JSX.Element {
  const keyFor=(option:ProviderActivityScopeOption)=>`${option.scope}:${option.id??""}`;
  const [scopeKey,setScopeKey]=useState(initialScopeKey??keyFor(scopes[0]??{scope:"overall",label:"All Ponderosa"}));
  const [rangeKey,setRangeKey]=useState<"24h"|"7d"|"30d"|"all">("30d");
  useEffect(()=>{if(!scopes.some(option=>keyFor(option)===scopeKey)&&scopes[0])setScopeKey(keyFor(scopes[0]))},[scopes,scopeKey]);
  const selected=scopes.find(option=>keyFor(option)===scopeKey)??scopes[0]??{scope:"overall" as const,label:"All Ponderosa"};
  const from=rangeKey==="all"?undefined:new Date(Date.now()-({"24h":1,"7d":7,"30d":30}[rangeKey]*86_400_000)).toISOString();
  const usage=useQuery({queryKey:queryKeys.tokenUsage.detail(selected.scope,selected.id,rangeKey),queryFn:()=>api.getTokenUsage(selected.scope,selected.id,from?{from}:{}),refetchInterval:30_000});
  return <Paper variant="outlined" sx={{p:{xs:2,sm:2.5}}}>
    <Typography variant="h6" fontWeight={800}>{title}</Typography>
    <Typography variant="body2" color="text.secondary" sx={{mb:2}}>Provider-reported Run telemetry for experiments and diagnostics.</Typography>
    <Stack direction={{xs:"column",sm:"row"}} spacing={1.5} sx={{pb:2}}>
      {scopes.length>1&&<FormControl size="small" sx={{minWidth:260}}><InputLabel id="usage-scope">Scope</InputLabel><Select labelId="usage-scope" label="Scope" value={scopeKey} onChange={event=>setScopeKey(event.target.value)}>{scopes.map(option=><MenuItem key={keyFor(option)} value={keyFor(option)}>{option.label}</MenuItem>)}</Select></FormControl>}
      <FormControl size="small" sx={{minWidth:160}}><InputLabel id="usage-range">Time Range</InputLabel><Select labelId="usage-range" label="Time Range" value={rangeKey} onChange={event=>setRangeKey(event.target.value as typeof rangeKey)}><MenuItem value="24h">Last 24 Hours</MenuItem><MenuItem value="7d">Last 7 Days</MenuItem><MenuItem value="30d">Last 30 Days</MenuItem><MenuItem value="all">All Time</MenuItem></Select></FormControl>
    </Stack>
    <Alert severity="info" sx={{mb:2}}>Input includes instructions, tools, conversation context, and cached reuse. These are provider-reported tokens, not subscription quota, remaining context, or a cost estimate.</Alert>
    <Box>{usage.isError?<Alert severity="error">Provider activity could not be loaded.</Alert>:!usage.data?<LinearProgress/>:<TokenUsageDetails data={usage.data}/>}</Box>
  </Paper>;
}
