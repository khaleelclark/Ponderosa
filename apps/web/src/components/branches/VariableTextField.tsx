import {useId,useRef,useState} from 'react';
import {Button,Menu,MenuItem,Stack,TextField,type TextFieldProps} from '@mui/material';
import type {BranchDefinition} from '@ponderosa/core';

export function VariableTextField({parameters,label,value,onValueChange,...props}:Omit<TextFieldProps,'value'|'onChange'|'inputRef'|'label'>&{
 parameters:BranchDefinition['parameters'];label:string;value:string;onValueChange(value:string):void;
}):JSX.Element{
 const field=useRef<HTMLInputElement|HTMLTextAreaElement>(null);
 const selection=useRef({start:0,end:0});
 const returnCaret=useRef<number>();
 const button=useRef<HTMLButtonElement>(null);
 const [anchor,setAnchor]=useState<HTMLButtonElement>();
 const menuId=useId();
 const variables=Object.entries(parameters??{}).filter(([,parameter])=>parameter.type!=='secret');

 const input=<TextField {...props} label={label} inputRef={field} value={value} onChange={event=>onValueChange(event.target.value)}/>;
 if(!variables.length)return input;

 return <Stack spacing={0.5}>
  {input}
  <Button ref={button} size="small" sx={{alignSelf:'start',minHeight:44}} aria-label={'Insert variable into '+label}
   aria-haspopup="menu" aria-expanded={Boolean(anchor)} aria-controls={anchor?menuId:undefined}
   onClick={event=>{
    selection.current={start:field.current?.selectionStart??value.length,end:field.current?.selectionEnd??value.length};
    setAnchor(event.currentTarget);
   }}>Insert variable</Button>
  <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={()=>setAnchor(undefined)} disableRestoreFocus
   slotProps={{list:{id:menuId,'aria-label':'Variables for '+label},transition:{onExited:()=>{
    const caret=returnCaret.current;
    returnCaret.current=undefined;
    if(caret===undefined){button.current?.focus();return;}
    field.current?.focus();
    field.current?.setSelectionRange(caret,caret);
   }}}}>
   {variables.map(([name])=><MenuItem key={name} sx={{minHeight:44,whiteSpace:'normal',overflowWrap:'anywhere'}}
    onClick={()=>{
     const {start,end}=selection.current;
     const reference='{{parameter:'+name+'}}';
     onValueChange(value.slice(0,start)+reference+value.slice(end));
     returnCaret.current=start+reference.length;
     setAnchor(undefined);
    }}>{name}</MenuItem>)}
  </Menu>
 </Stack>;
}
