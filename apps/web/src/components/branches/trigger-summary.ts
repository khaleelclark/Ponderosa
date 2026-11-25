import type {BranchDefinition,TriggerSourceConfig} from '@ponderosa/core';
import {intervalParts} from '../TriggerSourceFields';

export function workflowTriggerSummary(kind:BranchDefinition['trigger']['kind'],config?:TriggerSourceConfig):string {
 if(kind==='manual')return 'Start manually';
 if(kind==='webhook')return 'When a webhook arrives';
 if(kind==='filesystem')return 'When files change';
 if(!config||!('scheduleKind'in config))return 'On a schedule';
 if(config.scheduleKind==='interval'){
  const {value,unit}=intervalParts(config.everyMs);
  return `Every ${value} ${value==='1'?unit.slice(0,-1):unit}`;
 }
 if(config.scheduleKind==='once')return `Once on ${new Date(config.at).toLocaleString()}`;
 return `Cron: ${config.expression} (${config.timezone})`;
}
