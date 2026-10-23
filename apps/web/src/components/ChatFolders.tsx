import {routeLinkPath} from "../routeRegistry";
import {SidebarActivityBadge} from "./SidebarActivityBadge";
import type {WorkspaceActivityCountDto} from "@ponderosa/core";
import type { ComponentProps } from "react";
import { ResourceFolders } from "./ResourceFolders";
import type { ChatFolderDto, ConversationDto, WorkspaceConversationDirectoryItemDto } from "@ponderosa/core";

type Item = WorkspaceConversationDirectoryItemDto;
type Props = Omit<ComponentProps<typeof ResourceFolders<Item & {id: string; title: string; updatedAt: string}>>, "resourceKind" | "resourceLabel" | "items" | "openItems" | "folders" | "onChange" | "onReorder" | "onRename" | "onDelete" | "onOpenInNewTab"> & {
  folderActivity?: Record<string,WorkspaceActivityCountDto>; activityFresh?: boolean;
  items: Item[]; openItems?: Item[]; folders: ChatFolderDto[];
  onChange(folders: ChatFolderDto[], customOrder?: boolean): void;
  onReorder(source: string, target: string, position: "before" | "after", folders?: ChatFolderDto[]): void;
  onRename(conversation: ConversationDto): void; onDelete(conversation: ConversationDto): void;
};
const resource = (item: Item) => ({...item, id: item.conversation.id, title: item.conversation.title, updatedAt: item.conversation.updatedAt});
const chatFolders = (folders: import("../resourcePreferences").ResourceFolder[]) => folders.map(({memberIds, ...folder}) => ({...folder, conversationIds: memberIds}));

/** Preserve the normal Chat API while sharing its folder controls with Branches. */
export function ChatFolders({items, openItems, folders, onChange, onReorder, onRename, onDelete, folderActivity, activityFresh, ...props}: Props) {
  return <ResourceFolders {...props} renderFolderStatus={folder=><SidebarActivityBadge activity={folderActivity?.[folder.id]} fresh={activityFresh}/>} resourceKind="conversation" resourceLabel="Chats"
    items={items.map(resource)} openItems={openItems?.map(resource)}
    folders={folders.map(({conversationIds, ...folder}) => ({...folder, memberIds: conversationIds}))}
    onChange={(next, custom) => onChange(chatFolders(next), custom)}
    onReorder={(source, target, position, next) => onReorder(source, target, position, next && chatFolders(next))}
    onOpenInNewTab={item => window.open(routeLinkPath({kind:"conversation",projectId:item.project.id,conversationId:item.conversation.id}), "_blank", "noopener,noreferrer")}
    onRename={item => onRename(item.conversation)} onDelete={item => onDelete(item.conversation)}/>;
}
