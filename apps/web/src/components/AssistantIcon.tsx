import {SvgIcon,type SvgIconProps} from '@mui/material';
/** The Assistant's conversation spark stays distinct from Chat and Agent icons. */
export function AssistantIcon(props:SvgIconProps):JSX.Element {
 return <SvgIcon {...props} viewBox="0 0 24 24"><path d="M13 3H7a4 4 0 0 0-4 4v7a4 4 0 0 0 4 4h1v3l4-3h5a4 4 0 0 0 4-4v-2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/><path d="m18 2 1.3 3.7L23 7l-3.7 1.3L18 12l-1.3-3.7L13 7l3.7-1.3Z" fill="currentColor"/></SvgIcon>;
}
