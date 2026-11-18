import {useEffect,useState} from 'react';
import {MenuItem,TextField} from '@mui/material';
import {TEXT_SIZE_EVENT,TEXT_SIZES,readTextSize,saveTextSize} from '../textSize';

/** Appearance is a device preference shared across core, Branches and output URLs. */
export function TextSizeSetting():JSX.Element {
 const [size,setSize]=useState(readTextSize);
 useEffect(()=>{
  const update=()=>setSize(readTextSize());
  window.addEventListener(TEXT_SIZE_EVENT,update);window.addEventListener('storage',update);
  return()=>{window.removeEventListener(TEXT_SIZE_EVENT,update);window.removeEventListener('storage',update);};
 },[]);
 return <TextField select fullWidth label="Text Size" value={size} onChange={event=>saveTextSize(Number(event.target.value))}>
  {TEXT_SIZES.map(value=><MenuItem key={value} value={value}>{value}%</MenuItem>)}
 </TextField>;
}
