import {Alert, Box, Button, Stack, Typography} from '@mui/material';
import {availabilityFailure, errorDetail, readDismissalKey, readIssueKey, type WorkspaceReadIssue} from '../workspaceAvailability';
import {useReportWorkspaceRead} from './WorkspaceRefreshContext';

/** Query feedback only. Retry never dispatches an action or clears cached data. */
export function WorkspaceQueryError({read, initial=false, reportOnly=false, active=true}: {
  read: WorkspaceReadIssue; initial?: boolean; reportOnly?: boolean; active?:boolean;
}): JSX.Element | null {
  const owner = useReportWorkspaceRead({...read,active:active&&read.active!==false});
  const key = readDismissalKey(read), error = read.error;
  if (!active || read.active===false || !error || reportOnly || availabilityFailure(error) && owner.shared && !initial) return null;
  const retry = () => { if (availabilityFailure(error) && owner.shared) owner.retry(); else void read.retry(); };
  if (initial) return <Box sx={{p:2, minWidth:0}} role="status">
    <Typography>{read.resource} could not be loaded.</Typography>
    <Typography variant="body2" color="text.secondary">{availabilityFailure(error) ? 'Check the connection and retry.' : errorDetail(error)}</Typography>
    <Button aria-label={`Retry ${read.resource}`} aria-busy={read.retrying||undefined} onClick={retry} disabled={owner.retrying}>Retry</Button>
  </Box>;
  if (owner.dismissed.has(key)) return <Box component="details" sx={{mx:1, fontSize:'.8125rem', minWidth:0}}>
    <summary>{read.resource} needs attention</summary>
    <Typography variant="caption" sx={{overflowWrap:'anywhere'}}>{errorDetail(error)}</Typography>
    <Button size="small" aria-label={`Retry ${read.resource}`} aria-busy={read.retrying||undefined} onClick={retry}>Retry</Button>
  </Box>;
  return <Alert severity="warning" onClose={() => owner.dismiss(key)}
    action={<Stack direction="row">
      <Button size="small" color="inherit" aria-label={`Retry ${read.resource}`} aria-busy={read.retrying||undefined} onClick={retry}>Retry</Button>
      <Button size="small" color="inherit" aria-label={`Close ${read.resource} warning`} onClick={() => owner.dismiss(key)}>Close</Button>
    </Stack>}
    sx={{mx:1, py:0, minWidth:0, '& .MuiAlert-message':{overflowWrap:'anywhere'}}}>
    {read.resource}: {errorDetail(error)}
  </Alert>;
}

export function WorkspaceQueryErrors({reads, reportOnly=false}: {reads:WorkspaceReadIssue[]; reportOnly?:boolean}):JSX.Element {
  return <>{reads.map(read => <WorkspaceQueryError key={readIssueKey(read)} read={read} reportOnly={reportOnly}/>)}</>;
}
