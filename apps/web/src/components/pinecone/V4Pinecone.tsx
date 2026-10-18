import type {BranchRoute} from '../../branchesRouting';
import type {ColorMode} from '../../theme';
import {PineconeConsumer} from './PineconeConsumer';

/** Legacy V4 adapter; the consumer app also mounts this conversation directly. */
export function V4Pinecone({route,onNavigate,colorMode,onToggleColorMode}:{route:BranchRoute;onNavigate(route:BranchRoute,replace?:boolean):boolean;colorMode:ColorMode;onToggleColorMode():void}):JSX.Element {
  return <PineconeConsumer branchId={route.branchId??''} onOpenAdvanced={(tab,owner)=>{onNavigate({branchId:route.branchId,tab,chatId:owner?.conversationId,...(owner?{workspace:{kind:'agent',projectId:owner.projectId,agentId:owner.id}}:{})});}} colorMode={colorMode} onToggleColorMode={onToggleColorMode}/>;
}
