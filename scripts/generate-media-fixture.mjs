import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const [destination, ...extra] = process.argv.slice(2);
const format = destination && path.extname(destination);
if (extra.length || !destination || !path.isAbsolute(destination) || !['.mp4', '.webm'].includes(format)) {
  throw new Error('Specify an absolute .mp4 or .webm destination in the owned QA workspace.');
}

const video = ['-f', 'lavfi', '-i', 'color=c=0x27364b:size=320x180:rate=30'];
const audio = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];
const encoding = format === '.mp4'
  ? [...audio, '-c:v', 'libx264', '-profile:v', 'baseline', '-g', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart']
  : ['-c:v', 'libvpx', '-crf', '24', '-b:v', '0', '-an'];

try {
  await promisify(execFile)('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...video, ...encoding,
    '-threads', '1', '-map_metadata', '-1', '-t', '8', destination,
  ], { timeout: 30_000, windowsHide: true });
} catch (problem) {
  if (problem.code === 'ENOENT') throw new Error('FFmpeg is required on PATH to generate synthetic QA media.', { cause: problem });
  throw problem;
}
