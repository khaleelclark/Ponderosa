import { SvgIcon, type SvgIconProps } from "@mui/material";

export function PineconeMark(props: SvgIconProps): JSX.Element {
  return <SvgIcon {...props} viewBox="0 0 24 24">
    <path d="M12 2v3m0 0c-3 2-6 6-6 10 0 4 3 7 6 7s6-3 6-7c0-4-3-8-6-10Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="m8 9 4 3 4-3M6.5 13l5.5 4 5.5-4M8 18l4 3 4-3M12 5v16" fill="none" stroke="currentColor" strokeWidth="1.25" />
  </SvgIcon>;
}
