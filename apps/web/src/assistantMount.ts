import type {ColorMode} from './theme';
import type {MutationNotifier} from './components/MutationNotifications';

/** Plain data and callbacks cross the two independent React runtimes. */
export interface AssistantMountProps {
  colorMode:ColorMode;
  returnTo?:string;
  onOpenNavigation():void;
  onToggleColorMode():void;
  onOpenProviderSettings():void;
  notify?:MutationNotifier;
  /** Request a fresh canonical identity projection in the host runtime. */
  onIdentityChanged?():void;
}
export interface AssistantMountApi {
  mount(host:HTMLElement,props:AssistantMountProps):void;
  update(props:AssistantMountProps):void;
  unmount():void;
  canLeave():boolean;
  blockers():string[];
  productScope():string;
}
export type AssistantMountWindow=Window&{__ponderosaAssistantMount?:AssistantMountApi};
