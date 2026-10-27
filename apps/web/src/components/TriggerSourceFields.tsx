import {useState} from 'react';
import {FormControl,InputLabel,Select,MenuItem,Stack,TextField,Typography} from '@mui/material';
import type {TriggerScheduleWhenRunning,TriggerSourceConfig,TriggerSourceKind} from '@ponderosa/core';
import {splitTriggerGlobText} from './triggerSourceValues';
export function isoToDatetimeLocal(value: string): string {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 23);
}

export function changedSourceConfig(original: TriggerSourceConfig, next: TriggerSourceConfig): TriggerSourceConfig | undefined {
  return JSON.stringify(original) === JSON.stringify(next) ? undefined : next;
}

export function intervalSourceConfig(everyMs: number, original?: { startsAt: string }): TriggerSourceConfig {
  return { scheduleKind: "interval", everyMs, startsAt: original?.startsAt ?? new Date().toISOString() };
}

export type IntervalUnit = "minutes" | "hours" | "days" | "weeks";
export const INTERVAL_UNIT_MS: Record<IntervalUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};
export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 365 * 86_400_000;

export function intervalParts(everyMs: number): { value: string; unit: IntervalUnit } {
  for (const unit of ["weeks", "days", "hours"] as const) {
    const value = everyMs / INTERVAL_UNIT_MS[unit];
    if (Number.isInteger(value)) return { value: String(value), unit };
  }
  return { value: String(everyMs / INTERVAL_UNIT_MS.minutes), unit: "minutes" };
}

export function intervalSummary(everyMs: number): string {
  const { value, unit } = intervalParts(everyMs);
  const singular = Number(value) === 1 ? unit.slice(0, -1) : unit;
  return `every ${value} ${singular}`;
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
  const intervalInvalid=!intervalValue.trim()||!Number.isFinite(intervalMs)||intervalMs<MIN_INTERVAL_MS||intervalMs>MAX_INTERVAL_MS;
  const cronFormatError = cronExpression.trim().split(/\s+/u).length !== 5 ? "Use five fields: minute, hour, day, month, weekday. The minimum interval is one minute." : undefined;
  let timezoneError: string | undefined;
  try { if (!timezone.trim()) throw new Error(); new Intl.DateTimeFormat(undefined, { timeZone: timezone.trim() }); }
  catch { timezoneError = "Enter a valid IANA timezone, such as America/New_York or UTC."; }
  const load=(config:TriggerSourceConfig)=>{
   if('scheduleKind'in config){setScheduleKindValue(config.scheduleKind);setWhenRunning(config.scheduleKind==='once'?'run_latest':config.whenRunning);if(config.scheduleKind==='once')setOnceAt(isoToDatetimeLocal(config.at));else if(config.scheduleKind==='interval'){const parts=intervalParts(config.everyMs);setIntervalValue(parts.value);setIntervalUnit(parts.unit)}else{setCronExpression(config.expression);setTimezone(config.timezone)}}
   else if('include'in config){setInclude(config.include.join('\n'));setExclude(config.exclude.join('\n'));setQuietSeconds(String(config.quietMs/1000));setMaxWindowSeconds(String(config.maxWindowMs/1000))}
  };
  const configuration=(kind:TriggerSourceKind,original?:TriggerSourceConfig):TriggerSourceConfig=>{
   if(kind==='webhook')return original&&'replayWindowSeconds'in original?original:{replayWindowSeconds:300};
   if(kind==='filesystem')return {include:splitTriggerGlobText(include),exclude:splitTriggerGlobText(exclude),quietMs:Math.round(Number(quietSeconds)*1000),maxWindowMs:Math.round(Number(maxWindowSeconds)*1000)};
   if(scheduleKind==='once')return {scheduleKind:'once',at:new Date(onceAt).toISOString()};
   const policy=whenRunning===undefined?{}:{whenRunning};
   if(scheduleKind==='cron')return {scheduleKind:'cron',expression:cronExpression,timezone,...policy};
   return {...intervalSourceConfig(Math.round(intervalMs),original&&'scheduleKind'in original&&original.scheduleKind==='interval'?original:undefined),...policy};
  };
  return {scheduleKind,whenRunning,onceAt,intervalValue,intervalUnit,cronExpression,timezone,include,exclude,quietSeconds,maxWindowSeconds,setScheduleKind,setWhenRunning,setOnceAt,setIntervalValue,setIntervalUnit,setCronExpression,setTimezone,setInclude,setExclude,setQuietSeconds,setMaxWindowSeconds,filesystemErrors,intervalInvalid,cronFormatError,timezoneError,configuration,load};
}
export function TriggerSourceFields({sourceKind,draft}:{sourceKind:TriggerSourceKind;draft:ReturnType<typeof useTriggerSourceDraft>}):JSX.Element{
 const {scheduleKind,whenRunning,onceAt,intervalValue,intervalUnit,cronExpression,timezone,include,exclude,quietSeconds,maxWindowSeconds,setScheduleKind,setWhenRunning,setOnceAt,setIntervalValue,setIntervalUnit,setCronExpression,setTimezone,setInclude,setExclude,setQuietSeconds,setMaxWindowSeconds,filesystemErrors,intervalInvalid,cronFormatError,timezoneError}=draft;
 return <>      {sourceKind === "schedule" ? <>
        <FormControl fullWidth><InputLabel id="schedule-kind-label">Schedule type</InputLabel><Select labelId="schedule-kind-label" label="Schedule type" value={scheduleKind} onChange={(event) => setScheduleKind(event.target.value as typeof scheduleKind)}><MenuItem value="interval">Interval</MenuItem><MenuItem value="once">One Time</MenuItem><MenuItem value="cron">Cron</MenuItem></Select></FormControl>
        {scheduleKind === "interval" ? <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <TextField fullWidth label="Every" type="number" value={intervalValue} onChange={(event) => setIntervalValue(event.target.value)} inputProps={{ min: 1, step: 1 }} error={intervalInvalid} helperText={intervalInvalid ? "Choose an interval from 1 minute through 365 days." : "1 minute–365 days"} />
          <FormControl fullWidth><InputLabel id="trigger-interval-unit-label">Unit</InputLabel><Select labelId="trigger-interval-unit-label" label="Unit" value={intervalUnit} onChange={(event) => setIntervalUnit(event.target.value as IntervalUnit)}><MenuItem value="minutes">Minutes</MenuItem><MenuItem value="hours">Hours</MenuItem><MenuItem value="days">Days</MenuItem><MenuItem value="weeks">Weeks</MenuItem></Select></FormControl>
        </Stack> : null}
        {scheduleKind === "once" ? <TextField label="Run at" type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} InputLabelProps={{ shrink: true }} inputProps={{ step: 0.001 }} /> : null}
        {scheduleKind === "cron" ? <><TextField label="Cron expression" value={cronExpression} onChange={(event) => setCronExpression(event.target.value)} error={Boolean(cronFormatError)} helperText={cronFormatError ?? "Five fields; minimum frequency is once per minute."} /><TextField label="IANA timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} error={Boolean(timezoneError)} helperText={timezoneError} /></> : null}
        {scheduleKind !== "once" ? <><FormControl fullWidth><InputLabel id="schedule-when-running-label">When Already Running</InputLabel><Select labelId="schedule-when-running-label" label="When Already Running" value={whenRunning??'queue_all'} onChange={event=>setWhenRunning(event.target.value as TriggerScheduleWhenRunning)}><MenuItem value="update_current">Update Current Run</MenuItem><MenuItem value="run_latest">Run Latest When Finished</MenuItem><MenuItem value="queue_all">Queue Every Run</MenuItem></Select></FormControl><Typography variant="caption" color="text.secondary">{whenRunning==='update_current'?'Send newer scheduled events to supported active Agent work; otherwise keep only the latest event for the next Run.':whenRunning==='run_latest'?'Keep only the latest scheduled event for the next Run when current work finishes.':'Queue a separate Run for each schedule check, even while current work is active.'} Runs already queued remain queued. Changing this setting does not clear or merge them.</Typography></> : null}
      </> : null}
      {sourceKind === "filesystem" ? <><TextField label="Include globs" value={include} onChange={(event) => setInclude(event.target.value)} multiline minRows={2} /><TextField label="Exclude globs" value={exclude} onChange={(event) => setExclude(event.target.value)} multiline minRows={3} /><Stack direction={{ xs: "column", sm: "row" }} spacing={1}><TextField fullWidth label="Quiet window (seconds)" type="number" value={quietSeconds} onChange={(event) => setQuietSeconds(event.target.value)} inputProps={{ min: 0.1, max: 3_600, step: 0.1 }} error={Boolean(filesystemErrors.quiet)} helperText={filesystemErrors.quiet ?? "0.1 seconds–1 hour"} /><TextField fullWidth label="Maximum window (seconds)" type="number" value={maxWindowSeconds} onChange={(event) => setMaxWindowSeconds(event.target.value)} inputProps={{ min: 0.1, max: 3_600, step: 0.1 }} error={Boolean(filesystemErrors.max)} helperText={filesystemErrors.max ?? "At least quiet window; no more than 1 hour"} /></Stack><Typography variant="caption" color="text.secondary">Only paths and event types are captured; file contents are not injected.</Typography></> : null}
      {sourceKind === "webhook" ? <Typography variant="body2" color="text.secondary">Ponderosa will show a signing secret once. Send a stable event ID, Unix timestamp, and v1 HMAC-SHA256 signature with each JSON request.</Typography> : null}
</>;
}
