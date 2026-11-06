/// <reference lib="webworker" />
import type { ProcessedTask, WorkerRequest, WorkerReply } from '../services/processing-service';
import { createCalibrationPreview, type CalibrationPreview } from '../features/timeline/core/precision-calibration';
import { executeProcessingRequest } from './worker-logic';

const workerScope = self as DedicatedWorkerGlobalScope;
workerScope.onmessage = (event: MessageEvent<{ requestId: string; request: WorkerRequest }>) => {
  const { requestId, request } = event.data;
  let reply: WorkerReply<ProcessedTask | CalibrationPreview>;
  try {
    reply = { requestId, result: request.kind === 'calibration'
      ? createCalibrationPreview(request.cues, request.anchors, request.selectedIds)
      : executeProcessingRequest(request, {
      onStepProgress: progress => workerScope.postMessage({ requestId, progress } satisfies WorkerReply),
    }) };
  } catch (error) {
    reply = { requestId, error: error instanceof Error ? error.message : '字幕处理失败。' };
  }
  const buffers = reply.result && 'outputs' in reply.result ? reply.result.outputs.map(output => output.bytes.buffer as ArrayBuffer) : [];
  workerScope.postMessage(reply, buffers);
};
