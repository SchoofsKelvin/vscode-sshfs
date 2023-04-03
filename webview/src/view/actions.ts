import type { ConfigLocation, FileSystemConfig } from 'common/fileSystemConfig';

export enum ActionType {
  // Startscreen
  OPEN_STARTSCREEN = 'OPEN_STARTSCREEN',
  // NewConfig
  OPEN_NEWCONFIG = 'OPEN_NEWCONFIG',
  NEWCONFIG_SETNAME = 'NEWCONFIG_SETNAME',
  NEWCONFIG_SETLOCATION = 'NEWCONFIG_SETLOCATION',
  // ConfigEditor
  OPEN_CONFIGEDITOR = 'OPEN_CONFIGEDITOR',
  OPEN_CONFIGLOCATOR = 'OPEN_CONFIGLOCATOR',
  CONFIGEDITOR_SETNEWCONFIG = 'CONFIGEDITOR_SETNEWCONFIG',
  CONFIGEDITOR_SETSTATUSMESSAGE = 'CONFIGEDITOR_SETSTATUSMESSAGE',
}

export interface ActionTypes {
  // Startscreen
  OPEN_STARTSCREEN: IActionOpenStartscreen;
  // NewConfig
  OPEN_NEWCONFIG: IActionOpenNewConfig;
  NEWCONFIG_SETNAME: IActionNewConfigSetName;
  NEWCONFIG_SETLOCATION: IActionNewConfigSetLocation;
  // ConfigEditor
  OPEN_CONFIGEDITOR: IActionOpenConfigEditor;
  OPEN_CONFIGLOCATOR: IActionOpenConfigLocator;
  CONFIGEDITOR_SETNEWCONFIG: IActionConfigEditorSetNewConfig;
  CONFIGEDITOR_SETSTATUSMESSAGE: IActionConfigEditorSetStatusMessage;
}
export type Action = ActionTypes[keyof ActionTypes];

interface IAction {
  type: ActionType;
}

/* Startscreen */

export interface IActionOpenStartscreen extends IAction {
  type: ActionType.OPEN_STARTSCREEN;
  groupBy?: string;
}
export function openStartScreen(groupBy?: string): IActionOpenStartscreen {
  return { type: ActionType.OPEN_STARTSCREEN, groupBy };
}

/* NewConfig */

export interface IActionOpenNewConfig extends IAction {
  type: ActionType.OPEN_NEWCONFIG;
  name: string;
}
export function openNewConfig(name = 'unnamed'): IActionOpenNewConfig {
  return { type: ActionType.OPEN_NEWCONFIG, name };
}

export interface IActionNewConfigSetLocation extends IAction {
  type: ActionType.NEWCONFIG_SETLOCATION;
  location: ConfigLocation;
}
export function newConfigSetLocation(location: ConfigLocation): IActionNewConfigSetLocation {
  return { type: ActionType.NEWCONFIG_SETLOCATION, location };
}

export interface IActionNewConfigSetName extends IAction {
  type: ActionType.NEWCONFIG_SETNAME;
  name: string;
}
export function newConfigSetName(name: string): IActionNewConfigSetName {
  return { type: ActionType.NEWCONFIG_SETNAME, name };
}

/* ConfigEditor */

export interface IActionOpenConfigEditor extends IAction {
  type: ActionType.OPEN_CONFIGEDITOR;
  config: FileSystemConfig;
}
export function openConfigEditor(config: FileSystemConfig): IActionOpenConfigEditor {
  return { type: ActionType.OPEN_CONFIGEDITOR, config };
}

export interface IActionOpenConfigLocator extends IAction {
  type: ActionType.OPEN_CONFIGLOCATOR;
  configs: FileSystemConfig[];
  name: string;
}
export function openConfigLocator(configs: FileSystemConfig[], name: string): IActionOpenConfigLocator {
  return { type: ActionType.OPEN_CONFIGLOCATOR, configs, name };
}

export interface IActionConfigEditorSetNewConfig extends IAction {
  type: ActionType.CONFIGEDITOR_SETNEWCONFIG;
  config: FileSystemConfig;
}
export function configEditorSetNewConfig(config: FileSystemConfig): IActionConfigEditorSetNewConfig {
  return { type: ActionType.CONFIGEDITOR_SETNEWCONFIG, config };
}

export interface IActionConfigEditorSetStatusMessage extends IAction {
  type: ActionType.CONFIGEDITOR_SETSTATUSMESSAGE,
  message?: string;
}
export function configEditorSetStatusMessage(message?: string): IActionConfigEditorSetStatusMessage {
  return { type: ActionType.CONFIGEDITOR_SETSTATUSMESSAGE, message };
}
