import {MIN_SCHEDULE_INTERVAL_MS,nextIntervalTime} from "@ponderosa/core";
import {useId,useState} from 'react';
import {Button,FormControl,FormControlLabel,FormLabel,InputLabel,Select,MenuItem,Radio,RadioGroup,Stack,TextField,Typography} from '@mui/material';
import type {TriggerScheduleConfig,TriggerScheduleWhenRunning,TriggerSourceConfig,TriggerSourceKind} from '@ponderosa/core';
import {splitTriggerGlobText} from './triggerSourceValues';
export function isoToDatetimeLocal(value: string): string {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 23);
}

export function intervalSourceConfig(everyMs: number, original?: { startsAt: string }): Extract<TriggerScheduleConfig,{scheduleKind:"interval"}> {
  return { scheduleKind: "interval", everyMs, startsAt: original?.startsAt ?? new Date().toISOString() };
}

export type IntervalUnit = "minutes" | "hours" | "days" | "weeks";
export const INTERVAL_UNIT_MS: Record<IntervalUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

export function intervalParts(everyMs: number): { value: string; unit: IntervalUnit } {
  for (const unit of ["weeks", "days", "hours"] as const) {
    const value = everyMs / INTERVAL_UNIT_MS[unit];
    if (Number.isInteger(value)) return { value: String(value), unit };
  }
  return { value: String(everyMs / INTERVAL_UNIT_MS.minutes), unit: "minutes" };
}

export function filesystemWindowErrors(quietValue: string, maxValue: string): { quiet?: string; max?: string } {
  const quiet = Number(quietValue);
  const max = Number(maxValue);
  const errors: { quiet?: string; max?: string } = {};
  if (!quietValue.trim() || !Number.isFinite(quiet) || quiet < 0.1 || quiet > 3_600) {
    errors.quiet = "Quiet window must be between 0.1 seconds and 1 hour.";
  }
  if (!maxValue.trim() || !Number.isFinite(max) || max < 0.1 || max > 3_600) {
    errors.max = "Maximum window must be between 0.1 seconds and 1 hour.";
  } else if (!errors.quiet && max < quiet) {
    errors.max = "Maximum window must be at least the quiet window.";
  }
  return errors;
}


export function useTriggerSourceDraft(initial?:TriggerSourceConfig){
 const schedule=initial&&'scheduleKind'in initial?initial:undefined;
 const files=initial&&'include'in initial?initial:undefined;
  const [scheduleKind, setScheduleKindValue] = useState<"once" | "interval" | "cron">(schedule?.scheduleKind??"interval");
  const [whenRunning,setWhenRunning]=useState<TriggerScheduleWhenRunning|undefined>(schedule&&schedule.scheduleKind!=='once'?schedule.whenRunning:'run_latest');
  const setScheduleKind=(kind:typeof scheduleKind)=>{if(scheduleKind==='once'&&kind!=='once')setWhenRunning('run_latest');setScheduleKindValue(kind)};
  const [onceAt, setOnceAt] = useState(isoToDatetimeLocal(schedule?.scheduleKind==='once'?schedule.at:new Date(Date.now()+300000).toISOString()));
  const [intervalValue, setIntervalValue] = useState(schedule?.scheduleKind==='interval'?intervalParts(schedule.everyMs).value:'1');
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(schedule?.scheduleKind==='interval'?intervalParts(schedule.everyMs).unit:'hours');
  const [cronExpression, setCronExpression] = useState(schedule?.scheduleKind==='cron'?schedule.expression:'0 9 * * 1-5');
  const [timezone, setTimezone] = useState(schedule?.scheduleKind==='cron'?schedule.timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');
  const [include, setInclude] = useState(files?.include.join('\n')??'**/*');
  const [exclude, setExclude] = useState(files?.exclude.join('\n')??'.git/**\nnode_modules/**\n.ponderosa/**');
  const [quietSeconds, setQuietSeconds] = useState(String((files?.quietMs??1000)/1000));
  const [maxWindowSeconds, setMaxWindowSeconds] = useState(String((files?.maxWindowMs??10000)/1000));
  const filesystemErrors=filesystemWindowErrors(quietSeconds,maxWindowSeconds);
  const intervalMs=Number(intervalValue)*INTERVAL_UNIT_MS[intervalUnit];
  let intervalError: string | undefined;
  if(!intervalValue.trim()||intervalMs<MIN_SCHEDULE_INTERVAL_MS)intervalError="Choose an interval of at least 1 minute.";
  else try{
   const now=Date.now(),startsAt=schedule?.scheduleKind==='interval'?new Date(schedule.startsAt).getTime():now;
   nextIntervalTime(Math.round(intervalMs),startsAt,now);
  }catch(error){intervalError=error instanceof Error?error.message:"Invalid interval.";}
  const intervalInvalid=Boolean(intervalError);
  const cronFormatError = cronExpression.trim().split(/\s+/u).length !== 5 ? "Five fields: minute, hour, day, month, weekday · minimum interval: one minute" : undefined;
  let timezoneError: string | undefined;
  try { if (!timezone.trim()) throw new Error(); new Intl.DateTimeFormat(undefined, { timeZone: timezone.trim() }); }
  catch { timezoneError = "Enter a valid IANA timezone, such as America/New_York or UTC."; }
  const load=(config:TriggerSourceConfig)=>{
   if('scheduleKind'in config){setScheduleKindValue(config.scheduleKind);setWhenRunning(config.scheduleKind==='once'?'run_latest':config.whenRunning);if(config.scheduleKind==='once')setOnceAt(isoToDatetimeLocal(config.at));else if(config.scheduleKind==='interval'){const parts=intervalParts(config.everyMs);setIntervalValue(parts.value);setIntervalUnit(parts.unit)}else{setCronExpression(config.expression);setTimezone(config.timezone)}}
   else if('include'in config){setInclude(config.include.join('\n'));setExclude(config.exclude.join('\n'));setQuietSeconds(String(config.quietMs/1000));setMaxWindowSeconds(String(config.maxWindowMs/1000))}
  };
  const configuration=(kind:TriggerSourceKind,original?:TriggerSourceConfig):TriggerSourceConfig=>{
   if(kind==='webhook')return {};
   if(kind==='filesystem')return {include:splitTriggerGlobText(include),exclude:splitTriggerGlobText(exclude),quietMs:Math.round(Number(quietSeconds)*1000),maxWindowMs:Math.round(Number(maxWindowSeconds)*1000)};
   if(scheduleKind==='once'&&original&&'scheduleKind'in original&&original.scheduleKind==='once')return original;
   const policy=whenRunning===undefined?{}:{whenRunning};
   if(scheduleKind==='cron')return {scheduleKind:'cron',expression:cronExpression,timezone,...policy};
   return {...intervalSourceConfig(Math.round(intervalMs),original&&'scheduleKind'in original&&original.scheduleKind==='interval'?original:undefined),...policy};
  };
  return {scheduleKind,whenRunning,onceAt,intervalValue,intervalUnit,cronExpression,timezone,include,exclude,quietSeconds,maxWindowSeconds,setScheduleKind,setWhenRunning,setIntervalValue,setIntervalUnit,setCronExpression,setTimezone,setInclude,setExclude,setQuietSeconds,setMaxWindowSeconds,filesystemErrors,intervalInvalid,intervalError,cronFormatError,timezoneError,configuration,load};
}
export function TriggerSourceFields({sourceKind,draft}:{sourceKind:TriggerSourceKind;draft:ReturnType<typeof useTriggerSourceDraft>}):JSX.Element{
 const {scheduleKind,whenRunning,onceAt,intervalValue,intervalUnit,cronExpression,timezone,include,exclude,quietSeconds,maxWindowSeconds,setScheduleKind,setWhenRunning,setIntervalValue,setIntervalUnit,setCronExpression,setTimezone,setInclude,setExclude,setQuietSeconds,setMaxWindowSeconds,filesystemErrors,intervalInvalid,intervalError,cronFormatError,timezoneError}=draft;
 const labelId=useId(),[changeOnce,setChangeOnce]=useState(false);
 return <>      {sourceKind === "schedule" ? <>
        {scheduleKind==='once'&&<Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
          <Typography>One-time schedule · {new Date(onceAt).toLocaleString()}</Typography>
          {!changeOnce&&<Button onClick={()=>setChangeOnce(true)}>Change schedule type</Button>}
        </Stack>}
        {(scheduleKind!=='once'||changeOnce)&&<FormControl>
          <FormLabel id={labelId}>Schedule type</FormLabel>
          <RadioGroup row aria-labelledby={labelId} value={scheduleKind} onChange={(_,value)=>{setChangeOnce(false);setScheduleKind(value as 'interval'|'cron')}}>
            <FormControlLabel value="interval" control={<Radio size="small" autoFocus={changeOnce}/>} label="Repeat at an interval"/>
            <FormControlLabel value="cron" control={<Radio size="small"/>} label="Cron"/>
          </RadioGroup>
        </FormControl>}
        {scheduleKind === "interval" ? <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <TextField fullWidth label="Every" type="number" value={intervalValue} onChange={(event) => setIntervalValue(event.target.value)} inputProps={{ min: 1, step: 1 }} error={intervalInvalid} helperText={intervalError??"At least 1 minute"} />
          <FormControl fullWidth><InputLabel id="trigger-interval-unit-label">Unit</InputLabel><Select labelId="trigger-interval-unit-label" label="Unit" value={intervalUnit} onChange={(event) => setIntervalUnit(event.target.value as IntervalUnit)}><MenuItem value="minutes">Minutes</MenuItem><MenuItem value="hours">Hours</MenuItem><MenuItem value="days">Days</MenuItem><MenuItem value="weeks">Weeks</MenuItem></Select></FormControl>
        </Stack> : null}
        {scheduleKind === "cron" ? <><TextField label="Cron Expression" value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} error={Boolean(cronFormatError)} helperText={cronFormatError ?? "Five fields; minimum frequency is once per minute."} /><TextField label="IANA Timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} error={Boolean(timezoneError)} helperText={timezoneError} /></> : null}
        {scheduleKind !== "once" && <FormControl>
          <FormLabel id={labelId+'-overlap'}>When already running</FormLabel>
          <RadioGroup aria-labelledby={labelId+'-overlap'} aria-describedby={labelId+'-overlap-help'} value={whenRunning??'queue_all'} onChange={(_,value)=>setWhenRunning(value as TriggerScheduleWhenRunning)}>
            {Object.entries(scheduleOverlapLabels).map(([value,label])=><FormControlLabel key={value} value={value} control={<Radio size="small"/>} label={label}/>)}
          </RadioGroup>
          <Typography id={labelId+'-overlap-help'} variant="body2" color="text.secondary">
            {whenRunning==='update_current'?'Send the next event to a supported Agent in the active run. Otherwise keep only the latest event for the next run.':whenRunning==='run_latest'?'Keep only the latest event for a run after the current one finishes.':'Queue a separate run for each scheduled event.'} Runs already queued stay queued.
          </Typography>
        </FormControl>}
      </> : null}
      {sourceKind === "filesystem" ? <><TextField label="Include Globs" value={include} onChange={(event) => setInclude(event.target.value)} multiline minRows={2} /><TextField label="Exclude Globs" value={exclude} onChange={(event) => setExclude(event.target.value)} multiline minRows={3} /><Stack direction={{ xs: "column", sm: "row" }} spacing={1}><TextField fullWidth label="Quiet Window (Seconds)" type="number" value={quietSeconds} onChange={(event) => setQuietSeconds(event.target.value)} inputProps={{ min: 0.1, max: 3_600, step: 0.1 }} error={Boolean(filesystemErrors.quiet)} helperText={filesystemErrors.quiet ?? "0.1 seconds–1 hour"} /><TextField fullWidth label="Maximum Window (Seconds)" type="number" value={maxWindowSeconds} onChange={(event) => setMaxWindowSeconds(event.target.value)} inputProps={{ min: 0.1, max: 3_600, step: 0.1 }} error={Boolean(filesystemErrors.max)} helperText={filesystemErrors.max ?? "At least quiet window; no more than 1 hour"} /></Stack><Typography variant="caption" color="text.secondary">Only paths and event types are captured; file contents are not injected.</Typography></> : null}
      {sourceKind === "webhook" ? <Typography variant="body2" color="text.secondary">JSON + stable X-Ponderosa-Event-Id · same ID/input: original occurrence · conflicting input: refused</Typography> : null}
</>;
}

export const scheduleOverlapLabels:Record<TriggerScheduleWhenRunning,string>={
 queue_all:'Queue every run',
 run_latest:'Run latest after current',
 update_current:'Update current run',
};
