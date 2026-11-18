import type {CheckpointPackageSource} from '@ponderosa/core';
/** Emitted only before beginning a specific expert source capture. */
export class ExpertCaptureHeldBeforeStart extends Error {
 constructor(readonly source:CheckpointPackageSource,readonly sourceProjectId:string,
   readonly attemptId:string,readonly holdWitness:string,cause:Error){super('Checkpoint capture refused: memory mutation requires reconciliation',{cause});}
}
