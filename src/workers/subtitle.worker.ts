/// <reference lib="webworker" />
import type { ProcessingRequest, WorkerReply } from '../services/processing-service';
import { executeProcessingRequest } from './worker-logic';

const workerScope = self as DedicatedWorkerGlobalScope;
workerScope.onmessage = (event: MessageEvent<{ requestId: string; request: ProcessingRequest }>) => {
  const { requestId, request } = event.data;
  let reply: WorkerReply;
  try {
    reply = { requestId, result: executeProcessingRequest(request) };
  } catch (error) {
    reply = { requestId, error: error instanceof Error ? error.message : '字幕处理失败。' };
  }
  const buffers = reply.result?.outputs.map((output) => output.bytes.buffer as ArrayBuffer) ?? [];
  workerScope.postMessage(reply, buffers);
};
