import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_IDS,
  filterRuntimeToolsForCapabilities,
  resolveCapabilityPolicy,
} from "@ponderosa/core";

test("capability policy only narrows across ordered scopes", () => {
  const effective = resolveCapabilityPolicy([
    {scopeKind:"global",scopeId:"ponderosa",label:"Ponderosa",restrictedCapabilityIds:[CAPABILITY_IDS.browserInteract]},
    {scopeKind:"branch",scopeId:"b",label:"Review",restrictedCapabilityIds:[CAPABILITY_IDS.hostFileImport]},
    {scopeKind:"agent",scopeId:"a",label:"Reviewer",restrictedCapabilityIds:[CAPABILITY_IDS.browserInteract,CAPABILITY_IDS.managedAgentCreate]},
  ]);
  assert.deepEqual(effective.restrictedCapabilityIds,[
    CAPABILITY_IDS.managedAgentCreate,
    CAPABILITY_IDS.browserInteract,
    CAPABILITY_IDS.hostFileImport,
  ].sort());
  assert.equal(effective.restrictionSources[CAPABILITY_IDS.browserInteract].scopeKind,"global");
  assert.equal(effective.restrictionSources[CAPABILITY_IDS.managedAgentCreate].scopeKind,"agent");
});

test("runtime tools are removed by stable capability rather than display text", () => {
  const effective=resolveCapabilityPolicy([{scopeKind:"branch",scopeId:"b",label:"Branch",restrictedCapabilityIds:[CAPABILITY_IDS.browserInteract]}]);
  const tools=["ponderosa_browser_inspect","ponderosa_browser_act","ponderosa_browser_navigate","ponderosa_message"].map(name=>({name,description:name,inputSchema:{type:"object"}}));
  assert.deepEqual(filterRuntimeToolsForCapabilities(tools,effective).map(tool=>tool.name),[
    "ponderosa_browser_inspect",
    "ponderosa_message",
  ]);
});

test("managed Agent restrictions also remove create_agent from the management tool", () => {
  const effective=resolveCapabilityPolicy([{scopeKind:"agent",scopeId:"a",label:"Agent",restrictedCapabilityIds:[CAPABILITY_IDS.managedAgentCreate]}]);
  const tools=[
    {name:"ponderosa_create_managed_agent",description:"create",inputSchema:{type:"object"}},
    {name:"ponderosa_manage",description:"manage",inputSchema:{type:"object",properties:{operations:{type:"array",items:{type:"object",properties:{kind:{type:"string",enum:["create_agent","rename_agent","stop_agent"]}}}}}}},
  ];
  const filtered=filterRuntimeToolsForCapabilities(tools,effective);
  assert.deepEqual(filtered.map(tool=>tool.name),["ponderosa_manage"]);
  assert.deepEqual(filtered[0].inputSchema.properties.operations.items.properties.kind.enum,["rename_agent","stop_agent"]);
});
