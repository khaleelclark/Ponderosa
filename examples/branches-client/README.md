# Drive a workflow from another application

This standalone TypeScript client uses only public HTTP routes. It imports no
Ponderosa package, database, private runtime, or test fixture. Node 24 can run the
TypeScript file directly. No extra dependency or provider credential is needed
in the client; the Engine uses its existing host harness configuration.

Create and publish a manual workflow in Branches. Copy its workflow ID. Set
`PONDEROSA_URL` to your Engine address (the default is `http://127.0.0.1:3000`).
Explicitly starting a workflow may run its configured agents, tools or Scripts.

```sh
node examples/branches-client/client.ts start WORKFLOW_ID order-1042 'Summarize this order'
node examples/branches-client/client.ts status EXECUTION_ID
node examples/branches-client/client.ts result EXECUTION_ID
```

The start response supplies the execution ID. Keep the occurrence key stable
when recovering an uncertain response; changing it creates a separate execution.
Do not automatically retry failed mutations. Status includes workflow state and
pending actions. A workflow waiting for a human remains waiting; resolve its
Decision in Branches. The result endpoint returns the retained final output;
`null` is not a fabricated success or an empty completed answer.

The public interface also provides workflow deployment, trigger settings,
checkpoints, execution actions and Step evidence in
`apps/server/src/routes/branches.ts`. This sample intentionally uses only start,
status and result. It is a usable integration example, not evidence of framework
parity or a passing implementation check. It has not been executed during the
implementation-first phase.
