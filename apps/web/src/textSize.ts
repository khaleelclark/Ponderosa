import {readBrowserStorage,writeBrowserStorage} from './browserStorage';

export const TEXT_SIZE_KEY='ponderosa.text-size.v1';
export const TEXT_SIZE_EVENT='ponderosa:text-size';
export const TEXT_SIZES=[100,115,130,150,175,200] as const;
export function normalizeTextSize(value:unknown):number {
 const size=Number(value);
 return TEXT_SIZES.some(option=>option===size)?size:100;
}
export const readTextSize=():number=>normalizeTextSize(readBrowserStorage('localStorage',TEXT_SIZE_KEY));
export function saveTextSize(size:number):void {
 writeBrowserStorage('localStorage',TEXT_SIZE_KEY,String(normalizeTextSize(size)));
 window.dispatchEvent(new Event(TEXT_SIZE_EVENT));
}
