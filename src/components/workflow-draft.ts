import type { WorkflowDefinition } from '../core/workflow';

export interface WorkflowDraft extends WorkflowDefinition { id?: string; name: string; description: string }
export const emptyWorkflow = (): WorkflowDraft => ({ schemaVersion: 1, name: '', description: '', steps: [], lossyMode: 'reject' });
